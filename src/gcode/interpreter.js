// G-code interpreter.
//
// Consumes lexed blocks and produces a flat list of moves in scene
// coordinates (millimetres, Z up, work-offset applied). Everything the
// simulator, the backplot and the collision reporter need lives in that
// list; nothing downstream has to know about modal state.

import { lex } from './lexer.js';
import { normaliseCode, expandMacro } from '../machine/macros.js';
import { Vars, evaluate, ARGUMENTS, parseArgs } from './macro.js';
import { resolveDialect, detectDialect, DIALECTS, registersOf, parseRegisterKey } from './dialects.js';
import { BlockLog } from './blockLog.js';
import { MM_PER_INCH, deg2rad } from '../core/util.js';
import * as m4 from '../core/mat4.js';

export const DEFAULT_CONFIG = {
  /** Rapid traverse used for time estimates, mm/min. */
  rapidRate: 15000,
  /**
   * How fast the rotaries turn at rapid, degrees a minute — and the fastest
   * they turn at all, whatever F asks for. 7200 is 20 rpm.
   */
  rotaryRapid: 7200,
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

/**
 * The rotary axes in the order a Siemens swivel data record counts them:
 * those that turn the tool first, then those that turn the part, each from
 * the machine outwards.
 */
function swivelAxes(kin) {
  const rot = kin.rotaries();
  const depth = (n) => (typeof kin.depth === 'function' ? kin.depth(n.id) : 0);
  const head = rot.filter((n) => kin.branchOf(n.id) === 'tool').sort((a, b) => depth(a) - depth(b));
  const table = rot.filter((n) => kin.branchOf(n.id) !== 'tool').sort((a, b) => depth(a) - depth(b));
  return [...head, ...table];
}

/** The Siemens drilling cycles this reader turns into moves. */
const IGNORED_CALLS = new Set(['CYCLE832', 'MSG', 'WORKPIECE', 'SETMS', 'G_SETTINGS', 'CYCLE800_RESET']);
const DRILL_CYCLES = new Set(['CYCLE81', 'CYCLE82', 'CYCLE83', 'CYCLE84', 'CYCLE840', 'CYCLE85', 'CYCLE86', 'CYCLE87', 'CYCLE88', 'CYCLE89']);

/** Coarse metric thread pitches, by nominal size: what MPIT=10 means. */
const METRIC_PITCH = { 1: 0.25, 1.2: 0.25, 1.6: 0.35, 2: 0.4, 2.5: 0.45, 3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5, 12: 1.75, 14: 2, 16: 2, 18: 2.5, 20: 2.5, 22: 2.5, 24: 3, 27: 3, 30: 3.5, 33: 3.5, 36: 4, 42: 4.5, 48: 5 };
const metricPitch = (size) => METRIC_PITCH[Math.abs(Number(size) || 0)] || 0;

/** @typedef {{kind:string, line:number, path:Float64Array, ...}} Move */

class State {
  constructor(cfg) {
    this.cfg = cfg;
    // Where the tool is before the program starts: the machine at home,
    // which puts its *gauge line* on machine zero — so the tip of whatever
    // is in the spindle hangs its own length below that. Same rule as G53,
    // and it is what makes a G53 Z0 from the start of a program the
    // nothing-happens move it is on the machine.
    const start = (cfg.initialPosition || cfg.machineZero || [0, 0, 0]).slice();
    if (!cfg.initialPosition && cfg.gaugeLength) start[2] -= cfg.gaugeLength;
    this.pos = start;
    const ctl = cfg.controller || {};
    this.motion = 0;             // modal motion G code
    this.plane = ctl.plane ?? 17;
    this.metric = ctl.metric !== false;
    this.absolute = ctl.absolute !== false;
    this.arcAbsolute = !!ctl.arcCentreAbsolute;
    this.feedMode = ctl.feedMode ?? 94;
    this.feed = 0;
    /** The F word as written, for G93, where it is a rate and not a length. */
    this.feedRaw = 0;
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
    /**
     * A Siemens programmable frame — TRANS, ROT and their additive forms —
     * or null. It sits inside the tilted plane, if there is one: `xf` is the
     * two together, which is what a programmed point goes through.
     */
    this.frame = null;
    this.xf = null;
    /**
     * A plane swivelled by CYCLE800: the control works out the axes for
     * the turned frame itself, so what is programmed in it is the tip on
     * the part, as under TRAORI.
     */
    this.swivel = false;
    /** The cycle MCALL made modal: run again at every position that follows. */
    this.mcall = null;
    this.retractMode = 98;
    this.cycleR = 0;
    this.cycleZ = 0;
    this.cycleQ = 0;
    this.cycleP = 0;
    this.cycleF = 0;
    /** Where the tool stood when the cycle began: G98 comes back up to it. */
    this.cycleInit = 0;
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
  if (kin && typeof kin.extras === 'function') {
    for (const node of kin.extras()) {
      if (node.letter) out.set(node.letter, node.kind === 'rotary' ? 'rotary' : 'linear');
    }
  }
  // The part indexer is read whether or not the machine has been modelled
  // with one: see indexerOf. What the chain says about a letter it has
  // stands — this only adds the letter a machine does not name at all.
  const idx = indexerOf(cfg);
  if (idx && !out.has(idx.letter)) out.set(idx.letter, 'rotary');
  // And the same for the axis that runs down the tool: a length, in
  // program units, that the control turns into X, Y and Z.
  const along = alongToolOf(cfg);
  if (along && !out.has(along.letter)) out.set(along.letter, 'linear');
  return out;
}

/**
 * The letter that moves the tool along its own line, or null.
 *
 * There is no such slide on the machine: the control reads W as "move the
 * tip this far the way the spindle is pointing" and drives X, Y and Z to
 * do it. Which is why it is read whether or not any axis is named W, and
 * why a machine that does name one — a real quill — keeps that instead.
 *
 * @returns {null | {letter:string, inChain:boolean}}
 */
function alongToolOf(cfg) {
  const d = resolveDialect(
    (cfg && cfg.controller && cfg.controller.dialect)
      || (cfg && cfg.controller && cfg.controller.flavour) || 'fanuc',
    cfg && cfg.controller && cfg.controller.syntax,
  );
  const a = d.alongTool;
  if (!a || !a.letter) return null;
  const kin = cfg && cfg.kinematics;
  const node = kin && typeof kin.extras === 'function'
    ? kin.extras().find((n) => n.letter === a.letter) : null;
  return { ...a, inChain: !!node };
}

/**
 * The letter that turns the work rather than the machine.
 *
 * A Fidia's U is the angle the part is sitting at: the work turns and the
 * coordinate system it is measured in does not. Which is true whether or
 * not the machine has been modelled with the axis — a shop that has drawn
 * its indexer into the chain has one that turns the part through the
 * chain, and one that has not still writes U in its programs — so the
 * angle is reported either way and `inChain` says who applies it.
 *
 * A machine that says its U is a slide is taken at its word: that is a
 * different machine, and the chain wins.
 *
 * @returns {null | {letter:string, axis:string, inChain:boolean}}
 */
function indexerOf(cfg) {
  const d = resolveDialect(
    (cfg && cfg.controller && cfg.controller.dialect)
      || (cfg && cfg.controller && cfg.controller.flavour) || 'fanuc',
    cfg && cfg.controller && cfg.controller.syntax,
  );
  const idx = d.indexer;
  if (!idx || !idx.letter) return null;
  const kin = cfg && cfg.kinematics;
  const node = kin && typeof kin.extras === 'function'
    ? kin.extras().find((n) => n.letter === idx.letter) : null;
  if (node && node.kind !== 'rotary') return null;
  return { ...idx, inChain: !!node };
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

/** T7 or T="FACE MILL", as the program wrote it. */
const toolLabel = (tool) => (typeof tool === 'string' ? `T="${tool}"` : `T${tool}`);

/**
 * Whether a tool asked for is the one already in the spindle: the same
 * pot, or the same name however it is capitalised. No tool yet is never
 * the same as one asked for.
 */
function sameToolAs(asked, current) {
  if (!asked || !current) return false;
  if (typeof asked === 'string' || typeof current === 'string') {
    return String(asked).trim().toLowerCase() === String(current).trim().toLowerCase();
  }
  return asked === current;
}

/**
 * Flatten an arc into a polyline.
 * Returns points as a flat array [x,y,z, x,y,z, ...] including both ends.
 */
export function flattenArc(from, to, center, plane, ccw, tolerance, turns = 0) {
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
  // Coincident endpoints with a valid centre mean a full circle — judged in
  // the plane, so a full turn of a helix, which ends higher than it began,
  // is one too and not a sliver decided by the last bit of rounding.
  if (Math.hypot(ea - sa, eb - sb) < 1e-9) sweep = ccw ? Math.PI * 2 : -Math.PI * 2;
  // TURN=n on a Siemens: n whole turns more before the arc ends — a helix
  // winding down a hole, its depth shared over all of them.
  if (turns > 0) sweep += (ccw ? 1 : -1) * Math.PI * 2 * Math.floor(turns);

  const tol = Math.max(tolerance, 1e-4);
  let stepAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  if (!Number.isFinite(stepAngle) || stepAngle <= 1e-6) stepAngle = 0.02;
  let n = Math.ceil(Math.abs(sweep) / stepAngle);
  n = Math.max(2, Math.min(n, 4096 * (1 + Math.min(Math.floor(turns), 15))));

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
  // Once each: a machine's own A and C are among its extras as well.
  const turning = [...new Set(['A', 'B', 'C', ...[...extras].filter(([, k]) => k === 'rotary').map(([L]) => L)])];

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

  /** The same note on the same line of the same file, said once and counted. */
  const said = new Map();
  const warn = (line, message, severity = 'warning') => {
    const key = `${curSrc || ''}\u0000${line}\u0000${message}`;
    const again = said.get(key);
    if (again) {
      again.count = (again.count || 1) + 1;
      return;
    }
    if (warnings.length >= 500) return;
    const w = { line, message, severity };
    if (curSrc) w.source = curSrc;
    said.set(key, w);
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

  /**
   * A work offset that turns a rotary — G55 C60 — turns the part and not
   * the coordinates the program is written in. Without TCP that is so
   * already, X Y Z being the slides. With it, a point is a point on the
   * part, so it is carried round by the offset's turn: the same place in
   * the machine as it would be with the rotaries at their programmed
   * angles, which on the part is 60° further round. Six slots from one
   * programmed slot and six offsets, as on the machine.
   *
   * @returns {null | ((p:number[], u:number) => number[])}
   */
  const turnFor = (move) => {
    const kin = cfg.kinematics;
    if (!move.tcp || !kin || typeof kin.solve !== 'function') return null;
    // What the points are counted against. In a CYCLE800 plane without
    // TRAORI, the angles the cycle swung to: the plane was made then, and a
    // rotary turned on its own afterwards turns the part under it and not
    // the plane. Under TRAORI, the rotaries as programmed — the work
    // offset's turn of them left out.
    let reference;
    if (move.swivelRot) {
      const frozen = move.swivelRot;
      reference = (rot) => ({ ...rot, ...frozen });
    } else {
      const off = cfg.wcsRotary && cfg.wcsRotary[move.wcs];
      const letters = off ? Object.keys(off).filter((L) => Number(off[L])) : [];
      if (!letters.length) return null;
      reference = (rot) => {
        const r = { ...rot };
        for (const L of letters) r[L] = (Number(r[L]) || 0) - Number(off[L]);
        return r;
      };
    }
    const differs = (rot) => {
      const r = reference(rot);
      return Object.keys({ ...rot, ...r }).some((L) => Math.abs((Number(rot[L]) || 0) - (Number(r[L]) || 0)) > 1e-12);
    };
    if (!differs(move.rotFrom || {}) && !differs(move.rotTo || {})) return null;
    const at = (rot, programmed) => {
      const values = { ...(programmed ? reference(rot) : rot), X: 0, Y: 0, Z: 0 };
      kin.solve(values);
      return m4.copy(m4.create(), kin.matrixOf(kin.workNode));
    };
    // Machine angle u of the way along, programmed the same less the offset.
    const between = (u) => {
      const r = {};
      for (const L of Object.keys({ ...move.rotFrom, ...move.rotTo })) {
        const a = Number((move.rotFrom || {})[L]) || 0;
        const b = Number((move.rotTo || {})[L]) || 0;
        r[L] = a + (b - a) * u;
      }
      return r;
    };
    const turnAt = (u) => {
      const rot = between(u);
      return m4.multiply(m4.create(), m4.invertRigid(m4.create(), at(rot, false)), at(rot, true));
    };
    const t0 = turnAt(0);
    const t1 = turnAt(1);
    const same = t0.every((v, i) => Math.abs(v - t1[i]) < 1e-12);
    const o = kin.tableOffset || [0, 0, 0];
    return (p, u) => {
      const M = same ? t0 : turnAt(u);
      const q = m4.transformPoint([0, 0, 0], M, [p[0] + o[0], p[1] + o[1], p[2] + o[2]]);
      return [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
    };
  };

  const push = (move) => {
    move.i = moves.length;
    if (curSrc) move.source = curSrc;
    if (move.tcp && !st.tcp && st.swivel && st.swivelRot) move.swivelRot = st.swivelRot;
    const turn = turnFor(move);
    if (turn) {
      move.from = turn(move.from, 0);
      move.to = turn(move.to, 1);
      if (move.center) move.center = turn(move.center, 0.5);
      if (move.path) {
        const n = move.path.length / 3;
        for (let i = 0; i < n; i++) {
          const q = turn([move.path[i * 3], move.path[i * 3 + 1], move.path[i * 3 + 2]], n > 1 ? i / (n - 1) : 1);
          move.path[i * 3] = q[0]; move.path[i * 3 + 1] = q[1]; move.path[i * 3 + 2] = q[2];
        }
      }
    }
    // A tool change: the M6 macro's moves, and any on the block with M6.
    // The changer usually sits past the travels a program may use, so the
    // simulator holds these to the machine's reach, not to the envelope.
    if (m6Block || callStack.some((f) => f.macro === 'M6')) move.toolChange = true;
    moves.push(move);
    // Every move ends where the rotaries now are, so the next one starts
    // there. Leaving this to the blocks that carry an A/B/C word would make
    // each of them look like it swung all the way from the last angle.
    st.rotPrev = { ...st.rot };
    return move;
  };

  /**
   * How fast a move goes, in mm/min, and how long it takes.
   *
   * F is only a speed under G94. Under G95 it is a length per turn of the
   * spindle, and under G93 it is how many of these moves fit in a minute —
   * the form 5-axis posts write, because a swing of the table has no
   * sensible speed along the tip. Read as mm/min, F0.1 at S1000 took a
   * thousand minutes over a 100 mm line, and a G93 F2 took fifty.
   */
  const timing = (kind, tipLen, feed) => {
    // The other axes the move turns or slides. A swing of the head with the
    // tip standing still is not a move of no length: it takes as long as
    // the slowest axis needs, and a U/V/W slide is travel like X, Y and Z.
    const { turn, turnSq, slideSq } = otherTravel();
    const len = slideSq > 0 ? Math.sqrt(tipLen * tipLen + slideSq) : tipLen;
    // No rotary turns faster than its own rapid, whatever F says.
    const turnMin = turn > 0 ? (turn / Math.max(cfg.rotaryRapid, 1e-6)) * 60 : 0;
    if (kind === 'rapid') {
      return { feed: cfg.rapidRate, time: Math.max(len > 0 ? (len / cfg.rapidRate) * 60 : 0, turnMin) };
    }
    if (st.feedMode === 93 && st.feedRaw > 0) return { feed: len * st.feedRaw, time: Math.max(60 / st.feedRaw, turnMin) };
    const rate = st.feedMode === 95 && st.rpm > 0 ? feed * st.rpm : feed;
    // What F is a speed along. A rotary alone: degrees a minute. With the
    // linear axes, a Fanuc applies it to all of them together, degrees
    // counted as millimetres; Siemens, Heidenhain and Fidia to the linear
    // path, the rotaries keeping pace — as does any control under tool
    // centre point, where F is the tip's speed along the part.
    let span = len;
    if (turnSq > 0) {
      if (len <= 1e-9) span = Math.sqrt(turnSq);
      else if (dialect.id === 'fanuc' && !st.tcp) span = Math.sqrt(len * len + turnSq);
    }
    const t = span > 0 ? (span / Math.max(rate, 1e-6)) * 60 : 0;
    return { feed: rate, time: Math.max(t, turnMin) };
  };

  /** How far this move turns the rotaries (largest, and sum of squares) and slides U/V/W. */
  const otherTravel = () => {
    let turn = 0;
    let turnSq = 0;
    let slideSq = 0;
    for (const L of turning) {
      const d = Math.abs((st.rot[L] || 0) - (st.rotPrev[L] || 0));
      if (d > turn) turn = d;
      turnSq += d * d;
    }
    for (const L of auxLinear) {
      const d = (st.rot[L] || 0) - (st.rotPrev[L] || 0);
      slideSq += d * d;
    }
    return { turn, turnSq, slideSq };
  };

  /** Is the tip what is programmed? Under TRAORI or G43.4 — and in a swivelled plane. */
  const tcpNow = () => st.tcp || (st.swivel ? 4 : 0);

  /**
   * Switch between the two ways a position is written, without moving.
   *
   * With tool centre point on, the position is the tip on the part. Off,
   * it is where the tip would be with these slides and every rotary at
   * zero — which is what a machine without TCP is told. With the rotaries
   * at zero they are the same point; turned, they are not, and changing
   * mode with the head over at 90 has to carry one into the other through
   * the machine, or the next move starts from somewhere the tool is not.
   */
  const setTcpMode = (change) => {
    const before = tcpNow();
    const frozenBefore = !st.tcp && st.swivel ? st.swivelRot : null;
    change();
    const after = tcpNow();
    const frozenAfter = !st.tcp && st.swivel ? st.swivelRot : null;
    const kin = cfg.kinematics;
    if (!!before === !!after || !kin || typeof kin.linearsForTip !== 'function') return;
    const g = cfg.gaugeLength || 0;
    // Under TCP a point is counted with the rotaries at their programmed
    // angles — the work offset's turn of them left out; see turnFor.
    const rot = {};
    for (const L of turning) rot[L] = (st.rot[L] || 0) - rotaryOffset(L);
    // In a CYCLE800 plane the point is counted at the angles the cycle
    // swung to, whatever a rotary has done since; see turnFor.
    const frozen = after ? frozenAfter : frozenBefore;
    if (frozen) for (const L of turning) if (frozen[L] !== undefined) rot[L] = frozen[L];
    if (!turning.some((L) => Math.abs(rot[L]) > 1e-9)) return;
    const zero = {};
    for (const L of turning) zero[L] = 0;
    const axes = after
      ? kin.linearsForTip(st.pos, zero, g)
      : kin.linearsForTip(st.pos, rot, g);
    if (!axes) return;
    st.pos = kin.toolInWork({ ...(after ? rot : zero), ...axes }, g).tip;
  };

  /** The tilted plane and the programmable frame inside it, as one matrix. */
  const updateXf = () => {
    st.xf = st.tilt && st.frame ? m4.multiply(m4.create(), st.tilt, st.frame) : st.tilt || st.frame;
    // The current point, carried into the new frame, so the next block
    // may leave any axis word out.
    if (st.xf) {
      st.tiltLocal = workToPlane(st.pos);
      st.tiltLocalPrev = st.tiltLocal;
    }
  };

  const emitLinear = (line, kind, target, feed) => {
    const from = st.pos.slice();
    const len = dist3(from, target);
    const pace = timing(kind, len, feed);
    const move = push({
      kind,
      line,
      from,
      to: target.slice(),
      path: [from[0], from[1], from[2], target[0], target[1], target[2]],
      rotFrom: { ...st.rotPrev },
      rotTo: { ...st.rot },
      tcp: tcpNow(),
      feed: pace.feed,
      rpm: st.rpm,
      spindleDir: st.spindleDir,
      tool: st.tool,
      wcs: st.wcs,
      coolant: st.coolant,
      length: len,
      time: pace.time,
    });
    st.pos = target.slice();
    return move;
  };

  /**
   * @param {null|{from:number[], to:number[], center:number[]}} local
   *   When a tilted plane is active the arc is a circle only in that plane,
   *   so it is flattened there and the polyline brought out afterwards.
   */
  const emitArc = (line, target, center, ccw, feed, local = null, turns = 0) => {
    const from = st.pos.slice();
    let centre = center;
    let path;
    if (local) {
      const lp = flattenArc(local.from, local.to, local.center, st.plane, ccw, cfg.arcTolerance, turns);
      path = new Array(lp.length);
      for (let i = 0; i < lp.length; i += 3) {
        const w = planeToWork([lp[i], lp[i + 1], lp[i + 2]]);
        path[i] = w[0];
        path[i + 1] = w[1];
        path[i + 2] = w[2];
      }
      centre = planeToWork(local.center);
    } else {
      path = flattenArc(from, target, center, st.plane, ccw, cfg.arcTolerance, turns);
    }
    let len = 0;
    for (let i = 3; i < path.length; i += 3) {
      len += Math.hypot(path[i] - path[i - 3], path[i + 1] - path[i - 2], path[i + 2] - path[i - 1]);
    }
    const pace = timing('arc', len, feed);
    const move = push({
      kind: 'arc',
      line,
      from,
      to: target.slice(),
      rotFrom: { ...st.rotPrev },
      rotTo: { ...st.rot },
      tcp: tcpNow(),
      center: centre.slice(),
      plane: st.plane,
      ccw,
      path,
      feed: pace.feed,
      rpm: st.rpm,
      spindleDir: st.spindleDir,
      tool: st.tool,
      wcs: st.wcs,
      coolant: st.coolant,
      length: len,
      time: pace.time,
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
      tcp: tcpNow(),
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
  const resolveLinear = (axis, metric, machineCoords, modes = null) => {
    // X=IC(5) in G90, X=AC(5) in G91: one axis read the other way.
    const absAt = (i) => {
      const mode = modes && modes['XYZ'[i]];
      return mode === 'AC' ? true : mode === 'IC' ? false : st.absolute;
    };
    if (st.xf && !machineCoords) {
      // The block is written in the plane's own frame, so the position is
      // tracked there too: a G91 delta is a step along the plane's axes,
      // and an arc's I/J are offsets in the plane. Keeping the local point
      // rather than re-deriving it from the machine position is what lets
      // arcs stay circles once the frame is tilted.
      //
      // Unless something moved the tool outside the plane since — a G53, a
      // G28, a drilling cycle — in which case the plane's idea of where the
      // tool is has gone stale, and the next G91 step would start from
      // where it used to be.
      let prev = st.tiltLocal;
      if (dist3(planeToWork(prev), st.pos) > 1e-6) prev = workToPlane(st.pos);
      const local = [0, 1, 2].map((i) => {
        const w = [axis.X, axis.Y, axis.Z][i];
        const d = w === undefined ? undefined : toMM(w, metric);
        if (absAt(i)) return d === undefined ? prev[i] : d;
        return prev[i] + (d === undefined ? 0 : d);
      });
      st.tiltLocalPrev = prev;
      st.tiltLocal = local;
      return planeToWork(local);
    }

    // Machine coordinates are read at the gauge line, so the tip they put
    // the tool at is a gauge length below the numbers in the block.
    const drop = machineCoords ? gaugeDrop() : null;
    return [0, 1, 2].map((i) => {
      const w = [axis.X, axis.Y, axis.Z][i];
      if (w === undefined) return st.pos[i];
      const v = toMM(w, metric);
      if (machineCoords) return cfg.machineZero[i] + v + drop[i];
      if (absAt(i)) return st.offset()[i] + v;
      return st.pos[i] + v;
    });
  };

  /**
   * How far the tip hangs below the gauge line, as a vector.
   *
   * A machine coordinate is an axis position, and an axis position is read
   * at the gauge line — the spindle's own face — not at the tip of
   * whatever happens to be in it. So G53 Z0 stands the spindle nose at
   * machine zero and the tool hangs a gauge length below it, which is why
   * the same block leaves a long tool lower than a short one. Tilt the
   * head and it hangs down the tool rather than down Z, so the direction
   * comes off the machine when there is one.
   */
  const gaugeDrop = () => {
    const gauge = cfg.gaugeLength || 0;
    if (!gauge) return [0, 0, 0];
    const kin = cfg.kinematics;
    if (kin && typeof kin.toolAxis === 'function' && kin.rotaries().length) {
      const a = kin.toolAxis(st.rot, gauge);
      return [-a[0] * gauge, -a[1] * gauge, -a[2] * gauge];
    }
    return [0, 0, -gauge];
  };

  /** A point in the active tilted plane, expressed in work coordinates. */
  const planeToWork = (local) => {
    const w = m4.transformPoint([0, 0, 0], st.xf, local);
    const off = st.offset();
    return [w[0] + off[0], w[1] + off[1], w[2] + off[2]];
  };

  /** The reverse, used to pick up the current point when a plane is set. */
  const workToPlane = (pos) => {
    const off = st.offset();
    const rel = [pos[0] - off[0], pos[1] - off[1], pos[2] - off[2]];
    return m4.transformPoint([0, 0, 0], m4.invertRigid(m4.create(), st.xf), rel);
  };

  /** A point as the program states it — through any plane or frame — in work coordinates. */
  const progToWork = (p) => (st.xf ? planeToWork(p) : st.offset().map((o, i) => o + p[i]));
  /** And back: where the tool is, in the program's own terms. */
  const workToProg = (w) => (st.xf ? workToPlane(w) : w.map((v, i) => v - st.offset()[i]));

  /** Single-axis form, still needed by G28/G30 and the canned cycles. */
  const resolveAxis = (idx, word, metric, machineCoords) => {
    if (word === undefined) return st.pos[idx];
    const v = toMM(word, metric);
    if (machineCoords) return cfg.machineZero[idx] + v + gaugeDrop()[idx];
    if (st.absolute) return st.offset()[idx] + v;
    return st.pos[idx] + v;
  };

  /**
   * Apply A/B/C and any U/V/W words to the axes that are not the tool tip.
   *
   * Rotaries are in degrees whatever G20/G21 says; an extra linear slide is
   * in program units like any other length, so it goes through toMM.
   */
  const applyExtraAxes = (axis, modes = null, machineCoords = false) => {
    st.rotPrev = { ...st.rot };
    let moved = false;
    for (const L of turning) {
      if (axis[L] === undefined) continue;
      const mode = modes && modes[L];
      const cur = st.rot[L];
      // The work offset's own turn of this axis — G54 C12.5 — is added to
      // where the program sends it, as the control does: C0 in G54 is the
      // dial at 12.5. A move by an amount, or in machine coordinates, is
      // not offset.
      const incremental = mode === 'IC' || (!mode && !st.absolute);
      const turnOff = machineCoords || incremental ? 0 : rotaryOffset(L);
      const v = axis[L] + turnOff;
      // Where a rotary goes when the program says how: DC by the shorter
      // way round, ACP forwards, ACN backwards — each to the position v
      // reads as on the dial, 0 to 360 — and AC/IC absolute or incremental
      // whatever G90/G91 says.
      const turn = (d) => cur + d;
      const mod = (x) => ((x % 360) + 360) % 360;
      if (mode === 'DC') st.rot[L] = turn(mod(v - cur + 180) - 180);
      else if (mode === 'ACP') st.rot[L] = turn(mod(v - cur));
      else if (mode === 'ACN') st.rot[L] = turn(-mod(cur - v));
      else if (mode === 'AC') st.rot[L] = v;
      else if (mode === 'IC') st.rot[L] = cur + v;
      else st.rot[L] = st.absolute ? v : cur + v;
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

  /** The active work offset's turn of a rotary axis, degrees. */
  const rotaryOffset = (L) => {
    const r = cfg.wcsRotary && cfg.wcsRotary[st.wcs];
    return (r && Number(r[L])) || 0;
  };

  const vars = new Vars(dialect.locals);
  /**
   * A Siemens system variable. The tool in the spindle and its D number
   * are known; its wear is none, since nothing here has measured it; the
   * rest of what the control keeps — its geometry tables, its axis
   * readings — read as 0, said once each.
   */
  vars.dollar = (name, index) => {
    if (name === '$P_UIFR' && index && index.length >= 2) {
      const key = frameKey(index[0]);
      const part = String(index[2] || 'TR').toUpperCase();
      return key && part === 'TR' ? offsetAxis(key, String(index[1]).toUpperCase()) : 0;
    }
    if (name === '$P_TOOLNO') return typeof st.tool === 'number' ? st.tool : 0;
    if (name === '$P_TOOL') return st.dNumber || 1;
    const dp = /^\$TC_DP(\d+)$/.exec(name);
    if (dp && Number(dp[1]) >= 12 && Number(dp[1]) <= 20) return 0;
    if (!spokenFor.has(name)) {
      spokenFor.add(name);
      warn(vars.where.line, `${name}${index ? '[…]' : ''} is the control's own data, not kept here; it reads as 0.`);
    }
    return 0;
  };
  /** Every block the run reads, in order: what single block steps through. */
  const blockLog = new BlockLog(cfg.maxBlockLog || 1000000);

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

  // Which banks of numbered variables this control has — # on a Fanuc,
  // RG and PT on a Fidia — and which numbers exist in each.
  const registers = registersOf(dialect);
  vars.configure(registers, { vacantZero: !!dialect.vacantZero });

  // Every change is written down, so the program can be read as it runs:
  // what R1 was before the fifth move, not only what it ended as.
  if (cfg.traceVariables !== false) vars.trace = [];

  // Registers the machine holds between programs, and what the operator
  // dialled into them. A Fidia branches on one — $IF (RG 50 != 5) — so a
  // program is unreadable without a way to say what RG 50 is. A machine
  // parameter named for a register is that register: "#500", "RG50",
  // "PT3"; a bare number is the main bank, so "50" is RG 50 on a Fidia.
  for (const [key, value] of Object.entries(cfg.parameters || {})) {
    const reg = parseRegisterKey(key, registers);
    if (reg) {
      if (!Number.isFinite(Number(value))) continue;
      try {
        vars.set(reg.n, Number(value), reg.bank);
      } catch (err) {
        warn(1, `Machine parameter ${key}: ${err.message}.`, 'error');
      }
    // A parameter with a name is the machine's own data — on a Siemens, a
    // global user variable (GUD) a program reads without declaring it.
    } else if (dialect.namedVariables && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      vars.defineGlobal(key, typeof value === 'string' && !Number.isFinite(Number(value)) ? value : Number(value),
        typeof value === 'string' && !Number.isFinite(Number(value)) ? 'STRING' : 'REAL');
    }
  }

  // The control's own variables: positions, offsets, modal codes. This
  // reader does not hold them, and a zero where the program expected the
  // machine's position is worth one sentence, once. (A machine parameter
  // can still give one a value — #5221, say — and that is read as given.)
  const systemSaid = new Set();
  vars.onSystem = (key, k, writing, value) => {
    const line = vars.where.line || 1;
    // #3000 = n is a Fanuc macro's way of stopping the machine with an
    // alarm of its own — "A not given", "tool too short". The run stops
    // there, as it does on the machine.
    if (writing && k === 3000 && registers.main === '#') {
      warn(line, `#3000 = ${value}: the program raises alarm ${3000 + Math.round(Number(value) || 0)} here, and the machine stops.`, 'error');
      ended = true;
      return;
    }
    if (systemSaid.has(key)) return;
    systemSaid.add(key);
    warn(line, writing
      ? `${key} is one of the control's own variables; setting it changes nothing this simulator follows.`
      : `${key} is one of the control's own variables, which this simulator does not keep: it reads 0 here, where the machine would give its own value.`);
  };

  // ---- work offsets the program writes ---------------------------------
  //
  // A program may set its own offsets: Siemens through $P_UIFR, a Fanuc
  // through #5221… or G10 L2. They change the run's own copy — the
  // offsets the run started with stay as Setup › Work offsets has them, as
  // a control's table does not change until a program changes it.
  cfg.wcs = Object.fromEntries(Object.entries(cfg.wcs).map(([k, v]) => [k, [...v]]));
  cfg.wcsRotary = JSON.parse(JSON.stringify(cfg.wcsRotary || {}));
  /** Siemens settable frame n: 1–4 are G54–G57, 5–99 G505–G599, 0 G500. */
  const frameKey = (n) => {
    const k = Math.round(Number(n));
    if (k === 0) return 'G500';
    if (k >= 1 && k <= 4) return `G${53 + k}`;
    if (k >= 5 && k <= 99) return `G${500 + k}`;
    return null;
  };
  const LINEAR = ['X', 'Y', 'Z'];
  /** One axis of one offset, in program units (degrees for a rotary). */
  const offsetAxis = (key, L) => {
    const i = LINEAR.indexOf(L);
    if (i >= 0) {
      const mm = (cfg.wcs[key] || [0, 0, 0])[i];
      return st.metric ? mm : mm / MM_PER_INCH;
    }
    return Number((cfg.wcsRotary[key] || {})[L]) || 0;
  };
  const setOffsetAxis = (key, L, v) => {
    const i = LINEAR.indexOf(L);
    if (i >= 0) {
      const next = [...(cfg.wcs[key] || [0, 0, 0])];
      next[i] = toMM(v, st.metric);
      cfg.wcs[key] = next;
    } else {
      cfg.wcsRotary[key] = { ...(cfg.wcsRotary[key] || {}), [L]: Number(v) || 0 };
    }
  };
  const offsetSaid = (line, key) => events.push({ line, type: 'offset', moveIndex: moves.length, text: `${key} set by the program` });

  // A Fanuc keeps its offsets as variables: #5221 G54 X, #5222 Y, #5223 Z,
  // #5224 and #5225 the 4th and 5th axes, twenty a step to G59's #5321.
  const fanucAxes = ['X', 'Y', 'Z', ...[...extras].filter(([, k]) => k === 'rotary').map(([L]) => L)];
  const fanucOffset = (mark, k) => {
    if (registers.main !== '#' || mark !== '#' || k < 5221 || k > 5340) return null;
    const n = Math.floor((k - 5201) / 20);
    const L = fanucAxes[(k - 5201) % 20];
    return n >= 1 && n <= 6 && L ? { key: `G${53 + n}`, L } : null;
  };
  vars.sysRead = (mark, k) => {
    const o = fanucOffset(mark, k);
    return o ? offsetAxis(o.key, o.L) : undefined;
  };
  vars.sysWrite = (mark, k, value) => {
    const o = fanucOffset(mark, k);
    if (!o) return false;
    setOffsetAxis(o.key, o.L, value);
    offsetSaid(vars.where.line, o.key);
    return true;
  };

  /** $P_UIFR[n] = $P_UIFR[m], and $P_UIFR[n, C, TR] = … */
  const assignFrame = (a) => {
    const idx = a.index || [];
    const key = frameKey(evaluate(idx[0], vars));
    if (!key) { warn(vars.where.line, `$P_UIFR[${evaluate(idx[0], vars)}]: there is no settable frame of that number.`, 'error'); return; }
    if (idx.length === 1) {
      const v = a.value;
      if (v && v.op === 'named' && /^\$P_UIFR$/i.test(v.name) && v.index && v.index.length === 1) {
        const from = frameKey(evaluate(v.index[0], vars));
        if (!from) return;
        cfg.wcs[key] = [...(cfg.wcs[from] || [0, 0, 0])];
        cfg.wcsRotary[key] = { ...(cfg.wcsRotary[from] || {}) };
        offsetSaid(vars.where.line, key);
        return;
      }
      if (!spokenFor.has('$P_UIFR=')) {
        spokenFor.add('$P_UIFR=');
        warn(vars.where.line, 'A whole frame is set here only as a copy of another ($P_UIFR[2]=$P_UIFR[1]); CTRANS and the rest are not simulated.');
      }
      return;
    }
    const L = String((idx[1] && (idx[1].axis || idx[1].name)) || '').toUpperCase();
    const part = String((idx[2] && (idx[2].axis || idx[2].name)) || 'TR').toUpperCase();
    if (part !== 'TR') {
      if (!spokenFor.has(`$P_UIFR ${part}`)) {
        spokenFor.add(`$P_UIFR ${part}`);
        warn(vars.where.line, `$P_UIFR[…,${part}]: only the offsets (TR) of a frame are simulated; ${part === 'FI' ? 'fine offsets' : part === 'RT' ? 'rotations' : part === 'SC' ? 'scales' : 'mirrors'} are not.`);
      }
      return;
    }
    setOffsetAxis(key, L, evaluate(a.value, vars));
    offsetSaid(vars.where.line, key);
  };

  /** Put a value in a variable, numbered or named. */
  const assign = (a) => {
    if (a.named && /^\$P_UIFR$/i.test(a.named)) { assignFrame(a); return; }
    const value = evaluate(a.value, vars);
    if (a.named) vars.setNamed(a.named, a.index ? a.index.map((e) => evaluate(e, vars)) : null, value);
    else vars.set(evaluate(a.target, vars), value, a.bank);
  };
  /** What a variable holds, numbered or named. */
  const valueOf = (a) => (a.named
    ? vars.getNamed(a.named, a.index ? a.index.map((e) => evaluate(e, vars)) : null)
    : vars.get(evaluate(a.target, vars), a.bank));

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
  const TAIL_OF = { while: 'end', do: 'end', for: 'end-for', repeat: 'until', times: 'end-times' };
  const HEADS_OF = { end: ['while', 'do'], 'end-for': ['for'], until: ['repeat'], 'end-times': ['times'] };

  /**
   * How many times round a counted loop still has to go.
   *
   * $REP 4 carries its count on the head and nothing anywhere else, so the
   * tally lives here, against the block that opened it. It is dropped when
   * the loop finishes, which is what lets an outer loop run the same $REP
   * again from the top.
   */
  const repsLeft = new Map();

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

  /**
   * The ELSE or ENDIF that answers the IF or ELSE at `idx`, with IFs inside
   * it counted out. `orElse` stops at an ELSE as well as an ENDIF.
   */
  const ifCache = new Map();
  const matchIf = (idx, orElse) => {
    const key = `${idx}:${orElse}`;
    if (ifCache.has(key)) return ifCache.get(key);
    const from = blocks[idx];
    let depth = 0;
    let found = -1;
    for (let i = idx + 1; i < blocks.length; i++) {
      const b = blocks[i];
      if ((b.src || null) !== (from.src || null)) break;
      const c = b.macro && b.macro.control;
      if (!c) continue;
      if (c.kind === 'if-block') depth++;
      else if (c.kind === 'endif') {
        if (depth === 0) { found = i; break; }
        depth--;
      } else if (c.kind === 'else' && depth === 0 && orElse) { found = i; break; }
    }
    ifCache.set(key, found);
    return found;
  };

  const callStack = [];
  /** Is the block being read a tool change? See push. */
  let m6Block = false;
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

  /**
   * The M code this control comes back out of a called file on.
   *
   * Most controls keep the two apart — M99 goes back, M30 ends the run —
   * but a Fidia writes M30 at the end of every file, the one that called
   * and the one that was called. Which of the two it means is whether
   * anything is waiting for it, so that is what decides here. Without this
   * the first called file ends the program and everything the main one had
   * left to do — the next face, the retract — silently never happens.
   */
  const returnCode = (() => {
    const m = /^M0*(\d+)$/i.exec((dialect.call && dialect.call.ret) || '');
    return m ? Number(m[1]) : null;
  })();

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
      // Called again from the top: what it declared starts over.
      if (frame.scoped) vars.resetScope();
    } else {
      pc = frame.ret;
      // The call's own #1 to #33 go with it, which is what lets one macro
      // call another without the two treading on each other.
      if (frame.macroVars) vars.pop();
      if (frame.scoped) vars.popScope();
      if (frame.metricWas !== undefined) st.metric = frame.metricWas;
      if (frame.resumeEnded) ended = true;
    }
  };

  // A call written after a move in the same block — G0 X10 Y20
  // CYCLE81(…) — made once the move is.
  let afterCall = null;

  while (pc < blocks.length || afterCall) {
    if (afterCall) {
      const call = afterCall;
      afterCall = null;
      siemensStatement(call, true);
      continue;
    }
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

    // The end of a section a REPEAT is running: round again, or back to
    // the block after the REPEAT.
    const sectionFrame = callStack[callStack.length - 1];
    if (sectionFrame && sectionFrame.section && pc === sectionFrame.end + 1) {
      if (sectionFrame.remaining > 0) {
        sectionFrame.remaining--;
        pc = sectionFrame.target;
      } else {
        callStack.pop();
        pc = sectionFrame.ret;
      }
      continue;
    }

    executed++;
    if (executed > cfg.maxBlocks) {
      warn(blocks[pc].line, 'Aborted: block limit reached (runaway subprogram loop?).', 'error');
      break;
    }

    const b = blocks[pc];
    pc++;
    curSrc = b.src || null;
    m6Block = false;
    // Single block stops after every block that does something — a move,
    // a spindle start, an assignment — so each one goes in the record. So
    // does a block the reader could not make sense of: the control would
    // stop on it too, with an alarm. Blank lines, remarks, labels and the
    // % marks do nothing to stop on.
    if (!b.endOfSource && !b.marker && !b.setting && !b.blockDelete && (b.words.length || b.command
      || (b.names && b.names.length) || b.error
      || (b.macro && (b.macro.error || b.macro.assigns.length || b.macro.control || b.macro.call || (b.macro.defs && b.macro.defs.length))))) {
      const at = blockLog.push(b.line, moves.length, curSrc);
      if (at >= 0) vars.where.block = at;
    }
    // Where a change to a variable is written down as having happened.
    vars.where.line = b.line;
    vars.where.move = moves.length;
    vars.where.src = curSrc;

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
        // DEF REAL DEPTH=5: the program's own variables, before anything
        // on the block reads them.
        for (const def of b.macro.defs || []) vars.declare(def, (e) => evaluate(e, vars));
        // STEP=2.5 reads like an address with a long name; it is one only
        // if something of that name has been declared. That is asked each
        // time the block runs, from the words as they were read: a loop
        // comes back to this block, and the assignment has to be here for
        // it on every pass, not only the first.
        if (dialect.namedVariables && (b.allWords || b.words).length) {
          if (!b.allWords) b.allWords = b.words;
          const kept = [];
          for (const w of b.allWords) {
            if (w.letter.length > 1 && vars.hasNamed(w.letter)) {
              const value = w.expr ? evaluate(w.expr, vars) : w.value;
              vars.setNamed(w.letter.toUpperCase(), null, value);
            } else kept.push(w);
          }
          b.words = kept.length === b.allWords.length ? b.allWords : kept;
        }
        for (const w of b.words) if (w.expr) w.value = evaluate(w.expr, vars);
        for (const a of b.macro.assigns) assign(a);

        const c = b.macro.control;
        if (c) {
          if (c.kind === 'goto' || (c.kind === 'if-goto' && evaluate(c.cond, vars))) {
            const target = c.label !== undefined ? c.label : evaluate(c.target, vars);
            const at = findLabel(b, target);
            if (at < 0 && c.quiet) continue;               // GOTOC: no label, no alarm
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
          // IF … ELSE … ENDIF. A false condition goes past ELSE, or to the
          // ENDIF; arriving at ELSE means the true part has run, so on to
          // the ENDIF.
          if (c.kind === 'if-block') {
            // An IF that could not be read says why, and runs nothing.
            if (!c.cond && b.error) warn(b.line, b.error, 'error');
            if (c.cond && evaluate(c.cond, vars)) continue;
            const to = matchIf(pc - 1, true);
            if (to < 0) { warn(b.line, 'IF has no ENDIF.', 'error'); continue; }
            pc = to + 1;
            continue;
          }
          if (c.kind === 'else') {
            const to = matchIf(pc - 1, false);
            if (to < 0) { warn(b.line, 'ELSE has no ENDIF.', 'error'); continue; }
            pc = to + 1;
            continue;
          }
          if (c.kind === 'endif') continue;
          if (c.kind === 'if-then') {
            if (evaluate(c.cond, vars)) assign(c.assign);
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
            assign(c.counter);
            if (valueOf(c.counter) > evaluate(c.last, vars)) pc = end + 1;
            continue;
          }
          if (c.kind === 'end-for') {
            const head = matchLoop(pc - 1, false);
            if (head < 0) { warn(b.line, 'ENDFOR has no FOR above it.', 'error'); continue; }
            const counter = blocks[head].macro.control.counter;
            const next = valueOf(counter) + 1;
            assign({ ...counter, value: { op: 'num', value: next } });
            if (valueOf(counter) <= evaluate(blocks[head].macro.control.last, vars)) pc = head + 1;
            continue;
          }

          // $REP 4 runs its body four times and does not ask anything. The
          // head counts it out, the tail counts it down.
          if (c.kind === 'times') {
            const head = pc - 1;
            const end = matchLoop(head, true);
            if (end < 0) {
              warn(b.line, `${dialect.keywords.rep || 'REP'} has no ${dialect.keywords.repEnd || 'END'}.`, 'error');
              continue;
            }
            if (!repsLeft.has(head)) repsLeft.set(head, Math.floor(evaluate(c.count, vars)));
            if (repsLeft.get(head) >= 1) continue;         // into the body
            repsLeft.delete(head);
            pc = end + 1;
            continue;
          }
          if (c.kind === 'end-times') {
            const head = matchLoop(pc - 1, false);
            if (head < 0) {
              warn(b.line, `${dialect.keywords.repEnd || 'END'} has no ${dialect.keywords.rep || 'REP'} above it.`, 'error');
              continue;
            }
            const left = (repsLeft.get(head) || 0) - 1;
            if (left >= 1) { repsLeft.set(head, left); pc = head + 1; continue; }
            repsLeft.delete(head);
            continue;
          }

          // REPEAT LABEL: run a section of the program again, P times, and
          // carry on after the REPEAT. The section is from the label to a
          // second label when one is named, else to the first ENDLABEL:
          // after it, else — the label being above — down to the REPEAT.
          if (c.kind === 'repeat-section' || c.kind === 'repeat-block') {
            const start = findLabel(b, c.start);
            if (start < 0) { warn(b.line, `REPEAT: there is no label called ${c.start} in this program.`, 'error'); continue; }
            let end = -1;
            if (c.kind === 'repeat-block') end = start;
            else if (c.end) {
              end = findLabel(b, c.end);
              if (end < 0) { warn(b.line, `REPEAT: there is no label called ${c.end} in this program.`, 'error'); continue; }
            } else {
              for (let i = start + 1; i < blocks.length && (blocks[i].src || null) === (b.src || null); i++) {
                const lab = blocks[i].macro && blocks[i].macro.label;
                if (lab && lab.toUpperCase() === 'ENDLABEL') { end = i; break; }
                if (i === pc - 1) break;
              }
              if (end < 0) end = start < pc - 1 ? pc - 2 : -1;
              if (end < 0) { warn(b.line, `REPEAT ${c.start}: the section has no end — no ENDLABEL: after the label, and the label is not above the REPEAT.`, 'error'); continue; }
            }
            if (end < start) { warn(b.line, `REPEAT: ${c.end || 'the end'} comes before ${c.start}.`, 'error'); continue; }
            if (callStack.length > 16) { warn(b.line, 'REPEAT nested too deep.', 'error'); continue; }
            const times = c.count ? Math.floor(evaluate(c.count, vars)) : 1;
            if (times < 1) continue;
            callStack.push({ ret: pc, remaining: times - 1, target: start, end, section: true });
            pc = start;
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
        // A condition that cannot be worked out guards nothing it should
        // run: on past its ENDIF, not into it.
        const c = b.macro.control;
        if (c && c.kind === 'if-block') {
          const to = matchIf(pc - 1, false);
          if (to >= 0) pc = to + 1;
        }
        continue;
      }
    }

    if (b.blockDelete) {
      b.skipped = true;
      continue;
    }

    // ---- the words a Siemens writes for itself ---------------------------
    if (b.modes) siemensModes(b);
    if (b.siemens && siemensStatement(b)) continue;
    if (b.toolName && !b.words.length) {
      st.pendingTool = b.toolName;
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
        callStack.push({ ret: pc, remaining: 0, target, scoped: true });
        vars.pushScope(name);
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
    let f, s, t, h, d, p, q, r, l, iArc, jArc, kArc, cr, ar, turns;
    // SUPA: this block in machine coordinates, every frame suppressed.
    let machineCoords = !!(b.modes && b.modes.includes('SUPA'));
    let fixedPoint = 1;

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
        case 'D': d = w.value; st.dNumber = w.value; break;
        case 'P': p = w.value; break;
        case 'Q': q = w.value; break;
        case 'R': r = w.value; break;
        case 'L': l = w.value; break;
        case 'FP': fixedPoint = w.value; break;
        // A Siemens arc: CR= its radius, AR= the angle it opens, TURN= the
        // whole turns it makes before it ends.
        case 'CR': cr = w.value; break;
        case 'AR': ar = w.value; break;
        case 'TURN': turns = w.value; break;
        default: break;
      }
    }

    // A control that writes its pot number after a decimal point — T0.07,
    // T.05, T0.7 are pots 7, 5 and 7 — means the same thing by it as T7
    // does elsewhere. Read from the digits rather than from the value: 0.7
    // and 0.07 are not the same number but are the same pot, and taking
    // the value times a hundred made one of them pot 70.
    // T="FACE MILL" chose the tool by its name.
    if (b.toolName) t = b.toolName;
    if (t !== undefined && dialect.toolDecimal && !b.toolName) {
      const word = b.words.find((w) => w.letter === 'T');
      const parts = word && /^[Tt]\s*(\d*)\.(\d*)$/.exec(word.text.replace(/\s+/g, ''));
      if (parts) {
        const whole = Number(parts[1] || 0);
        t = whole > 0 ? whole : Number(parts[2] || 0);
      }
    }

    // M6 for the tool already in the spindle: the control has nothing to
    // change, so its change macro does not run and the machine stays put.
    const sameTool = m.includes(6) && sameToolAs(t !== undefined ? t : st.pendingTool, st.tool);
    m6Block = m.includes(6) && !sameTool;

    // ---- Non-modal and modal G codes -------------------------------------
    const motionBefore = st.motion;
    let motionThisBlock = null;
    let g28 = false, g30 = false, g10 = false, g92set = false, g92clear = false, g75 = false;
    /** Set by codes whose X/Y/Z words are data, not a destination. */
    let axesConsumed = false;

    for (const code of g) {
      // A Siemens's further settable frames, G505 to G599.
      if (code >= 505 && code <= 599 && Number.isInteger(code) && dialect.id === 'siemens') {
        st.wcs = `G${code}`;
        continue;
      }
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
          // G04 X2. is two seconds, not a move to X2 — nor, with a drilling
          // cycle in force, another hole there.
          axesConsumed = true;
          break;
        }
        case 10: g10 = true; break;
        case 17: st.plane = 17; break;
        case 18: st.plane = 18; break;
        case 19: st.plane = 19; break;
        case 20: st.metric = false; break;
        case 21: st.metric = true; break;
        case 28: g28 = true; break;
        // Siemens: G74 back to the reference point, G75 to a fixed point —
        // FP=1, the default, being home — on the axes the block names. The
        // values in the block (G75 Z1.0) are only there to name them.
        case 75: g75 = true; axesConsumed = true; break;
        case 74:
          if (dialect.siemensWords) { g75 = true; axesConsumed = true; break; }
          motionThisBlock = 74;
          st.motion = 74;
          break;
        // G153 and G500: machine coordinates for the block, and no
        // settable frame — the Siemens forms of G53 and "no work offset".
        case 153: machineCoords = true; break;
        case 500: st.wcs = 'G500'; break;
        case 70: case 700: st.metric = false; break;
        case 71: case 710: st.metric = true; break;
        // Exact stop, continuous path and the rest of the smoothing modes:
        // how the control blends the path, not where it goes.
        case 9: case 60: case 601: case 602: case 603: case 641: case 642: case 643: case 644: case 645:
        case 290: case 291: case 450: case 451: case 931: case 961: case 971: break;
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
          updateXf();
          events.push({
            line: b.line, type: 'plane', moveIndex: moves.length,
            text: `G68.2 tilted plane at ${origin.join(', ')} (${mode === 2 ? 'RPY' : 'Euler ZXZ'} ${iArc || 0}, ${jArc || 0}, ${kArc || 0})`,
          });
          break;
        }
        case 69:
          if (st.tilt) events.push({ line: b.line, type: 'plane', moveIndex: moves.length, text: 'G69 tilted plane cancelled' });
          st.tilt = null;
          st.swivel = false;
          updateXf();
          break;
        case 43:
          st.lengthComp = true;
          st.hNumber = h !== undefined ? h : st.hNumber;
          if (h === undefined) warn(b.line, 'G43 without an H word; the control would use the last offset.', 'error');
          else {
            // T5 M06 G43 H5 changes the tool in the same block, so it is the
            // new tool the offset has to match, not the one going back.
            const holding = m.includes(6) ? (t !== undefined ? t : st.pendingTool) || st.tool : st.tool;
            if (holding && typeof holding === 'number' && h !== holding) warn(b.line, `G43 H${h} does not match the active tool T${holding}. On the machine this is a length-offset crash.`, 'error');
          }
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
          vars.push(args, p !== undefined ? `O${p}` : name);
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

    // A Fidia writes its feed a hundred times over: F80000 is 800 a minute.
    // It is how the control's own screen reads, so the number in the block
    // is not the number in the machine — see feedScale.
    if (f !== undefined) {
      st.feed = toMM(f, st.metric) * (dialect.feedScale || 1);
      st.feedRaw = f;
    }
    if (st.feedMode === 95 && !(st.rpm > 0) && !spokenFor.has('G95')) {
      spokenFor.add('G95');
      warn(b.line, 'Feed per revolution (G95) with no spindle speed; F is read as mm/min for the times.');
    }
    if (s !== undefined) st.rpm = s;
    if (t !== undefined) st.pendingTool = t;

    // ---- M codes ---------------------------------------------------------
    for (const code of m) {
      // What this machine does at this code, if its builder said. It runs
      // after the block, so the control has already recorded the tool
      // change or the spindle state the macro is there to carry out.
      if (code === 6 && sameTool) {
        events.push({ line: b.line, type: 'cycle', moveIndex: moves.length, text: `${toolLabel(st.tool)} is already in the spindle: no tool change` });
        continue;
      }
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
        case 0: case 1: {
          // What the line says beside it is usually the instruction the stop
          // is there for: M00 (TURN THE PART OVER).
          const stop = { line: b.line, type: 'stop', code, moveIndex: moves.length, text: code === 0 ? 'Program stop (M00)' : 'Optional stop (M01)' };
          const said = (b.comments || []).filter(Boolean).join(' ');
          if (said) stop.comment = said;
          if (curSrc) stop.source = curSrc;
          events.push(stop);
          break;
        }
        case 2: case 30:
          // The end of a called file on a control that ends them this way.
          if (code === returnCode && callStack.length) { returnFromCall(); break; }
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
          events.push({ line: b.line, type: 'toolchange', moveIndex: moves.length, tool: next, text: `Tool change ${toolLabel(next)}` });
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
          // And the offset's turn of the rotaries: G10 L2 P2 C60.
          for (const L of turning) if (axis[L] !== undefined) setOffsetAxis(key, L, axis[L]);
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
      // Reference return is a machine-coordinate move like any other, so
      // the axis goes home and the tip hangs its gauge length below.
      const drop = gaugeDrop();
      const at = (i) => home[i] + drop[i];
      const target = [
        axis.X !== undefined ? at(0) : st.pos[0],
        axis.Y !== undefined ? at(1) : st.pos[1],
        axis.Z !== undefined ? at(2) : st.pos[2],
      ];
      if (!hasAxis) { target[0] = at(0); target[1] = at(1); target[2] = at(2); }
      emitLinear(b.line, 'rapid', target, cfg.rapidRate);
      continue;
    }

    if (g75) {
      // Every axis the block names, at rapid, straight to the point — no
      // intermediate point, unlike G28. A rotary named goes to its zero.
      // It is the slides that go, whatever the head or table is turned to
      // and whatever frame or TCP is on: so the move is written as a
      // machine without TCP is told it, where Z home is the spindle face
      // on machine zero and the tip a gauge length under it.
      const point = fixedPoint === 2 ? cfg.g30 : cfg.machineZero;
      const g = cfg.gaugeLength || 0;
      const tcpWas = st.tcp;
      const swivelWas = st.swivel;
      setTcpMode(() => { st.tcp = 0; st.swivel = false; });
      const target = st.pos.slice();
      for (const [i, L] of ['X', 'Y', 'Z'].entries()) if (axis[L] !== undefined) target[i] = point[i] - (i === 2 ? g : 0);
      const turned = turning.filter((L) => axis[L] !== undefined);
      if (turned.length) {
        st.rotPrev = { ...st.rot };
        for (const L of turned) st.rot[L] = 0;
      }
      emitLinear(b.line, 'rapid', target, cfg.rapidRate);
      setTcpMode(() => { st.tcp = tcpWas; st.swivel = swivelWas; });
      if (st.xf) { st.tiltLocal = workToPlane(st.pos); st.tiltLocalPrev = st.tiltLocal; }
      continue;
    }

    // ---- Motion ----------------------------------------------------------
    if (axesConsumed) continue;
    const hasAxisWord = axis.X !== undefined || axis.Y !== undefined || axis.Z !== undefined;
    const motion = motionThisBlock !== null ? motionThisBlock : st.motion;

    if (MOTION_CYCLES.has(motion)) {
      // The initial level is where the tool stood when the cycle started,
      // and it stays put for every hole after: a G99 hole leaves the tool
      // at R, and the G98 hole after it still goes all the way back up.
      if (!MOTION_CYCLES.has(motionBefore)) st.cycleInit = st.pos[2];
      // In G91 R is measured from the initial level and Z from R, not
      // both from wherever the tool is — which drilled 8 mm short.
      if (r !== undefined) st.cycleR = st.absolute ? st.offset()[2] + toMM(r, st.metric) : st.cycleInit + toMM(r, st.metric);
      if (axis.Z !== undefined) {
        st.cycleZ = st.absolute ? resolveAxis(2, axis.Z, st.metric, false) : st.cycleR + toMM(axis.Z, st.metric);
      }
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

    if (hasRotaryWord) applyExtraAxes(axis, b.axisModes, machineCoords);

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

    const target = resolveLinear(axis, st.metric, machineCoords, b.axisModes);

    if (motion === 0) {
      emitLinear(b.line, 'rapid', target, cfg.rapidRate);
    } else if (motion === 1) {
      if (!(st.feed > 0)) warn(b.line, 'Feed move with no active F word; assuming 100 mm/min.', 'error');
      emitLinear(b.line, 'feed', target, st.feed > 0 ? st.feed : 100);
    } else if (motion === 2 || motion === 3) {
      const ccw = motion === 3;
      const feed = st.feed > 0 ? st.feed : 100;
      const am = b.axisModes || {};
      const words = { i: iArc, j: jArc, k: kArc, r, cr, ar, absolute: { I: am.I === 'AC', J: am.J === 'AC', K: am.K === 'AC' } };
      const tilted = st.xf && !machineCoords;
      const from = tilted ? st.tiltLocalPrev : st.pos;
      const to = tilted ? st.tiltLocal : target;
      const center = arcCentre(b.line, to, words, warn, from, tilted ? [0, 0, 0] : null, ccw);
      if (!center) {
        emitLinear(b.line, 'feed', target, feed);
      } else if (tilted) {
        emitArc(b.line, target, center, ccw, feed, { from, to, center }, turns || 0);
      } else {
        emitArc(b.line, target, center, ccw, feed, null, turns || 0);
      }
    }

    // MCALL CYCLE81(...): the cycle again, at the position just reached.
    if (st.mcall && hasAxisWord) runSiemensCycle(st.mcall.name, st.mcall.args, b.line);
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
    // I=AC(…): this one centre word measured from the work zero, whatever
    // the mode.
    const abs = words.absolute || {};
    const absOf = st.plane === 18 ? [abs.K, abs.I] : st.plane === 19 ? [abs.J, abs.K] : [abs.I, abs.J];
    const hasIJK = offs[0] !== undefined || offs[1] !== undefined;

    if (hasIJK) {
      const c = p0.slice();
      for (let n = 0; n < 2; n++) {
        const v = offs[n] === undefined ? 0 : toMM(offs[n], st.metric);
        c[ax[n]] = st.arcAbsolute || absOf[n] ? base[ax[n]] + v : p0[ax[n]] + v;
      }
      // Sanity check: the two radii should agree.
      const r0 = Math.hypot(p0[ax[0]] - c[ax[0]], p0[ax[1]] - c[ax[1]]);
      const r1 = Math.hypot(target[ax[0]] - c[ax[0]], target[ax[1]] - c[ax[1]]);
      if (Math.abs(r0 - r1) > Math.max(0.01, r0 * 0.001)) {
        warnFn(line, `Arc end point is ${(r1 - r0).toFixed(4)} mm off the programmed radius.`, 'error');
      }
      return c;
    }

    if (words.r !== undefined || words.cr !== undefined || words.ar !== undefined) {
      const a0 = p0[ax[0]], b0 = p0[ax[1]];
      const a1 = target[ax[0]], b1 = target[ax[1]];
      const da = a1 - a0, db = b1 - b0;
      const chord = Math.hypot(da, db);
      // Some controls write the radius of a minor arc negative, which is
      // the opposite of what the sign means here. Flipping it in one place
      // is what keeps the arc code one piece of arithmetic. A Siemens CR
      // means what the sign means here — negative, the long way round — and
      // an opening angle AR makes the radius from the chord, the long way
      // round past 180°.
      let R;
      if (words.cr !== undefined) {
        R = toMM(words.cr, st.metric);
      } else if (words.ar !== undefined) {
        const open = Math.abs(words.ar);
        if (!(open > 1e-9 && open < 360 - 1e-9)) {
          warnFn(line, `AR=${words.ar}: an arc opens by more than 0° and less than 360°.`, 'error');
          return null;
        }
        R = chord / (2 * Math.sin((open * Math.PI) / 360)) * (open > 180 ? -1 : 1);
      } else {
        R = toMM(words.r, st.metric) * (dialect.arcRSign || 1);
      }
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

  // ---- Siemens ---------------------------------------------------------------

  /** Modes a Siemens writes as words: TRAORI, TRAFOOF, DIAMON and the rest. */
  function siemensModes(b) {
    for (const mode of b.modes) {
      if (mode === 'TRAORI' || mode === 'TRAFOOF') {
        const on = mode === 'TRAORI';
        if (on !== (st.tcp !== 0)) {
          events.push({ line: b.line, type: 'tcp', moveIndex: moves.length, text: on ? 'Tool centre point control on (TRAORI)' : 'Tool centre point control off (TRAFOOF)' });
        }
        setTcpMode(() => { st.tcp = on ? 4 : 0; });
      } else if ((mode === 'DIAMON' || mode === 'DIAM90') && !spokenFor.has(mode)) {
        // Diameter programming is a lathe's: X read as a diameter. A mill
        // has no use for it, and this reader keeps X a position.
        spokenFor.add(mode);
        warn(b.line, `${mode} is diameter programming, for turning; X is read as a position here.`);
      }
      // DIAMOF, SUPA (read where the axes are), and the smoothing and
      // orientation modes change nothing about where the tool goes.
    }
  }

  /**
   * A block that is one Siemens statement: a frame, a call written as a
   * function, MCALL. True when the block has been dealt with whole.
   */
  function siemensStatement(b, now = false) {
    const sw = b.siemens;
    if (sw.op === 'mcall-off') {
      if (st.mcall) events.push({ line: b.line, type: 'cycle', moveIndex: moves.length, text: `MCALL ${st.mcall.name} ended` });
      st.mcall = null;
      return true;
    }
    if (sw.op === 'frame') {
      siemensFrame(b);
      return true;
    }
    if (sw.op === 'ret') {
      returnFromCall();
      return true;
    }
    if (sw.op !== 'call') return false;
    if (sw.after && !now) {
      afterCall = b;
      return false;
    }
    // Settings the control keeps for the machining that follows — high
    // speed, the message line, the blank's outline for its own graphics —
    // none of which moves anything. Their arguments are the control's own
    // constants (_ROUGH, _FINISH), not this program's, so they are not read.
    if (IGNORED_CALLS.has(sw.name) && !sw.modal) return true;
    let args;
    try {
      if (!sw.args) sw.args = parseArgs(sw.argsText, dialect);
      args = sw.args.map((a) => (a === null ? null : evaluate(a, vars)));
    } catch (err) {
      warn(b.line, `${sw.name}: ${err.message}.`, 'error');
      return true;
    }
    const name = sw.name;
    if (sw.modal) {
      if (!DRILL_CYCLES.has(name)) {
        warn(b.line, `MCALL ${name}: only the drilling cycles are run modally here.`, 'error');
        return true;
      }
      st.mcall = { name, args };
      events.push({ line: b.line, type: 'cycle', moveIndex: moves.length, text: `MCALL ${name}: at every position that follows` });
      return true;
    }
    if (name === 'CYCLE800') { cycle800(args, b.line); return true; }
    if (DRILL_CYCLES.has(name)) { runSiemensCycle(name, args, b.line); return true; }
    // A program of the shop's own, with arguments: run it.
    const target = namedTarget(name);
    if (target !== undefined) {
      if (callStack.length > 16) { warn(b.line, 'Subprogram nesting too deep.', 'error'); return true; }
      callStack.push({ ret: pc, remaining: Math.max(1, sw.count || 1) - 1, target, scoped: true });
      vars.pushScope(name);
      pc = target;
      return true;
    }
    if (sw.bare) {
      warn(b.line, `There is no subprogram called ${name}: none in this program's files or on the machine (Machine › Macros).`, 'error');
      return true;
    }
    if (!spokenFor.has(name)) {
      spokenFor.add(name);
      warn(b.line, `${name} is not simulated: no toolpath comes from it.`, /^CYCLE|^POCKET|^SLOT|^HOLES|^LONGHOLE/.test(name) ? 'warning' : 'error');
    }
    return true;
  }

  /**
   * TRANS, ROT and their additive forms: a frame of the program's own
   * inside the work offset. The plain forms replace the whole frame — and
   * with nothing after them clear it; ATRANS and AROT add to it, in its
   * own axes. ROT turns Z, then Y, then X; RPL turns in the working plane.
   */
  function siemensFrame(b) {
    const name = b.siemens.name;
    const v = {};
    for (const w of b.words) v[w.letter] = w.value;
    const has = ['X', 'Y', 'Z', 'RPL'].some((L) => v[L] !== undefined);
    const additive = name[0] === 'A';
    const base = name.replace(/^A/, '');
    if (!has) {
      if (additive) return;
      if (base === 'ROT') {
        // ROT on its own takes the turns away — ROT's and AROT's alike —
        // and leaves the shift where it was.
        if (st.frame) {
          const shift = [st.frame[12], st.frame[13], st.frame[14]];
          st.frame = shift.some((v) => Math.abs(v) > 1e-12) ? m4.fromTranslation(m4.create(), shift) : null;
          events.push({ line: b.line, type: 'plane', moveIndex: moves.length, text: 'ROT: rotations cleared' });
          updateXf();
        }
        return;
      }
      if (st.frame) events.push({ line: b.line, type: 'plane', moveIndex: moves.length, text: `${name}: programmable frame cleared` });
      st.frame = null;
      updateXf();
      return;
    }
    let mat;
    if (base === 'TRANS') {
      mat = m4.fromTranslation(m4.create(), [0, 1, 2].map((i) => toMM(v['XYZ'[i]] || 0, st.metric)));
    } else if (base === 'ROT') {
      mat = m4.create();
      const turn = (axisV, deg) => {
        if (!deg) return;
        m4.multiply(mat, mat, m4.fromRotation(m4.create(), axisV, deg2rad(deg)));
      };
      if (v.RPL !== undefined) {
        turn(st.plane === 18 ? [0, 1, 0] : st.plane === 19 ? [1, 0, 0] : [0, 0, 1], v.RPL);
      } else {
        turn([0, 0, 1], v.Z || 0);
        turn([0, 1, 0], v.Y || 0);
        turn([1, 0, 0], v.X || 0);
      }
    } else {
      if (!spokenFor.has(name)) {
        spokenFor.add(name);
        warn(b.line, `${name} is not modelled: the path is read unscaled and unmirrored.`);
      }
      return;
    }
    st.frame = additive && st.frame ? m4.multiply(m4.create(), st.frame, mat) : mat;
    updateXf();
    events.push({ line: b.line, type: 'plane', moveIndex: moves.length, text: `${name} ${b.words.map((w) => `${w.letter}${+w.value.toFixed(3)}`).join(' ')}` });
  }

  /**
   * CYCLE800: swivel the working plane, and the head or table with it.
   *
   *   CYCLE800(_FR, _TC, _ST, _MODE, _X0, _Y0, _Z0, _A, _B, _C, _X1, _Y1, _Z1, _DIR, ...)
   *
   * _MODE's top two bits say how the angles are given — axis by axis (the
   * other bits then give the order, two to an axis: 1 X, 2 Y, 3 Z, so 57
   * is X then Y then Z), as a solid angle, or as the rotary positions
   * themselves. Each turn is about the axes the last one left. _X0.._Z0
   * shift the origin before turning, _X1.._Z1 after. _ST 1 adds to the
   * plane already there. _FR retracts first (1 in Z, 2 in Z then X and Y),
   * and a _DIR of 0 turns the plane without swinging the machine.
   *
   * CYCLE800() with nothing in it takes the plane away again.
   */
  function cycle800(args, line) {
    const n = (i) => (Number.isFinite(Number(args[i])) && args[i] !== null && typeof args[i] !== 'string' ? Number(args[i]) : 0);
    if (!args.length || args.every((a) => a === null || a === '' || a === 0)) {
      if (st.tilt) events.push({ line, type: 'plane', moveIndex: moves.length, text: 'CYCLE800() swivel plane cleared' });
      setTcpMode(() => { st.swivel = false; });
      st.tilt = null;
      updateXf();
      return;
    }
    const fr = n(0);
    const additive = n(2) % 10 === 1;
    const mode = Math.round(n(3));
    const kind = (mode >> 6) & 3;
    const angles = [n(7), n(8), n(9)];
    const dir = args[13] === null || args[13] === undefined ? -1 : n(13);
    const kin = cfg.kinematics;

    const rot = m4.create();
    const turn = (axisIndex, deg) => {
      if (!deg || !axisIndex) return;
      const a = [[1, 0, 0], [0, 1, 0], [0, 0, 1]][axisIndex - 1];
      m4.multiply(rot, rot, m4.fromRotation(m4.create(), a, deg2rad(deg)));
    };
    let direct = null;
    if (kind === 0 || kind === 2) {
      if (kind === 2 && !spokenFor.has('CYCLE800 projection')) {
        spokenFor.add('CYCLE800 projection');
        warn(line, 'CYCLE800 projection angles are read as axis-by-axis angles; check the swivelled plane.');
      }
      const order = [mode & 3, (mode >> 2) & 3, (mode >> 4) & 3];
      if (!order.some(Boolean)) order.splice(0, 3, 1, 2, 3);
      order.forEach((ax, k) => turn(ax, angles[k]));
    } else if (kind === 1) {
      // A solid angle: round Z in the plane, then tipped about the new Y.
      turn(3, angles[0]);
      turn(2, angles[1]);
    } else {
      // The rotary positions themselves, in the order the machine has them.
      if (!kin || !kin.rotaries().length) {
        warn(line, 'CYCLE800 with rotary positions needs a machine with rotary axes.', 'error');
        return;
      }
      // _A is rotary axis 1 and _B rotary axis 2, the way Siemens counts
      // them: the head's axes before the table's, each from the machine
      // outwards — A then C on a trunnion, B then C on a head and table,
      // C then B on a fork head.
      direct = {};
      swivelAxes(kin).forEach((node, k) => { if (k < 3) direct[node.letter] = angles[k]; });
      // The plane is the tool's own frame as the part sees it with the
      // rotaries there: Z up the tool, and X and Y turned with whatever
      // turned — so a C turn of the table turns the plane, which the
      // direction of the tool alone could never say.
      const frame = kin.toolInWork({ ...st.rot, ...direct }, cfg.gaugeLength || 0).matrix;
      m4.copy(rot, frame);
      rot[12] = 0; rot[13] = 0; rot[14] = 0;
    }
    const shift0 = [n(4), n(5), n(6)].map((x) => toMM(x, st.metric));
    const shift1 = [n(10), n(11), n(12)].map((x) => toMM(x, st.metric));
    let plane = m4.multiply(m4.create(), m4.fromTranslation(m4.create(), shift0), rot);
    plane = m4.multiply(m4.create(), plane, m4.fromTranslation(m4.create(), shift1));
    if (additive && st.tilt) plane = m4.multiply(m4.create(), st.tilt, plane);

    // The cycle retracts and swings with the slides, not the tip: Z up to
    // its stop, then the head or table turns where it stands. So both are
    // written as a machine without TCP is told them, whatever was on.
    const tcpWas = st.tcp;
    setTcpMode(() => { st.swivel = false; st.tcp = 0; });
    if (fr === 1 || fr === 2 || fr === 4) {
      const g = cfg.gaugeLength || 0;
      const up = st.pos.slice();
      up[2] = cfg.machineZero[2] - g;
      if (Math.abs(up[2] - st.pos[2]) > 1e-9) emitLinear(line, 'rapid', up, cfg.rapidRate);
      if (fr === 2) {
        const home = [cfg.machineZero[0], cfg.machineZero[1], up[2]];
        if (dist3(home, st.pos) > 1e-9) emitLinear(line, 'rapid', home, cfg.rapidRate);
      }
    }
    st.tilt = plane;
    updateXf();
    const swivelOn = () => {
      // The angles the plane is made at; a rotary turned on its own later
      // turns the part under the plane, not the plane.
      st.swivelRot = {};
      for (const L of turning) st.swivelRot[L] = st.rot[L] || 0;
      setTcpMode(() => { st.swivel = true; st.tcp = tcpWas; });
      updateXf();
    };
    events.push({ line, type: 'plane', moveIndex: moves.length, text: `CYCLE800 swivel plane (${['axis by axis', 'solid angle', 'projection', 'rotary positions'][kind]} ${angles.map((x) => +x.toFixed(3)).join(', ')})` });

    if (dir === 0) { swivelOn(); return; }
    let sol = direct;
    if (!sol) {
      if (!kin || !kin.rotaries().length) {
        warn(line, 'CYCLE800 swings the machine, which needs a machine with rotary axes; load a 5-axis machine in Setup.', 'error');
        swivelOn();
        return;
      }
      const normal = m4.normalize(m4.transformDir([0, 0, 0], st.tilt, [0, 0, 1]));
      sol = kin.rotariesForToolAxis(normal, st.rot, cfg.gaugeLength || 0);
      if (!sol) {
        warn(line, `CYCLE800 cannot reach a tool axis of ${normal.map((x) => x.toFixed(3)).join(', ')} within the machine's travel.`, 'error');
        swivelOn();
        return;
      }
    }
    st.rotPrev = { ...st.rot };
    Object.assign(st.rot, sol);
    emitLinear(line, 'rapid', st.pos.slice(), cfg.rapidRate);
    events.push({ line, type: 'align', moveIndex: moves.length, text: `CYCLE800 swung the machine: ${Object.entries(sol).map(([k, x]) => `${k}${x.toFixed(3)}`).join(' ')}` });
    swivelOn();
  }

  /**
   * A Siemens drilling cycle at the position the tool stands over.
   *
   * The first five are the same on all of them: RTP the retract plane and
   * RFP the reference plane, both absolute; SDIS the safety distance above
   * RFP, which is where feeding starts; DP the final depth, absolute — or
   * DPR, the depth below RFP, which wins when both are given. Depths run
   * down the working plane's own Z, so a swivelled plane drills down its
   * own axis.
   */
  function runSiemensCycle(name, args, line) {
    const num = (i, dflt = 0) => (args[i] === null || args[i] === undefined || typeof args[i] === 'string' ? dflt : Number(args[i]));
    const given = (i) => args[i] !== null && args[i] !== undefined && typeof args[i] !== 'string';
    if (st.plane !== 17 && !spokenFor.has('cycle plane')) {
      spokenFor.add('cycle plane');
      warn(line, `${name} is drilled along Z; the cycles here are for G17.`);
    }
    const mm = (v) => toMM(v, st.metric);
    const rtp = mm(num(0));
    const rfp = mm(num(1));
    const sdis = Math.abs(mm(num(2)));
    const depth = given(4) && num(4) !== 0 ? rfp - Math.abs(mm(num(4))) : mm(num(3));
    const approach = rfp + sdis;
    // Every cycle feeds at F but the tapping ones, which go at the pitch.
    const tapping = name === 'CYCLE84' || name === 'CYCLE840';
    const feed = st.feed > 0 ? st.feed : 100;
    if (!(st.feed > 0) && !(tapping && st.rpm > 0)) warn(line, `${name} with no active F word; assuming 100 mm/min.`, 'error');
    const here = workToProg(st.pos);
    const [hx, hy] = here;
    const go = (z, kind, f, x = hx, y = hy) => {
      const local = [x, y, z];
      const w = progToWork(local);
      if (st.xf) { st.tiltLocalPrev = st.tiltLocal; st.tiltLocal = local; }
      emitLinear(line, kind, w, kind === 'rapid' ? cfg.rapidRate : f);
    };
    // Down to where feeding starts: from above it, straight down; from
    // below — a cycle called with the tool low — up first, then over.
    if (here[2] < approach - 1e-9) go(approach, 'rapid', 0, here[0], here[1]);
    go(approach, 'rapid', 0);
    const dwell = (secs) => { if (secs > 0) emitDwell(line, secs); };
    const out = () => go(Math.max(rtp, approach), 'rapid', 0);

    switch (name) {
      case 'CYCLE81':
        go(depth, 'feed', feed);
        out();
        break;
      case 'CYCLE82':
        go(depth, 'feed', feed);
        dwell(num(5));
        out();
        break;
      case 'CYCLE83': {
        // Deep hole: FDEP (absolute) or FDPR (below RFP) for the first
        // stroke, each stroke after it DAM shorter but never shorter than
        // DAM; VARI 0 breaks the chip by backing off a millimetre, VARI 1
        // clears it by going back up to RFP + SDIS between strokes.
        const first = given(6) && num(6) ? rfp - Math.abs(mm(num(6))) : given(5) ? mm(num(5)) : depth;
        const dam = Math.abs(mm(num(7)));
        const dtb = num(8);
        const dts = num(9);
        const frf = given(10) && num(10) > 0 ? Math.min(1, num(10)) : 1;
        const vari = num(11);
        const vrt = given(14) && num(14) > 0 ? mm(num(14)) : 1;
        let z = approach;
        let step = Math.max(rfp - Math.max(first, depth), 1e-3);
        let stroke = 0;
        while (z > depth + 1e-6 && stroke < 10000) {
          if (stroke > 0 && dam > 0) step = Math.max(step - dam, dam);
          const next = stroke === 0 ? Math.max(first, depth) : Math.max(depth, z - step);
          go(next, 'feed', stroke === 0 ? feed * frf : feed);
          stroke++;
          if (next <= depth + 1e-6) break;
          if (vari === 1) {
            go(approach, 'rapid', 0);
            dwell(dts);
            go(next + 1, 'rapid', 0);
          } else {
            go(next + vrt, 'rapid', 0);
          }
          z = next;
        }
        dwell(dtb);
        out();
        break;
      }
      case 'CYCLE84':
      case 'CYCLE840': {
        // Tapping: down and back up along the thread, at the pitch times
        // the speed — PIT, or the pitch of the MPIT metric size.
        const pitch = name === 'CYCLE84'
          ? (given(8) && num(8) ? Math.abs(mm(num(8))) : metricPitch(num(7)))
          : (given(10) && num(10) ? Math.abs(mm(num(10))) : metricPitch(num(9)));
        const tapFeed = pitch > 0 && st.rpm > 0 ? pitch * st.rpm : feed;
        go(depth, 'feed', tapFeed);
        dwell(num(5));
        go(approach, 'feed', tapFeed);
        out();
        break;
      }
      case 'CYCLE85': {
        // Boring, fed in at FFR and fed out at RFF.
        const ffr = given(6) && num(6) > 0 ? mm(num(6)) : feed;
        const rff = given(7) && num(7) > 0 ? mm(num(7)) : ffr;
        go(depth, 'feed', ffr);
        dwell(num(5));
        go(approach, 'feed', rff);
        out();
        break;
      }
      case 'CYCLE86': {
        // Boring with the spindle stopped at the bottom and the tool lifted
        // off the wall — RPA in X, RPO in Y, RPAP in Z — before it comes out.
        go(depth, 'feed', feed);
        dwell(num(5));
        const ox = hx + mm(num(7));
        const oy = hy + mm(num(8));
        go(depth + mm(num(9)), 'rapid', 0, ox, oy);
        go(approach, 'rapid', 0, ox, oy);
        go(approach, 'rapid', 0);
        out();
        break;
      }
      case 'CYCLE87':
      case 'CYCLE88':
        // Boring with a stop at the bottom: the operator brings it out.
        go(depth, 'feed', feed);
        if (name === 'CYCLE88') dwell(num(5));
        out();
        break;
      case 'CYCLE89':
        go(depth, 'feed', feed);
        dwell(num(5));
        go(approach, 'feed', feed);
        out();
        break;
      default:
        break;
    }
  }

  /** Expand a drilling canned cycle into discrete moves. */
  function runCycle(code, line, hx, hy) {
    const rPlane = st.cycleR;
    const zBottom = st.cycleZ;
    const feed = st.cycleF > 0 ? st.cycleF : 100;
    const startZ = Math.max(st.pos[2], rPlane);

    // Position over the hole at the current (safe) height, then to the R
    // plane — the second of which is no move at all after a G99 hole.
    emitLinear(line, 'rapid', [hx, hy, startZ], cfg.rapidRate);
    if (Math.abs(startZ - rPlane) > 1e-9) emitLinear(line, 'rapid', [hx, hy, rPlane], cfg.rapidRate);

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

    // P is in the same units as G04's: P500 is half a second on a Fanuc,
    // and guessing from the size of the number made it eight minutes.
    if ((code === 82 || code === 89) && st.cycleP > 0) emitDwell(line, cfg.dwellPUnits === 'ms' ? st.cycleP / 1000 : st.cycleP);
    if (code === 84) emitDwell(line, 0.1);

    const retractTo = st.retractMode === 98 ? Math.max(st.cycleInit, rPlane) : rPlane;
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
    variablePrefix: registers.main,
    /** The banks this control has and what each range of numbers is for. */
    registers,
    /** Every block the run read, in order, and the move each started at. */
    blockLog: blockLog.finish(),
    /** What the program declared, and the machine data it used. */
    namedVariables: vars.catalogueList(),
    /** Every change to a variable that lasts, in the order it happened. */
    variableTrace: vars.trace || [],
    variableTraceTruncated: vars.traceTruncated,
    /** Which control this program looks written for, when it is not this one. */
    suggested,
    /**
     * The letter that turns the work rather than the machine, when this
     * control has one and the machine has not been modelled with it.
     */
    indexer: indexerOf(cfg),
    /**
     * The letter that runs down the tool, when this control has one and
     * the machine has no slide of that name.
     */
    alongTool: alongToolOf(cfg),
    /**
     * The lines that fill in the machine's own tables and were skipped —
     * the tool-table block a Fidia program opens with. Kept so the summary
     * can say what was passed over instead of passing over it quietly.
     */
    settings: blocks.filter((b) => b.setting)
      .map((b) => ({ line: b.line, name: b.setting.name, text: b.setting.text })),
  };
}
