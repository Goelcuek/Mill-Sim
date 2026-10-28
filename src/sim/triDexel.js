// Tri-dexel stock: the material seen along X, Y and Z.
//
// The heightmap keeps one number per column — the top of the material —
// and so cannot hold anything under an overhang: a hole drilled from the
// side, a slot under a ledge, the far side of a part cut with the table
// tipped over. This keeps three grids of lines instead, one running along
// each axis, and for every line the stretches of it that are inside
// material: [in, out], [in, out], … A hole from the side is a gap in the
// X lines it runs along and in every Z and Y line it crosses. Every face of
// the part is crossed by one of the three families no further than 54.7°
// from square, so walls are seen as well as floors.
//
// Cutting is the same question on every line: where does it go into the
// swept cutter and where does it come out. The cutter is convex, so that is
// one interval, and it is solved exactly rather than by stamping wherever
// the geometry allows:
//
//   along the tool axis       — the lowest and highest the swept tool
//                               reaches on the line: a search over the move
//                               on the profile's tables, as the heightmap's
//                               sweep does
//   square to the tool axis   — the line lies in one slice of the tool, a
//                               disc; moving in a straight line it sweeps a
//                               capsule, which is closed form; a plunge
//                               widens it to the widest the tool gets; a
//                               ramp is searched
//   at any other angle        — the tool at one position, solved exactly
//                               against its pieces; a move is stamped
//
// The top-down view — the highest material on each Z line — is kept as the
// heightmap's own arrays, so everything that reads a heightmap (the air-move
// rejection, the force model, snapping, picking) keeps working.

import { Stock, TILE } from './stock.js';
import { lineInside, nearestWithin } from './surfaceIndex.js';
import { profileOf } from '../tools/profile.js';

/**
 * Removals smaller than this, in mm along a line, are rounding, not cuts.
 * The stretches are kept in single precision — about 8e-6 mm at 120 mm
 * from the origin — so a cut that only retraces a face already there (a
 * tool backing out of its own hole) recomputes it a few of those away.
 * Counted, that is a rapid "removing material" through air.
 */
const MIN_CUT = 1e-4;
/** What is left of a stretch shorter than this is dropped. */
const SLIVER = 1e-4;
/** Stretches one line can hold. A comb with more teeth than this is merged. */
const MAX_INTERVALS = 255;

const SCRATCH = new Float32Array(2 * (MAX_INTERVALS + 2));
const SCRATCH_W = new Uint8Array(2 * (MAX_INTERVALS + 2));
const HIT = [0, 0];
/** What the last subtract took out of its line, [from, to] pairs in the line's own measure. */
const REMOVED = [];
/** How many places a carve may ask the part about exactly. */
const GOUGE_CANDIDATES = 4;
const SPAN = [0, 0];

const PARALLEL = 0;
const PERP_FLAT = 1;
const PERP_PLUNGE = 2;
const PERP_RAMP = 3;
const OBLIQUE = 4;

/** The other two coordinates of p, in the order a family along `axis` keeps them. */
function rest(axis, p) {
  return axis === 0 ? [p[1], p[2]] : axis === 1 ? [p[0], p[2]] : [p[0], p[1]];
}

/** How far v is from leaving the stretch of `inside` it is in; 0 when in none. */
function depthAlong(inside, v) {
  for (let q = 0; q < inside.length; q += 2) {
    if (v >= inside[q] && v <= inside[q + 1]) return Math.min(v - inside[q], inside[q + 1] - v);
  }
  return 0;
}

/**
 * The part of a convex [r, z] outline on one side of the axis: r ≥ 0 for
 * side 1, r ≤ 0 for side −1. Still convex, and still [r, z].
 */
function clipHalf(poly, side) {
  const out = [];
  const m = poly.length;
  for (let k = 0; k < m; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % m];
    const sp = side * p[0];
    const sq = side * q[0];
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0) && sp !== sq) {
      const t = sp / (sp - sq);
      out.push([0, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** A cell size that keeps the three grids within the line budget. */
function cellFor(size, requested, maxRays) {
  let h = Math.max(requested || 0.4, 0.02);
  const area = size[0] * size[1] + size[1] * size[2] + size[0] * size[2];
  if (area / (h * h) > maxRays) h = Math.sqrt(area / maxRays);
  return h;
}

/**
 * The stretch of the line y = yl within distance r of the segment
 * (x0, y0)–(x1, y1): a capsule, which is convex, so the answer is an
 * interval whose ends lie on its outline — on one of the end discs, or on
 * one of the two straight sides.
 */
function capsuleLine(x0, y0, x1, y1, r, yl, out) {
  let lo = Infinity;
  let hi = -Infinity;
  let d = y0 - yl;
  if (d * d <= r * r) {
    const w = Math.sqrt(r * r - d * d);
    lo = x0 - w; hi = x0 + w;
  }
  d = y1 - yl;
  if (d * d <= r * r) {
    const w = Math.sqrt(r * r - d * d);
    if (x1 - w < lo) lo = x1 - w;
    if (x1 + w > hi) hi = x1 + w;
  }
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len > 1e-12 && Math.abs(dy) > 1e-12) {
    const nx = (-dy / len) * r;
    const ny = (dx / len) * r;
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const lam = (yl - y0 - sgn * ny) / dy;
      if (lam >= 0 && lam <= 1) {
        const x = x0 + lam * dx + sgn * nx;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
  }
  if (lo > hi) return false;
  out[0] = lo;
  out[1] = hi;
  return true;
}

/**
 * Where the line o + t·e_a (e_a the unit vector along axis a) runs through
 * a capsule: every point within `rad` of the segment P0–P1. A ball swept
 * along a straight line is exactly this. Convex, so one interval: the hull
 * of the two end balls and the round side between them.
 */
function rayCapsule(o, a, P0, P1, rad, out) {
  let lo = Infinity;
  let hi = -Infinity;
  const r2 = rad * rad;
  for (let k = 0; k < 2; k++) {
    const P = k ? P1 : P0;
    const qx = o[0] - P[0], qy = o[1] - P[1], qz = o[2] - P[2];
    const qa = a === 0 ? qx : a === 1 ? qy : qz;
    const disc = qa * qa - (qx * qx + qy * qy + qz * qz - r2);
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      if (-qa - sq < lo) lo = -qa - sq;
      if (-qa + sq > hi) hi = -qa + sq;
    }
  }
  const wx = P1[0] - P0[0], wy = P1[1] - P0[1], wz = P1[2] - P0[2];
  const L2 = wx * wx + wy * wy + wz * wz;
  if (L2 > 1e-18) {
    const qx = o[0] - P0[0], qy = o[1] - P0[1], qz = o[2] - P0[2];
    const qw = qx * wx + qy * wy + qz * wz;
    const wa = a === 0 ? wx : a === 1 ? wy : wz;
    const qa = a === 0 ? qx : a === 1 ? qy : qz;
    // Squared distance to the segment's line, less r², as a quadratic in t.
    const A2 = 1 - (wa * wa) / L2;
    const A1 = 2 * (qa - (qw * wa) / L2);
    const A0 = qx * qx + qy * qy + qz * qz - (qw * qw) / L2 - r2;
    let ta = -Infinity;
    let tb = Infinity;
    let ok = true;
    if (A2 > 1e-14) {
      const disc = A1 * A1 - 4 * A2 * A0;
      if (disc < 0) ok = false;
      else {
        const sq = Math.sqrt(disc);
        ta = (-A1 - sq) / (2 * A2);
        tb = (-A1 + sq) / (2 * A2);
      }
    } else if (A0 > 0) ok = false;
    if (ok) {
      // Only alongside the segment, not past its ends.
      if (Math.abs(wa) > 1e-14) {
        let t0 = -qw / wa;
        let t1 = (L2 - qw) / wa;
        if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
        if (t0 > ta) ta = t0;
        if (t1 < tb) tb = t1;
      } else if (qw < 0 || qw > L2) ok = false;
      if (ok && ta <= tb) {
        if (ta < lo) lo = ta;
        if (tb > hi) hi = tb;
      }
    }
  }
  if (lo > hi) return false;
  out[0] = lo;
  out[1] = hi;
  return true;
}

/**
 * The stretch of the line y = yl inside the hull of two discs: a disc whose
 * centre and radius both move in a straight line sweeps exactly that, which
 * is a cone of the cutter moving square to its axis. The hull's outline is
 * the two circles and the two outer tangents between them.
 */
function hullLine(x0, y0, r0, x1, y1, r1, yl, out) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < 2; k++) {
    const x = k ? x1 : x0, y = k ? y1 : y0, r = k ? r1 : r0;
    const d = y - yl;
    if (d * d <= r * r) {
      const w = Math.sqrt(r * r - d * d);
      if (x - w < lo) lo = x - w;
      if (x + w > hi) hi = x + w;
    }
  }
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist > Math.abs(r1 - r0) + 1e-12) {
    const ex = dx / dist, ey = dy / dist;
    const cs = (r0 - r1) / dist;
    const sn = Math.sqrt(Math.max(0, 1 - cs * cs));
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const nx = cs * ex - sgn * sn * ey;
      const ny = cs * ey + sgn * sn * ex;
      const ax = x0 + r0 * nx, ay = y0 + r0 * ny;
      const bx = x1 + r1 * nx, by = y1 + r1 * ny;
      if ((ay - yl) * (by - yl) <= 0 && Math.abs(by - ay) > 1e-15) {
        const lam = (yl - ay) / (by - ay);
        const x = ax + lam * (bx - ax);
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
  }
  if (lo > hi) return false;
  out[0] = lo;
  out[1] = hi;
  return true;
}

const PIECE = [0, 0];
const BALL0 = [0, 0, 0];
const BALL1 = [0, 0, 0];

/** Golden-section minimum of a convex function on [a, b], seeded with the ends. */
function goldenMin(f, a, b, iters) {
  let best = Math.min(f(a), f(b));
  if (b - a < 1e-12) return best;
  const R = 0.6180339887498949;
  let x1 = b - R * (b - a);
  let x2 = a + R * (b - a);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let it = 0; it < iters; it++) {
    if (f1 < f2) {
      b = x2; x2 = x1; f2 = f1;
      x1 = b - R * (b - a);
      f1 = f(x1);
    } else {
      a = x1; x1 = x2; f1 = f2;
      x2 = a + R * (b - a);
      f2 = f(x2);
    }
  }
  if (f1 < best) best = f1;
  if (f2 < best) best = f2;
  return best;
}

export class TriDexelStock extends Stock {
  /**
   * @param {object} opts  as Stock, plus `maxRays`: the most lines the three
   *   grids may hold between them. Twelve million is a little under 200 MB
   *   at one stretch a line.
   */
  constructor(opts) {
    const size = opts.size.map((v) => Math.max(Math.abs(v), 0.1));
    const h = cellFor(size, opts.resolution, opts.maxRays || 12000000);
    super({ ...opts, resolution: h, maxCells: Infinity });
    this.kind = 'tridexel';
    const nz = Math.max(2, Math.round(this.size[2] / h));
    /** Counts, spacings and origins along X, Y, Z: the three grids share them. */
    this.n3 = [this.nx, this.ny, nz];
    this.d3 = [this.dx, this.dy, this.size[2] / nz];
    this.o3 = [this.origin[0], this.origin[1], this.base];
    this.fam = [0, 1, 2].map((a) => this.makeFamily(a));
    /** The reference part along each line, as it is asked for; made when there is one. */
    this.partCache = { target: null, lines: [] };
    this.partLines = null;
    this.candidates = [];
    this.reset();
  }

  /** The lines along axis a, on a grid over the other two. */
  makeFamily(a) {
    const b = a === 0 ? 1 : 0;
    const c = a === 2 ? 1 : 2;
    const nb = this.n3[b];
    const nc = this.n3[c];
    const rays = nb * nc;
    return {
      a, b, c, nb, nc, rays,
      db: this.d3[b], dc: this.d3[c],
      len: this.size[a],
      off: new Int32Array(rays),
      cnt: new Uint8Array(rays),
      cap: new Uint8Array(rays),
      pool: new Float32Array(0),
      who: new Uint8Array(0),
      used: 0,
      version: 0,
    };
  }

  get rayCount() { return this.fam ? this.fam[0].rays + this.fam[1].rays + this.fam[2].rays : 0; }

  reset() {
    // The top-down view first: it is the heightmap's own reset.
    super.reset();
    if (!this.fam) return;                 // still inside Stock's constructor
    for (const F of this.fam) this.fill(F);
    this.removedVolume = 0;
  }

  /**
   * Start every line off as the stock: one stretch end to end for a block;
   * for a shaped stock, the runs of columns that are taller than the line.
   */
  fill(F) {
    const init = this.initial;
    const lists = init ? this.shapedRuns(F, init) : null;
    let total = 0;
    for (let r = 0; r < F.rays; r++) total += Math.max(1, lists ? lists[r].length / 2 : 1);
    const size = Math.ceil(total * 2 * 1.25) + 4096;
    F.pool = new Float32Array(size);
    F.who = new Uint8Array(size);
    let at = 0;
    for (let r = 0; r < F.rays; r++) {
      const list = lists ? lists[r] : null;
      const n = list ? list.length / 2 : 1;
      F.off[r] = at;
      F.cap[r] = Math.max(1, Math.min(MAX_INTERVALS, n));
      F.cnt[r] = Math.min(MAX_INTERVALS, n);
      if (list) for (let k = 0; k < 2 * F.cnt[r]; k++) F.pool[at + k] = list[k];
      else { F.pool[at] = 0; F.pool[at + 1] = F.len; }
      at += 2 * F.cap[r];
    }
    F.used = at;
    F.version++;
    const o = this.o3;
    this.markDirty3(o[0], o[1], o[2], o[0] + this.size[0], o[1] + this.size[1], o[2] + this.size[2]);
  }

  /**
   * The box of space whose material changed since the display last asked,
   * world mm: [x0, y0, z0, x1, y1, z1], or null. A box rather than the
   * lines' footprint, because a Z line cut at the top is unchanged lower
   * down, and the surface is redrawn by the block.
   */
  markDirty3(x0, y0, z0, x1, y1, z1) {
    const d = this.dirty3;
    if (!d) { this.dirty3 = [x0, y0, z0, x1, y1, z1]; return; }
    if (x0 < d[0]) d[0] = x0;
    if (y0 < d[1]) d[1] = y0;
    if (z0 < d[2]) d[2] = z0;
    if (x1 > d[3]) d[3] = x1;
    if (y1 > d[4]) d[4] = y1;
    if (z1 > d[5]) d[5] = z1;
  }

  /** The changed box, cleared for next time. */
  takeDirty3() {
    const d = this.dirty3 || null;
    this.dirty3 = null;
    return d;
  }

  /** Stretches of each line inside a shaped stock, from its column heights. */
  shapedRuns(F, init) {
    const out = new Array(F.rays);
    const { nx, ny } = this;
    const base = this.base;
    if (F.a === 2) {
      for (let r = 0; r < F.rays; r++) {
        const hgt = init[r] - base;
        out[r] = hgt > SLIVER ? [0, hgt] : [];
      }
      return out;
    }
    const dz = this.d3[2];
    // Along X: a run of columns in one row taller than the line's height.
    // Along Y: the same down a column of the grid. The run ends at the
    // edges of the columns, which is as near as a column says.
    for (let k = 0; k < F.nc; k++) {
      const z = (k + 0.5) * dz;
      for (let m = 0; m < F.nb; m++) {
        const runs = [];
        let start = -1;
        const n = F.a === 0 ? nx : ny;
        const step = F.a === 0 ? this.dx : this.dy;
        for (let q = 0; q <= n; q++) {
          const inside = q < n && (F.a === 0 ? init[m * nx + q] : init[q * nx + m]) - base > z;
          if (inside && start < 0) start = q;
          if (!inside && start >= 0) { runs.push(start * step, q * step); start = -1; }
        }
        out[k * F.nb + m] = runs;
      }
    }
    return out;
  }

  // ---- the stretches on one line --------------------------------------

  /** A block of the pool big enough for `cap` stretches. */
  allocBlock(F, cap) {
    const need = 2 * cap;
    if (F.used + need > F.pool.length) this.compact(F, need);
    const at = F.used;
    F.used += need;
    return at;
  }

  /** Close up the holes lines left when they moved to bigger blocks. */
  compact(F, extra) {
    let live = 0;
    for (let r = 0; r < F.rays; r++) live += 2 * F.cap[r];
    const size = Math.ceil((live + extra) * 1.4) + 4096;
    const pool = new Float32Array(size);
    const who = new Uint8Array(size);
    let at = 0;
    for (let r = 0; r < F.rays; r++) {
      const o = F.off[r];
      const n2 = 2 * F.cnt[r];
      if (n2) {
        pool.set(F.pool.subarray(o, o + n2), at);
        who.set(F.who.subarray(o, o + n2), at);
      }
      F.off[r] = at;
      at += 2 * F.cap[r];
    }
    F.pool = pool;
    F.who = who;
    F.used = at;
  }

  /**
   * Take [a, b] out of line r. Returns how much material that was, in mm
   * along the line. The new faces are marked as cut by `flag`.
   */
  subtract(F, r, a, b, flag) {
    const n = F.cnt[r];
    if (n === 0) return 0;
    let o = F.off[r];
    const pool = F.pool;
    const who = F.who;
    if (b <= pool[o] + MIN_CUT || a >= pool[o + 2 * n - 1] - MIN_CUT) return 0;
    // Nearly every cut takes the top off the highest stretch — a tool
    // coming down on the material — and that is one number changed in
    // place, not a list rebuilt.
    {
      const k = 2 * (n - 1);
      const s0 = pool[o + k];
      const e0 = pool[o + k + 1];
      if (b >= e0 && a - s0 > SLIVER && (n === 1 || a >= pool[o + k - 1])) {
        const removed = e0 - a;
        if (removed <= MIN_CUT) return 0;
        REMOVED.length = 0;
        REMOVED.push(a, e0);
        pool[o + k + 1] = a;
        who[o + k + 1] = flag;
        return removed;
      }
    }
    let m = 0;
    let removed = 0;
    REMOVED.length = 0;
    for (let k = 0; k < n; k++) {
      const s = pool[o + 2 * k];
      const e = pool[o + 2 * k + 1];
      if (e <= a || s >= b) {
        SCRATCH[m] = s; SCRATCH_W[m++] = who[o + 2 * k];
        SCRATCH[m] = e; SCRATCH_W[m++] = who[o + 2 * k + 1];
        continue;
      }
      removed += (e < b ? e : b) - (s > a ? s : a);
      REMOVED.push(s > a ? s : a, e < b ? e : b);
      if (a - s > SLIVER) {
        SCRATCH[m] = s; SCRATCH_W[m++] = who[o + 2 * k];
        SCRATCH[m] = a; SCRATCH_W[m++] = flag;
      }
      if (e - b > SLIVER) {
        SCRATCH[m] = b; SCRATCH_W[m++] = flag;
        SCRATCH[m] = e; SCRATCH_W[m++] = who[o + 2 * k + 1];
      }
    }
    if (removed <= MIN_CUT) return 0;
    let count = m >> 1;
    if (count > MAX_INTERVALS) {
      // More teeth than a line holds: the last ones are merged, which keeps
      // the material and loses only the gaps between them.
      SCRATCH[2 * MAX_INTERVALS - 1] = SCRATCH[m - 1];
      SCRATCH_W[2 * MAX_INTERVALS - 1] = SCRATCH_W[m - 1];
      count = MAX_INTERVALS;
    }
    if (count > F.cap[r]) {
      const cap = Math.min(MAX_INTERVALS, Math.max(count, 2 * F.cap[r], 2));
      o = this.allocBlock(F, cap);
      F.off[r] = o;
      F.cap[r] = cap;
    }
    const P = F.pool;
    const Wh = F.who;
    for (let q = 0; q < 2 * count; q++) {
      P[o + q] = SCRATCH[q];
      Wh[o + q] = SCRATCH_W[q];
    }
    F.cnt[r] = count;
    return removed;
  }

  // ---- cutting ----------------------------------------------------------

  /** A tool standing upright at one point. */
  carve(env, x, y, z, toolIndex = 0) {
    return this.carveLinear(env, [x, y, z], [x, y, z], [0, 0, 1], toolIndex).volume;
  }

  /** The heightmap's upright sweep: the same move, seen along all three axes. */
  carveSweep(env, from, to, toolIndex = 0, opts = {}) {
    return this.carveLinear(env, from, to, [0, 0, 1], toolIndex, opts);
  }

  /** A leaning tool at one position. */
  carveTilted(env, tip, dir, fluteLength, toolIndex = 0, opts = {}) {
    return this.carveLinear(env, tip, tip, dir, toolIndex, opts);
  }

  /**
   * Remove a cutter moved in a straight line from tipA to tipB, standing up
   * `dir` the whole way.
   *
   * @returns {{volume:number, gouge:null|{depth:number,x:number,y:number,z:number}}}
   */
  carveLinear(env, tipA, tipB, dir, toolIndex = 0, opts = {}) {
    const none = { volume: 0, gouge: null };
    const prof = profileOf(env);
    if (!prof) return none;
    const top = prof.top;
    const R = prof.rMax;
    const D = [tipB[0] - tipA[0], tipB[1] - tipA[1], tipB[2] - tipA[2]];

    // Nowhere near material: the same tile test the heightmap makes, on the
    // box round the swept axis. The top of every Z line is the highest
    // material anywhere on it, so this never skips a cut under an overhang.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of [tipA, tipB]) {
      for (const s of [0, top]) {
        const px = p[0] + dir[0] * s, py = p[1] + dir[1] * s, pz = p[2] + dir[2] * s;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (pz < z0) z0 = pz;
      }
    }
    const lean = Math.hypot(dir[0], dir[1]);
    if (z0 - R * lean >= this.maxHeightIn(x0 - R, y0 - R, x1 + R, y1 + R)) return none;

    const flag = Math.min(255, toolIndex + 1);
    this.gouge = null;
    this.gougeOpts = opts.target ? opts : null;
    // A closed reference part can be asked along every line, not only
    // from above: see gougeAlong.
    const t = opts.target;
    this.partLines = t && t.closed && t.surface ? t : null;
    if (this.partLines && this.partCache.target !== t) this.partCache = this.newPartCache(t);
    this.candidates = [];
    let volume = 0;
    for (const F of this.fam) {
      const len = this.carveFamily(F, prof, tipA, D, dir, flag);
      if (F.a === 2) volume = len * F.db * F.dc;
    }
    const gouge = this.gouge;
    const gouge3 = this.measureCandidates(opts.tolerance || 0);
    this.gouge = null;
    this.gougeOpts = null;
    this.partLines = null;
    if (volume <= 0) return { volume: 0, gouge, gouge3 };
    this.version++;
    this.removedVolume += volume;
    return { volume, gouge, gouge3 };
  }

  /**
   * Did what line r just lost reach into the part?
   *
   * The part is asked along the same line: where it is solid there. A
   * stretch removed from inside it is a gouge at most as deep as the
   * furthest it gets from the ends of the part's stretch — and, since a
   * point that deep along one line need not be deep at all (a line running
   * just inside a wall is inside it end to end), the same is asked along
   * the other two axes through that point, and the least of the three kept.
   * What is still deeper than the tolerance is a candidate; the deepest few
   * are measured to the part's surface at the end of the carve.
   */
  gougeAlong(F, r, i, j, tolerance) {
    const { a, b, c } = F;
    const L = this.partCache.lines[a];
    const pb = this.o3[b] + (i + 0.5) * F.db;
    const pc = this.o3[c] + (j + 0.5) * F.dc;
    if (L.off[r] < 0) {
      const hits = lineInside(this.partLines.surface, a, pb, pc);
      const n = Math.min(hits.length, 2 * MAX_INTERVALS);
      if (L.used + n > L.pool.length) {
        const grown = new Float32Array(Math.max(2 * L.pool.length, L.used + n, 1024));
        grown.set(L.pool.subarray(0, L.used));
        L.pool = grown;
      }
      L.pool.set(hits.subarray(0, n), L.used);
      L.off[r] = L.used;
      L.cnt[r] = n / 2;
      L.used += n;
    }
    const n = L.cnt[r];
    if (!n) return;
    const part = L.pool;
    const base = L.off[r];
    const oa = this.o3[a];
    for (let k = 0; k < REMOVED.length; k += 2) {
      const x0 = oa + REMOVED[k];
      const x1 = oa + REMOVED[k + 1];
      for (let q = base; q < base + 2 * n; q += 2) {
        const ps = part[q];
        const pe = part[q + 1];
        const y0 = Math.max(x0, ps);
        const y1 = Math.min(x1, pe);
        if (!(y1 > y0)) continue;
        const mid = Math.min(y1, Math.max(y0, (ps + pe) / 2));
        let bound = Math.min(mid - ps, pe - mid);
        if (bound <= tolerance) continue;
        const p = [0, 0, 0];
        p[a] = mid; p[b] = pb; p[c] = pc;
        for (const other of [b, c]) {
          bound = Math.min(bound, depthAlong(lineInside(this.partLines.surface, other, ...rest(other, p)), p[other]));
          if (bound <= tolerance) break;
        }
        if (bound <= tolerance) continue;
        this.candidates.push({ bound, p });
        if (this.candidates.length > 4 * GOUGE_CANDIDATES) this.trimCandidates();
      }
    }
  }

  /**
   * Where each line is inside the reference, filled in as lines are cut:
   * per family an offset into a pool (−1 until asked) and a count, the
   * way the stock keeps its own stretches — a Map of little arrays ran to
   * hundreds of megabytes on a fine lattice.
   */
  newPartCache(target) {
    return {
      target,
      lines: this.fam.map((F) => ({
        off: new Int32Array(F.rays).fill(-1), cnt: new Uint8Array(F.rays), pool: new Float32Array(0), used: 0,
      })),
    };
  }

  trimCandidates() {
    this.candidates.sort((u, v) => v.bound - u.bound);
    this.candidates.length = Math.min(this.candidates.length, GOUGE_CANDIDATES);
  }

  /** The deepest of the candidates, measured to the part's surface. */
  measureCandidates(tolerance) {
    if (!this.candidates || !this.candidates.length || !this.partCache.target) return null;
    this.trimCandidates();
    const surface = this.partCache.target.surface;
    let best = null;
    for (const { bound, p } of this.candidates) {
      // Inside the part, so the nearest face is how deep: and no further
      // than the bound, which is what the search is limited to.
      const d = nearestWithin(surface, p[0], p[1], p[2], bound + 1e-6);
      const depth = d < Infinity ? d : bound;
      if (depth > tolerance && (!best || depth > best.depth)) best = { depth, x: p[0], y: p[1], z: p[2] };
    }
    this.candidates = [];
    return best;
  }

  /** One family's share of a cut. Returns the material removed, in mm along its lines. */
  carveFamily(F, prof, A, D, d, flag) {
    const { a, b, c } = F;
    const ca = d[a];
    const Dd = D[0] * d[0] + D[1] * d[1] + D[2] * d[2];
    const Dlen = Math.hypot(D[0], D[1], D[2]);
    let mode;
    if (Math.abs(ca) > 1 - 1e-12) mode = PARALLEL;
    else if (Math.abs(ca) < 1e-12) {
      if (Dlen < 1e-12 || Math.abs(Dd) < 1e-12) mode = PERP_FLAT;
      else if (Math.hypot(D[0] - Dd * d[0], D[1] - Dd * d[1], D[2] - Dd * d[2]) < 1e-12) mode = PERP_PLUNGE;
      else mode = PERP_RAMP;
    } else mode = OBLIQUE;

    if (mode === OBLIQUE && Dlen > 1e-12) {
      // No closed form for a leaning tool moving along lines at an angle to
      // it, so the move is stamped: positions close enough that the cusps
      // between them are a small fraction of the cell.
      const spacing = Math.max(Math.min(this.d3[0], this.d3[1], this.d3[2]) * 0.5, Math.min(prof.rMax * 0.05, 0.25));
      const n = Math.max(1, Math.ceil(Dlen / spacing));
      let total = 0;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        total += this.carveFamilyAt(F, prof, [A[0] + D[0] * t, A[1] + D[1] * t, A[2] + D[2] * t], [0, 0, 0], d, flag, OBLIQUE);
      }
      return total;
    }
    return this.carveFamilyAt(F, prof, A, D, d, flag, mode);
  }

  carveFamilyAt(F, prof, A, D, d, flag, mode) {
    const { a, b, c, nb, nc, db, dc } = F;
    const R = prof.rMax;
    const R2 = R * R;
    const top = prof.top;
    const oa = this.o3[a], ob = this.o3[b], oc = this.o3[c];

    // The swept axis seen down these lines: a parallelogram in the grid's
    // own plane. Every line that can meet the tool is within R of it.
    const pb = [A[b], A[b] + d[b] * top, A[b] + D[b] + d[b] * top, A[b] + D[b]];
    const pc = [A[c], A[c] + d[c] * top, A[c] + D[c] + d[c] * top, A[c] + D[c]];
    const pa = [A[a], A[a] + d[a] * top, A[a] + D[a] + d[a] * top, A[a] + D[a]];
    let cMin = Infinity, cMax = -Infinity, aMin = Infinity, aMax = -Infinity;
    for (let k = 0; k < 4; k++) {
      if (pc[k] < cMin) cMin = pc[k];
      if (pc[k] > cMax) cMax = pc[k];
      if (pa[k] < aMin) aMin = pa[k];
      if (pa[k] > aMax) aMax = pa[k];
    }
    // The tool is inside the cylinder of radius R round its axis, so along
    // any direction it reaches past the axis only by R times how far that
    // direction is from the axis — nothing at all along the axis itself.
    // An upright cutter's side lines start at its tip, not R below it.
    const padA = R * Math.sqrt(Math.max(0, 1 - d[a] * d[a]));
    const padC = R * Math.sqrt(Math.max(0, 1 - d[c] * d[c]));
    // How far along the lines the tool can reach, relative to their start.
    const reachLo = aMin - padA - oa;
    const reachHi = aMax + padA - oa;
    const j0 = Math.max(0, Math.ceil((cMin - padC - oc) / dc - 0.5));
    const j1 = Math.min(nc - 1, Math.floor((cMax + padC - oc) / dc - 0.5));
    if (j0 > j1) return 0;

    // Fixed per cut: the tool's frame against these lines.
    const sgn = d[a] >= 0 ? 1 : -1;
    // A unit vector square to both the lines and the tool axis.
    const e = [0, 0, 0];
    e[a] = 1;
    const v = [d[1] * e[2] - d[2] * e[1], d[2] * e[0] - d[0] * e[2], d[0] * e[1] - d[1] * e[0]];
    const vl = Math.hypot(v[0], v[1], v[2]);
    if (vl > 1e-12) { v[0] /= vl; v[1] /= vl; v[2] /= vl; }
    const Dd = D[0] * d[0] + D[1] * d[1] + D[2] * d[2];
    const Dv = D[0] * v[0] + D[1] * v[1] + D[2] * v[2];

    let total = 0;
    let ti0 = Infinity, tj0 = Infinity, ti1 = -1, tj1 = -1;
    let aLo = Infinity, aHi = -Infinity;
    const o = [0, 0, 0];
    o[a] = oa;

    for (let j = j0; j <= j1; j++) {
      const yc = oc + (j + 0.5) * dc;
      // Where along this row the swept tool can be: the parallelogram's
      // edges, each widened by R.
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) & 3;
        if (capsuleLine(pb[k], pc[k], pb[k2], pc[k2], R, yc, SPAN)) {
          if (SPAN[0] < lo) lo = SPAN[0];
          if (SPAN[1] > hi) hi = SPAN[1];
        }
      }
      if (lo > hi) continue;
      const i0 = Math.max(0, Math.ceil((lo - ob) / db - 0.5));
      const i1 = Math.min(nb - 1, Math.floor((hi - ob) / db - 0.5));
      o[c] = yc;

      for (let i = i0; i <= i1; i++) {
        const r = j * nb + i;
        const n = F.cnt[r];
        if (n === 0) continue;
        const po = F.off[r];
        // Material on this line and the tool's reach along it do not meet —
        // which, after the first pass, is most lines a facing cutter crosses
        // again: the line already ends where the tool reaches. The ends are
        // single precision, so "where it reaches" has to allow for that or
        // every one of them goes on to be solved and subtracted for nothing.
        if (F.pool[po] >= reachHi - MIN_CUT || F.pool[po + 2 * n - 1] <= reachLo + MIN_CUT) continue;
        o[b] = ob + (i + 0.5) * db;

        let tIn;
        let tOut;
        if (mode === PARALLEL && prof.parallelClosed) {
          // Piece by piece, in closed form: a cylinder reaches its whole
          // height wherever the line is inside its radius, and a ball sweeps
          // a capsule.
          const wb = A[b] - o[b], wc = A[c] - yc;
          const c0 = wb * wb + wc * wc;
          const c1 = 2 * (wb * D[b] + wc * D[c]);
          const c2 = D[b] * D[b] + D[c] * D[c];
          const tipA = A[a] - oa;
          const Da = D[a];
          const pc = prof.pieces;
          tIn = Infinity;
          tOut = -Infinity;
          if (pc.length === 5 && pc[2] === 0) {
            // An end mill: one cylinder, the commonest cutter there is.
            let u1 = 0;
            let u2 = 1;
            if (c2 > 1e-15) {
              const disc = c1 * c1 - 4 * c2 * (c0 - R2);
              if (disc <= 0) continue;
              const sq = Math.sqrt(disc);
              u1 = (-c1 - sq) / (2 * c2);
              u2 = (-c1 + sq) / (2 * c2);
              if (u1 < 0) u1 = 0;
              if (u2 > 1) u2 = 1;
              if (u1 > u2) continue;
            } else if (c0 > R2) continue;
            const ta = tipA + Da * u1, tb = tipA + Da * u2;
            const lo = ta < tb ? ta : tb, hi = ta < tb ? tb : ta;
            if (sgn > 0) { tIn = lo + pc[0]; tOut = hi + pc[1]; } else { tIn = lo - pc[1]; tOut = hi - pc[0]; }
          } else for (let k = 0; k < pc.length; k += 5) {
            if (pc[k + 2] === 1) {
              const sc = pc[k + 4];
              BALL0[0] = A[0] + d[0] * sc; BALL0[1] = A[1] + d[1] * sc; BALL0[2] = A[2] + d[2] * sc;
              BALL1[0] = BALL0[0] + D[0]; BALL1[1] = BALL0[1] + D[1]; BALL1[2] = BALL0[2] + D[2];
              if (!rayCapsule(o, a, BALL0, BALL1, Math.sqrt(pc[k + 3]), PIECE)) continue;
            } else {
              const rr2 = pc[k + 3] * pc[k + 3];
              let u1 = 0;
              let u2 = 1;
              if (c2 > 1e-15) {
                const disc = c1 * c1 - 4 * c2 * (c0 - rr2);
                if (disc <= 0) continue;
                const sq = Math.sqrt(disc);
                u1 = Math.max(0, (-c1 - sq) / (2 * c2));
                u2 = Math.min(1, (-c1 + sq) / (2 * c2));
                if (u1 > u2) continue;
              } else if (c0 > rr2) continue;
              const ta = tipA + Da * u1, tb = tipA + Da * u2;
              const lo = ta < tb ? ta : tb, hi = ta < tb ? tb : ta;
              if (sgn > 0) { PIECE[0] = lo + pc[k]; PIECE[1] = hi + pc[k + 1]; }
              else { PIECE[0] = lo - pc[k + 1]; PIECE[1] = hi - pc[k]; }
            }
            if (PIECE[0] < tIn) tIn = PIECE[0];
            if (PIECE[1] > tOut) tOut = PIECE[1];
          }
          if (!(tOut > tIn)) continue;
        } else if (mode === PARALLEL) {
          // Distance from the line to the moving axis, as a quadratic in u.
          const wb = A[b] - o[b], wc = A[c] - yc;
          const c0 = wb * wb + wc * wc;
          const c1 = 2 * (wb * D[b] + wc * D[c]);
          const c2 = D[b] * D[b] + D[c] * D[c];
          let u1 = 0;
          let u2 = 1;
          if (c2 > 1e-15) {
            const disc = c1 * c1 - 4 * c2 * (c0 - R2);
            if (disc <= 0) continue;
            const sq = Math.sqrt(disc);
            u1 = Math.max(0, (-c1 - sq) / (2 * c2));
            u2 = Math.min(1, (-c1 + sq) / (2 * c2));
            if (u1 > u2) continue;
          } else if (c0 > R2) continue;
          const tipA = A[a] - oa;
          const Da = D[a];
          const rho2 = (u) => c0 + u * (c1 + u * c2);
          if (sgn > 0) {
            tIn = prof.lowerConstant
              ? Math.min(tipA + Da * u1, tipA + Da * u2) + prof.lower[0]
              : goldenMin((u) => tipA + Da * u + prof.lowAt(rho2(u)), u1, u2, 22);
            tOut = prof.upperConstant
              ? Math.max(tipA + Da * u1, tipA + Da * u2) + top
              : -goldenMin((u) => -(tipA + Da * u + prof.highAt(rho2(u))), u1, u2, 22);
          } else {
            tIn = prof.upperConstant
              ? Math.min(tipA + Da * u1, tipA + Da * u2) - top
              : goldenMin((u) => tipA + Da * u - prof.highAt(rho2(u)), u1, u2, 22);
            tOut = prof.lowerConstant
              ? Math.max(tipA + Da * u1, tipA + Da * u2) - prof.lower[0]
              : -goldenMin((u) => -(tipA + Da * u - prof.lowAt(rho2(u))), u1, u2, 22);
          }
        } else if (mode === OBLIQUE) {
          const ex = e[0], ey = e[1], ez = e[2];
          if (!prof.hit(o[0], o[1], o[2], ex, ey, ez, A[0], A[1], A[2], d[0], d[1], d[2], HIT)) continue;
          tIn = HIT[0];
          tOut = HIT[1];
        } else {
          // Square to the tool: the line lies in one slice of it. In that
          // slice the axis is a point (W, V) — W along the line, V across
          // it — and the tool a disc of the radius at that height.
          const qx = A[0] - o[0], qy = A[1] - o[1], qz = A[2] - o[2];
          const W0 = A[a] - oa;
          const V0 = qx * v[0] + qy * v[1] + qz * v[2];
          const s0 = -(qx * d[0] + qy * d[1] + qz * d[2]);
          if (mode === PERP_FLAT) {
            const rr = prof.radiusAt(s0);
            if (!(rr > 0)) continue;
            if (!capsuleLine(W0, V0, W0 + D[a], V0 + Dv, rr, 0, SPAN)) continue;
            tIn = SPAN[0];
            tOut = SPAN[1];
          } else if (mode === PERP_PLUNGE) {
            const rr = prof.maxRadiusIn(s0 - Dd, s0);
            if (rr * rr <= V0 * V0) continue;
            const w = Math.sqrt(rr * rr - V0 * V0);
            tIn = W0 - w;
            tOut = W0 + w;
          } else if (prof.closedForm) {
            // A ramp, piece by piece: a ball sweeps a capsule; a straight
            // piece, in the stretch of the move while the line is level
            // with it, is a disc whose centre and radius both move
            // linearly — the hull of its first and last disc.
            const Wd = D[a];
            const pc = prof.pieces;
            tIn = Infinity;
            tOut = -Infinity;
            for (let k = 0; k < pc.length; k += 5) {
              if (pc[k + 2] === 1) {
                const sc = pc[k + 4];
                BALL0[0] = A[0] + d[0] * sc; BALL0[1] = A[1] + d[1] * sc; BALL0[2] = A[2] + d[2] * sc;
                BALL1[0] = BALL0[0] + D[0]; BALL1[1] = BALL0[1] + D[1]; BALL1[2] = BALL0[2] + D[2];
                if (!rayCapsule(o, a, BALL0, BALL1, Math.sqrt(pc[k + 3]), PIECE)) continue;
              } else {
                let ua = (s0 - pc[k + 1]) / Dd;
                let ub = (s0 - pc[k]) / Dd;
                if (ua > ub) { const t = ua; ua = ub; ub = t; }
                if (ua < 0) ua = 0;
                if (ub > 1) ub = 1;
                if (ua > ub) continue;
                const ra = Math.max(0, pc[k + 3] + pc[k + 4] * (s0 - ua * Dd));
                const rb = Math.max(0, pc[k + 3] + pc[k + 4] * (s0 - ub * Dd));
                if (!hullLine(W0 + ua * Wd, V0 + ua * Dv, ra, W0 + ub * Wd, V0 + ub * Dv, rb, 0, PIECE)) continue;
              }
              if (PIECE[0] < tIn) tIn = PIECE[0];
              if (PIECE[1] > tOut) tOut = PIECE[1];
            }
          } else {
            // A ramp: the slice moves across and the radius changes with it.
            // Only while the line is level with the cutting part is there a
            // slice at all — and only there is the radius concave, so every
            // search is kept inside that stretch of the move.
            let uS0 = (s0 - top) / Dd;
            let uS1 = s0 / Dd;
            if (uS0 > uS1) { const t = uS0; uS0 = uS1; uS1 = t; }
            if (uS0 < 0) uS0 = 0;
            if (uS1 > 1) uS1 = 1;
            if (uS0 > uS1) continue;
            const Wd = D[a];
            const rad = (u) => prof.radiusAt(Math.min(Math.max(s0 - u * Dd, 0), top));
            const room = (u) => rad(u) - Math.abs(V0 + u * Dv);
            // Where the slice reaches the line at all: room is concave.
            let ua = uS0;
            let ub = uS1;
            let best = -Infinity;
            let at = 0;
            {
              const G = 0.6180339887498949;
              let x1 = ub - G * (ub - ua), x2 = ua + G * (ub - ua);
              let f1 = room(x1), f2 = room(x2);
              for (let it = 0; it < 40; it++) {
                if (f1 > f2) { ub = x2; x2 = x1; f2 = f1; x1 = ub - G * (ub - ua); f1 = room(x1); }
                else { ua = x1; x1 = x2; f1 = f2; x2 = ua + G * (ub - ua); f2 = room(x2); }
              }
              for (const [u, f] of [[uS0, room(uS0)], [uS1, room(uS1)], [x1, f1], [x2, f2]]) if (f > best) { best = f; at = u; }
            }
            if (best < 0) continue;
            const edge = (inside, outside) => {
              for (let it = 0; it < 40; it++) {
                const m = (inside + outside) / 2;
                if (room(m) >= 0) inside = m; else outside = m;
              }
              return inside;
            };
            const uL = room(uS0) >= 0 ? uS0 : edge(at, uS0);
            const uR = room(uS1) >= 0 ? uS1 : edge(at, uS1);
            const half = (u) => {
              const rr = rad(u);
              const vv = V0 + u * Dv;
              const q = rr * rr - vv * vv;
              return q > 0 ? Math.sqrt(q) : 0;
            };
            tIn = goldenMin((u) => W0 + u * Wd - half(u), uL, uR, 30);
            tOut = -goldenMin((u) => -(W0 + u * Wd + half(u)), uL, uR, 30);
          }
        }

        if (!(tOut > tIn)) continue;
        const removed = this.subtract(F, r, tIn, tOut, flag);
        if (removed <= 0) continue;
        total += removed;
        if (i < ti0) ti0 = i;
        if (i > ti1) ti1 = i;
        if (j < tj0) tj0 = j;
        if (j > tj1) tj1 = j;
        if (tIn < aLo) aLo = tIn;
        if (tOut > aHi) aHi = tOut;
        if (a === 2) this.topChanged(F, r, i, j);
        if (this.partLines) this.gougeAlong(F, r, i, j, this.gougeOpts.tolerance || 0);
      }
    }

    if (ti1 >= 0) {
      F.version++;
      if (a === 2) this.markDirtyRect(ti0, tj0, ti1, tj1);
      const lo = [0, 0, 0];
      const hi = [0, 0, 0];
      lo[a] = oa + Math.max(0, aLo); hi[a] = oa + Math.min(F.len, aHi);
      lo[b] = ob + ti0 * db; hi[b] = ob + (ti1 + 1) * db;
      lo[c] = oc + tj0 * dc; hi[c] = oc + (tj1 + 1) * dc;
      this.markDirty3(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    }
    return total;
  }

  // ---- turning -----------------------------------------------------------

  /**
   * Remove an outline turned round an axis: what a turning tool takes from
   * a part spinning under it.
   *
   * The tool is fixed and the part turns, so everything the tool's outline
   * passes through, at any angle round the axis, is gone. `poly` is that
   * outline — the insert swept along its move — as [r, z] pairs: r how far
   * from the axis, z how far along it from `axis.point`. It has to be
   * convex, which an insert and its sweep along a straight line are.
   *
   * Every line is solved exactly. Along a line, z moves in proportion and
   * r² is a quadratic, so where it crosses each edge of the outline is a
   * quadratic's roots, and between two crossings it is inside throughout or
   * not at all. An outline reaching across the axis — facing past centre —
   * is the part on each side turned round on its own.
   *
   * @param {number[][]} poly convex, [r, z] pairs, either way round
   * @param {{point:number[], dir:number[]}} axis
   * @param {number} [toolIndex]
   * @param {{target?:object, tolerance?:number}} [opts] as carveLinear
   * @returns {{volume:number, gouge:null, gouge3:null|object}}
   */
  carveRevolved(poly, axis, toolIndex = 0, opts = {}) {
    if (!poly || poly.length < 3) return { volume: 0, gouge: null, gouge3: null };
    // Across the axis: each side on its own, the far one folded over.
    const near = clipHalf(poly, 1);
    const far = clipHalf(poly, -1).map(([r, z]) => [-r, z]);
    const flag = Math.min(255, toolIndex + 1);
    const t = opts.target;
    this.gougeOpts = t ? opts : null;
    this.partLines = t && t.closed && t.surface ? t : null;
    if (this.partLines && this.partCache.target !== t) this.partCache = this.newPartCache(t);
    this.candidates = [];
    let volume = 0;
    for (const part of [near, far]) {
      if (part.length < 3) continue;
      for (const F of this.fam) {
        const len = this.revolveFamily(F, part, axis, flag);
        if (F.a === 2) volume += len * F.db * F.dc;
      }
    }
    const gouge3 = this.measureCandidates(opts.tolerance || 0);
    this.gougeOpts = null;
    this.partLines = null;
    if (volume <= 0) return { volume: 0, gouge: null, gouge3 };
    this.version++;
    this.removedVolume += volume;
    return { volume, gouge: null, gouge3 };
  }

  /** One family's share of a turned cut, in mm along its lines. */
  revolveFamily(F, poly, axis, flag) {
    const { a, b, c, nb, nc, db, dc } = F;
    const oa = this.o3[a], ob = this.o3[b], oc = this.o3[c];
    const d = axis.dir;
    const P = axis.point;
    let rMin = Infinity, rMax = 0, zMin = Infinity, zMax = -Infinity;
    for (const [r, z] of poly) {
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    // The edges as n·(r, z) ≤ k, normals pointing out, whichever way round
    // the outline was given.
    const m = poly.length;
    let area = 0;
    for (let k = 0; k < m; k++) {
      const [r0, z0] = poly[k];
      const [r1, z1] = poly[(k + 1) % m];
      area += r0 * z1 - r1 * z0;
    }
    const turn = area >= 0 ? 1 : -1;
    const edges = [];
    for (let k = 0; k < m; k++) {
      const [r0, z0] = poly[k];
      const [r1, z1] = poly[(k + 1) % m];
      const nr = turn * (z1 - z0);
      const nz = -turn * (r1 - r0);
      const l = Math.hypot(nr, nz);
      if (l < 1e-12) continue;
      edges.push({
        nr: nr / l, nz: nz / l, k: (nr * r0 + nz * z0) / l, r0, z0, r1, z1,
        dr: r1 - r0, dz: z1 - z0, len2: (r1 - r0) ** 2 + (z1 - z0) ** 2,
      });
    }
    const inside = (r, z) => {
      for (const e of edges) if (e.nr * r + e.nz * z > e.k + 1e-9) return false;
      return true;
    };

    // The box round the turned outline: a drum along the axis.
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    for (let q = 0; q < 3; q++) {
      const e0 = P[q] + d[q] * zMin;
      const e1 = P[q] + d[q] * zMax;
      const pad = rMax * Math.sqrt(Math.max(0, 1 - d[q] * d[q]));
      lo[q] = Math.min(e0, e1) - pad;
      hi[q] = Math.max(e0, e1) + pad;
    }
    const i0 = Math.max(0, Math.ceil((lo[b] - ob) / db - 0.5));
    const i1 = Math.min(nb - 1, Math.floor((hi[b] - ob) / db - 0.5));
    const j0 = Math.max(0, Math.ceil((lo[c] - oc) / dc - 0.5));
    const j1 = Math.min(nc - 1, Math.floor((hi[c] - oc) / dc - 0.5));
    if (i0 > i1 || j0 > j1) return 0;

    // Along a line, p(t) = base + t·e: z(t) = z0 + t·da, and the part of
    // p − P square to the axis is q0 + t·q1.
    const da = d[a];
    const q1 = [-da * d[0], -da * d[1], -da * d[2]];
    q1[a] += 1;
    const A2 = q1[0] * q1[0] + q1[1] * q1[1] + q1[2] * q1[2];
    const parallel = A2 < 1e-18;
    const square = Math.abs(da) < 1e-12;
    const ts = [];
    const ins = [];
    let total = 0;
    let ti0 = Infinity, tj0 = Infinity, ti1 = -1, tj1 = -1;
    let aLo = Infinity, aHi = -Infinity;
    const w0 = [0, 0, 0];

    for (let j = j0; j <= j1; j++) {
      const pc = oc + (j + 0.5) * dc;
      for (let i = i0; i <= i1; i++) {
        const r = j * nb + i;
        if (F.cnt[r] === 0) continue;
        const pb = ob + (i + 0.5) * db;
        w0[a] = oa - P[a]; w0[b] = pb - P[b]; w0[c] = pc - P[c];
        const z0 = w0[0] * d[0] + w0[1] * d[1] + w0[2] * d[2];
        const q0x = w0[0] - z0 * d[0], q0y = w0[1] - z0 * d[1], q0z = w0[2] - z0 * d[2];
        const C2 = q0x * q0x + q0y * q0y + q0z * q0z;
        const B2 = 2 * (q0x * q1[0] + q0y * q1[1] + q0z * q1[2]);
        // Too far from the axis anywhere on the line, or a line square to
        // the axis at a height the outline does not reach.
        const nearest = parallel ? C2 : C2 - (B2 * B2) / (4 * A2);
        if (nearest > rMax * rMax + 1e-9) continue;
        if (square && (z0 < zMin - 1e-9 || z0 > zMax + 1e-9)) continue;
        if (parallel && (Math.sqrt(C2) < rMin - 1e-9)) continue;
        // Where along the line the outline's band of heights is, against
        // where the line has metal at all: a line already cut back, or
        // below the band, has nothing to give.
        {
          const o = F.off[r];
          const first = F.pool[o];
          const last = F.pool[o + 2 * F.cnt[r] - 1];
          let tLo = -Infinity, tHi = Infinity;
          if (!square) {
            const ta = (zMin - z0) / da;
            const tb = (zMax - z0) / da;
            tLo = Math.min(ta, tb);
            tHi = Math.max(ta, tb);
          }
          if (!parallel) {
            // And where it is within rMax of the axis.
            const disc = B2 * B2 - 4 * A2 * (C2 - rMax * rMax);
            if (disc < 0) continue;
            const sq = Math.sqrt(disc);
            tLo = Math.max(tLo, (-B2 - sq) / (2 * A2));
            tHi = Math.min(tHi, (-B2 + sq) / (2 * A2));
          }
          if (tHi < first - 1e-6 || tLo > last + 1e-6) continue;
        }

        // Where it crosses each edge's line, kept if on the edge itself.
        ts.length = 0;
        for (const e of edges) {
          // nr·r(t) = k − nz·z(t) = g0 + g1·t, squared.
          const g0 = e.k - e.nz * z0;
          const g1 = -e.nz * da;
          const qa = e.nr * e.nr * A2 - g1 * g1;
          const qb = e.nr * e.nr * B2 - 2 * g0 * g1;
          const qc = e.nr * e.nr * C2 - g0 * g0;
          // Its roots, without an array for them: this runs for every edge
          // of every line in reach.
          let n2 = 0, t1 = 0, t2 = 0;
          if (Math.abs(qa) < 1e-14) {
            if (Math.abs(qb) > 1e-14) { t1 = -qc / qb; n2 = 1; }
          } else {
            const disc = qb * qb - 4 * qa * qc;
            if (disc >= 0) {
              const sq = Math.sqrt(disc);
              t1 = (-qb - sq) / (2 * qa);
              t2 = (-qb + sq) / (2 * qa);
              n2 = 2;
            }
          }
          for (let q = 0; q < n2; q++) {
            const tt = q === 0 ? t1 : t2;
            if (!Number.isFinite(tt)) continue;
            const rr = Math.sqrt(Math.max(0, A2 * tt * tt + B2 * tt + C2));
            const zz = z0 + da * tt;
            // On this edge, not on the far side of its line.
            const s = e.len2 > 0 ? ((rr - e.r0) * e.dr + (zz - e.z0) * e.dz) / e.len2 : 0;
            if (s < -1e-6 || s > 1 + 1e-6) continue;
            if (Math.abs(e.nr * rr + e.nz * zz - e.k) > 1e-6 * (1 + Math.abs(e.k))) continue;
            ts.push(tt);
          }
        }
        // The line's own span bounds it, and a line that crosses nothing
        // is inside throughout or not at all.
        ts.push(0, F.len);
        ts.sort((u, v) => u - v);
        ins.length = 0;
        for (let k = 0; k + 1 < ts.length; k++) {
          const s0 = Math.max(0, ts[k]);
          const s1 = Math.min(F.len, ts[k + 1]);
          if (!(s1 > s0 + 1e-9)) continue;
          const mid = (s0 + s1) / 2;
          const rr = Math.sqrt(Math.max(0, A2 * mid * mid + B2 * mid + C2));
          if (!inside(rr, z0 + da * mid)) continue;
          if (ins.length && Math.abs(ins[ins.length - 1] - s0) < 1e-9) ins[ins.length - 1] = s1;
          else ins.push(s0, s1);
        }
        for (let k = 0; k < ins.length; k += 2) {
          const removed = this.subtract(F, r, ins[k], ins[k + 1], flag);
          if (removed <= 0) continue;
          total += removed;
          if (i < ti0) ti0 = i;
          if (i > ti1) ti1 = i;
          if (j < tj0) tj0 = j;
          if (j > tj1) tj1 = j;
          if (ins[k] < aLo) aLo = ins[k];
          if (ins[k + 1] > aHi) aHi = ins[k + 1];
          if (a === 2) this.topChanged(F, r, i, j);
          if (this.partLines) this.gougeAlong(F, r, i, j, this.gougeOpts.tolerance || 0);
        }
      }
    }

    if (ti1 >= 0) {
      F.version++;
      if (a === 2) this.markDirtyRect(ti0, tj0, ti1, tj1);
      const lo3 = [0, 0, 0];
      const hi3 = [0, 0, 0];
      lo3[a] = oa + Math.max(0, aLo); hi3[a] = oa + Math.min(F.len, aHi);
      lo3[b] = ob + ti0 * db; hi3[b] = ob + (ti1 + 1) * db;
      lo3[c] = oc + tj0 * dc; hi3[c] = oc + (tj1 + 1) * dc;
      this.markDirty3(lo3[0], lo3[1], lo3[2], hi3[0], hi3[1], hi3[2]);
    }
    return total;
  }

  /** A Z line lost material: the top-down view follows, and the reference part is asked. */
  topChanged(F, r, i, j) {
    const n = F.cnt[r];
    const o = F.off[r];
    const h = n ? this.base + F.pool[o + 2 * n - 1] : this.base;
    this.height[r] = h;
    this.cutBy[r] = n ? F.who[o + 2 * n - 1] : 0;
    this.tileDirty[((j / TILE) | 0) * this.tilesX + ((i / TILE) | 0)] = 1;
    const opts = this.gougeOpts;
    if (opts && opts.target && opts.target.edge[r] === 0) {
      const want = opts.target.map[r];
      if (want > -Infinity) {
        const depth = want - h;
        if (depth > (opts.tolerance || 0) && (!this.gouge || depth > this.gouge.depth)) {
          this.gouge = { depth, x: this.cx(i), y: this.cy(j), z: h };
        }
      }
    }
  }

  // ---- collisions --------------------------------------------------------

  /**
   * The highest material on a Z line between two heights, or −Infinity.
   * What a probe asks: is there metal where the body is, and how high.
   */
  materialBetween(r, zLo, zHi) {
    const F = this.fam[2];
    const n = F.cnt[r];
    const o = F.off[r];
    const lo = zLo - this.base;
    const hi = zHi - this.base;
    let best = -Infinity;
    for (let k = 0; k < n; k++) {
      const s = F.pool[o + 2 * k];
      const e = F.pool[o + 2 * k + 1];
      if (e <= lo || s >= hi) continue;
      const m = e < hi ? e : hi;
      if (m > best) best = m;
    }
    return best === -Infinity ? best : best + this.base;
  }

  /**
   * The non-cutting body of an upright assembly against the material.
   * As the heightmap's, except that a Z line is metal only where its
   * stretches are: a holder over a side hole is over air.
   */
  probeBody(env, x, y, z) {
    if (env.isEmpty) return null;
    const rMax = env.rMax;
    if (z + env.zMin >= this.maxHeightIn(x - rMax, y - rMax, x + rMax, y + rMax)) return null;
    const zTop = z + bodyTop(env);
    const i0 = Math.max(0, Math.floor((x - rMax - this.origin[0]) / this.dx - 0.5));
    const i1 = Math.min(this.nx - 1, Math.ceil((x + rMax - this.origin[0]) / this.dx - 0.5));
    const j0 = Math.max(0, Math.floor((y - rMax - this.origin[1]) / this.dy - 0.5));
    const j1 = Math.min(this.ny - 1, Math.ceil((y + rMax - this.origin[1]) / this.dy - 0.5));
    if (i0 > i1 || j0 > j1) return null;
    const stride = Math.max(1, Math.round(0.25 / this.cell));
    const rMax2 = env.rMax2;
    let worst = null;
    for (let j = j0; j <= j1; j += stride) {
      const wy = this.cy(j);
      const py = wy - y;
      if (py * py > rMax2) continue;
      for (let i = i0; i <= i1; i += stride) {
        const wx = this.cx(i);
        const px = wx - x;
        const r2 = px * px + py * py;
        if (r2 >= rMax2) continue;
        const k = j * this.nx + i;
        const zb = z + env.at(r2);
        if (this.height[k] <= zb) continue;
        const m = this.materialBetween(k, zb, zTop);
        const depth = m - zb;
        if (depth > 0 && (!worst || depth > worst.depth)) worst = { x: wx, y: wy, z: zb, depth };
      }
    }
    return worst;
  }

  /** A sphere chain on a leaning tool, against the material on the Z lines. */
  probeChain(spheres, tip, dir) {
    if (!spheres || !spheres.length) return null;
    const stride = Math.max(1, Math.round(0.25 / this.cell));
    const ax = dir[0], ay = dir[1], az = dir[2];
    let worst = null;
    let prevLz = spheres[0];
    for (let s = 0; s < spheres.length; s += 2) {
      const r = spheres[s + 1];
      const lz = spheres[s];
      const bandLo = s === 0 ? lz : (prevLz + lz) * 0.5;
      prevLz = lz;
      if (r <= 0) continue;
      const cx = tip[0] + ax * lz;
      const cy = tip[1] + ay * lz;
      const cz = tip[2] + az * lz;
      if (cz - r >= this.maxHeightIn(cx - r, cy - r, cx + r, cy + r)) continue;
      const i0 = Math.max(0, Math.floor((cx - r - this.origin[0]) / this.dx - 0.5));
      const i1 = Math.min(this.nx - 1, Math.ceil((cx + r - this.origin[0]) / this.dx - 0.5));
      const j0 = Math.max(0, Math.floor((cy - r - this.origin[1]) / this.dy - 0.5));
      const j1 = Math.min(this.ny - 1, Math.ceil((cy + r - this.origin[1]) / this.dy - 0.5));
      if (i0 > i1 || j0 > j1) continue;
      const r2 = r * r;
      for (let j = j0; j <= j1; j += stride) {
        const wy = this.cy(j);
        const py = wy - cy;
        const py2 = py * py;
        if (py2 >= r2) continue;
        const qy = (wy - tip[1]) * ay;
        for (let i = i0; i <= i1; i += stride) {
          const wx = this.cx(i);
          const px = wx - cx;
          const d2 = px * px + py2;
          if (d2 >= r2) continue;
          const k = j * this.nx + i;
          const half = Math.sqrt(r2 - d2);
          let zb = cz - half;
          let zt = cz + half;
          // Only the slice of this sphere from its band upwards along the
          // tool: below that is the slice before it, and a sphere standing
          // at a flat face — the spindle nose — would otherwise bulge a
          // whole radius past it. Which side of the band a point on this
          // vertical line is on depends on which way the tool leans: from
          // below when it points up, from above when it points down, and
          // not along the line at all when it lies flat.
          const along = (wx - tip[0]) * ax + qy;
          if (az > 1e-9) {
            const face = tip[2] + (bandLo - along) / az;
            if (face > zb) zb = face;
          } else if (az < -1e-9) {
            const face = tip[2] + (bandLo - along) / az;
            if (face < zt) zt = face;
          } else if (along < bandLo) {
            continue;
          }
          if (!(zt > zb) || this.height[k] <= zb) continue;
          const m = this.materialBetween(k, zb, zt);
          const depth = m - zb;
          if (depth > 0 && (!worst || depth > worst.depth)) worst = { x: wx, y: wy, z: zb, depth };
        }
      }
    }
    return worst;
  }

  // ---- what is left -------------------------------------------------------

  /** Material along one family, mm³: each should agree with the others. */
  familyVolume(F) {
    let sum = 0;
    for (let r = 0; r < F.rays; r++) {
      const o = F.off[r];
      for (let k = 0; k < F.cnt[r]; k++) sum += F.pool[o + 2 * k + 1] - F.pool[o + 2 * k];
    }
    return sum * F.db * F.dc;
  }

  remainingVolume() {
    return this.fam ? this.familyVolume(this.fam[2]) : super.remainingVolume();
  }

  /** The stretches on the line through a point along an axis, in world mm. */
  stretchesAt(axis, p) {
    const F = this.fam[axis];
    const i = Math.floor((p[F.b] - this.o3[F.b]) / F.db);
    const j = Math.floor((p[F.c] - this.o3[F.c]) / F.dc);
    if (i < 0 || j < 0 || i >= F.nb || j >= F.nc) return [];
    const r = j * F.nb + i;
    const out = [];
    const o = F.off[r];
    for (let k = 0; k < F.cnt[r]; k++) {
      out.push([this.o3[axis] + F.pool[o + 2 * k], this.o3[axis] + F.pool[o + 2 * k + 1]]);
    }
    return out;
  }

  /** Is a point inside the material? Asked of the Z line through it. */
  inside(x, y, z) {
    for (const [lo, hi] of this.stretchesAt(2, [x, y, z])) if (z >= lo && z <= hi) return true;
    return false;
  }

  /** Is the point inside on the line of family a nearest it? */
  onLine(a, p) {
    const F = this.fam[a];
    const i = Math.floor((p[F.b] - this.o3[F.b]) / F.db);
    const j = Math.floor((p[F.c] - this.o3[F.c]) / F.dc);
    if (i < 0 || j < 0 || i >= F.nb || j >= F.nc) return false;
    const r = j * F.nb + i;
    const v = p[a] - this.o3[a];
    const o = F.off[r];
    for (let k = 0; k < F.cnt[r]; k++) {
      if (v >= F.pool[o + 2 * k] && v <= F.pool[o + 2 * k + 1]) return true;
    }
    return false;
  }

  /**
   * Cast a ray at the material, overhangs and side holes included.
   *
   * The heightmap's walk asks a column how high it is; here a point is
   * metal when two of the three lines nearest it say so, which no single
   * family's rounding can overturn. The hit is then put exactly where the
   * line running most nearly along the ray goes into the metal — so a ray
   * down a side hole stops at the true bottom of it, and one at a wall on
   * the wall, not on the nearest column.
   *
   * @param {[number,number,number]} origin ray origin, world mm
   * @param {[number,number,number]} dir    normalised direction
   * @returns {null | {point:[number,number,number], distance:number, face:string}}
   */
  raycast(origin, dir) {
    const o3 = this.o3;
    const min = [o3[0], o3[1], o3[2]];
    const max = [o3[0] + this.size[0], o3[1] + this.size[1], o3[2] + this.size[2]];
    let t0 = 0;
    let t1 = Infinity;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-12) {
        if (origin[a] < min[a] || origin[a] > max[a]) return null;
        continue;
      }
      let near = (min[a] - origin[a]) / dir[a];
      let far = (max[a] - origin[a]) / dir[a];
      if (near > far) { const t = near; near = far; far = t; }
      if (near > t0) t0 = near;
      if (far < t1) t1 = far;
      if (t0 > t1) return null;
    }
    if (t1 < 0) return null;
    const P = [0, 0, 0];
    const at = (t) => {
      P[0] = origin[0] + dir[0] * t;
      P[1] = origin[1] + dir[1] * t;
      P[2] = origin[2] + dir[2] * t;
      return P;
    };
    const solid = (t) => {
      const p = at(t);
      return (this.onLine(0, p) ? 1 : 0) + (this.onLine(1, p) ? 1 : 0) + (this.onLine(2, p) ? 1 : 0) >= 2;
    };
    // Half a cell at a time, then halve the step that crossed.
    const step = Math.max(0.5 * Math.min(this.d3[0], this.d3[1], this.d3[2]), 1e-3);
    let prev = t0;
    let hit = -1;
    if (solid(t0)) hit = t0;
    else {
      for (let t = t0 + step; t <= t1 + step; t += step) {
        const tc = Math.min(t, t1);
        if (solid(tc)) {
          let lo = prev;
          let hi = tc;
          for (let k = 0; k < 24; k++) {
            const mid = (lo + hi) * 0.5;
            if (solid(mid)) hi = mid; else lo = mid;
          }
          hit = hi;
          break;
        }
        if (tc >= t1) break;
        prev = tc;
      }
    }
    if (hit < 0) return null;

    // On the line most nearly along the ray, the end the ray came in by.
    let a = 0;
    for (let q = 1; q < 3; q++) if (Math.abs(dir[q]) > Math.abs(dir[a])) a = q;
    const p = at(hit);
    const F = this.fam[a];
    const i = Math.floor((p[F.b] - o3[F.b]) / F.db);
    const j = Math.floor((p[F.c] - o3[F.c]) / F.dc);
    let face = 'surface';
    if (i >= 0 && j >= 0 && i < F.nb && j < F.nc) {
      const r = j * F.nb + i;
      const v = p[a] - o3[a];
      const o = F.off[r];
      // Going up the line the ray meets an entry; going down it, an exit.
      const kind = dir[a] > 0 ? 0 : 1;
      let best = null;
      let bd = 2 * Math.max(F.db, F.dc, this.d3[a]);
      for (let k = kind; k < 2 * F.cnt[r]; k += 2) {
        const d = Math.abs(F.pool[o + k] - v);
        if (d <= bd) { bd = d; best = F.pool[o + k]; }
      }
      if (best !== null) {
        const t = hit + (best - v) / dir[a];
        if (t >= t0 - 1e-9) {
          hit = Math.max(t0, t);
          // A ray that ends on a face of the block it came in through.
          if (Math.abs(best) < 1e-6 || Math.abs(best - F.len) < 1e-6) face = ['x', 'y', 'z'][a];
        }
      }
    }
    const pt = at(hit);
    return { point: [pt[0], pt[1], pt[2]], distance: hit, face };
  }

  /** Bytes held, for the readout. */
  memoryBytes() {
    let sum = this.height.byteLength + this.cutBy.byteLength;
    for (const F of this.fam) {
      sum += F.off.byteLength + F.cnt.byteLength + F.cap.byteLength + F.pool.byteLength + F.who.byteLength;
    }
    return sum;
  }

  describe() {
    return { ...super.describe(), kind: 'tridexel', rays: this.rayCount, grid3: this.n3.slice(), cell3: this.d3.slice() };
  }
}

/** How high the body goes above the tip, from its silhouette. */
function bodyTop(env) {
  if (env._top === undefined) {
    let t = 0;
    for (const p of env.points || []) if (p.z > t) t = p.z;
    env._top = t || 1e6;
  }
  return env._top;
}
