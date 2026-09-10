// The simulation loop.
//
// Walks the interpreted move list, sub-steps each move finely enough that
// the swept tool leaves no gaps in the heightmap, removes material and
// reports every crash it finds. It is time-sliced: `run(budgetMs)` does as
// much work as fits in a frame and returns, so the UI stays responsive on
// programs with millions of moves.

import { checkFixtures, checkLimits, checkTable } from './collision.js';

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
};

const MAX_COLLISIONS = 400;

/** Cached per-move segment lengths. */
function segmentsOf(mv) {
  if (mv._segLen) return mv._segLen;
  const p = mv.path;
  const n = p.length / 3 - 1;
  const len = new Float64Array(Math.max(n, 1));
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(p[i * 3 + 3] - p[i * 3], p[i * 3 + 4] - p[i * 3 + 1], p[i * 3 + 5] - p[i * 3 + 2]);
    len[i] = d;
    total += d;
  }
  mv._segLen = len;
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
    if (opts.fixtures !== undefined) this.fixtures = opts.fixtures || [];
    if (opts.target !== undefined) this.target = opts.target;
    if (opts.gougeTolerance !== undefined) this.gougeTolerance = opts.gougeTolerance;
    this.reset();
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
        const take = Math.min(remaining, Math.max(mv.time - (this._dwelt || 0), 0));
        this._dwelt = (this._dwelt || 0) + take;
        this.time += take;
        remaining -= take;
        advanced += take;
        if (this._dwelt >= mv.time - 1e-9) {
          this._dwelt = 0;
          this.pos = mv.to.slice();
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

      // Does this segment interact with anything? Rejecting whole segments
      // is what makes long air moves free.
      const info = this.segmentInfo(mv, ax, ay, az, bx, by, bz);
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
        const cut = this.sweep(mv, [fromX, fromY, fromZ], [x, y, z]);
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
   * Decide whether a segment needs sampling at all and how finely.
   * The whole-segment rejection uses the stock tile pyramid plus the
   * bounding boxes of the fixtures.
   */
  segmentInfo(mv, ax, ay, az, bx, by, bz) {
    const slot = this.activeSlot;
    const stock = this.stock;

    if (!slot) return { active: false, stepSize: Infinity };

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

    const rBody = Math.max(slot.built.bodyRadius, slot.built.cutRadius);
    const zLow = Math.min(az, bz);

    let touchesStock = false;
    if (stock) {
      const x0 = Math.min(ax, bx) - rBody, x1 = Math.max(ax, bx) + rBody;
      const y0 = Math.min(ay, by) - rBody, y1 = Math.max(ay, by) + rBody;
      const maxH = stock.maxHeightIn(x0, y0, x1, y1);
      touchesStock = Number.isFinite(maxH) && zLow < maxH + 1e-6;
    }

    const hasObstacles = (this.fixtures && this.fixtures.length) || (this.machine && this.machine.table && this.machine.table.enabled);
    const limitsOn = this.machine && this.machine.limits && this.machine.limits.enabled;

    if (touchesStock) {
      return { active: true, stepSize: chunk };
    }
    if (hasObstacles) {
      return { active: true, stepSize: 1.5 };
    }
    if (limitsOn) {
      return { active: true, stepSize: 25 };
    }
    return { active: false, stepSize: Infinity };
  }

  /** Carve the volume swept between two tool positions, then look for crashes. */
  sweep(mv, from, to) {
    const slot = this.activeSlot;
    if (!slot) return false;
    const stock = this.stock;
    const [x, y, z] = to;
    let removed = 0;

    if (stock) {
      const result = stock.carveSweep(slot.built.cutEnvelope, from, to, slot.index, {
        target: this.target,
        tolerance: this.gougeTolerance,
      });
      removed = result.volume;
      if (result.gouge) {
        const g = result.gouge;
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
        if (mv.kind === 'rapid') {
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
      for (const p of this.probePoints(from, to)) {
        const shankHit = stock.probeBody(slot.built.shankEnvelope, p[0], p[1], p[2]);
        if (shankHit) {
          this.report('deep', {
            line: mv.line,
            message: (d) => `Cutting ${d.toFixed(2)} mm deeper than the flutes reach — the shank is dragging in the cut.`,
            position: [shankHit.x, shankHit.y, shankHit.z],
            depth: shankHit.depth,
          });
        }
        const holderHit = stock.probeBody(slot.built.holderEnvelope, p[0], p[1], p[2]);
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

    for (const tip of this.probePoints(from, to)) {
    if (this.fixtures && this.fixtures.length) {
      const f = checkFixtures(slot.spheres, tip, this.fixtures, 0);
      if (f) {
        this.report('fixture', {
          line: mv.line,
          message: (d) => `Assembly intersects "${f.fixture.name}" by ${d.toFixed(2)} mm.`,
          position: f.point,
          depth: f.depth,
        });
      }
    }

    if (this.machine) {
      const tbl = checkTable(slot.spheres, tip, this.machine.table);
      if (tbl) {
        this.report('table', {
          line: mv.line,
          message: (d) => `Assembly reaches ${d.toFixed(2)} mm below the table surface.`,
          position: [x, y, tbl.z],
          depth: tbl.depth,
        });
      }
      const lim = checkLimits(tip, this.machine.limits);
      if (lim) {
        this.report('limit', {
          line: mv.line,
          message: `${lim.axis} travel limit exceeded: ${lim.value.toFixed(2)} vs ${lim.limit.toFixed(2)} mm.`,
          position: tip.slice(),
          depth: Math.abs(lim.value - lim.limit),
        });
      }
    }
    }

    return removed > 0;
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
