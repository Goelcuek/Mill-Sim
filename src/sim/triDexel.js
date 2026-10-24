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
import { profileOf } from '../tools/profile.js';

/** Removals smaller than this, in mm along a line, are rounding, not cuts. */
const MIN_CUT = 1e-6;
/** What is left of a stretch shorter than this is dropped. */
const SLIVER = 1e-5;
/** Stretches one line can hold. A comb with more teeth than this is merged. */
const MAX_INTERVALS = 255;

const SCRATCH = new Float32Array(2 * (MAX_INTERVALS + 2));
const SCRATCH_W = new Uint8Array(2 * (MAX_INTERVALS + 2));
const HIT = [0, 0];
const SPAN = [0, 0];

const PARALLEL = 0;
const PERP_FLAT = 1;
const PERP_PLUNGE = 2;
const PERP_RAMP = 3;
const OBLIQUE = 4;

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
      /** Lines changed since the display last looked: [i0, j0, i1, j1] or null. */
      dirty: null,
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
    F.dirty = [0, 0, F.nb - 1, F.nc - 1];
    F.version++;
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
    let m = 0;
    let removed = 0;
    for (let k = 0; k < n; k++) {
      const s = pool[o + 2 * k];
      const e = pool[o + 2 * k + 1];
      if (e <= a || s >= b) {
        SCRATCH[m] = s; SCRATCH_W[m++] = who[o + 2 * k];
        SCRATCH[m] = e; SCRATCH_W[m++] = who[o + 2 * k + 1];
        continue;
      }
      removed += (e < b ? e : b) - (s > a ? s : a);
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
    F.pool.set(SCRATCH.subarray(0, 2 * count), o);
    F.who.set(SCRATCH_W.subarray(0, 2 * count), o);
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
    let volume = 0;
    for (const F of this.fam) {
      const len = this.carveFamily(F, prof, tipA, D, dir, flag);
      if (F.a === 2) volume = len * F.db * F.dc;
    }
    const gouge = this.gouge;
    this.gouge = null;
    this.gougeOpts = null;
    if (volume <= 0) return { volume: 0, gouge };
    this.version++;
    this.removedVolume += volume;
    return { volume, gouge };
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
    // How far along the lines the tool can reach, relative to their start.
    const reachLo = aMin - R - oa;
    const reachHi = aMax + R - oa;
    const j0 = Math.max(0, Math.ceil((cMin - R - oc) / dc - 0.5));
    const j1 = Math.min(nc - 1, Math.floor((cMax + R - oc) / dc - 0.5));
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
        // Material on this line and the tool's reach along it do not meet.
        if (F.pool[po] > reachHi || F.pool[po + 2 * n - 1] < reachLo) continue;
        o[b] = ob + (i + 0.5) * db;

        let tIn;
        let tOut;
        if (mode === PARALLEL) {
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
        if (a === 2) this.topChanged(F, r, i, j);
      }
    }

    if (ti1 >= 0) {
      const dr = F.dirty;
      if (!dr) F.dirty = [ti0, tj0, ti1, tj1];
      else {
        if (ti0 < dr[0]) dr[0] = ti0;
        if (tj0 < dr[1]) dr[1] = tj0;
        if (ti1 > dr[2]) dr[2] = ti1;
        if (tj1 > dr[3]) dr[3] = tj1;
      }
      F.version++;
      if (a === 2) this.markDirtyRect(ti0, tj0, ti1, tj1);
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
      const cut = Math.abs(az) > 1e-6;
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
          if (cut) {
            const face = tip[2] + (bandLo - ((wx - tip[0]) * ax + qy)) / az;
            if (face > zb) zb = face;
          }
          if (this.height[k] <= zb) continue;
          const m = this.materialBetween(k, zb, cz + half);
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
