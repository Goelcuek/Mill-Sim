// G-code interpreter.
//
// Consumes lexed blocks and produces a flat list of moves in scene
// coordinates (millimetres, Z up, work-offset applied). Everything the
// simulator, the backplot and the collision reporter need lives in that
// list; nothing downstream has to know about modal state.

import { lex } from './lexer.js';
import { normaliseCode, expandMacro } from '../machine/macros.js';
import { Vars, evaluate, ARGUMENTS } from './macro.js';
import { resolveDialect, detectDialect, DIALECTS } from './dialects.js';
import { MM_PER_INCH, deg2rad } from '../core/util.js';
import * as m4 from '../core/mat4.js';

export const DEFAULT_CONFIG = {
  /** Rapid traverse used for time estimates, mm/min. */
  rapidRate: 15000,
  /**
   * The control's own defaults — the modal state a program starts in
   * before it says anything.
   *
   * Controls do not agree on these. A program posted for one machine and
   * run on another is the classic way to crash: the second control starts
   * in inches, or reads I/J as absolute, or comes up in G18. So they are
   * settings of the *machine*, not assumptions baked into the reader.
   */
  controller: {
    /** G17 / G18 / G19 before any plane is commanded. */
    plane: 17,
    /** true for G21 (mm), false for G20 (inch). */
    metric: true,
    /** true for G90 absolute, false for G91 incremental. */
    absolute: true,
    /** true for G90.1 — arc centres absolute rather than incremental. */
    arcCentreAbsolute: false,
    /** G94 feed per minute, or G95 feed per revolution. */
    feedMode: 94,
  },
  /** Where machine zero sits in scene coordinates, for G53/G28/G30. */
  machineZero: [0, 0, 250],
  /** Secondary reference point for G30. */
  g30: [0, 0, 250],
  /**
   * Where the tool sits before the first block. Real controls start from
   * wherever the last program left the spindle; assuming machine home is
   * both the safest and the most common case.
   */
  initialPosition: null,
  /** Work coordinate system offsets, scene coordinates of each origin. */
  wcs: {
    G54: [0, 0, 0], G55: [0, 0, 0], G56: [0, 0, 0],
    G57: [0, 0, 0], G58: [0, 0, 0], G59: [0, 0, 0],
  },
  /** Chord tolerance used when flattening arcs, mm. */
  arcTolerance: 0.008,
  /** Safety valve for runaway subprogram loops. */
  maxBlocks: 400000,
  /**
   * Subprograms the main program may call with M98, as separate files.
   * Each is `{name, number, text}`; the number is the O number M98 asks
   * for when the text itself does not carry one.
   */
  subprograms: [],
  /**
   * What this machine does at an M code, as G-code. See machine/macros.js.
   */
  macros: [],
  /** Named numbers a macro body can substitute, such as toolChangeX. */
  parameters: {},
  /**
   * What the tool table holds, by pot number: `{7: {length, diameter}}` in
   * millimetres. A program that checks its tool before it cuts asks the
   * machine this, so the machine has to be able to answer.
   */
  tools: {},
  /**
   * The machine, when one is loaded. Only the 5-axis codes need it: G53.1
   * has to solve the rotaries against a real chain.
   */
  kinematics: null,
  /** Tip distance below the spindle gauge line, for those solves. */
  gaugeLength: 0,
  /**
   * Units of the P word in G04. Fanuc/Haas read it as milliseconds,
   * LinuxCNC as seconds. G04 X/U is always seconds.
   */
  dwellPUnits: 'ms',
};

const MOTION_CYCLES = new Set([73, 74, 76, 81, 82, 83, 84, 85, 86, 88, 89]);

/** @typedef {{kind:string, line:number, path:Float64Array, ...}} Move */

class State {
  constructor(cfg) {
    this.cfg = cfg;
    this.pos = (cfg.initialPosition || cfg.machineZero || [0, 0, 0]).slice();
    const ctl = cfg.controller || {};
    this.motion = 0;             // modal motion G code
    this.plane = ctl.plane ?? 17;
    this.metric = ctl.metric !== false;
    this.absolute = ctl.absolute !== false;
    this.arcAbsolute = !!ctl.arcCentreAbsolute;
    this.feedMode = ctl.feedMode ?? 94;
    this.feed = 0;
    this.rpm = 0;
    this.spindleDir = 0;         // -1 CCW, 0 off, 1 CW
    this.coolant = 'off';
    this.tool = 0;
    this.pendingTool = 0;
    this.wcs = 'G54';
    this.lengthComp = false;
    this.hNumber = 0;
    this.cutterComp = 0;         // 40/41/42
    /**
     * Where every axis that is not the tool tip stands: the rotaries in
     * degrees, and any extra linear slide (U, V, W) in millimetres. One
     * dict, because a move has to carry all of them and the chain does not
     * care which is which.
     */
    this.rot = { A: 0, B: 0, C: 0 };
    for (const L of extraLetters(cfg).keys()) this.rot[L] = 0;
    this.rotPrev = { ...this.rot };
    /** Last programmed point in the tilted plane's own coordinates. */
    this.tiltLocal = [0, 0, 0];
    this.tiltLocalPrev = [0, 0, 0];
    /** Tool centre point control: 0 off, 4 = G43.4, 5 = G43.5. */
    this.tcp = 0;
    /**
     * Tilted working plane from G68.2, or null. Deliberately NOT called
     * `plane` — that is the G17/18/19 arc plane and they are unrelated.
     */
    this.tilt = null;
    this.retractMode = 98;
    this.cycleR = 0;
    this.cycleZ = 0;
    this.cycleQ = 0;
    this.cycleP = 0;
    this.cycleF = 0;
    this.g92 = [0, 0, 0];
    /** Tool-vector mode: the block says where the tool points, not the angles. */
    this.vector = false;
  }

  offset() {
    const w = this.cfg.wcs[this.wcs] || [0, 0, 0];
    return [w[0] + this.g92[0], w[1] + this.g92[1], w[2] + this.g92[2]];
  }
}

const toMM = (v, metric) => (metric ? v : v * MM_PER_INCH);

/**
 * The extra linear axis letters this machine has, if any.
 *
 * U, V and W are only read as axis words when the machine actually carries
 * such a slide. A program written for a machine without one can use the
 * letter for something else, and silently turning that into a 300 mm move
 * is not a trade worth making.
 */
function auxLinearLetters(cfg) {
  const kin = cfg && cfg.kinematics;
  if (!kin || typeof kin.auxLinears !== 'function') return [];
  return kin.auxLinears().map((n) => n.letter);
}

/**
 * Every axis this machine has beyond the tool tip, and what kind it is.
 *
 * A, B and C are rotaries by convention and are always read. U, V and W are
 * whatever the machine says they are: a quill on one, the part indexer on
 * another — the Fidia in front of us turns its table with U — and reading a
 * 90° index as a 90 mm slide is not a mistake worth making twice.
 *
 * @returns {Map<string, 'rotary'|'linear'>}
 */
function extraLetters(cfg) {
  const out = new Map();
  const kin = cfg && cfg.kinematics;
  if (!kin || typeof kin.extras !== 'function') return out;
  for (const node of kin.extras()) {
    if (node.letter) out.set(node.letter, node.kind === 'rotary' ? 'rotary' : 'linear');
  }
  return out;
}

/**
 * Build the frame G68.2 defines.
 *
 * Fanuc's default (P1) reads I, J, K as ZXZ Euler angles in degrees about
 * the rotating axes, applied after shifting the origin to X, Y, Z. P2 is
 * the roll-pitch-yaw form about the fixed axes. Both are handled because
 * posts differ on which they emit, and picking the wrong one tilts the
 * whole operation the wrong way.
 */
export function tiltedPlaneMatrix(origin, i, j, k, mode = 1) {
  const out = m4.fromTranslation(m4.create(), origin);
  const tmp = m4.create();
  const rot = m4.create();

  if (mode === 2) {
    m4.fromRotation(rot, [0, 0, 1], deg2rad(k));
    m4.multiply(tmp, out, rot);
    m4.fromRotation(rot, [0, 1, 0], deg2rad(j));
    m4.multiply(out, tmp, rot);
    m4.fromRotation(rot, [1, 0, 0], deg2rad(i));
    m4.multiply(tmp, out, rot);
    return m4.copy(out, tmp);
  }

  m4.fromRotation(rot, [0, 0, 1], deg2rad(i));
  m4.multiply(tmp, out, rot);
  m4.fromRotation(rot, [1, 0, 0], deg2rad(j));
  m4.multiply(out, tmp, rot);
  m4.fromRotation(rot, [0, 0, 1], deg2rad(k));
  m4.multiply(tmp, out, rot);
  return m4.copy(out, tmp);
}

function dist3(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Flatten an arc into a polyline.
 * Returns points as a flat array [x,y,z, x,y,z, ...] including both ends.
 */
export function flattenArc(from, to, center, plane, ccw, tolerance) {
  // Axis indices for the plane: [a, b, normal]
  const ax = plane === 18 ? [2, 0, 1] : plane === 19 ? [1, 2, 0] : [0, 1, 2];
  const [ia, ib, ic] = ax;

  const sa = from[ia] - center[ia];
  const sb = from[ib] - center[ib];
  const ea = to[ia] - center[ia];
  const eb = to[ib] - center[ib];
  const r = Math.hypot(sa, sb);
  if (!(r > 1e-9)) return [from[0], from[1], from[2], to[0], to[1], to[2]];

  let a0 = Math.atan2(sb, sa);
  let a1 = Math.atan2(eb, ea);
  let sweep = a1 - a0;
  if (ccw) {
    while (sweep <= 1e-12) sweep += Math.PI * 2;
  } else {
    while (sweep >= -1e-12) sweep -= Math.PI * 2;
  }
  // Coincident endpoints with a valid centre mean a full circle.
  if (Math.abs(dist3(from, to)) < 1e-9) sweep = ccw ? Math.PI * 2 : -Math.PI * 2;

  const tol = Math.max(tolerance, 1e-4);
  let stepAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  if (!Number.isFinite(stepAngle) || stepAngle <= 1e-6) stepAngle = 0.02;
  let n = Math.ceil(Math.abs(sweep) / stepAngle);
  n = Math.max(2, Math.min(n, 4096));

  const out = new Array((n + 1) * 3);
  const dc = to[ic] - from[ic];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + sweep * t;
    const p = [0, 0, 0];
    p[ia] = center[ia] + r * Math.cos(a);
    p[ib] = center[ib] + r * Math.sin(a);
    p[ic] = from[ic] + dc * t;
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  // Snap the last point so successive moves chain exactly.
  out[n * 3] = to[0];
  out[n * 3 + 1] = to[1];
  out[n * 3 + 2] = to[2];
  return out;
}

/**
 * Interpret a G-code program.
 *
 * @param {string} text
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 */
export function interpret(text, config = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    wcs: { ...DEFAULT_CONFIG.wcs, ...(config.wcs || {}) },
    controller: { ...DEFAULT_CONFIG.controller, ...(config.controller || {}) },
  };
  /**
   * Every source concatenated into one block list.
   *
   * A subprogram is a separate file but the same machine reads it, so it is
   * simplest to lay them end to end and let the program counter run through
   * the lot. Each block remembers which source it came from, and each
   * source ends in a sentinel that returns from the call that entered it —
   * which is also the implicit M99 at the end of a subprogram file.
   */
  // How this control spells its macros. Everything that reads a block goes
  // through here, so a machine set to Siemens reads Siemens everywhere —
  // its subprograms and its own M-code macros included.
  const dialect = resolveDialect(
    (cfg.controller && cfg.controller.dialect) || (cfg.controller && cfg.controller.flavour) || 'fanuc',
    cfg.controller && cfg.controller.syntax,
  );

  /**
   * Which control the program itself looks written for.
   *
   * Read against the wrong one it does not come out slightly wrong, it
   * comes out as a page of errors and no toolpath — so the question is
   * asked once, here, and the answer offered rather than acted on. A
   * machine whose spellings have been edited by hand is left alone: it has
   * already been told what it reads.
   */
  const looksLike = detectDialect(text);
  const suggested = looksLike && looksLike !== dialect.id
    && !(cfg.controller && cfg.controller.syntax) ? looksLike : null;

  const blocks = [];
  const appendSource = (src, body) => {
    const start = blocks.length;
    for (const b of lex(body, dialect)) {
      b.src = src;
      blocks.push(b);
    }
    blocks.push({ line: -1, raw: '', words: [], comments: [], src, endOfSource: true });
    return start;
  };
  appendSource(null, text);

  const st = new State(cfg);
  // Where rapid is not modal, what a bare block of coordinates means is a
  // feed move — including the first one, before any G word has been read.
  if (dialect.modalMotion === false) st.motion = 1;
  /** Which of U, V and W this machine reads as an axis word, and as what. */
  const extras = extraLetters(cfg);
  const auxLinear = new Set([...extras].filter(([, kind]) => kind === 'linear').map(([L]) => L));
  /** Rotary letters: the three by convention, plus whatever else turns. */
  const turning = ['A', 'B', 'C', ...[...extras].filter(([, k]) => k === 'rotary').map(([L]) => L)];

  const moves = [];
  const warnings = [];
  if (suggested) {
    warnings.push({
      line: 1,
      severity: 'warning',
      message: `This program is written for a ${DIALECTS[suggested].name}; this machine reads ${dialect.name}. Nearly everything below follows from that.`,
    });
  }
  const toolChanges = [];
  const events = [];

  /** Which source the block being read came from; null is the main program. */
  let curSrc = null;
  /** Control words already remarked on, so each is mentioned once. */
  const spokenFor = new Set();

  const warn = (line, message, severity = 'warning') => {
    if (warnings.length >= 500) return;
    const w = { line, message, severity };
    if (curSrc) w.source = curSrc;
    warnings.push(w);
  };

  // Subprogram files come after the main program, in the order given.
  //
  // A file answers to two things: the number it declares, the way Fanuc
  // counts programs, and the name it is saved under, the way most other
  // controls find one. Neither is required, and a file that has both can be
  // called either way.
  const subStarts = new Map();
  /** name (lower case, with and without its extension) -> where it starts. */
  const byName = new Map();
  const nameKey = (n) => String(n == null ? '' : n).trim().toLowerCase();
  const nameSource = (name, start) => {
    const key = nameKey(name);
    if (!key) return;
    if (!byName.has(key)) byName.set(key, start);
    const bare = key.replace(/\.[^.]+$/, '');
    if (bare && !byName.has(bare)) byName.set(bare, start);
  };
  for (const sub of cfg.subprograms || []) {
    if (!sub) continue;
    const start = appendSource(sub.name || `O${sub.number}`, sub.text || '');
    const n = Number(sub.number);
    if (Number.isFinite(n) && n > 0) subStarts.set(n, start);
    nameSource(sub.name, start);
  }

  // Index O-numbers for M98 subprogram calls. The label is the block after
  // the O word, so a call jumps straight into the body.
  const labels = new Map();
  const declaredIn = new Map();
  const clashed = new Set();
  blocks.forEach((b, idx) => {
    const o = b.words.find((w) => w.letter === 'O');
    if (!o) return;
    const source = b.src || 'the main program';
    if (labels.has(o.value)) {
      // Two files both called O1000 is a real mix-up on a control, and
      // silently running one of them is how the wrong pocket gets cut.
      if (declaredIn.get(o.value) !== source && !clashed.has(o.value)) {
        clashed.add(o.value);
        warn(b.line, `O${o.value} is in both ${declaredIn.get(o.value)} and ${source}; M98 will run the first.`);
      }
      return;
    }
    labels.set(o.value, idx + 1);
    declaredIn.set(o.value, source);
  });
  // A file that declares its own number answers to it, unless the main
  // program already has a label of its own with that number.
  for (const [n, start] of subStarts) if (!labels.has(n)) labels.set(n, start);

  /**
   * The name a block asks for, when it asks for one rather than a number.
   *
   * Three spellings, all of them in use: a name in brackets or quotes after
   * a call word (`CALL "ROUGH"`, `M98 <ROUGH>`), the name a Fanuc control
   * writes in the block's own comment (`M98 (ROUGH)`), and the bare name of
   * a file, which is a whole call on the controls that spell it that way.
   */
  const askedName = (b, { bare = false, comment = false } = {}) => {
    if (b.names && b.names.length) return b.names[0];
    if (comment && b.comments && b.comments.length) return b.comments[0];
    if (bare && b.idents && b.idents.length === 1) return b.idents[0];
    return null;
  };
  const namedTarget = (name) => (name === null ? undefined : byName.get(nameKey(name)));

  const push = (move) => {
    move.i = moves.length;
    if (curSrc) move.source = curSrc;
    moves.push(move);
    // Every move ends where the rotaries now are, so the next one starts
    // there. Leaving this to the blocks that carry an A/B/C word would make
    // each of them look like it swung all the way from the last angle.
    st.rotPrev = { ...st.rot };
    return move;
  };

  const emitLinear = (line, kind, target, feed) => {
    const from = st.pos.slice();
    const len = dist3(from, target);
    const rate = kind === 'rapid' ? cfg.rapidRate : Math.max(feed, 1e-6);
    const move = push({
      kind,
      line,
      from,
      to: target.slice(),
      path: [from[0], from[1], from[2], target[0], target[1], target[2]],
      rotFrom: { ...st.rotPrev },
      rotTo: { ...st.rot },
      tcp: st.tcp,
      feed: kind === 'rapid' ? cfg.rapidRate : feed,
      rpm: st.rpm,
      spindleDir: st.spindleDir,
      tool: st.tool,
      wcs: st.wcs,
      coolant: st.coolant,
      length: len,
      time: len > 0 ? (len / rate) * 60 : 0,
    });
    st.pos = target.slice();
    return move;
  };

  /**
   * @param {null|{from:number[], to:number[], center:number[]}} local
   *   When a tilted plane is active the arc is a circle only in that plane,
   *   so it is flattened there and the polyline brought out afterwards.
   */
  const emitArc = (line, target, center, ccw, feed, local = null) => {
    const from = st.pos.slice();
    let centre = center;
    let path;
    if (local) {
      const lp = flattenArc(local.from, local.to, local.center, st.plane, ccw, cfg.arcTolerance);
      path = new Array(lp.length);
      for (let i = 0; i < lp.length; i += 3) {
        const w = planeToWork([lp[i], lp[i + 1], lp[i + 2]]);
        path[i] = w[0];
        path[i + 1] = w[1];
        path[i + 2] = w[2];
      }
      centre = planeToWork(local.center);
    } else {
      path = flattenArc(from, target, center, st.plane, ccw, cfg.arcTolerance);
    }
    let len = 0;
    for (let i = 3; i < path.length; i += 3) {
      len += Math.hypot(path[i] - path[i - 3], path[i + 1] - path[i - 2], path[i + 2] - path[i - 1]);
    }
    const rate = Math.max(feed, 1e-6);
    const move = push({
      kind: 'arc',
      line,
      from,
      to: target.slice(),
      rotFrom: { ...st.rotPrev },
      rotTo: { ...st.rot },
      tcp: st.tcp,
      center: centre.slice(),
      plane: st.plane,
      ccw,
      path,
      feed,
      rpm: st.rpm,
      spindleDir: st.spindleDir,
      tool: st.tool,
      wcs: st.wcs,
      coolant: st.coolant,
      length: len,
      time: len > 0 ? (len / rate) * 60 : 0,
    });
    st.pos = target.slice();
    return move;
  };

  const emitDwell = (line, seconds) => {
    push({
      kind: 'dwell',
      line,
      from: st.pos.slice(),
      to: st.pos.slice(),
      rotFrom: { ...st.rot },
      rotTo: { ...st.rot },
      tcp: st.tcp,
      path: [st.pos[0], st.pos[1], st.pos[2], st.pos[0], st.pos[1], st.pos[2]],
      feed: 0,
      rpm: st.rpm,
      spindleDir: st.spindleDir,
      tool: st.tool,
      wcs: st.wcs,
      coolant: st.coolant,
      length: 0,
      time: Math.max(0, seconds),
    });
  };

  /**
   * Resolve the three linear axis words into work coordinates.
   *
   * With a tilted working plane in force the programmed point is expressed
   * in that plane, so it is transformed out of it before anything else sees
   * it — everything downstream keeps working in one frame.
   */
  const resolveLinear = (axis, metric, machineCoords) => {
    if (st.tilt && !machineCoords) {
      // The block is written in the plane's own frame, so the position is
      // tracked there too: a G91 delta is a step along the plane's axes,
      // and an arc's I/J are offsets in the plane. Keeping the local point
      // rather than re-deriving it from the machine position is what lets
      // arcs stay circles once the frame is tilted.
      const prev = st.tiltLocal;
      const local = [0, 1, 2].map((i) => {
        const w = [axis.X, axis.Y, axis.Z][i];
        const d = w === undefined ? undefined : toMM(w, metric);
        if (st.absolute) return d === undefined ? prev[i] : d;
        return prev[i] + (d === undefined ? 0 : d);
      });
      st.tiltLocalPrev = prev;
      st.tiltLocal = local;
      return planeToWork(local);
    }

    return [0, 1, 2].map((i) => {
      const w = [axis.X, axis.Y, axis.Z][i];
      if (w === undefined) return st.pos[i];
      const v = toMM(w, metric);
      if (machineCoords) return cfg.machineZero[i] + v;
      if (st.absolute) return st.offset()[i] + v;
      return st.pos[i] + v;
    });
  };

  /** A point in the active tilted plane, expressed in work coordinates. */
  const planeToWork = (local) => {
    const w = m4.transformPoint([0, 0, 0], st.tilt, local);
    const off = st.offset();
    return [w[0] + off[0], w[1] + off[1], w[2] + off[2]];
  };

  /** The reverse, used to pick up the current point when a plane is set. */
  const workToPlane = (pos) => {
    const off = st.offset();
    const rel = [pos[0] - off[0], pos[1] - off[1], pos[2] - off[2]];
    return m4.transformPoint([0, 0, 0], m4.invertRigid(m4.create(), st.tilt), rel);
  };

  /** Single-axis form, still needed by G28/G30 and the canned cycles. */
  const resolveAxis = (idx, word, metric, machineCoords) => {
    if (word === undefined) return st.pos[idx];
    const v = toMM(word, metric);
    if (machineCoords) return cfg.machineZero[idx] + v;
    if (st.absolute) return st.offset()[idx] + v;
    return st.pos[idx] + v;
  };

  /**
   * Apply A/B/C and any U/V/W words to the axes that are not the tool tip.
   *
   * Rotaries are in degrees whatever G20/G21 says; an extra linear slide is
   * in program units like any other length, so it goes through toMM.
   */
  const applyExtraAxes = (axis) => {
    st.rotPrev = { ...st.rot };
    let moved = false;
    for (const L of turning) {
      if (axis[L] === undefined) continue;
      st.rot[L] = st.absolute ? axis[L] : st.rot[L] + axis[L];
      moved = true;
    }
    for (const L of auxLinear) {
      if (axis[L] === undefined) continue;
      const v = toMM(axis[L], st.metric);
      st.rot[L] = st.absolute ? v : st.rot[L] + v;
      moved = true;
    }
    return moved;
  };

  // ---- macro variables ---------------------------------------------------
  //
  // #1 to #33 belong to whichever macro call is running; #100 and up belong
  // to the program. Everything that reads a number can read one of these,
  // which is what makes a family of parts one program instead of twenty.

  const vars = new Vars(dialect.locals);

  /**
   * What the tool table says, in the units the program is asking in.
   *
   * Pot 0 is whatever is in the spindle, which is what a program means by
   * TLENGTH 00 straight after a tool change. A pot nothing is set up in
   * answers zero, and a program that guards on that — "if the tool is
   * shorter than a tenth, go to the alarm" — then takes the branch it
   * would on a machine with an empty pot, which is the honest answer.
   */
  vars.table = (what, index) => {
    const table = cfg.tools || {};
    const asked = Math.round(Number(index) || 0);
    const pot = asked > 0 ? asked : (st.tool || st.pendingTool || 0);
    const entry = table[pot];
    const mm = entry ? Number(entry[what]) || 0 : 0;
    return st.metric ? mm : mm / MM_PER_INCH;
  };

  // Registers the machine holds between programs, and what the operator
  // dialled into them. A Fidia branches on one — $IF (RG 50 != 5) — so a
  // program is unreadable without a way to say what RG 50 is: a machine
  // parameter whose name is a number is that register.
  for (const [key, value] of Object.entries(cfg.parameters || {})) {
    const n = Number(key);
    if (Number.isInteger(n) && n > 0 && Number.isFinite(Number(value))) vars.set(n, Number(value));
  }

  /**
   * Where a jump goes, within the source that asked for it.
   *
   * Controls that count lines look for an N number; controls that name
   * their labels look for the name. Which of the two is the dialect's
   * business, so both live here.
   */
  const labelCache = new Map();
  const findLabel = (from, target) => {
    const key = `${from.src || ''}\u0000${target}`;
    if (labelCache.has(key)) return labelCache.get(key);
    const named = typeof target === 'string';
    let found = -1;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if ((b.src || null) !== (from.src || null)) continue;
      if (named) {
        if (b.macro && b.macro.label && b.macro.label.toUpperCase() === target.toUpperCase()) { found = i; break; }
        continue;
      }
      if (!b.words) continue;
      const label = b.words.find((w) => w.letter === 'N');
      if (label && Math.round(label.value) === Math.round(target)) { found = i; break; }
    }
    labelCache.set(key, found);
    return found;
  };

  /**
   * The block that closes a loop, and the one that opened it.
   *
   * Controls disagree about the words — END 1, ENDWHILE, ENDFOR, UNTIL —
   * but every one of them is a head and a tail with a nesting level
   * between, so the pairing is one piece of code over a small table.
   */
  const TAIL_OF = { while: 'end', do: 'end', for: 'end-for', repeat: 'until' };
  const HEADS_OF = { end: ['while', 'do'], 'end-for': ['for'], until: ['repeat'] };

  const loopCache = new Map();
  const matchLoop = (idx, forward) => {
    const key = `${idx}:${forward}`;
    if (loopCache.has(key)) return loopCache.get(key);
    const from = blocks[idx];
    const control = from.macro.control;
    const level = control.level || 0;
    const tail = forward ? TAIL_OF[control.kind] : control.kind;
    const heads = forward ? Object.keys(TAIL_OF).filter((k) => TAIL_OF[k] === tail) : HEADS_OF[control.kind] || [];
    let depth = 0;
    let found = -1;

    for (let i = idx + (forward ? 1 : -1); forward ? i < blocks.length : i >= 0; i += forward ? 1 : -1) {
      const b = blocks[i];
      if ((b.src || null) !== (from.src || null) || !b.macro || !b.macro.control) continue;
      const c = b.macro.control;
      if ((c.level || 0) !== level) continue;
      const isHead = heads.includes(c.kind);
      const isTail = c.kind === tail;
      if (forward ? isHead : isTail) depth++;
      else if (forward ? isTail : isHead) {
        if (depth === 0) { found = i; break; }
        depth--;
      }
    }
    loopCache.set(key, found);
    return found;
  };

  const callStack = [];
  let pc = 0;
  let executed = 0;
  let ended = false;

  // ---- macros ------------------------------------------------------------
  //
  // A macro is a scrap of G-code the machine runs when it meets its code. It
  // is expanded at the call — the body can mention the T word of the block
  // that called it — and the result is appended to the block list, so from
  // there on it is read exactly like any other program.

  const macroByCode = new Map();
  for (const mac of cfg.macros || []) {
    if (!mac || mac.enabled === false) continue;
    if (!String(mac.body || '').trim()) continue;
    const code = normaliseCode(mac.code);
    if (code) macroByCode.set(code, mac);
  }
  /** Expanded bodies, so a hundred tool changes to the same pot cost one. */
  const macroCache = new Map();
  /** Queued by the block that asked for them, run before the next block. */
  const pendingMacros = [];

  const expandInto = (mac, code, vars, line) => {
    const missing = [];
    const body = expandMacro(mac.body, vars, (name) => {
      if (!missing.includes(name)) missing.push(name);
    });
    if (missing.length) {
      warn(line, `${code} macro: nothing is set for ${missing.map((n) => `#${n}`).join(', ')}, read as 0.`);
    }
    const key = `${mac.id}\u0000${body}`;
    if (macroCache.has(key)) return macroCache.get(key);
    const start = appendSource(`${code} macro`, body);
    macroCache.set(key, start);
    return start;
  };

  /** A macro that is already running does not call itself again. */
  const macroRunning = (code) => callStack.some((f) => f.macro === code);

  /** Pop one call frame, whether it came from M98, a macro or the file end. */
  const returnFromCall = () => {
    const frame = callStack.pop();
    if (!frame) {
      ended = true;
      return;
    }
    if (frame.remaining > 0) {
      frame.remaining--;
      callStack.push(frame);
      pc = frame.target;
    } else {
      pc = frame.ret;
      // The call's own #1 to #33 go with it, which is what lets one macro
      // call another without the two treading on each other.
      if (frame.macroVars) vars.pop();
      if (frame.metricWas !== undefined) st.metric = frame.metricWas;
      if (frame.resumeEnded) ended = true;
    }
  };

  while (pc < blocks.length) {
    // A macro queued by the block just read runs before the next one — and
    // before the program is allowed to end, so an M30 macro can park the
    // machine on its way out.
    if (pendingMacros.length) {
      const call = pendingMacros.shift();
      if (callStack.length > 16) {
        warn(call.line, `${call.code} macro: nesting too deep.`, 'error');
      } else {
        // An M30 macro runs with the program already ended, so the end is
        // held on the frame and restored when the macro returns.
        //
        // And it runs in the machine's own units. The body is the machine
        // builder's, written in the millimetres its positions are kept in;
        // the program's G20 has nothing to do with it. Reading a tool
        // change position of −320 as −320 inches sends the machine eight
        // metres out, which is what it did.
        callStack.push({
          ret: pc,
          remaining: 0,
          target: call.start,
          macro: call.code,
          resumeEnded: ended,
          metricWas: st.metric,
        });
        st.metric = true;
        ended = false;
        pc = call.start;
      }
      continue;
    }
    if (ended) break;

    executed++;
    if (executed > cfg.maxBlocks) {
      warn(blocks[pc].line, 'Aborted: block limit reached (runaway subprogram loop?).', 'error');
      break;
    }

    const b = blocks[pc];
    pc++;
    curSrc = b.src || null;

    // The end of a subprogram or a macro returns to whatever called it; the
    // end of the main program is the end of the run.
    if (b.endOfSource) {
      returnFromCall();
      continue;
    }

    // ---- macro arithmetic and control flow -------------------------------
    if (b.macro) {
      try {
        // A word's value may be an expression: G1 X[#100 + 2].
        for (const w of b.words) if (w.expr) w.value = evaluate(w.expr, vars);
        for (const a of b.macro.assigns) vars.set(evaluate(a.target, vars), evaluate(a.value, vars));

        const c = b.macro.control;
        if (c) {
          if (c.kind === 'goto' || (c.kind === 'if-goto' && evaluate(c.cond, vars))) {
            const target = c.label !== undefined ? c.label : evaluate(c.target, vars);
            const at = findLabel(b, target);
            if (at < 0) {
              warn(b.line, typeof target === 'string'
                ? `There is no label called ${target} in this program.`
                : `GOTO N${target}: there is no such line in this program.`, 'error');
              continue;
            }
            pc = at;
            continue;
          }
          if (c.kind === 'if-goto') continue;              // the condition was false
          if (c.kind === 'if-then') {
            if (evaluate(c.cond, vars)) vars.set(evaluate(c.assign.target, vars), evaluate(c.assign.value, vars));
            continue;
          }
          if (c.kind === 'while' || c.kind === 'do') {
            // Look for the END first, whatever the condition says. A loop
            // that never closes is wrong even on the pass where the test
            // happens to be true, and saying so then is the point.
            const end = matchLoop(pc - 1, true);
            if (end < 0) {
              warn(b.line, `${c.kind === 'do' ? 'DO' : 'WHILE ... DO'} ${c.level} has no END ${c.level}.`, 'error');
              continue;
            }
            if (c.kind === 'do' || evaluate(c.cond, vars)) continue;   // into the body
            pc = end + 1;
            continue;
          }
          if (c.kind === 'end') {
            const head = matchLoop(pc - 1, false);
            if (head < 0) { warn(b.line, 'This loop is closed but never opened.', 'error'); continue; }
            pc = head;
            continue;
          }

          // FOR runs its counter from where it starts to where it ends.
          // The head sets the counter; the tail counts and comes back.
          if (c.kind === 'for') {
            const end = matchLoop(pc - 1, true);
            if (end < 0) { warn(b.line, 'FOR has no ENDFOR.', 'error'); continue; }
            vars.set(evaluate(c.counter.target, vars), evaluate(c.counter.value, vars));
            if (vars.get(evaluate(c.counter.target, vars)) > evaluate(c.last, vars)) pc = end + 1;
            continue;
          }
          if (c.kind === 'end-for') {
            const head = matchLoop(pc - 1, false);
            if (head < 0) { warn(b.line, 'ENDFOR has no FOR above it.', 'error'); continue; }
            const forControl = blocks[head].macro.control;
            const n = evaluate(forControl.counter.target, vars);
            vars.set(n, vars.get(n) + 1);
            if (vars.get(n) <= evaluate(forControl.last, vars)) pc = head + 1;
            continue;
          }

          // REPEAT runs its body and then asks whether to go round again.
          if (c.kind === 'repeat') {
            if (matchLoop(pc - 1, true) < 0) { warn(b.line, 'REPEAT has no UNTIL.', 'error'); }
            continue;
          }
          if (c.kind === 'until') {
            const head = matchLoop(pc - 1, false);
            if (head < 0) { warn(b.line, 'UNTIL has no REPEAT above it.', 'error'); continue; }
            if (!evaluate(c.cond, vars)) pc = head + 1;
            continue;
          }
        }
      } catch (err) {
        warn(b.line, `Macro: ${err.message}.`, 'error');
        continue;
      }
    }

    if (b.blockDelete) {
      b.skipped = true;
      continue;
    }
    // ---- a call written as a name ----------------------------------------
    //
    // Not every control counts its programs. Siemens writes CALL "ROUGH";
    // some controls write the name of the file and nothing else. Either way
    // the block is a call, and what it calls is a file this machine holds.
    if ((b.macro && b.macro.call) || (!b.words.length && !(b.macro && b.macro.control))) {
      const name = askedName(b, { bare: true });
      const target = namedTarget(name);
      if (target !== undefined) {
        if (callStack.length > 16) { warn(b.line, 'Subprogram nesting too deep.', 'error'); continue; }
        callStack.push({ ret: pc, remaining: 0, target });
        pc = target;
        continue;
      }
      if (name !== null && ((b.macro && b.macro.call) || (b.names && b.names.length))) {
        warn(b.line, `There is no subprogram called ${name}.`, 'error');
        continue;
      }
    }

    // ---- a command written as a word --------------------------------------
    //
    // RTCP ON, ORIGIN 4. Controls that spell these as words rather than as
    // G codes are not doing anything unusual by it, so they are read here
    // and mean what the G codes mean.
    if (b.command) {
      const { name, text, value } = b.command;
      const arg = String(text || '').trim().toUpperCase();
      if (name === 'RTCP' && dialect.rtcp) {
        const on = arg === 'ON' || arg === '1';
        if (on !== (st.tcp !== 0)) {
          events.push({
            line: b.line, type: 'tcp', moveIndex: moves.length,
            text: on ? 'Tool centre point control on (RTCP ON)' : 'Tool centre point control off (RTCP OF)',
          });
        }
        st.tcp = on ? 4 : 0;
      } else if (name === 'ORIGIN') {
        const key = `G${53 + (value || 0)}`;
        if (value >= 1 && cfg.wcs[key]) {
          st.wcs = key;
          events.push({ line: b.line, type: 'wcs', moveIndex: moves.length, text: `ORIGIN ${value} (read as ${key})` });
        } else {
          warn(b.line, `ORIGIN ${value === null ? '' : value} has no work offset behind it; the offsets this reader holds are G54 to G59.`);
        }
      } else if (!spokenFor.has(name)) {
        // The compensation switches. They change what the control does to
        // the numbers, not what the numbers are, so the path is the path —
        // said once rather than on every block that carries one.
        spokenFor.add(name);
        warn(b.line, `${name} is a control setting this reader does not model; the toolpath is read as written.`);
      }
      continue;
    }

    if (b.error) warn(b.line, b.error, 'error');
    else if (b.idents && b.idents.length) {
      // A word that is not a call and not an address is a typo — the one
      // thing a reader must never pass over in silence.
      warn(b.line, `Unrecognised text: ${b.idents.join(' ').slice(0, 24)}`, 'error');
    }
    if (!b.words.length) continue;
    // Bucket the words for this block.
    const g = [];
    const m = [];
    const axis = {};
    let f, s, t, h, d, p, q, r, l, iArc, jArc, kArc;
    let machineCoords = false;

    for (const w of b.words) {
      switch (w.letter) {
        case 'G': g.push(w.value); break;
        case 'M': m.push(w.value); break;
        case 'X': case 'Y': case 'Z': case 'A': case 'B': case 'C': axis[w.letter] = w.value; break;
        case 'U': case 'V': case 'W': if (extras.has(w.letter)) axis[w.letter] = w.value; break;
        // Which way the tool points, on a control that says so directly.
        case 'DX': case 'DY': case 'DZ': axis[w.letter] = w.value; break;
        case 'I': iArc = w.value; break;
        case 'J': jArc = w.value; break;
        case 'K': kArc = w.value; break;
        case 'F': f = w.value; break;
        case 'S': s = w.value; break;
        case 'T': t = w.value; break;
        case 'H': h = w.value; break;
        case 'D': d = w.value; break;
        case 'P': p = w.value; break;
        case 'Q': q = w.value; break;
        case 'R': r = w.value; break;
        case 'L': l = w.value; break;
        default: break;
      }
    }

    // A control that writes its pot number after a decimal point — T0.07,
    // T.05, T0.7 are pots 7, 5 and 7 — means the same thing by it as T7
    // does elsewhere. Read from the digits rather than from the value: 0.7
    // and 0.07 are not the same number but are the same pot, and taking
    // the value times a hundred made one of them pot 70.
    if (t !== undefined && dialect.toolDecimal) {
      const word = b.words.find((w) => w.letter === 'T');
      const parts = word && /^[Tt]\s*(\d*)\.(\d*)$/.exec(word.text.replace(/\s+/g, ''));
      if (parts) {
        const whole = Number(parts[1] || 0);
        t = whole > 0 ? whole : Number(parts[2] || 0);
      }
    }

    // ---- Non-modal and modal G codes -------------------------------------
    let motionThisBlock = null;
    let g28 = false, g30 = false, g10 = false, g92set = false, g92clear = false;
    /** Set by codes whose X/Y/Z words are data, not a destination. */
    let axesConsumed = false;

    for (const code of g) {
      switch (code) {
        case 0: case 1: case 2: case 3:
          motionThisBlock = code;
          // Where rapid and the arcs last one block, what they leave behind
          // is the feed move — so the next bare block of coordinates is a
          // G1 rather than another rapid across the part.
          st.motion = dialect.modalMotion === false && code !== 1 ? 1 : code;
          break;
        case 4: {
          const secs = axis.X !== undefined
            ? axis.X
            : p !== undefined
              ? (cfg.dwellPUnits === 'ms' ? p / 1000 : p)
              : 0;
          emitDwell(b.line, secs);
          break;
        }
        case 10: g10 = true; break;
        case 17: st.plane = 17; break;
        case 18: st.plane = 18; break;
        case 19: st.plane = 19; break;
        case 20: st.metric = false; break;
        case 21: st.metric = true; break;
        case 28: g28 = true; break;
        case 30: g30 = true; break;
        case 40: st.cutterComp = 40; break;
        case 41: case 42:
          if (st.cutterComp !== code) warn(b.line, `Cutter compensation G${code} is acknowledged but not applied; the simulated path is the programmed centreline.`);
          st.cutterComp = code;
          break;
        case 43.4:
        case 43.5:
          st.lengthComp = true;
          st.tcp = code === 43.4 ? 4 : 5;
          events.push({ line: b.line, type: 'tcp', moveIndex: moves.length, text: `Tool centre point control on (G${code})` });
          break;
        case 53.1: {
          // Orient the tool normal to the tilted plane. The rotary values
          // are solved against the machine, so this needs one to be loaded.
          if (!st.tilt) {
            warn(b.line, 'G53.1 without an active G68.2 plane; nothing to align to.', 'error');
            break;
          }
          const normal = m4.normalize(m4.transformDir([0, 0, 0], st.tilt, [0, 0, 1]));
          if (!cfg.kinematics || !cfg.kinematics.rotaries().length) {
            warn(b.line, 'G53.1 needs a machine with rotary axes; load a 5-axis machine in Setup.', 'error');
            break;
          }
          const sol = cfg.kinematics.rotariesForToolAxis(normal, st.rot, cfg.gaugeLength || 0);
          if (!sol) {
            warn(b.line, `G53.1 cannot reach a tool axis of ${normal.map((v) => v.toFixed(3)).join(', ')} within the machine's travel.`, 'error');
            break;
          }
          st.rotPrev = { ...st.rot };
          Object.assign(st.rot, sol);
          events.push({
            line: b.line, type: 'align', moveIndex: moves.length,
            text: `G53.1 aligned the tool: ${Object.entries(sol).map(([k, v]) => `${k}${v.toFixed(3)}`).join(' ')}`,
          });
          // A rotary-only move, so the machine actually swings there.
          emitLinear(b.line, 'rapid', st.pos.slice(), cfg.rapidRate);
          break;
        }
        case 68.2: {
          // A control with RTCP does not have a tilted plane at all; it
          // holds the tip still and lets the program say where the tool
          // points. Read it anyway — a program pasted from another machine
          // is still worth looking at — but say so.
          if (dialect.rtcp) warn(b.line, `A ${dialect.name} has no tilted working plane; on this control RTCP ON and a tool vector do that job.`);
          const origin = [
            axis.X !== undefined ? toMM(axis.X, st.metric) : 0,
            axis.Y !== undefined ? toMM(axis.Y, st.metric) : 0,
            axis.Z !== undefined ? toMM(axis.Z, st.metric) : 0,
          ];
          const mode = p === 2 ? 2 : 1;
          // X/Y/Z here are where the plane sits, not somewhere to go.
          axesConsumed = true;
          st.tilt = tiltedPlaneMatrix(origin, iArc || 0, jArc || 0, kArc || 0, mode);
          // Carry the current point into the new frame so the first block
          // in the plane can leave any axis word out.
          st.tiltLocal = workToPlane(st.pos);
          st.tiltLocalPrev = st.tiltLocal;
          events.push({
            line: b.line, type: 'plane', moveIndex: moves.length,
            text: `G68.2 tilted plane at ${origin.join(', ')} (${mode === 2 ? 'RPY' : 'Euler ZXZ'} ${iArc || 0}, ${jArc || 0}, ${kArc || 0})`,
          });
          break;
        }
        case 69:
          if (st.tilt) events.push({ line: b.line, type: 'plane', moveIndex: moves.length, text: 'G69 tilted plane cancelled' });
          st.tilt = null;
          break;
        case 43:
          st.lengthComp = true;
          st.hNumber = h !== undefined ? h : st.hNumber;
          if (h === undefined) warn(b.line, 'G43 without an H word; the control would use the last offset.', 'error');
          else if (st.tool && h !== st.tool) warn(b.line, `G43 H${h} does not match the active tool T${st.tool}. On the machine this is a length-offset crash.`, 'error');
          break;
        case 44: st.lengthComp = true; st.hNumber = h !== undefined ? h : st.hNumber; break;
        case 49:
          st.lengthComp = false;
          st.hNumber = 0;
          if (st.tcp) events.push({ line: b.line, type: 'tcp', moveIndex: moves.length, text: 'Tool centre point control off (G49)' });
          st.tcp = 0;
          break;
        case 65: {
          // A macro call: the block's letters become #1 to #26 inside it,
          // which is why its X, Y and Z are arguments rather than a move.
          const name = askedName(b, { comment: p === undefined });
          if (p === undefined && name === null) { warn(b.line, 'G65 without a macro to call.', 'error'); break; }
          const target = p !== undefined ? labels.get(p) : namedTarget(name);
          if (target === undefined) { warn(b.line, `Macro ${p !== undefined ? `O${p}` : name} not found.`, 'error'); break; }
          if (callStack.length > 16) { warn(b.line, 'Macro calls nested too deep.', 'error'); break; }
          const args = [];
          for (const w of b.words) {
            const n = ARGUMENTS[w.letter];
            if (n) args.push([n, w.value]);
          }
          vars.push(args);
          callStack.push({ ret: pc, remaining: Math.max(1, Math.floor(l ?? 1)) - 1, target, macroVars: true });
          pc = target;
          axesConsumed = true;
          break;
        }
        case 53: machineCoords = true; break;
        case 54: case 55: case 56: case 57: case 58: case 59: st.wcs = `G${code}`; break;
        case 61: case 61.1: case 64: break;
        case 80:
          motionThisBlock = 80;
          // Where motion is not modal, cancelling a canned cycle does not
          // leave the machine in "no motion" — the next block of
          // coordinates is a feed move. Every Fidia program opens with a
          // safety line that says G80 and then starts moving.
          st.motion = dialect.modalMotion === false ? 1 : 80;
          break;
        case 90: st.absolute = true; break;
        case 90.1: st.arcAbsolute = true; break;
        case 91: st.absolute = false; break;
        case 91.1: st.arcAbsolute = false; break;
        case 92:
          // On a control with a vector mode this is where it starts: the
          // block carries the direction the tool points and the control
          // works out the rotaries. Everywhere else it is a coordinate
          // shift, which is a different thing entirely.
          if (dialect.vectorMode && dialect.vectorMode.on === 92) {
            if (!st.vector) events.push({ line: b.line, type: 'plane', moveIndex: moves.length, text: 'G92 tool-vector mode on' });
            st.vector = true;
          } else g92set = true;
          break;
        case 92.1: case 92.2: g92clear = true; break;
        case 93:
          if (dialect.vectorMode && dialect.vectorMode.off === 93) {
            if (st.vector) events.push({ line: b.line, type: 'plane', moveIndex: moves.length, text: 'G93 tool-vector mode off' });
            st.vector = false;
          } else st.feedMode = 93;
          break;
        case 94: st.feedMode = 94; break;
        case 95: st.feedMode = 95; break;
        case 98: st.retractMode = 98; break;
        case 99: st.retractMode = 99; break;
        default:
          if (MOTION_CYCLES.has(code)) {
            motionThisBlock = code;
            st.motion = code;
          } else {
            warn(b.line, `Unsupported G${code} ignored.`);
          }
      }
    }

    if (f !== undefined) st.feed = toMM(f, st.metric);
    if (s !== undefined) st.rpm = s;
    if (t !== undefined) st.pendingTool = t;

    // ---- M codes ---------------------------------------------------------
    for (const code of m) {
      // What this machine does at this code, if its builder said. It runs
      // after the block, so the control has already recorded the tool
      // change or the spindle state the macro is there to carry out.
      const mac = macroByCode.get(`M${code}`);
      if (mac && !macroRunning(`M${code}`)) {
        pendingMacros.push({
          code: `M${code}`,
          line: b.line,
          start: expandInto(mac, `M${code}`, {
            ...(cfg.parameters || {}),
            M: code,
            T: t !== undefined ? t : st.pendingTool || st.tool,
            S: s !== undefined ? s : st.rpm,
            P: p,
            Q: q,
            R: r,
            H: h,
            D: d,
          }, b.line),
        });
      }

      switch (code) {
        case 0: case 1:
          events.push({ line: b.line, type: 'stop', moveIndex: moves.length, text: code === 0 ? 'Program stop (M00)' : 'Optional stop (M01)' });
          break;
        case 2: case 30:
          ended = true;
          events.push({ line: b.line, type: 'end', moveIndex: moves.length, text: `Program end (M${code === 30 ? '30' : '02'})` });
          break;
        case 3: st.spindleDir = 1; break;
        case 4: st.spindleDir = -1; break;
        case 5: st.spindleDir = 0; break;
        case 6: {
          const next = t !== undefined ? t : st.pendingTool;
          if (!next) { warn(b.line, 'M06 without a T word.', 'error'); break; }
          st.tool = next;
          toolChanges.push({ line: b.line, tool: next, moveIndex: moves.length });
          events.push({ line: b.line, type: 'toolchange', moveIndex: moves.length, tool: next, text: `Tool change T${next}` });
          break;
        }
        case 7: st.coolant = 'mist'; break;
        case 8: st.coolant = 'flood'; break;
        case 9: st.coolant = 'off'; break;
        case 98: {
          // P1000 on a Fanuc, a name on everything else — and on a Fanuc
          // too, when the file has one: M98 <ROUGH> and M98 (ROUGH).
          const name = askedName(b, { comment: p === undefined });
          const target = p !== undefined ? labels.get(p) : namedTarget(name);
          if (p === undefined && name === null) { warn(b.line, 'M98 without a program to call.', 'error'); break; }
          if (target === undefined) {
            warn(b.line, p !== undefined
              ? `Subprogram O${p} not found — no label in this program and no subprogram file with that number.`
              : `Subprogram ${name} not found — no file of that name is loaded.`, 'error');
            break;
          }
          const repeats = Math.max(1, Math.floor(l ?? 1));
          if (callStack.length > 16) { warn(b.line, 'Subprogram nesting too deep.', 'error'); break; }
          callStack.push({ ret: pc, remaining: repeats - 1, target });
          pc = target;
          break;
        }
        // M99 on a Fanuc, M17 on a Siemens and most of Europe: both mean
        // "that is the end of this subprogram, go back to what called it".
        case 17: case 99: returnFromCall(); break;
        default:
          events.push({ line: b.line, type: 'm', moveIndex: moves.length, text: `M${code}` });
      }
    }

    // Round the loop rather than out of it: M30 ends the program, but a
    // macro queued by that same block still has to park the machine.
    if (ended) continue;

    // ---- G10 work offset programming ------------------------------------
    if (g10) {
      const lVal = l ?? 2;
      if (lVal === 2 && p !== undefined) {
        const key = `G${53 + p}`;
        if (cfg.wcs[key]) {
          const cur = cfg.wcs[key];
          cfg.wcs[key] = [
            axis.X !== undefined ? toMM(axis.X, st.metric) : cur[0],
            axis.Y !== undefined ? toMM(axis.Y, st.metric) : cur[1],
            axis.Z !== undefined ? toMM(axis.Z, st.metric) : cur[2],
          ];
          events.push({ line: b.line, type: 'offset', moveIndex: moves.length, text: `G10 set ${key}` });
        }
      }
      continue;
    }

    if (g92clear) st.g92 = [0, 0, 0];
    if (g92set) {
      // G92 makes the current position read as the given value.
      const want = [
        axis.X !== undefined ? toMM(axis.X, st.metric) : null,
        axis.Y !== undefined ? toMM(axis.Y, st.metric) : null,
        axis.Z !== undefined ? toMM(axis.Z, st.metric) : null,
      ];
      const w = cfg.wcs[st.wcs] || [0, 0, 0];
      for (let i = 0; i < 3; i++) if (want[i] !== null) st.g92[i] = st.pos[i] - w[i] - want[i];
      warn(b.line, 'G92 offset applied; verify against your control.');
      continue;
    }

    // ---- G28 / G30 reference return -------------------------------------
    if (g28 || g30) {
      const home = g30 ? cfg.g30 : cfg.machineZero;
      const hasAxis = axis.X !== undefined || axis.Y !== undefined || axis.Z !== undefined;
      if (hasAxis) {
        const mid = [
          axis.X !== undefined ? resolveAxis(0, axis.X, st.metric, false) : st.pos[0],
          axis.Y !== undefined ? resolveAxis(1, axis.Y, st.metric, false) : st.pos[1],
          axis.Z !== undefined ? resolveAxis(2, axis.Z, st.metric, false) : st.pos[2],
        ];
        // "G91 G28 Z0" — the usual way of writing "retract" — names an
        // intermediate point that is where the machine already is. A real
        // control goes straight home; emitting a zero-length rapid for it
        // only puts a move in the list that nothing can see.
        if (dist3(st.pos, mid) > 1e-9) emitLinear(b.line, 'rapid', mid, cfg.rapidRate);
      }
      const target = [
        axis.X !== undefined ? home[0] : st.pos[0],
        axis.Y !== undefined ? home[1] : st.pos[1],
        axis.Z !== undefined ? home[2] : st.pos[2],
      ];
      if (!hasAxis) { target[0] = home[0]; target[1] = home[1]; target[2] = home[2]; }
      emitLinear(b.line, 'rapid', target, cfg.rapidRate);
      continue;
    }

    // ---- Motion ----------------------------------------------------------
    if (axesConsumed) continue;
    const hasAxisWord = axis.X !== undefined || axis.Y !== undefined || axis.Z !== undefined;
    const motion = motionThisBlock !== null ? motionThisBlock : st.motion;

    if (MOTION_CYCLES.has(motion)) {
      if (r !== undefined) st.cycleR = st.absolute ? st.offset()[2] + toMM(r, st.metric) : st.pos[2] + toMM(r, st.metric);
      if (axis.Z !== undefined) st.cycleZ = resolveAxis(2, axis.Z, st.metric, false);
      if (q !== undefined) st.cycleQ = toMM(q, st.metric);
      if (p !== undefined) st.cycleP = p;
      st.cycleF = st.feed;
      if (hasAxisWord || axis.X !== undefined || axis.Y !== undefined) {
        if (!MOTION_CYCLES.has(motion) || ![73, 81, 82, 83, 85, 89].includes(motion)) {
          warn(b.line, `G${motion} is simulated as a plain drilling cycle; spindle reversal and boring shifts are not modelled.`);
        }
        if (!st.absolute) warn(b.line, 'Incremental (G91) canned cycles use the R and Z planes captured at the first hole.');
        const reps = Math.max(1, Math.floor(l ?? 1));
        const dx = axis.X !== undefined ? toMM(axis.X, st.metric) : 0;
        const dy = axis.Y !== undefined ? toMM(axis.Y, st.metric) : 0;
        for (let rep = 0; rep < reps; rep++) {
          const hx = st.absolute
            ? (axis.X !== undefined ? st.offset()[0] + dx : st.pos[0])
            : st.pos[0] + dx;
          const hy = st.absolute
            ? (axis.Y !== undefined ? st.offset()[1] + dy : st.pos[1])
            : st.pos[1] + dy;
          runCycle(motion, b.line, hx, hy);
        }
      }
      continue;
    }

    const hasRotaryWord = turning.some((L) => axis[L] !== undefined)
      || [...auxLinear].some((L) => axis[L] !== undefined);

    // ---- the tool vector, where the control reads one ---------------------
    //
    // In vector mode the block says which way the tool points and the
    // control works out the angles that produce it. That is the same solve
    // G53.1 does against a tilted plane, so it is the same code: a
    // direction in, the machine's own rotaries out.
    let turnedByVector = false;
    const hasVector = axis.DX !== undefined || axis.DY !== undefined || axis.DZ !== undefined;
    if (hasVector && !st.vector) {
      warn(b.line, 'DX/DY/DZ outside vector mode; the tool direction was ignored.');
    } else if (hasVector) {
      const v = [axis.DX || 0, axis.DY || 0, axis.DZ || 0];
      const len = Math.hypot(v[0], v[1], v[2]);
      if (len < 1e-9) {
        warn(b.line, 'Tool vector of zero length; the direction was ignored.', 'error');
      } else if (!cfg.kinematics || !cfg.kinematics.rotaries().length) {
        warn(b.line, 'A tool vector needs a machine with rotary axes; load one on the Machine tab.', 'error');
      } else {
        const sol = cfg.kinematics.rotariesForToolAxis(
          [v[0] / len, v[1] / len, v[2] / len], st.rot, cfg.gaugeLength || 0,
        );
        if (!sol) {
          warn(b.line, `No rotary position reaches a tool vector of ${v.map((x) => (x / len).toFixed(3)).join(', ')} within the machine's travel.`, 'error');
        } else {
          st.rotPrev = { ...st.rot };
          Object.assign(st.rot, sol);
          turnedByVector = true;
        }
      }
    }

    if (hasRotaryWord) applyExtraAxes(axis);

    if (motion === 80 || (!hasAxisWord && !hasRotaryWord && !turnedByVector)) {
      if (hasAxisWord && motion === 80) warn(b.line, 'Axis words with G80 are ignored.');
      continue;
    }

    if (!hasAxisWord && (hasRotaryWord || turnedByVector)) {
      // A rotary-only block still moves the machine, and on a table machine
      // it moves the tool relative to the part.
      emitLinear(b.line, motion === 0 ? 'rapid' : 'feed', st.pos.slice(), st.feed > 0 ? st.feed : 100);
      continue;
    }

    const target = resolveLinear(axis, st.metric, machineCoords);

    if (motion === 0) {
      emitLinear(b.line, 'rapid', target, cfg.rapidRate);
    } else if (motion === 1) {
      if (!(st.feed > 0)) warn(b.line, 'Feed move with no active F word; assuming 100 mm/min.', 'error');
      emitLinear(b.line, 'feed', target, st.feed > 0 ? st.feed : 100);
    } else if (motion === 2 || motion === 3) {
      const ccw = motion === 3;
      const feed = st.feed > 0 ? st.feed : 100;
      const words = { i: iArc, j: jArc, k: kArc, r };
      const tilted = st.tilt && !machineCoords;
      const from = tilted ? st.tiltLocalPrev : st.pos;
      const to = tilted ? st.tiltLocal : target;
      const center = arcCentre(b.line, to, words, warn, from, tilted ? [0, 0, 0] : null, ccw);
      if (!center) {
        emitLinear(b.line, 'feed', target, feed);
      } else if (tilted) {
        emitArc(b.line, target, center, ccw, feed, { from, to, center });
      } else {
        emitArc(b.line, target, center, ccw, feed);
      }
    }
  }

  /**
   * Compute an arc centre from IJK or R for the current plane.
   *
   * `p0` and `target` are in whatever frame the block was written in — work
   * coordinates normally, the tilted plane's own frame under G68.2 — and
   * `absBase` is where an absolute centre (G90.1) is measured from in that
   * same frame.
   */
  function arcCentre(line, target, words, warnFn, p0 = st.pos, absBase = null, ccw = st.motion === 3) {
    const base = absBase || st.offset();
    const ax = st.plane === 18 ? [2, 0] : st.plane === 19 ? [1, 2] : [0, 1];
    const offs = st.plane === 18 ? [words.k, words.i] : st.plane === 19 ? [words.j, words.k] : [words.i, words.j];
    const hasIJK = offs[0] !== undefined || offs[1] !== undefined;

    if (hasIJK) {
      const c = p0.slice();
      for (let n = 0; n < 2; n++) {
        const v = offs[n] === undefined ? 0 : toMM(offs[n], st.metric);
        c[ax[n]] = st.arcAbsolute ? base[ax[n]] + v : p0[ax[n]] + v;
      }
      // Sanity check: the two radii should agree.
      const r0 = Math.hypot(p0[ax[0]] - c[ax[0]], p0[ax[1]] - c[ax[1]]);
      const r1 = Math.hypot(target[ax[0]] - c[ax[0]], target[ax[1]] - c[ax[1]]);
      if (Math.abs(r0 - r1) > Math.max(0.01, r0 * 0.001)) {
        warnFn(line, `Arc end point is ${(r1 - r0).toFixed(4)} mm off the programmed radius.`, 'error');
      }
      return c;
    }

    if (words.r !== undefined) {
      // Some controls write the radius of a minor arc negative, which is
      // the opposite of what the sign means here. Flipping it in one place
      // is what keeps the arc code one piece of arithmetic.
      const R = toMM(words.r, st.metric) * (dialect.arcRSign || 1);
      const a0 = p0[ax[0]], b0 = p0[ax[1]];
      const a1 = target[ax[0]], b1 = target[ax[1]];
      const da = a1 - a0, db = b1 - b0;
      const chord = Math.hypot(da, db);
      if (chord < 1e-9) {
        warnFn(line, 'R-format arc with coincident end points is ambiguous; move skipped.', 'error');
        return null;
      }
      const half = chord / 2;
      const disc = R * R - half * half;
      if (disc < -1e-6) {
        warnFn(line, `R-format arc radius ${R} is smaller than half the chord (${half.toFixed(3)}).`, 'error');
        return null;
      }
      const hgt = Math.sqrt(Math.max(0, disc));
      // Sign selects minor vs major arc; direction selects which side.
      // Which direction is the *block's*, not the modal one: on a control
      // where G2 and G3 last a single block there is no modal one to ask,
      // and asking anyway put every arc on the long way round.
      const sign = (R < 0) !== ccw ? 1 : -1;
      const c = p0.slice();
      c[ax[0]] = a0 + da / 2 + (sign * hgt * -db) / chord;
      c[ax[1]] = b0 + db / 2 + (sign * hgt * da) / chord;
      return c;
    }

    warnFn(line, 'Arc without I/J/K or R; treated as a straight feed move.', 'error');
    return null;
  }

  /** Expand a drilling canned cycle into discrete moves. */
  function runCycle(code, line, hx, hy) {
    const rPlane = st.cycleR;
    const zBottom = st.cycleZ;
    const feed = st.cycleF > 0 ? st.cycleF : 100;
    const startZ = Math.max(st.pos[2], rPlane);

    // Position over the hole at the current (safe) height, then to the R plane.
    emitLinear(line, 'rapid', [hx, hy, startZ], cfg.rapidRate);
    emitLinear(line, 'rapid', [hx, hy, rPlane], cfg.rapidRate);

    const peck = st.cycleQ;
    if ((code === 83 || code === 73) && peck > 0.001) {
      let z = rPlane;
      const clearance = code === 83 ? 0.5 : 0;
      while (z > zBottom + 1e-6) {
        const next = Math.max(zBottom, z - peck);
        emitLinear(line, 'feed', [hx, hy, next], feed);
        if (next <= zBottom + 1e-6) break;
        if (code === 73) {
          emitLinear(line, 'feed', [hx, hy, next + 0.2], feed);   // chip break
        } else {
          emitLinear(line, 'rapid', [hx, hy, rPlane], cfg.rapidRate);
          emitLinear(line, 'rapid', [hx, hy, next + clearance], cfg.rapidRate);
        }
        z = next;
      }
    } else {
      emitLinear(line, 'feed', [hx, hy, zBottom], feed);
    }

    if (code === 82 && st.cycleP > 0) emitDwell(line, st.cycleP / (st.cycleP > 1000 ? 1000 : 1));
    if (code === 84) emitDwell(line, 0.1);

    const retractTo = st.retractMode === 98 ? Math.max(startZ, rPlane) : rPlane;
    const retractKind = code === 85 || code === 89 ? 'feed' : 'rapid';
    emitLinear(line, retractKind, [hx, hy, retractTo], retractKind === 'feed' ? feed : cfg.rapidRate);
  }

  // ---- Summary -----------------------------------------------------------
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let rapidDistance = 0;
  let feedDistance = 0;
  let cycleTime = 0;
  for (const mv of moves) {
    cycleTime += mv.time;
    if (mv.kind === 'rapid') rapidDistance += mv.length;
    else feedDistance += mv.length;
    for (let i = 0; i < mv.path.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = mv.path[i + a];
        if (v < bounds.min[a]) bounds.min[a] = v;
        if (v > bounds.max[a]) bounds.max[a] = v;
      }
    }
  }
  if (!moves.length) {
    bounds.min = [0, 0, 0];
    bounds.max = [0, 0, 0];
  }

  if (!toolChanges.length && moves.length) {
    warn(moves[0].line, 'No M06 tool change found; the active assembly is used for the whole program.');
  }
  if (!ended && moves.length) warn(blocks.length, 'Program has no M02/M30 end code.');

  return {
    moves,
    blocks,
    warnings,
    toolChanges,
    events,
    config: cfg,
    stats: { rapidDistance, feedDistance, cycleTime, bounds, moveCount: moves.length, blockCount: blocks.length },
    /** What the macro variables came to, for anyone who wants to look. */
    variables: vars.snapshot(),
    /** How this control writes one, so a readout can say R1 rather than #1. */
    variablePrefix: dialect.sigil || dialect.letters[0] || '#',
    /** Which control this program looks written for, when it is not this one. */
    suggested,
  };
}
