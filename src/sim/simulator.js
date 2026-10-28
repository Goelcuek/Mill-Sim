// The simulation loop.
//
// Walks the interpreted move list, sub-steps each move finely enough that
// the swept tool leaves no gaps in the stock, removes material and
// reports every crash it finds. It is time-sliced: `run(budgetMs)` does as
// much work as fits in a frame and returns, so the UI stays responsive on
// programs with millions of moves.

import { checkFixtures, checkLimits, checkTable, checkSolids, meshGrid } from './collision.js';
import * as m4 from '../core/mat4.js';
import { homeOf, limitsInScene } from '../machine/config.js';
import { gougeDepth } from './target.js';
import { checkReference, referenceSkyline, skylineOver, insideColumns } from './referenceContact.js';
import { placeSolid, boxesMeet, solidContact, solidIntoStock, solidIntoReference } from './machineContact.js';

export const COLLISION_TYPES = {
  holder: { label: 'Holder / shank crash', severity: 'error' },
  rapid: { label: 'Rapid into material', severity: 'error' },
  fixture: { label: 'Fixture collision', severity: 'error' },
  table: { label: 'Table collision', severity: 'error' },
  casting: { label: 'Machine collision', severity: 'error' },
  machine: { label: 'Machine collision', severity: 'error' },
  limit: { label: 'Travel limit exceeded', severity: 'error' },
  spindle: { label: 'Cutting with spindle stopped', severity: 'warning' },
  notool: { label: 'No tool assembly loaded', severity: 'warning' },
  deep: { label: 'Depth of cut exceeds flute length', severity: 'error' },
  gouge: { label: 'Gouge into the reference part', severity: 'error' },
  part: { label: 'Reference part collision', severity: 'error' },
  near: { label: 'Near miss', severity: 'warning' },
};

/**
 * Findings kept of each kind. Of each kind, not in all: a program that runs
 * past a travel limit on every line filled a shared 400 with those, and the
 * gouges and crashes found after it were never written down.
 */
const MAX_COLLISIONS = 400;
const UP = [0, 0, 1];
const DEG = Math.PI / 180;

/**
 * A box round a casting solid, in its axis's frame: the matrix into the
 * box's own frame and its half sizes. A box is its own; a cylinder is the
 * box it stands in; a mesh is the box round its triangles.
 */
function boundOf(s) {
  if (s.kind === 'mesh') {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.tris.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], s.tris[i + a]);
        hi[a] = Math.max(hi[a], s.tris[i + a]);
      }
    }
    if (!(lo[0] <= hi[0])) return { toBox: m4.create(), boxHalf: [0, 0, 0] };
    return {
      toBox: m4.fromTranslation(m4.create(), lo.map((v, a) => -(v + hi[a]) / 2)),
      boxHalf: lo.map((v, a) => (hi[a] - v) / 2),
    };
  }
  const r = s.kind === 'cyl' ? Math.max(s.r0, s.r1) : 0;
  return { toBox: s.toLocal, boxHalf: s.kind === 'box' ? s.half : [r, s.h / 2, r] };
}

/**
 * Could anything within `pad` of the segments a0–b0 … a1–b1 (the tool's
 * axis at two poses, and every place between them) be inside the box
 * `half`? The four ends' box, grown by the pad, against the box itself:
 * never a miss, and tight for the long thin castings a sphere is not.
 */
function sweepNearBox(m0, m1, a0, b0, a1, b1, pad, half) {
  const q = [0, 0, 0];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const take = (m, p) => {
    applyRigid(m, p, q);
    for (let k = 0; k < 3; k++) {
      if (q[k] < lo[k]) lo[k] = q[k];
      if (q[k] > hi[k]) hi[k] = q[k];
    }
  };
  take(m0, a0); take(m0, b0); take(m1, a1); take(m1, b1);
  for (let k = 0; k < 3; k++) if (lo[k] - pad > half[k] || hi[k] + pad < -half[k]) return false;
  return true;
}

function applyRigid(m, p, out) {
  out[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  out[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  out[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  return out;
}

/** How a tool's name is looked up among the slots: by itself, not by case. */
export const slotNameKey = (name) => `name:${String(name).trim().toLowerCase()}`;

/** Distance from p to the segment a–b. */
function pointSegment(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ll = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  let t = ll > 0 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ll : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
}

/** The least distance between segments p0–p1 and q0–q1, after Ericson. */
function segmentSegment(p0, p1, q0, q1) {
  const d1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const d2 = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]];
  const r = [p0[0] - q0[0], p0[1] - q0[1], p0[2] - q0[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const clamp = (v) => Math.max(0, Math.min(1, v));
  let s = 0;
  let t = 0;
  if (a <= 1e-12 && e <= 1e-12) return Math.hypot(...r);
  if (a <= 1e-12) {
    t = clamp(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      s = clamp(-c / a);
    } else {
      const b = dot(d1, d2);
      const den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a); } else if (t > 1) { t = 1; s = clamp((b - c) / a); }
    }
  }
  return Math.hypot(p0[0] + d1[0] * s - q0[0] - d2[0] * t, p0[1] + d1[1] * s - q0[1] - d2[1] * t, p0[2] + d1[2] * s - q0[2] - d2[2] * t);
}

/** Turn a point about Z, which is what indexing the work amounts to. */
function spinZ(p, deg) {
  if (!deg) return p;
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

/** Interpolate two unit directions along the shorter great-circle arc. */
function slerp(a, b, t) {
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const theta = Math.acos(d);
  if (theta < 1e-6) return b.slice();
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}
const ZERO_ROT = { A: 0, B: 0, C: 0 };

/** Cached per-move segment lengths. */
function segmentsOf(mv) {
  if (mv._segLen) return mv._segLen;
  const p = mv.path;
  const n = p.length / 3 - 1;
  const len = new Float64Array(Math.max(n, 1));
  const cum = new Float64Array(Math.max(n, 1) + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(p[i * 3 + 3] - p[i * 3], p[i * 3 + 4] - p[i * 3 + 1], p[i * 3 + 5] - p[i * 3 + 2]);
    len[i] = d;
    total += d;
    cum[i + 1] = total;
  }
  mv._segLen = len;
  mv._segCum = cum;
  mv._segTotal = total;
  return len;
}

/** Do two tool axes point the same way, near enough that nothing swings? */
function sameAxis(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 1 - 1e-12;
}

export class Simulator {
  constructor() {
    this.program = null;
    this.stock = null;
    this.machine = null;
    this.fixtures = [];
    /** The machine's castings as solids on their axes; see setCastings. */
    this.castings = [];
    this.slots = new Map();     // tool number -> { built, spheres, index }
    this.fallbackSlot = null;
    /** Reference-part surface on the stock grid; cutting below it gouges. */
    this.target = null;
    /** Stop the run at an error finding; the app asks for it while playing. */
    this.haltOnCollision = false;
    /** Kinds of finding that do not stop it: those switched off in the list. */
    this.quietKinds = [];
    this.gougeTolerance = 0.02;
    /**
     * Columns a single swept chunk may touch, which sets the chunk length.
     * A stationary Ø10 cutter alone covers 126k columns at 0.025 mm, so this
     * has to be large enough that the chunk is the *band* budget and not
     * merely the disc — otherwise the chunk collapses to nothing and the
     * sweep degenerates back into stamping.
     */
    this.columnBudget = 2_000_000;
    /** Collision probes are point tests, so they get their own spacing. */
    this.probeSpacing = 2.5;
    /**
     * The machine, when one with rotary axes is loaded. Without it every
     * move is taken as tool-down-Z, which is what a 3-axis program means
     * and what the fast swept carver assumes.
     */
    this.kinematics = null;
    /** Cosine below which a move counts as tilted rather than upright. */
    this.uprightCos = Math.cos(0.25 * Math.PI / 180);
    this.reset();
  }

  /**
   * @param {{program:object, stock:object, slots:Map, fallbackSlot:object,
   *          machine:object, fixtures:Array}} opts
   */
  load(opts) {
    if (opts.program !== undefined) this.program = opts.program;
    if (opts.stock !== undefined) this.stock = opts.stock;
    if (opts.slots !== undefined) this.slots = opts.slots;
    if (opts.fallbackSlot !== undefined) this.fallbackSlot = opts.fallbackSlot;
    if (opts.machine !== undefined) this.machine = opts.machine;
    if (opts.kinematics !== undefined) this.kinematics = opts.kinematics;
    if (opts.fixtures !== undefined) this.fixtures = opts.fixtures || [];
    if (opts.castings !== undefined) this.setCastings(opts.castings);
    if (opts.target !== undefined) this.target = opts.target;
    if (opts.gougeTolerance !== undefined) this.gougeTolerance = opts.gougeTolerance;
    if (opts.checks !== undefined) this.checks = opts.checks;
    if (opts.analyzer !== undefined) this.analyzer = opts.analyzer;
    // A different program, tool table or stock is a different answer.
    if (this.analyzer && (opts.program !== undefined || opts.slots !== undefined
      || opts.fallbackSlot !== undefined || opts.stock !== undefined)) this.analyzer.invalidate();
    this.reset();
  }

  /**
   * Update settings that do not change what has already been cut.
   *
   * `load()` resets the run, which is right when the program, the stock or
   * the machine's geometry changes and wrong when all that changed is a
   * collision threshold or which fixtures are in the way.
   */
  retune(opts) {
    if (opts.machine !== undefined) this.machine = opts.machine;
    if (opts.fixtures !== undefined) this.fixtures = opts.fixtures || [];
    if (opts.castings !== undefined) this.setCastings(opts.castings);
    if (opts.gougeTolerance !== undefined) this.gougeTolerance = opts.gougeTolerance;
    if (opts.checks !== undefined) this.checks = opts.checks;
  }

  reset() {
    this.moveIndex = 0;
    this.segIndex = 0;
    this.segPos = 0;            // mm travelled into the current segment
    this.time = 0;              // simulated seconds
    this.distance = 0;
    /** The finding the run stopped at, while it waits; see haltOnCollision. */
    this.halted = null;
    this.finished = !this.program || !this.program.moves.length;
    this.collisions = [];
    this.collisionKeys = new Map();
    /** How many findings of each kind are kept; see MAX_COLLISIONS. */
    this.collisionKinds = new Map();
    /** Findings of a kind past its cap: still counted, not listed. */
    this.collisionsDropped = 0;
    this.removedVolume = 0;
    this.peakMrr = 0;
    this.currentTool = 0;
    this.activeSlot = this.fallbackSlot;
    this.pos = this.program && this.program.moves.length
      ? this.program.moves[0].from.slice()
      : [0, 0, 0];
    this.u = 0;
    this.moveStats = this.program ? new Float32Array(this.program.moves.length) : new Float32Array(0);
    if (this.stock) this.stock.reset();
    // Cutting loads come out of the run, so they start again with it.
    if (this.analyzer) this.analyzer.reset(this.program ? this.program.moves.length : 0);
    this.notified = new Set();
  }

  get totalTime() {
    return this.program ? this.program.stats.cycleTime : 0;
  }

  get progress() {
    const t = this.totalTime;
    return t > 0 ? Math.min(1, this.time / t) : this.finished ? 1 : 0;
  }

  /**
   * Tool assembly in effect for a T number — or for a name, on a control
   * that chooses its tools by name (T="FACE MILL 50"), matched against
   * the assemblies' and their tools' names without regard to case.
   */
  slotFor(toolNumber) {
    const key = typeof toolNumber === 'string' ? slotNameKey(toolNumber) : toolNumber;
    if (this.slots.has(key)) return this.slots.get(key);
    if (toolNumber && !this.notified.has(`t${toolNumber}`)) {
      this.notified.add(`t${toolNumber}`);
      this.report('notool', {
        line: this.program.moves[this.moveIndex] ? this.program.moves[this.moveIndex].line : 0,
        message: typeof toolNumber === 'string'
          ? `T="${toolNumber}": no assembly or tool of that name; the fallback assembly is used.`
          : `T${toolNumber} has no assembly assigned; the fallback assembly is used.`,
      });
    }
    return this.fallbackSlot;
  }

  /**
   * Stop the run at a crash, when asked to: an error of a kind not left
   * out stops it where it is found, before another chunk is worked out —
   * a holder buried deep in the part costs a great deal to follow, chunk
   * after chunk, and following it is not what anybody wants by then.
   */
  haltFor(type, severity, data) {
    if (!this.haltOnCollision || this.halted || severity !== 'error') return;
    if (this.quietKinds && this.quietKinds.includes(type)) return;
    const label = (COLLISION_TYPES[type] || { label: type }).label;
    const message = typeof data.message === 'function' ? data.message(data.depth || 0) : data.message;
    this.halted = { type, label, line: data.line, message, moveIndex: this.moveIndex };
  }

  /**
   * Go on from a stop: what is left of the block that stopped the run is
   * passed over — not cut, not checked — and the run picks up at the
   * block after it, the tool where that block would have left it.
   */
  skipBlock() {
    const moves = this.program ? this.program.moves : [];
    // The block is the one the crash was found in — which the run may have
    // finished already, when it was found on its last stretch: then there
    // is nothing of it left to pass over.
    const at = this.halted ? this.halted.moveIndex : this.moveIndex;
    const mv = moves[at];
    this.halted = null;
    if (!mv || this.finished) return;
    const same = (m) => m && (m.source || null) === (mv.source || null) && m.line === mv.line;
    if (this.moveIndex > at && !same(moves[this.moveIndex])) return;
    this._dwelt = 0;
    while (!this.finished && same(moves[this.moveIndex])) {
      this.pos = moves[this.moveIndex].to.slice();
      this.nextMove();
    }
    // The clock where the next block starts, as a seek would count it.
    let t = 0;
    for (let i = 0; i < this.moveIndex && i < moves.length; i++) t += moves[i].time;
    this.time = this.finished ? this.totalTime || t : t;
    this.u = 0;
  }

  report(type, data) {
    const meta = COLLISION_TYPES[type] || { label: type, severity: 'error' };
    const key = `${type}:${data.line}`;
    const existing = this.collisionKeys.get(key);
    if (existing) {
      existing.count++;
      this.haltFor(type, meta.severity, data);
      if ((data.depth || 0) > (existing.depth || 0)) {
        existing.depth = data.depth;
        existing.position = data.position || existing.position;
        if (typeof data.message === 'function') existing.message = data.message(existing.depth);
      }
      if (data.volume) existing.volume = (existing.volume || 0) + data.volume;
      return existing;
    }
    const kept = this.collisionKinds.get(type) || 0;
    if (kept >= MAX_COLLISIONS) {
      this.collisionsDropped++;
      return null;
    }
    this.collisionKinds.set(type, kept + 1);
    this.haltFor(type, meta.severity, data);
    const entry = {
      type,
      label: meta.label,
      severity: meta.severity,
      count: 1,
      time: this.time,
      moveIndex: this.moveIndex,
      ...data,
      message: typeof data.message === 'function' ? data.message(data.depth || 0) : data.message,
    };
    this.collisions.push(entry);
    this.collisionKeys.set(key, entry);
    return entry;
  }

  /**
   * Advance the simulation.
   *
   * @param {number} dtSeconds  simulated time to consume, or Infinity to run
   *                            until the budget is spent
   * @param {number} budgetMs   wall-clock work limit for this call
   * @returns {{advanced:number, done:boolean, cut:boolean}}
   */
  run(dtSeconds, budgetMs = 12) {
    if (this.finished || !this.program) return { advanced: 0, done: true, cut: false };
    const deadline = performance.now() + budgetMs;
    const moves = this.program.moves;
    const stock = this.stock;
    let remaining = dtSeconds;
    let didCut = false;
    let advanced = 0;

    while (remaining > 1e-12 && !this.finished) {
      if (this.halted || performance.now() > deadline) break;

      const mv = moves[this.moveIndex];
      if (!mv) { this.finished = true; break; }

      if (mv.tool !== this.currentTool) {
        this.currentTool = mv.tool;
        this.activeSlot = this.slotFor(mv.tool);
      }

      // Dwells and zero-length moves just consume time.
      const lens = segmentsOf(mv);
      if (mv._segTotal <= 1e-9) {
        // No linear travel, but the rotaries may still be swinging the tool
        // through the part, so the swing is carved before the move retires.
        const take = Math.min(remaining, Math.max(mv.time - (this._dwelt || 0), 0));
        this._dwelt = (this._dwelt || 0) + take;
        // How far through the swing, so the machine is drawn part way
        // round it — a G93 swing takes as long as it says, not no time.
        this.u = mv.time > 0 ? Math.min(1, this._dwelt / mv.time) : 1;
        this.time += take;
        remaining -= take;
        advanced += take;
        if (this._dwelt >= mv.time - 1e-9) {
          this._dwelt = 0;
          this.pos = mv.to.slice();
          if (this.swings(mv) && this.sweep(mv, mv.from, mv.to, 0, 1)) didCut = true;
          this.nextMove();
        }
        continue;
      }

      const speed = mv.time > 0 ? mv._segTotal / mv.time : 1e9;   // mm/s
      const p = mv.path;
      const s = this.segIndex;
      const segLen = lens[s];
      if (segLen <= 1e-12) { this.advanceSegment(mv, lens); continue; }

      const ax = p[s * 3], ay = p[s * 3 + 1], az = p[s * 3 + 2];
      const bx = p[s * 3 + 3], by = p[s * 3 + 4], bz = p[s * 3 + 5];
      const cum = mv._segCum;
      const uPrev = mv._segTotal > 1e-12 ? (cum[s] + this.segPos) / mv._segTotal : 0;

      // Does this segment interact with anything? Rejecting whole segments
      // is what makes long air moves free.
      const info = this.segmentInfo(mv, ax, ay, az, bx, by, bz, uPrev, cum[s + 1] / mv._segTotal);
      const step = info.stepSize;

      const allowedByTime = remaining * speed;
      let advanceLen = Math.min(step, segLen - this.segPos, allowedByTime);
      if (advanceLen <= 1e-9) {
        if (allowedByTime <= 1e-9) break;
        advanceLen = Math.min(segLen - this.segPos, allowedByTime);
      }

      const tPrev = this.segPos / segLen;
      const fromX = ax + (bx - ax) * tPrev;
      const fromY = ay + (by - ay) * tPrev;
      const fromZ = az + (bz - az) * tPrev;

      this.segPos += advanceLen;
      const uNow = mv._segTotal > 1e-12 ? (cum[s] + this.segPos) / mv._segTotal : 1;
      this.u = uNow;
      const t = Math.min(1, this.segPos / segLen);
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      this.pos[0] = x; this.pos[1] = y; this.pos[2] = z;

      const dt = advanceLen / speed;
      this.time += dt;
      this.distance += advanceLen;
      remaining -= dt;
      advanced += dt;

      if (info.active) {
        const cut = this.sweep(mv, [fromX, fromY, fromZ], [x, y, z], uPrev, uNow);
        if (cut) didCut = true;
      }

      if (this.segPos >= segLen - 1e-9) this.advanceSegment(mv, lens);
    }

    if (stock) stock.refreshTiles();
    return { advanced, done: this.finished, cut: didCut };
  }

  advanceSegment(mv, lens) {
    this.segPos = 0;
    this.segIndex++;
    if (this.segIndex >= lens.length) {
      this.pos = mv.to.slice();
      this.nextMove();
    }
  }

  nextMove() {
    this.segIndex = 0;
    this.segPos = 0;
    this.moveIndex++;
    if (this.moveIndex >= this.program.moves.length) {
      this.finished = true;
      this.moveIndex = this.program.moves.length - 1;
      if (this.analyzer) this.analyzer.finish();
    }
  }

  /**
   * Does the chain say anything a tool-tip coordinate does not?
   *
   * A rotary tilts the tool; an extra slide such as W moves it without ever
   * appearing in X, Y or Z. Either way the pose has to come from the chain
   * rather than straight from the programmed point.
   */
  get fiveAxis() {
    return !!(this.kinematics && this.kinematics.extras().length);
  }

  /**
   * The table the tool is checked against: the one the machine draws, when
   * it draws one, at the height the setting gives. A trunnion's platter is
   * a circle 330 across; the setting's 900 by 460 slab is a three-axis
   * table, and swung up on end it reached a tool nothing on screen was near.
   */
  tableShape() {
    const t = this.machine && this.machine.table;
    if (!t) return t;
    const k = this.kinematics;
    const drawn = k && this.machine.proxies !== false && k.tableFootprint ? k.tableFootprint() : null;
    return drawn ? { ...t, xMin: -Infinity, xMax: Infinity, yMin: -Infinity, yMax: Infinity, ...drawn } : t;
  }

  /**
   * The castings to check the assembly against: per axis, its solids in
   * that axis's frame (see MachineView.collisionBodies). Meshes get a grid
   * here, once, so a pose asks only about the triangles near the tool.
   */
  setCastings(bodies) {
    // The chain may have changed with them: nothing worked out on the old
    // one still holds.
    this.basisMemo = null;
    this.mates = null;
    const all = (bodies || []).map((b) => ({
      ...b,
      solids: b.solids.map((s) => ({ ...s, ...boundOf(s), ...(s.kind === 'mesh' ? { grid: meshGrid(s.tris) } : {}) })),
    }));
    // What the tool is checked against: everything not riding with it,
    // less the table, which the table check answers for.
    this.castings = all
      .filter((b) => b.side !== 'tool')
      .map((b) => ({ ...b, solids: b.solids.filter((s) => !s.table) }))
      .filter((b) => b.solids.length);
    // The machine against itself: what rides with the spindle, against
    // everything else, the table included.
    const flat = (side) => all.filter((b) => (side === 'tool') === (b.side === 'tool'))
      .flatMap((b) => b.solids.map((s) => ({ s, body: b })));
    this.headSolids = flat('tool');
    this.workSolids = flat('work');
  }

  /** Is the machine-against-itself check on, with anything to check? */
  get machineOn() {
    return !!(this.kinematics && this.headSolids && this.headSolids.length
      && !(this.machine && this.machine.castingsCheck === false));
  }

  /**
   * Pairs that touch with every axis at zero are how the machine is built
   * — a bridge sitting on its walls, a slide on its ways — and are never
   * reported. Worked out once per chain.
   */
  matePairs() {
    if (this.mates) return this.mates;
    const k = this.kinematics;
    k.solve({});
    const head = this.headSolids.map(({ s, body }) => placeSolid(s, k.matrixOf(body.node)));
    const work = this.workSolids.map(({ s, body }) => placeSolid(s, k.matrixOf(body.node)));
    this.mates = new Set();
    head.forEach((P, i) => work.forEach((Q, j) => {
      const c = solidContact(P, Q, 0.05);
      if (c) this.mates.add(i * 65536 + j);
    }));
    return this.mates;
  }

  /**
   * Every head solid and every other solid, placed for the chain as posed
   * now (see placeCastings), with the part's frame and the scene's.
   */
  placeMachine() {
    const k = this.kinematics;
    return {
      head: this.headSolids.map(({ s, body }) => placeSolid(s, k.matrixOf(body.node))),
      work: this.workSolids.map(({ s, body }) => placeSolid(s, k.matrixOf(body.node))),
    };
  }

  /**
   * Which head-and-other pairs, and which head solids against the stock,
   * could meet anywhere along a chunk. While the rotaries stand still
   * every solid only slides, so the boxes at the two ends, joined, hold
   * all of its sweep. A chunk that turns a rotary is asked pose by pose.
   */
  machineNear(poses, mv, clearance) {
    if (!this.machineOn || !poses.length) return null;
    const mates = this.matePairs();
    const pad = Math.max(clearance, 0) + 1e-6;
    const all = () => {
      const pairs = [];
      for (let i = 0; i < this.headSolids.length; i++) {
        for (let j = 0; j < this.workSolids.length; j++) if (!mates.has(i * 65536 + j)) pairs.push([i, j]);
      }
      const every = this.headSolids.map((_, i) => i);
      return { pairs, stock: every, ref: this.referenceOn() ? every : [] };
    };
    const first = poses[0];
    const last = poses[poses.length - 1];
    const ra = this.rotaryAt(mv, first[3]);
    const rb = this.rotaryAt(mv, last[3]);
    for (const L in { ...ra, ...rb }) if (Math.abs((ra[L] || 0) - (rb[L] || 0)) > 1e-9) return all();
    const ends = [];
    for (const p of [first, last]) {
      if (!this.placeCastings(p[0], mv, p[3], [])) return all();
      const placed = this.placeMachine();
      placed.stock = this.stock ? this.stockBox(this.kinematics) : null;
      placed.ref = this.referenceOn() ? this.partBox(this.kinematics, this.target.surface.bounds) : null;
      ends.push(placed);
    }
    const join = (a, b) => ({
      lo: a.lo.map((v, k) => Math.min(v, b.lo[k])),
      hi: a.hi.map((v, k) => Math.max(v, b.hi[k])),
    });
    const head = ends[0].head.map((P, i) => join(P, ends[1].head[i]));
    const work = ends[0].work.map((Q, j) => join(Q, ends[1].work[j]));
    const pairs = [];
    head.forEach((P, i) => work.forEach((Q, j) => {
      if (!mates.has(i * 65536 + j) && boxesMeet(P, Q, pad)) pairs.push([i, j]);
    }));
    const stockBox = ends[0].stock && join(ends[0].stock, ends[1].stock);
    const stock = stockBox ? head.map((P, i) => (boxesMeet(P, stockBox, 0) ? i : -1)).filter((i) => i >= 0) : [];
    const refBox = ends[0].ref && join(ends[0].ref, ends[1].ref);
    const ref = refBox ? head.map((P, i) => (boxesMeet(P, refBox, 0) ? i : -1)).filter((i) => i >= 0) : [];
    return { pairs, stock, ref };
  }

  /** A box on the part — [x0, y0, z0, x1, y1, z1] — in the scene, for the chain as posed now. */
  partBox(k, b) {
    const part = m4.multiply(m4.create(), k.matrixOf(k.workNode), m4.fromTranslation(m4.create(), k.tableOffset));
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const q = [0, 0, 0];
    for (let c = 0; c < 8; c++) {
      m4.transformPoint(q, part, [c & 1 ? b[3] : b[0], c & 2 ? b[4] : b[1], c & 4 ? b[5] : b[2]]);
      for (let a = 0; a < 3; a++) {
        if (q[a] < lo[a]) lo[a] = q[a];
        if (q[a] > hi[a]) hi[a] = q[a];
      }
    }
    return { lo, hi };
  }

  /** The stock's box in the scene, for the chain as posed now. */
  stockBox(k) {
    const st = this.stock;
    const part = m4.multiply(m4.create(), k.matrixOf(k.workNode), m4.fromTranslation(m4.create(), k.tableOffset));
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const q = [0, 0, 0];
    for (let c = 0; c < 8; c++) {
      m4.transformPoint(q, part, [
        c & 1 ? st.origin[0] + st.size[0] : st.origin[0],
        c & 2 ? st.origin[1] + st.size[1] : st.origin[1],
        c & 4 ? st.top : st.base,
      ]);
      for (let a = 0; a < 3; a++) {
        if (q[a] < lo[a]) lo[a] = q[a];
        if (q[a] > hi[a]) hi[a] = q[a];
      }
    }
    return { lo, hi };
  }

  /**
   * The machine against itself, and against the part, at one pose: the
   * worst of the pairs a chunk left to ask about.
   */
  checkMachine(tip, mv, u, clearance, near) {
    if (!near || (!near.pairs.length && !near.stock.length && !(near.ref && near.ref.length))) return null;
    if (!this.placeCastings(tip, mv, u, [])) return null;
    const k = this.kinematics;
    const head = new Map();
    const work = new Map();
    const placeHead = (i) => head.get(i) || head.set(i, placeSolid(this.headSolids[i].s, k.matrixOf(this.headSolids[i].body.node))).get(i);
    const placeWork = (j) => work.get(j) || work.set(j, placeSolid(this.workSolids[j].s, k.matrixOf(this.workSolids[j].body.node))).get(j);
    const pad = Math.max(clearance, 0);
    let worst = null;
    for (const [i, j] of near.pairs) {
      const c = solidContact(placeHead(i), placeWork(j), pad);
      if (c && (!worst || c.gap < worst.gap)) worst = { ...c, head: this.headSolids[i], other: this.workSolids[j] };
    }
    if (this.stock && this.stock.stretchesAt && near.stock.length) {
      const part = m4.multiply(m4.create(), k.matrixOf(k.workNode), m4.fromTranslation(m4.create(), k.tableOffset));
      const fromScene = m4.invertRigid(m4.create(), part);
      for (const i of near.stock) {
        const c = solidIntoStock(placeHead(i), this.stock, fromScene, part);
        if (c && (!worst || -c.depth < worst.gap)) worst = { gap: -c.depth, point: c.point, partFrame: true, head: this.headSolids[i], other: null };
      }
    }
    // The machine into the reference part — its real shape, wherever it
    // stands, stock round it or not.
    if (near.ref && near.ref.length && this.referenceOn()) {
      const part = m4.multiply(m4.create(), k.matrixOf(k.workNode), m4.fromTranslation(m4.create(), k.tableOffset));
      const fromScene = m4.invertRigid(m4.create(), part);
      const inside = insideColumns(this.target);
      for (const i of near.ref) {
        const c = solidIntoReference(placeHead(i), this.target.surface, inside, fromScene, part);
        if (c && (!worst || -c.depth < worst.gap)) worst = { gap: -c.depth, point: c.point, partFrame: true, head: this.headSolids[i], other: null, reference: true };
      }
    }
    if (!worst) return null;
    // Positions are reported on the part, where everything else is.
    if (!worst.partFrame) {
      const part = m4.multiply(m4.create(), k.matrixOf(k.workNode), m4.fromTranslation(m4.create(), k.tableOffset));
      worst.point = m4.transformPoint([0, 0, 0], m4.invertRigid(m4.create(), part), worst.point);
    }
    return worst;
  }

  /**
   * Are the travels the rule for this move? Not during a tool change, by
   * default: a machine's changer sits past what a program may use — Z
   * above its top, X out to the carousel — and the macro goes there.
   */
  limitsApply(mv) {
    return !(mv && mv.toolChange && !(this.machine && this.machine.toolChangeFree === false));
  }

  /** Is the castings check on, with anything to check? */
  get castingsOn() {
    return !!(this.kinematics && this.castings.length && !(this.machine && this.machine.castingsCheck === false));
  }

  /**
   * Pose the chain for a tool tip on the part, and give the matrix that
   * carries the part's frame into each casting body's axis frame — or null
   * when no axis positions put the tool there.
   */
  placeCastings(tip, mv, u, bodies) {
    const k = this.kinematics;
    const rot = this.rotaryAt(mv, u);
    const gauge = this.gaugeLength;
    // Working out how X, Y and Z move the tip costs four solves of the
    // chain; for one set of rotaries and one tool it is the same answer.
    const key = `${gauge}|${Object.keys(rot).sort().map((L) => `${L}${rot[L]}`).join(',')}`;
    const memo = this.basisMemo && this.basisMemo.kin === k && this.basisMemo.key === key
      ? this.basisMemo
      : (this.basisMemo = { kin: k, key, basis: k.linearBasis(rot, gauge) });
    const lin = k.linearsForTip(this.coordTip({ tip }, mv, u), rot, gauge, memo.basis);
    if (!lin) return null;
    k.solve({ ...rot, ...lin });
    // Part frame to scene: the work node, then up onto the fixture face.
    const part = m4.multiply(m4.create(), k.matrixOf(k.workNode), m4.fromTranslation(m4.create(), k.tableOffset));
    const inv = m4.create();
    return bodies.map((body) => m4.multiply(m4.create(), m4.invertRigid(inv, k.matrixOf(body.node)), part));
  }

  /** How far up the chain reaches from the tip, and its widest radius. */
  reachOf(slot) {
    if (slot.reach) return slot.reach;
    let top = 0;
    let fat = 0;
    for (let i = 0; i < slot.spheres.length; i += 2) {
      if (slot.spheres[i] > top) top = slot.spheres[i];
      if (slot.spheres[i + 1] > fat) fat = slot.spheres[i + 1];
    }
    slot.reach = { top, fat };
    return slot.reach;
  }

  /**
   * The castings that could come near the tool anywhere along a chunk of
   * poses. While the rotaries stand still the tool and every casting move
   * in straight lines relative to each other, so the closest a body's
   * bounding sphere comes to the tool's axis is a distance between two
   * segments, and two placements — at the ends — answer for the lot. Most
   * chunks are nowhere near the machine and check nothing further; a chunk
   * that turns a rotary is asked pose by pose.
   */
  castingsNear(slot, poses, mv, clearance) {
    if (!this.castingsOn || !poses.length) return [];
    const first = poses[0];
    const last = poses[poses.length - 1];
    const ra = this.rotaryAt(mv, first[3]);
    const rb = this.rotaryAt(mv, last[3]);
    for (const L in { ...ra, ...rb }) if (Math.abs((ra[L] || 0) - (rb[L] || 0)) > 1e-9) return this.castings;
    const dir = first[1];
    if (Math.hypot(dir[0] - last[1][0], dir[1] - last[1][1], dir[2] - last[1][2]) > 1e-9) return this.castings;
    const a = this.placeCastings(first[0], mv, first[3], this.castings);
    const b = this.placeCastings(last[0], mv, last[3], this.castings);
    if (!a || !b) return this.castings;
    const { top, fat } = this.reachOf(slot);
    // Poses off the chord between the ends, which an arc's would be; the
    // castings shift against the tool, so the gap between them bows twice as far.
    const t0 = first[0];
    const t1 = last[0];
    let bow = 0;
    for (const p of poses) bow = Math.max(bow, pointSegment(p[0], t0, t1));
    const want = Math.max(clearance, 0);
    const top0 = [t0[0] + dir[0] * top, t0[1] + dir[1] * top, t0[2] + dir[2] * top];
    const top1 = [t1[0] + dir[0] * top, t1[1] + dir[1] * top, t1[2] + dir[2] * top];
    const pad = fat + want + 2 * bow + 1e-6;
    const m0 = m4.create();
    const m1 = m4.create();
    const near = [];
    this.castings.forEach((body, i) => {
      const solids = body.solids.filter((s) => {
        m4.multiply(m0, s.toBox, a[i]);
        m4.multiply(m1, s.toBox, b[i]);
        return sweepNearBox(m0, m1, t0, top0, t1, top1, pad, s.boxHalf);
      });
      if (solids.length) near.push(solids.length === body.solids.length ? body : { ...body, solids });
    });
    return near;
  }

  /**
   * The assembly against the machine's castings at one pose.
   *
   * The pose is a tip and an axis on the part; the axes that put it there
   * are solved for, the chain is posed with them, and each casting is
   * carried into the part's frame from wherever its axis has taken it — a
   * cheek stands still while the cradle swings, the column stays put while
   * the table runs under the tool.
   */
  checkCastings(slot, tip, dir, mv, u, clearance, bodies = this.castings) {
    if (!this.castingsOn || !bodies.length) return null;
    const placed = this.placeCastings(tip, mv, u, bodies);
    if (!placed) return null;
    const { top, fat } = this.reachOf(slot);
    const want = Math.max(clearance, 0);
    const boxes = [];
    const others = [];
    const end = [tip[0] + dir[0] * top, tip[1] + dir[1] * top, tip[2] + dir[2] * top];
    const m = m4.create();
    bodies.forEach((body, i) => {
      const toNode = placed[i];
      for (const s of body.solids) {
        // Nowhere near: the chain's axis, grown by its widest, clear of
        // the box round the solid.
        m4.multiply(m, s.toBox, toNode);
        if (!sweepNearBox(m, m, tip, end, tip, end, fat + want, s.boxHalf)) continue;
        if (s.kind === 'box') {
          boxes.push({ name: s.name, inverse: m4.multiply(m4.create(), s.toLocal, toNode), half: s.half, centre: [0, 0, 0], scale: 1, body });
        } else if (s.kind === 'cyl') {
          others.push({ ...s, inverse: m4.multiply(m4.create(), s.toLocal, toNode), body });
        } else {
          others.push({ ...s, inverse: toNode, body });
        }
      }
    });
    const a = boxes.length ? checkFixtures(slot.spheres, tip, boxes, 0, clearance, dir) : null;
    const b = others.length ? checkSolids(slot.spheres, tip, others, clearance, dir) : null;
    const hit = !a ? b : !b ? a : (a.gap <= b.gap ? a : b);
    if (!hit) return null;
    const solid = hit.fixture || hit.solid;
    return { ...hit, name: solid.name, axis: solid.body.letter, node: solid.body.node };
  }

  /** Gauge length of the assembly currently in the spindle. */
  get gaugeLength() {
    return this.activeSlot ? this.activeSlot.built.gaugeLength : 0;
  }

  /** Rotary positions part way through a move. */
  rotaryAt(mv, u) {
    const a = mv.rotFrom || ZERO_ROT;
    const b = mv.rotTo || ZERO_ROT;
    const out = {};
    // Whatever the move carries: A/B/C on every machine, plus U, V or W on
    // one that has them. A missing key is that axis sitting at zero.
    for (const L in a) out[L] = a[L] + ((b[L] || 0) - a[L]) * u;
    for (const L in b) if (!(L in out)) out[L] = (b[L] || 0) * u;
    return out;
  }

  /**
   * Where the tool tip is on the part, and which way the tool points.
   *
   * Two conventions meet here. Under G43.4/G43.5 the control is doing the
   * work: the programmed point *is* the tip on the part, and the rotaries
   * only say which way the tool leans. Without it the programmed point is
   * an axis position, so the part has to be carried through the chain to
   * find out where that lands — with a rotary table, the same X/Y/Z is a
   * different place on the part at every angle.
   *
   * @param {number[]} point programmed point, work coordinates
   * @param {number} u  0..1 through the move, for interpolating the swing
   */
  poseAt(mv, point, u) {
    const idx = this.indexer;
    const index = idx ? this.indexAt(mv, u) : 0;
    // How far down its own line the tool has been sent. Nothing on the
    // machine answers for it: the control puts the tip there by moving X,
    // Y and Z together, so here it is a shift along the tool axis and the
    // rig is solved for it afterwards, which is the same thing.
    const along = this.alongTool;
    // Who turns the part: the chain, when the machine has been modelled
    // with the axis, or this, when it has not. Doing it twice puts the cut
    // at double the angle, and doing it neither leaves the tool going
    // round with the part instead of standing still.
    const chainSpins = !!(idx && idx.inChain);
    if (!this.fiveAxis) {
      return { tip: this.downTool(this.onPart(point, index), UP, mv, u), dir: UP, index };
    }
    const rot = this.rotaryAt(mv, u);
    const gauge = this.gaugeLength;
    const k = this.kinematics;
    if (mv.tcp) {
      // Under RTCP the programmed point is the tip, given in the
      // coordinate system — which is the one that stays still while the
      // part indexes. The chain is not consulted for it, so nothing has
      // carried it onto the part yet, whichever way the machine is
      // modelled; and everything downstream — the cut, the drawn tool —
      // wants it on the part.
      // The tool axis comes out of the chain already expressed on the
      // part — toolAxis walks to the work node, and on a machine that
      // models the indexer that walk has turned it. Only the programmed
      // point still needs carrying over, and doing both turned the drawn
      // tool twice: at A0 that is invisible, and at any other angle the
      // head swings away from its own castings as the table indexes.
      const axis = k.toolAxis(rot, gauge);
      if (chainSpins) {
        const m = k.indexTransform(k.coordNode(idx.letter), { ...rot });
        const tip = m4.transformPoint([0, 0, 0], m, point);
        return { tip: this.downTool(tip, axis, mv, u), dir: axis, index };
      }
      const dir = this.onPart(axis, index);
      return { tip: this.downTool(this.onPart(point, index), dir, mv, u), dir, index };
    }
    // Without TCP the linear axes stand where the program sent them,
    // measured as a control measures them — with a work offset and a tool
    // length set with every rotary at zero, so the tip is on the programmed
    // point there. The rotaries then turn the part about their own pivots,
    // wherever the part sits on the table, and the axes do not follow.
    const axes = k.linearsForTip(point, {}, gauge) || { X: point[0], Y: point[1], Z: point[2] };
    const r = k.toolInWork({ ...axes, ...rot }, gauge);
    const spin = chainSpins ? 0 : index;
    const dir = this.onPart(r.axis, spin);
    return { tip: this.downTool(this.onPart(r.tip, spin), dir, mv, u), dir, index };
  }

  /** The letter that runs down the tool, when the chain has no such slide. */
  get alongTool() {
    const a = this.program && this.program.alongTool;
    return a && !a.inChain ? a : null;
  }

  /**
   * Shift a tip along the tool by however far W has been sent.
   *
   * The axis points up the tool from the tip, and W is measured the way
   * the slide it stands in for would be — so W-50 puts the tip fifty
   * millimetres further down the tool, whichever way the head is leaning.
   */
  downTool(tip, dir, mv, u) {
    const a = this.alongTool;
    if (!a) return tip;
    const from = (mv.rotFrom && mv.rotFrom[a.letter]) || 0;
    const to = (mv.rotTo && mv.rotTo[a.letter]) || 0;
    const w = from + (to - from) * u;
    if (!w) return tip;
    return [tip[0] + dir[0] * w, tip[1] + dir[1] * w, tip[2] + dir[2] * w];
  }

  /**
   * The gauge line, given where the tip is and which way the tool points.
   *
   * Every machine coordinate in this program is read here — G53, G28, the
   * travel limits — because that is where a machine reads one: at the
   * spindle's own face, with whatever is in it hanging below.
   */
  gaugePoint(tip, dir) {
    const gauge = this.gaugeLength;
    if (!gauge) return tip;
    const d = dir || UP;
    return [tip[0] + d[0] * gauge, tip[1] + d[1] * gauge, tip[2] + d[2] * gauge];
  }

  /** The letter that turns the work rather than the machine, or null. */
  get indexer() {
    return (this.program && this.program.indexer) || null;
  }

  /** How far round the work is, part way through a move. */
  indexAt(mv, u) {
    const idx = this.indexer;
    if (!idx) return 0;
    const a = (mv.rotFrom && mv.rotFrom[idx.letter]) || 0;
    const b = (mv.rotTo && mv.rotTo[idx.letter]) || 0;
    return a + (b - a) * u;
  }

  /**
   * A point the program gave in machine terms, in the part's own frame.
   *
   * Turning the work by a degrees puts a part-frame point q at machine
   * position Rz(a)q, so a machine position p is at Rz(-a)p on the part.
   * That is the whole of what indexing does here: the machine stands
   * still, and the part is somewhere else underneath it.
   */
  onPart(p, index) {
    return index ? spinZ(p, -index) : p;
  }

  /**
   * A tip on the part, back in the frame the chain solves in: undoing an
   * index the chain does not model, which is the one turn it cannot see.
   */
  coordTip(pose, mv, u) {
    const idx = this.indexer;
    if (!idx || idx.inChain) return pose.tip;
    const index = this.indexAt(mv, u);
    return index ? spinZ(pose.tip, index) : pose.tip;
  }

  /**
   * Does this stretch of a move turn the part without TCP? Then the tip
   * goes round the pivot on an arc, and the poses between its ends have to
   * be asked for rather than drawn as a straight line — a chord across a
   * quarter turn of the table cuts through whatever is inside the arc.
   */
  swingsWithoutTcp(mv, u0, u1) {
    if (!this.fiveAxis || mv.tcp) return false;
    const a = this.rotaryAt(mv, u0);
    const b = this.rotaryAt(mv, u1);
    for (const k in b) if (Math.abs((b[k] || 0) - (a[k] || 0)) > 1e-9) return true;
    return false;
  }

  /** n poses between two ends of a swing, each where the machine puts it: [tip, dir, point, u]. */
  posesAlong(mv, from, to, u0, u1, n) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
      const u = u0 + (u1 - u0) * t;
      const pose = this.poseAt(mv, point, u);
      out.push([pose.tip, pose.dir, point, u]);
    }
    return out;
  }

  /**
   * The point the travel envelope is checked at, in the same terms as a
   * three-axis machine: where the gauge line would be for these linear
   * axes with every rotary at zero. A rotary turning the part does not
   * move a linear axis, so it does not move this either — reading the
   * envelope off the tool on the turned part had a trunnion swing run Y
   * off its travel without Y moving at all.
   */
  envelopePoint(mv, tip, dir, point, u) {
    const gauge = this.gaugeLength;
    if (!this.fiveAxis) return this.gaugePoint(tip, dir);
    if (!mv.tcp && point) return [point[0], point[1], point[2] + gauge];
    const k = this.kinematics;
    const axes = k.linearsForTip(this.coordTip({ tip }, mv, u), this.rotaryAt(mv, u), gauge);
    if (!axes) return this.gaugePoint(tip, dir);
    const flat = k.toolInWork({ X: axes.X, Y: axes.Y, Z: axes.Z }, gauge).tip;
    return [flat[0], flat[1], flat[2] + gauge];
  }

  /**
   * Where the spindle face is in machine terms right now — the point the
   * travels are measured at, for the slides as they stand. Subtract home
   * and it is what the control reads out as machine X, Y and Z.
   */
  machinePoint() {
    const mv = this.program && this.program.moves[this.moveIndex];
    const pose = this.currentPose();
    if (!mv) return this.gaugePoint(pose.tip, pose.dir);
    return this.envelopePoint(mv, pose.tip, pose.dir, this.pos, Math.max(0, Math.min(1, this.u || 0)));
  }

  /**
   * Where the machine is right now: axis positions for the rig, and the
   * tool on the part for the viewport.
   *
   * Under TCP the programmed point is the tip, so the axis positions have
   * to be solved for rather than read off — that solve is exact and runs
   * once a frame, which is nothing.
   */
  currentPose() {
    const point = this.pos.slice();
    const flat = { values: { X: point[0], Y: point[1], Z: point[2] }, tip: point, dir: UP, rot: ZERO_ROT, index: 0 };
    const mv = this.program && this.program.moves[this.moveIndex];
    if (!mv || (!this.fiveAxis && !this.indexer)) return flat;
    if (!this.fiveAxis) {
      // Indexed, but otherwise an ordinary three-axis machine: the axes
      // stand where the program put them and only the work has turned.
      const pose = this.poseAt(mv, point, Math.max(0, Math.min(1, this.u || 0)));
      return { values: flat.values, tip: pose.tip, dir: UP, rot: this.rotaryAt(mv, this.u || 0), index: pose.index };
    }

    const u = Math.max(0, Math.min(1, this.u || 0));
    const rot = this.rotaryAt(mv, u);
    const pose = this.poseAt(mv, point, u);
    const k = this.kinematics;
    const gauge = this.gaugeLength;
    let values = { ...rot, X: point[0], Y: point[1], Z: point[2] };
    // Where the linear axes really are, from home: what the rig is drawn at.
    let axes = mv.tcp ? null : k.linearsForTip(point, {}, gauge);
    if (mv.tcp) {
      axes = k.linearsForTip(this.coordTip(pose, mv, u), rot, gauge);
      // Read out as the program counts them: from the work offset, so with
      // the rotaries at zero they are the programmed point.
      const zero = k.linearsForTip([0, 0, 0], {}, gauge);
      if (axes && zero) values = { ...rot, X: axes.X - zero.X, Y: axes.Y - zero.Y, Z: axes.Z - zero.Z };
    }
    return { values, axes: axes ? { ...rot, ...axes } : null, gauge, tip: pose.tip, dir: pose.dir, rot, index: pose.index || 0 };
  }

  /** True when the tool stands close enough to vertical to sweep normally. */
  isUpright(dir) {
    return dir[2] >= this.uprightCos;
  }

  /**
   * Decide whether a segment needs sampling at all and how finely.
   * The whole-segment rejection uses the stock tile pyramid plus the
   * bounding boxes of the fixtures.
   */
  segmentInfo(mv, ax, ay, az, bx, by, bz, u = 1, uEnd = 1) {
    const slot = this.activeSlot;
    const stock = this.stock;

    if (!slot) return { active: false, stepSize: Infinity };

    // On a 5-axis machine the programmed point is not the tool tip, so the
    // rejection box is built from the tip and padded for the lean: the
    // flutes reach sideways and the ball of a tilted cutter dips below the
    // tip. Padding only ever makes the box bigger, so a segment is never
    // skipped when it should have been sampled.
    let lean = 0;
    let bodyLean = 0;
    if (this.fiveAxis) {
      const pa = this.poseAt(mv, [ax, ay, az], u);
      const pb = this.poseAt(mv, [bx, by, bz], uEnd);
      ax = pa.tip[0]; ay = pa.tip[1]; az = pa.tip[2];
      bx = pb.tip[0]; by = pb.tip[1]; bz = pb.tip[2];
      const sin = Math.max(Math.hypot(pa.dir[0], pa.dir[1]), Math.hypot(pb.dir[0], pb.dir[1]));
      lean = sin * Math.max(slot.built.fluteLength, slot.built.cutRadius);
      // The holder and the spindle nose swing far wider than the flutes do
      // — the lever is the whole assembly, not the cutting length — and a
      // box that does not hold them throws the segment away before
      // anything is asked about where they are.
      bodyLean = sin * slot.built.totalLength;
    }

    // How far to advance before carving. Sweeping means the cost of a chunk
    // is the area of the band it covers, so the chunk is sized to a column
    // budget rather than to the cell size — at a fine resolution that keeps
    // each frame's work bounded without shrinking the step to nothing.
    const cellArea = stock ? stock.dx * stock.dy : 1;
    const r = Math.max(slot.built.cutRadius, 0.05);
    // The cutter's own footprint is paid once per chunk whatever the chunk
    // length, so only the *extra* band a longer chunk sweeps counts against
    // the budget. When the footprint alone already blows the budget — a Ø50
    // face mill covers 3.1M columns at 0.025 mm — the answer is the longest
    // chunk allowed, to amortise that cost, not the shortest. Getting this
    // backwards silently turns the sweep back into stamping.
    let chunk = 25;
    if (stock) {
      const discColumns = (Math.PI * r * r) / cellArea;
      chunk = discColumns >= this.columnBudget
        ? 25
        : Math.min(Math.max(((this.columnBudget - discColumns) * cellArea) / (2 * r), 0.25), 25);
    }

    const rBody = Math.max(slot.built.bodyRadius, slot.built.cutRadius) + lean;
    const zLow = Math.min(az, bz) - (lean > 0 ? slot.built.cutRadius : 0);

    let touchesStock = false;
    let bodyNear = false;
    if (stock) {
      const x0 = Math.min(ax, bx) - rBody, x1 = Math.max(ax, bx) + rBody;
      const y0 = Math.min(ay, by) - rBody, y1 = Math.max(ay, by) + rBody;
      const maxH = stock.maxHeightIn(x0, y0, x1, y1);
      touchesStock = Number.isFinite(maxH) && zLow < maxH + 1e-6;
      // Nothing to cut, but leaned over the holder can still be standing in
      // metal a long way from the tip. That is not a carving question and
      // does not get the carving step size — it gets probed like any other
      // obstacle.
      if (!touchesStock && bodyLean > lean) {
        const rSwing = Math.max(slot.built.bodyRadius, slot.built.cutRadius) + bodyLean;
        const maxHB = stock.maxHeightIn(
          Math.min(ax, bx) - rSwing, Math.min(ay, by) - rSwing,
          Math.max(ax, bx) + rSwing, Math.max(ay, by) + rSwing,
        );
        bodyNear = Number.isFinite(maxHB) && zLow < maxHB + 1e-6;
      }
    }

    // The reference part asks for the fine steps only where the tool could
    // come down to it — the cutter as well as the holder, since a cutter in
    // the part where there is no stock is a gouge only it can show: the
    // tool's lowest point, over the whole segment, below the highest the
    // part stands under it.
    let referenceNear = false;
    if (this.referenceOn()) {
      const sky = referenceSkyline(this.target);
      const want = Math.max((this.checks && this.checks.nearMiss) || 0, 0);
      const reach = Math.max(slot.built.bodyRadius, slot.built.cutRadius) + bodyLean + want;
      const toolLow = zLow - (bodyLean > 0 ? Math.max(slot.built.bodyRadius, slot.built.cutRadius) : 0);
      referenceNear = !sky || toolLow <= skylineOver(sky, Math.min(ax, bx) - reach, Math.min(ay, by) - reach,
        Math.max(ax, bx) + reach, Math.max(ay, by) + reach) + want + 0.05;
    }
    const hasObstacles = (this.fixtures && this.fixtures.length) || (this.machine && this.machine.table && this.machine.table.enabled)
      || this.castingsOn || this.machineOn || referenceNear;
    const limitsOn = this.machine && this.machine.limits && this.machine.limits.enabled;

    if (touchesStock) {
      // A tilted cut is stamped rather than swept, so a long chunk would
      // just become a long inner loop; keeping the chunk short instead
      // keeps each frame's work bounded and the orientation fresh.
      if (lean > 0) return { active: true, stepSize: Math.min(chunk, Math.max(r, 1)) };
      return { active: true, stepSize: chunk };
    }
    if (bodyNear || hasObstacles) {
      return { active: true, stepSize: 1.5 };
    }
    if (limitsOn) {
      return { active: true, stepSize: 25 };
    }
    return { active: false, stepSize: Infinity };
  }

  /** Does the tool swing during this move, so orientation has to be sampled? */
  swings(mv) {
    if (!this.fiveAxis) return false;
    const a = mv.rotFrom || ZERO_ROT;
    const b = mv.rotTo || ZERO_ROT;
    let moved = 0;
    for (const L in { ...a, ...b }) moved += Math.abs((a[L] || 0) - (b[L] || 0));
    return moved > 1e-9 || !this.isUpright(this.poseAt(mv, mv.to, 1).dir);
  }

  /**
   * Remove the material the tool passes through between two programmed
   * points, then look for crashes.
   *
   * With the tool upright this is one swept carve, which is the cheap case
   * and the one that matters for the 3-axis programs that make up most
   * work. Once the tool leans the swept solid stops being a translated
   * envelope, so the tilted carver is stamped along the chunk instead —
   * more work per millimetre, paid only where it is needed.
   */
  sweep(mv, from, to, u0 = 1, u1 = 1) {
    const slot = this.activeSlot;
    if (!slot) return false;
    const stock = this.stock;
    let removed = 0;

    const poseA = this.poseAt(mv, from, u0);
    const poseB = this.poseAt(mv, to, u1);
    const tilted = !this.isUpright(poseA.dir) || !this.isUpright(poseB.dir);
    const [x, y, z] = poseB.tip;
    const poses = this.probePoses(poseA, poseB, mv, from, to, u0, u1);

    if (stock) {
      // The carve compares on the stock's grid; a part the stock does not
      // reach has no grid of its own and is measured by its surface only.
      const opts = { target: this.target && this.target.map ? this.target : null, tolerance: this.gougeTolerance };
      let gouged = null;
      // Found along the lines rather than from above, and already measured
      // to the part's surface: see TriDexelStock.gougeAlong.
      let gouged3 = null;
      const take3 = (r) => { if (r.gouge3 && (!gouged3 || r.gouge3.depth > gouged3.depth)) gouged3 = r.gouge3; };
      if (!tilted) {
        // Before the carve: the stock still holds what this chunk will cut.
        if (this.analyzer) this.analyzer.sample(stock, slot, mv, poseA.tip, poseB.tip);
        const result = stock.carveSweep(slot.built.cutEnvelope, poseA.tip, poseB.tip, slot.index, opts);
        removed = result.volume;
        gouged = result.gouge;
        take3(result);
      } else if (stock.carveLinear && sameAxis(poseA.dir, poseB.dir)) {
        // Leaning but not swinging — 3+2 work — is a straight sweep of a
        // fixed solid, which a stock kept along all three axes solves
        // exactly wherever its lines allow, rather than stamp by stamp.
        const result = stock.carveLinear(slot.built.cutEnvelope, poseA.tip, poseB.tip, poseA.dir, slot.index, opts);
        removed = result.volume;
        gouged = result.gouge;
        take3(result);
      } else {
        for (const [tip, dir] of this.stamps(poseA, poseB, slot, mv, from, to, u0, u1)) {
          const result = stock.carveTilted(slot.built.cutEnvelope, tip, dir, slot.built.fluteLength, slot.index, opts);
          removed += result.volume;
          if (result.gouge && (!gouged || result.gouge.depth > gouged.depth)) gouged = result.gouge;
          take3(result);
        }
      }
      // The carver finds a gouge looking straight down, which overstates it
      // on any slope — by 41 % at 45°. Measured again along the normal, a
      // cut that is really within tolerance is no gouge at all.
      if (gouged && this.target && this.target.surface) {
        const depth = gougeDepth(this.target, gouged.x, gouged.y, gouged.z, gouged.z + gouged.depth);
        gouged = depth > this.gougeTolerance ? { ...gouged, depth } : null;
      }
      if (gouged3 && (!gouged || gouged3.depth > gouged.depth)) gouged = gouged3;
      if (gouged) {
        const g = gouged;
        this.report('gouge', {
          line: mv.line,
          message: (d) => `Cut ${d.toFixed(3)} mm into the reference part — this is gouging, not stock removal.`,
          position: [g.x, g.y, g.z],
          depth: g.depth,
        });
      }
      if (removed > 0) {
        this.removedVolume += removed;
        this.moveStats[mv.i] += removed;
        if (mv.kind === 'rapid' && (!this.checks || this.checks.rapidIntoStock !== false)) {
          this.report('rapid', {
            line: mv.line,
            message: `G0 rapid removed material at Z${z.toFixed(3)}. On the machine this is a crash, not a cut.`,
            position: [x, y, z],
            volume: removed,
          });
        }
        if (mv.spindleDir === 0) {
          this.report('spindle', {
            line: mv.line,
            message: 'Material removed while the spindle is stopped (no M03/M04 active).',
            position: [x, y, z],
          });
        }
      }

      // Chunks can be tens of millimetres long, so the body is probed at a
      // fixed spacing along the chunk rather than only where it ends.
      for (const [p, dir] of poses) {
        // Upright, the envelope probe is the cheaper way to ask; leaned
        // over, it is asking about a tool that is not there. See
        // Stock.probeChain.
        const upright = this.isUpright(dir);
        const shankHit = upright
          ? stock.probeBody(slot.built.shankEnvelope, p[0], p[1], p[2])
          : stock.probeChain(slot.built.shankSpheres, p, dir);
        if (shankHit) {
          this.report('deep', {
            line: mv.line,
            message: (d) => `Cutting ${d.toFixed(2)} mm deeper than the flutes reach — the shank is dragging in the cut.`,
            position: [shankHit.x, shankHit.y, shankHit.z],
            depth: shankHit.depth,
          });
        }
        const holderHit = upright
          ? stock.probeBody(slot.built.holderEnvelope, p[0], p[1], p[2])
          : stock.probeChain(slot.built.holderSpheres, p, dir);
        if (holderHit) {
          const name = slot.built.holder ? slot.built.holder.def.name : 'Holder';
          this.report('holder', {
            line: mv.line,
            message: (d) => `${name} buried ${d.toFixed(2)} mm into the stock.`,
            position: [holderHit.x, holderHit.y, holderHit.z],
            depth: holderHit.depth,
          });
        }
      }
    }

    // How close is too close. Zero means only report metal in metal, which
    // is what a check was before anybody could ask for room.
    const clearance = Math.max((this.checks && this.checks.nearMiss) || 0, 0);

    // Which of the machine's castings this chunk could reach at all, and
    // which parts of the machine could meet each other or the stock.
    const nearCastings = this.castingsNear(slot, poses, mv, clearance);
    const nearMachine = this.machineNear(poses, mv, clearance);

    for (const [tip, dir, point, u] of poses) {
      if (this.halted) break;
      if (this.fixtures && this.fixtures.length) {
        const f = checkFixtures(slot.spheres, tip, this.fixtures, 0, clearance, dir);
        if (f && f.gap < 0) {
          this.report('fixture', {
            line: mv.line,
            message: (d) => `Assembly intersects "${f.fixture.name}" by ${d.toFixed(2)} mm.`,
            position: f.point,
            depth: f.depth,
          });
        } else if (f) {
          this.report('near', {
            line: mv.line,
            message: `Passes within ${f.gap.toFixed(2)} mm of "${f.fixture.name}" — asked for ${f.clearance.toFixed(2)} mm.`,
            position: f.point,
            depth: f.clearance - f.gap,
            gap: f.gap,
          });
        }
      }

      // The cutter where it cut nothing: no stock there to say whether it
      // went past the part — air, or a blank that does not cover it — so
      // the cutter itself is measured against the part, and inside it by
      // more than the tolerance is a gouge. Where it did cut, the carve
      // has already measured what it took.
      if (this.referenceOn() && !(removed > 0) && this.target.closed !== false) {
        const cut = checkReference(slot.spheres, tip, dir, this.target.surface, {
          skipAbove: slot.built.fluteLength,
          closed: true,
          sky: referenceSkyline(this.target),
          inside: insideColumns(this.target),
        });
        if (cut && cut.depth > this.gougeTolerance) {
          this.report('gouge', {
            line: mv.line,
            message: (d) => `The cutter is ${d.toFixed(3)} mm inside the reference part, with no stock there to cut — this is gouging.`,
            position: cut.point,
            depth: cut.depth,
          });
        }
      }

      if (this.referenceOn()) {
        const hit = checkReference(slot.spheres, tip, dir, this.target.surface, {
          skipBelow: slot.built.fluteLength,
          clearance,
          closed: this.target.closed !== false,
          sky: referenceSkyline(this.target),
          inside: insideColumns(this.target),
        });
        if (hit && hit.gap < 0) {
          this.report('part', {
            line: mv.line,
            message: (d) => `The holder or shank reaches ${d.toFixed(2)} mm into the reference part.`,
            position: hit.point,
            depth: hit.depth,
          });
        } else if (hit) {
          this.report('near', {
            line: mv.line,
            message: `Passes within ${hit.gap.toFixed(2)} mm of the reference part — asked for ${hit.clearance.toFixed(2)} mm.`,
            position: hit.point,
            depth: hit.clearance - hit.gap,
            gap: hit.gap,
          });
        }
      }

      if (this.machine) {
        const tbl = checkTable(slot.spheres, tip, this.tableShape(), clearance, dir);
        if (tbl && tbl.gap < 0) {
          this.report('table', {
            line: mv.line,
            message: (d) => `Assembly reaches ${d.toFixed(2)} mm below the table surface.`,
            position: [tbl.x, tbl.y, tbl.z],
            depth: tbl.depth,
          });
        } else if (tbl) {
          this.report('near', {
            line: mv.line,
            message: `Passes within ${tbl.gap.toFixed(2)} mm of the table surface — asked for ${tbl.clearance.toFixed(2)} mm.`,
            position: [tbl.x, tbl.y, tbl.z],
            depth: tbl.clearance - tbl.gap,
            gap: tbl.gap,
          });
        }
        const hit = nearCastings.length ? this.checkCastings(slot, tip, dir, mv, u, clearance, nearCastings) : null;
        if (hit) {
          const what = hit.axis ? `the ${hit.name} (${hit.axis} axis)` : `the ${hit.name}`;
          if (hit.gap < 0) {
            this.report('casting', {
              line: mv.line,
              message: (d) => `Assembly hits ${what} by ${d.toFixed(2)} mm.`,
              position: hit.point,
              depth: hit.depth,
            });
          } else {
            this.report('near', {
              line: mv.line,
              message: `Passes within ${hit.gap.toFixed(2)} mm of ${what} — asked for ${hit.clearance.toFixed(2)} mm.`,
              position: hit.point,
              depth: hit.clearance - hit.gap,
              gap: hit.gap,
            });
          }
        }
        const clash = nearMachine ? this.checkMachine(tip, mv, u, clearance, nearMachine) : null;
        if (clash) {
          const say = (b) => (b.body.letter ? `the ${b.s.name} (${b.body.letter} axis)` : `the ${b.s.name}`);
          const what = clash.other ? say(clash.other) : clash.reference ? 'the reference part' : 'the stock';
          const who = say(clash.head);
          if (clash.gap < 0) {
            this.report('machine', {
              line: mv.line,
              message: (d) => `${who[0].toUpperCase()}${who.slice(1)} hits ${what} by ${d.toFixed(2)} mm.`,
              position: clash.point,
              depth: -clash.gap,
            });
          } else {
            this.report('near', {
              line: mv.line,
              message: `${who[0].toUpperCase()}${who.slice(1)} passes within ${clash.gap.toFixed(2)} mm of ${what}.`,
              position: clash.point,
              depth: Math.max(clearance, 0) - clash.gap,
              gap: clash.gap,
            });
          }
        }
        // The envelope belongs to the machine and is measured from its home
        // switches, so what is reported is the machine coordinate — which is
        // the number on the control when the axis stops. The point compared
        // is the gauge line, a gauge length up the tool from the tip, which
        // is the same point G53 reads: an envelope is how far the axis goes,
        // and it does not move when a longer tool goes in the spindle.
        const lim = this.limitsApply(mv)
          ? checkLimits(this.envelopePoint(mv, tip, dir, point, u), limitsInScene(this.machine), homeOf(this.machine))
          : null;
        if (lim) {
          this.report('limit', {
            line: mv.line,
            message: `${lim.axis} travel limit exceeded: machine ${lim.axis}${lim.value.toFixed(2)} vs ${lim.limit.toFixed(2)} mm.`,
            position: tip.slice(),
            depth: Math.abs(lim.value - lim.limit),
          });
        }
      }
    }

    // The rotaries have travels of their own, and a program that asks for
    // C400 or a trunnion past its stop is just as stopped as one that runs
    // the table off its ways. Reading them straight off the move costs
    // nothing, so it is checked on every chunk.
    if (this.fiveAxis && this.limitsApply(mv)) {
      const rot = this.rotaryAt(mv, u1);
      for (const n of this.kinematics.extras()) {
        const v = rot[n.letter];
        if (v === undefined) continue;
        const over = v < n.limits.min ? n.limits.min : v > n.limits.max ? n.limits.max : null;
        if (over === null) continue;
        const unit = n.kind === 'rotary' ? '°' : ' mm';
        this.report('limit', {
          line: mv.line,
          message: `${n.letter} axis travel limit exceeded: ${v.toFixed(2)}${unit} vs ${over.toFixed(2)}${unit}.`,
          position: poseB.tip.slice(),
          depth: Math.abs(v - over),
        });
      }
    }

    return removed > 0;
  }

  /**
   * Tool positions along a tilted chunk, close enough together that
   * consecutive cuts overlap rather than leaving scallops between them.
   * The spacing is a fraction of the cutter radius, which is what decides
   * how quickly the footprint moves off itself.
   */
  stamps(poseA, poseB, slot, mv = null, from = null, to = null, u0 = 1, u1 = 1) {
    const dx = poseB.tip[0] - poseA.tip[0];
    const dy = poseB.tip[1] - poseA.tip[1];
    const dz = poseB.tip[2] - poseA.tip[2];
    const len = Math.hypot(dx, dy, dz);
    const swing = Math.acos(Math.max(-1, Math.min(1, poseA.dir[0] * poseB.dir[0]
      + poseA.dir[1] * poseB.dir[1] + poseA.dir[2] * poseB.dir[2])));
    const r = Math.max(slot.built.cutRadius, 0.05);
    const cell = this.stock ? Math.max(this.stock.dx, this.stock.dy) : 0.05;
    // Stamping leaves a scallop of about d^2/(8r) between cuts, so a big
    // cutter tolerates a longer step — but only up to a point, because the
    // swing between stamps moves the far end of the flutes much further
    // than the tip. Capping the step keeps a tilting face mill from leaving
    // a scalloped wall, and the floor at one cell stops it going pointless.
    // A stock kept along all three axes is there to be read closely, so it
    // is stamped more finely: cusps of a few tenths of a micron rather than
    // a few microns.
    const spacing = this.stock && this.stock.kind === 'tridexel'
      ? Math.max(cell * 0.5, Math.min(r * 0.05, 0.3))
      : Math.max(cell, Math.min(r * 0.12, 0.8));
    // The far end of the flutes travels further than the tip when the tool
    // swings, so the swing gets a say in the count as well.
    const arc = swing * Math.max(slot.built.fluteLength, r);
    const n = Math.max(1, Math.min(4096, Math.ceil(Math.max(len, arc) / spacing)));
    // Turning the part without TCP: the cut follows the tip round its arc.
    if (mv && from && to && this.swingsWithoutTcp(mv, u0, u1)) return this.posesAlong(mv, from, to, u0, u1, n);

    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const tip = [poseA.tip[0] + dx * t, poseA.tip[1] + dy * t, poseA.tip[2] + dz * t];
      out.push([tip, slerp(poseA.dir, poseB.dir, t)]);
    }
    return out;
  }

  /**
   * Poses along a chunk at which to run the point-wise collision tests.
   *
   * The tip is not the whole story once the head can lean. A move that
   * swings the rotaries without moving the tip at all — a tool-axis change
   * over a fixed point, which is most of what five-axis positioning is —
   * drags the holder through an arc metres long at the spindle nose while
   * the tip stands still, so the swing gets a say in how many poses come
   * back alongside the distance travelled.
   *
   * @returns {Array<[number[], number[]]>} [tip, tool axis] pairs
   */
  probePoses(poseA, poseB, mv = null, from = null, to = null, u0 = 1, u1 = 1) {
    const tips = this.probePoints(poseA.tip, poseB.tip);
    const ends = (t) => (from && to ? [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t] : null);
    if (!this.fiveAxis) return tips.map((t, i) => [t, UP, ends((i + 1) / tips.length), u0 + (u1 - u0) * ((i + 1) / tips.length)]);

    const swing = Math.acos(Math.max(-1, Math.min(1, poseA.dir[0] * poseB.dir[0]
      + poseA.dir[1] * poseB.dir[1] + poseA.dir[2] * poseB.dir[2])));
    // How far the far end of the assembly travels on that swing. The tool
    // is the thing being swung, so its own length is the lever arm.
    const reach = this.activeSlot ? this.activeSlot.built.totalLength : 0;
    let n = Math.max(tips.length, Math.min(512, Math.ceil((swing * reach) / this.probeSpacing)));
    // Turning the part without TCP takes the tip round an arc as long as
    // its distance from the pivot; each pose is where the machine puts it.
    if (mv && from && to && this.swingsWithoutTcp(mv, u0, u1)) {
      const arc = Math.hypot(poseB.tip[0] - poseA.tip[0], poseB.tip[1] - poseA.tip[1], poseB.tip[2] - poseA.tip[2]) * (swing > 1e-9 ? swing / (2 * Math.sin(swing / 2) || 1) : 1);
      n = Math.max(n, Math.min(512, Math.ceil(arc / this.probeSpacing)));
      return this.posesAlong(mv, from, to, u0, u1, n);
    }
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      out.push([
        [
          poseA.tip[0] + (poseB.tip[0] - poseA.tip[0]) * t,
          poseA.tip[1] + (poseB.tip[1] - poseA.tip[1]) * t,
          poseA.tip[2] + (poseB.tip[2] - poseA.tip[2]) * t,
        ],
        slerp(poseA.dir, poseB.dir, t),
        ends(t),
        u0 + (u1 - u0) * t,
      ]);
    }
    return out;
  }

  /**
   * Points along a chunk at which to run the point-wise collision tests,
   * always including the far end.
   */
  probePoints(from, to) {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const n = Math.max(1, Math.ceil(len / this.probeSpacing));
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      out.push([
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ]);
    }
    return out;
  }

  /**
   * Run the whole program without a time limit.
   * @param {(p:number)=>void} [onProgress] called with 0..1
   */
  runAll(onProgress) {
    const started = performance.now();
    let guard = 0;
    while (!this.finished && guard++ < 200000) {
      this.run(Infinity, 40);
      if (onProgress) onProgress(this.progress);
    }
    return performance.now() - started;
  }

  /**
   * Whether the holder, shank and spindle are checked against the
   * reference part: when there is one, and the checks have not been told
   * to leave it out.
   */
  referenceOn() {
    return !!(this.target && this.target.surface) && !(this.checks && this.checks.reference === false);
  }

  /** Fast-forward from the start to a target simulated time. */
  seek(targetTime, budgetMs = 30) {
    if (targetTime < this.time) this.reset();
    return this.run(Math.max(0, targetTime - this.time), budgetMs);
  }

  summary() {
    const errors = this.collisions.filter((c) => c.severity === 'error');
    return {
      time: this.time,
      totalTime: this.totalTime,
      progress: this.progress,
      removedVolume: this.removedVolume,
      collisions: this.collisions.length,
      errors: errors.length,
      finished: this.finished,
      moveIndex: this.moveIndex,
      line: this.program && this.program.moves[this.moveIndex] ? this.program.moves[this.moveIndex].line : 0,
      pos: this.pos.slice(),
      tool: this.currentTool,
    };
  }
}
