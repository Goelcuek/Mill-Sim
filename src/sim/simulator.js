// The simulation loop.
//
// Walks the interpreted move list, sub-steps each move finely enough that
// the swept tool leaves no gaps in the heightmap, removes material and
// reports every crash it finds. It is time-sliced: `run(budgetMs)` does as
// much work as fits in a frame and returns, so the UI stays responsive on
// programs with millions of moves.

import { checkFixtures, checkLimits, checkTable } from './collision.js';
import * as m4 from '../core/mat4.js';
import { homeOf, limitsInScene } from '../machine/config.js';

export const COLLISION_TYPES = {
  holder: { label: 'Holder / shank crash', severity: 'error' },
  rapid: { label: 'Rapid into material', severity: 'error' },
  fixture: { label: 'Fixture collision', severity: 'error' },
  table: { label: 'Table collision', severity: 'error' },
  limit: { label: 'Travel limit exceeded', severity: 'error' },
  spindle: { label: 'Cutting with spindle stopped', severity: 'warning' },
  notool: { label: 'No tool assembly loaded', severity: 'warning' },
  deep: { label: 'Depth of cut exceeds flute length', severity: 'error' },
  gouge: { label: 'Gouge into the reference part', severity: 'error' },
  near: { label: 'Near miss', severity: 'warning' },
};

const MAX_COLLISIONS = 400;
const UP = [0, 0, 1];
const DEG = Math.PI / 180;

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

export class Simulator {
  constructor() {
    this.program = null;
    this.stock = null;
    this.machine = null;
    this.fixtures = [];
    this.slots = new Map();     // tool number -> { built, spheres, index }
    this.fallbackSlot = null;
    /** Reference-part surface on the stock grid; cutting below it gouges. */
    this.target = null;
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
    if (opts.target !== undefined) this.target = opts.target;
    if (opts.gougeTolerance !== undefined) this.gougeTolerance = opts.gougeTolerance;
    if (opts.checks !== undefined) this.checks = opts.checks;
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
    if (opts.gougeTolerance !== undefined) this.gougeTolerance = opts.gougeTolerance;
    if (opts.checks !== undefined) this.checks = opts.checks;
  }

  reset() {
    this.moveIndex = 0;
    this.segIndex = 0;
    this.segPos = 0;            // mm travelled into the current segment
    this.time = 0;              // simulated seconds
    this.distance = 0;
    this.finished = !this.program || !this.program.moves.length;
    this.collisions = [];
    this.collisionKeys = new Map();
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
    this.notified = new Set();
  }

  get totalTime() {
    return this.program ? this.program.stats.cycleTime : 0;
  }

  get progress() {
    const t = this.totalTime;
    return t > 0 ? Math.min(1, this.time / t) : this.finished ? 1 : 0;
  }

  /** Tool assembly in effect for a given T number. */
  slotFor(toolNumber) {
    if (this.slots.has(toolNumber)) return this.slots.get(toolNumber);
    if (toolNumber && !this.notified.has(`t${toolNumber}`)) {
      this.notified.add(`t${toolNumber}`);
      this.report('notool', {
        line: this.program.moves[this.moveIndex] ? this.program.moves[this.moveIndex].line : 0,
        message: `T${toolNumber} has no assembly assigned; the fallback assembly is used.`,
      });
    }
    return this.fallbackSlot;
  }

  report(type, data) {
    const meta = COLLISION_TYPES[type] || { label: type, severity: 'error' };
    const key = `${type}:${data.line}`;
    const existing = this.collisionKeys.get(key);
    if (existing) {
      existing.count++;
      if ((data.depth || 0) > (existing.depth || 0)) {
        existing.depth = data.depth;
        existing.position = data.position || existing.position;
        if (typeof data.message === 'function') existing.message = data.message(existing.depth);
      }
      if (data.volume) existing.volume = (existing.volume || 0) + data.volume;
      return existing;
    }
    if (this.collisions.length >= MAX_COLLISIONS) return null;
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
      if (performance.now() > deadline) break;

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
      const info = this.segmentInfo(mv, ax, ay, az, bx, by, bz, uPrev);
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
    // Who turns the part: the chain, when the machine has been modelled
    // with the axis, or this, when it has not. Doing it twice puts the cut
    // at double the angle, and doing it neither leaves the tool going
    // round with the part instead of standing still.
    const chainSpins = !!(idx && idx.inChain);
    if (!this.fiveAxis) return { tip: this.onPart(point, index), dir: UP, index };
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
      const axis = k.toolAxis(rot, gauge);
      if (chainSpins) {
        const m = k.indexTransform(k.coordNode(idx.letter), { ...rot });
        return { tip: m4.transformPoint([0, 0, 0], m, point), dir: m4.normalize(m4.transformDir([0, 0, 0], m, axis)), index };
      }
      return { tip: this.onPart(point, index), dir: this.onPart(axis, index), index };
    }
    const r = k.toolInPart({ X: point[0], Y: point[1], Z: point[2], ...rot }, gauge);
    const spin = chainSpins ? 0 : index;
    return { tip: this.onPart(r.tip, spin), dir: this.onPart(r.axis, spin), index };
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
    let values = { ...rot, X: point[0], Y: point[1], Z: point[2] };
    if (mv.tcp) {
      const sol = this.kinematics.linearsForTip(pose.tip, rot, this.gaugeLength);
      if (sol) values = { ...rot, ...sol };
    }
    return { values, tip: pose.tip, dir: pose.dir, rot, index: pose.index || 0 };
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
  segmentInfo(mv, ax, ay, az, bx, by, bz, u = 1) {
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
      const pb = this.poseAt(mv, [bx, by, bz], 1);
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

    const hasObstacles = (this.fixtures && this.fixtures.length) || (this.machine && this.machine.table && this.machine.table.enabled);
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
    const poses = this.probePoses(poseA, poseB);

    if (stock) {
      const opts = { target: this.target, tolerance: this.gougeTolerance };
      let gouged = null;
      if (!tilted) {
        const result = stock.carveSweep(slot.built.cutEnvelope, poseA.tip, poseB.tip, slot.index, opts);
        removed = result.volume;
        gouged = result.gouge;
      } else {
        for (const [tip, dir] of this.stamps(poseA, poseB, slot)) {
          const result = stock.carveTilted(slot.built.cutEnvelope, tip, dir, slot.built.fluteLength, slot.index, opts);
          removed += result.volume;
          if (result.gouge && (!gouged || result.gouge.depth > gouged.depth)) gouged = result.gouge;
        }
      }
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

    for (const [tip, dir] of poses) {
    // How close is too close. Zero means only report metal in metal, which
    // is what a check was before anybody could ask for room.
    const clearance = Math.max((this.checks && this.checks.nearMiss) || 0, 0);

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

    if (this.machine) {
      const tbl = checkTable(slot.spheres, tip, this.machine.table, clearance, dir);
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
      // The envelope belongs to the machine and is measured from its home
      // switches, so what is reported is the machine coordinate — which is
      // the number on the control when the axis stops. The point compared
      // is the gauge line, a gauge length up the tool from the tip, which
      // is the same point G53 reads: an envelope is how far the axis goes,
      // and it does not move when a longer tool goes in the spindle.
      const lim = checkLimits(this.gaugePoint(tip, dir), limitsInScene(this.machine), homeOf(this.machine));
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
    if (this.fiveAxis) {
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
  stamps(poseA, poseB, slot) {
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
    const spacing = Math.max(cell, Math.min(r * 0.12, 0.8));
    // The far end of the flutes travels further than the tip when the tool
    // swings, so the swing gets a say in the count as well.
    const arc = swing * Math.max(slot.built.fluteLength, r);
    const n = Math.max(1, Math.min(4096, Math.ceil(Math.max(len, arc) / spacing)));

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
  probePoses(poseA, poseB) {
    const tips = this.probePoints(poseA.tip, poseB.tip);
    if (!this.fiveAxis) return tips.map((t) => [t, UP]);

    const swing = Math.acos(Math.max(-1, Math.min(1, poseA.dir[0] * poseB.dir[0]
      + poseA.dir[1] * poseB.dir[1] + poseA.dir[2] * poseB.dir[2])));
    // How far the far end of the assembly travels on that swing. The tool
    // is the thing being swung, so its own length is the lever arm.
    const reach = this.activeSlot ? this.activeSlot.built.totalLength : 0;
    const n = Math.max(tips.length, Math.min(512, Math.ceil((swing * reach) / this.probeSpacing)));
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
