// A surface for the tri-dexel stock.
//
// The three families of lines cross at the points of one lattice — every X
// line meets every Y and Z line that shares its height or its column — and
// each edge of that lattice lies on a line. So whether a lattice point is
// in the metal is read off the line through it, and where an edge leaves
// the metal is not estimated at all: it is the end of a stretch on that
// edge's own line, exactly where the cutter put it.
//
// The mesh is dual to the lattice (dual contouring): a vertex in every
// cell the surface passes through, and a quad across every edge where it
// does. The vertex is the point that best fits the planes through the
// cell's crossings — each plane facing the way the surface does there,
// taken from the neighbouring lines — so a floor meeting a wall meets it
// in a sharp corner rather than a bevel the size of a cell, and a curved
// face, whose planes all but agree, falls back to the middle of its
// crossings.
//
// Outside the stock is air on all sides, so the mesh is always closed: it
// is the same surface the export writes and the section cuts open.
//
// It is built a block at a time, so a cut only remakes the blocks it went
// through. A block makes the vertices of a ring of cells round it too, the
// same way its neighbour does, so neighbouring blocks meet without seams.

/** Cells along each side of a block. */
const BLOCK = 32;
/** Crossings found past the end of their edge by less than this still count. */
const EPS = 1e-4;
/**
 * Pull towards the middle of the crossings, per crossing. Enough to keep a
 * curved face — whose planes nearly agree — from wandering off, small
 * enough that two faces meeting at an angle meet in a sharp line.
 */
const LAMBDA = 0.02;

export class DexelMesher {
  /**
   * @param {import('./triDexel.js').TriDexelStock} stock
   * @param {{step?:number, block?:number}} [opts] step: use every step-th
   *   line in each direction, for a lighter mesh of the same part
   */
  constructor(stock, opts = {}) {
    this.stock = stock;
    const s = Math.max(1, Math.floor(opts.step || 1));
    this.step = s;
    this.B = Math.max(2, Math.floor(opts.block || BLOCK));
    /** Lattice points along each axis. */
    this.N = stock.n3.map((n) => Math.ceil(n / s));
    // Cells run from -1, just outside the low face, to N-1, just outside
    // the high one: a point past either end is air.
    this.nBlocks = this.N.map((n) => Math.ceil((n + 1) / this.B));
    this.blockCount = this.nBlocks[0] * this.nBlocks[1] * this.nBlocks[2];

    const L = this.B + 2;
    this.L = L;
    const L3 = L * L * L;
    this.occ = new Uint8Array(L3);
    this.rowCount = new Int32Array(L * L);
    // Crossings on the block's edges, one set per axis, made when first asked.
    this.cStamp = [0, 1, 2].map(() => new Int32Array(L3));
    this.cVal = [0, 1, 2].map(() => new Float32Array(L3));
    this.cNrm = [0, 1, 2].map(() => new Float32Array(3 * L3));
    this.cWho = [0, 1, 2].map(() => new Uint8Array(L3));
    // Vertices made so far, per cell of the block and its ring.
    const C3 = (L - 1) * (L - 1) * (L - 1);
    this.vStamp = new Int32Array(C3);
    this.vIndex = new Int32Array(C3);
    this.stamp = 0;
    this.out = { positions: new Float32Array(3 * 4096), normals: new Float32Array(3 * 4096), who: new Uint8Array(4096), index: new Uint32Array(6 * 4096), vertices: 0, indices: 0 };
  }

  /** Where lattice point n sits along axis a, from the stock's low face. */
  pos(a, n) { return (this.step * n + 0.5) * this.stock.d3[a]; }

  /** The cells of block (bx, by, bz): [c0, c1) along each axis. */
  blockCells(bx, by, bz) {
    const B = this.B;
    const out = [];
    for (const [a, k] of [[0, bx], [1, by], [2, bz]]) {
      const c0 = -1 + k * B;
      out.push(c0, Math.min(c0 + B, this.N[a]));
    }
    return out;
  }

  /** Block number from its three indices, and back. */
  blockIndex(bx, by, bz) { return (bz * this.nBlocks[1] + by) * this.nBlocks[0] + bx; }
  blockCoords(k) {
    const nx = this.nBlocks[0];
    const ny = this.nBlocks[1];
    return [k % nx, Math.floor(k / nx) % ny, Math.floor(k / (nx * ny))];
  }

  /** The world box a block's surface stays inside, for culling. */
  blockBox(k) {
    const [bx, by, bz] = this.blockCoords(k);
    const cells = this.blockCells(bx, by, bz);
    const o3 = this.stock.o3;
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      lo[a] = o3[a] + this.pos(a, cells[2 * a] - 1);
      hi[a] = o3[a] + this.pos(a, cells[2 * a + 1] + 1);
    }
    return [lo, hi];
  }

  /**
   * The blocks a change inside a world box can reach: the lattice points in
   * it, the lines beside them that give the crossings their facing, and the
   * cells either side whose vertices the quads share.
   * @returns {number[]} [bx0, by0, bz0, bx1, by1, bz1]
   */
  blocksFor(box) {
    const o3 = this.stock.o3;
    const d3 = this.stock.d3;
    const s = this.step;
    // A crossing takes its facing from ends on the lines beside it up to
    // four cells away along them, so a change reaches that far.
    const pad = 5 * Math.max(d3[0], d3[1], d3[2]);
    const out = [0, 0, 0, 0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const nLo = Math.floor(((box[a] - pad - o3[a]) / d3[a] - 0.5) / s) - 1;
      const nHi = Math.ceil(((box[a + 3] + pad - o3[a]) / d3[a] - 0.5) / s) + 1;
      const cLo = nLo - 2;
      const cHi = nHi + 1;
      out[a] = Math.max(0, Math.floor((cLo + 1) / this.B));
      out[a + 3] = Math.min(this.nBlocks[a] - 1, Math.floor((cHi + 1) / this.B));
    }
    return out;
  }

  /**
   * Mesh one block. The result lives in `this.out` until the next call:
   * positions and normals per vertex (world mm), `who` the tool that cut
   * each vertex's face (0 for raw stock), and triangles as indices.
   */
  buildBlock(k) {
    const [bx, by, bz] = this.blockCoords(k);
    const cells = this.blockCells(bx, by, bz);
    const out = this.out;
    out.vertices = 0;
    out.indices = 0;
    this.stamp++;
    if (this.stamp > 0x7ffffff0) {
      this.stamp = 1;
      for (const a of this.cStamp) a.fill(0);
      this.vStamp.fill(0);
    }
    this.n0 = [cells[0] - 1, cells[2] - 1, cells[4] - 1];
    if (!this.fillOccupancy()) return out;

    const L = this.L;
    const occ = this.occ;
    const rc = this.rowCount;
    // Edges this block owns: along each axis, from a lattice point in the
    // block to the next; the block above in a direction owns the edges on
    // its own lower face. Local point indices 1 … L-2 are the block's own.
    const span = [cells[1] - cells[0], cells[3] - cells[2], cells[5] - cells[4]];
    const hiU = 1 + span[0], hiV = 1 + span[1], hiW = 1 + span[2];
    for (let lw = 1; lw < hiW; lw++) {
      for (let lv = 1; lv < hiV; lv++) {
        const row = lw * L + lv;
        const base = row * L;
        const cnt = rc[row];
        // Along X: only rows with both air and metal in them cross.
        if (cnt > 0 && cnt < L) {
          for (let lu = 1; lu < hiU; lu++) {
            const p = occ[base + lu];
            if (p !== occ[base + lu + 1]) this.quad(0, lu, lv, lw, p);
          }
        }
        // Along Y and Z: against the next row over.
        for (let a = 1; a < 3; a++) {
          const nrow = a === 1 ? row + 1 : row + L;
          const ncnt = rc[nrow];
          if ((cnt === 0 || cnt === L) && cnt === ncnt) continue;
          const nbase = nrow * L;
          for (let lu = 1; lu < hiU; lu++) {
            const p = occ[base + lu];
            if (p !== occ[nbase + lu]) this.quad(a, lu, lv, lw, p);
          }
        }
      }
    }
    return out;
  }

  /**
   * Which lattice points of the block and its ring are in the metal, read
   * off the X lines. Returns false when they all agree — nothing to draw.
   */
  fillOccupancy() {
    const stock = this.stock;
    const F = stock.fam[0];
    const L = this.L;
    const occ = this.occ;
    const rc = this.rowCount;
    const s = this.step;
    const [u0, v0, w0] = this.n0;
    const N = this.N;
    const dx = stock.d3[0];
    occ.fill(0);
    let total = 0;
    for (let lw = 0; lw < L; lw++) {
      const nw = w0 + lw;
      for (let lv = 0; lv < L; lv++) {
        const nv = v0 + lv;
        const row = lw * L + lv;
        rc[row] = 0;
        if (nw < 0 || nv < 0 || nw >= N[2] || nv >= N[1]) continue;
        const r = s * nw * F.nb + s * nv;
        const n = F.cnt[r];
        if (!n) continue;
        const o = F.off[r];
        const base = row * L;
        let count = 0;
        for (let q = 0; q < n; q++) {
          // Points whose position (s·u + ½)·dx falls inside [start, end].
          let ua = Math.ceil((F.pool[o + 2 * q] / dx - 0.5) / s);
          let ub = Math.floor((F.pool[o + 2 * q + 1] / dx - 0.5) / s);
          if (ua < 0) ua = 0;
          if (ub > N[0] - 1) ub = N[0] - 1;
          let la = ua - u0;
          let lb = ub - u0;
          if (la < 0) la = 0;
          if (lb > L - 1) lb = L - 1;
          if (la > lb) continue;
          occ.fill(1, base + la, base + lb + 1);
          count += lb - la + 1;
        }
        rc[row] = count;
        total += count;
      }
    }
    return total > 0 && total < L * L * L;
  }

  /**
   * The quad across the edge from local point (lu, lv, lw) along axis a,
   * facing out of the metal: `inLow` says the low end is the metal one.
   */
  quad(a, lu, lv, lw, inLow) {
    // The four cells round the edge, counter-clockwise seen from +a.
    const ids = QUAD_IDS;
    for (let q = 0; q < 4; q++) {
      const t = 12 * a + 3 * q;
      const v = this.vertex(lu + QUAD_OFF[t], lv + QUAD_OFF[t + 1], lw + QUAD_OFF[t + 2]);
      if (v < 0) return;
      ids[q] = v;
    }
    const out = this.out;
    if (out.indices + 6 > out.index.length) out.index = grow(out.index, out.index.length * 2);
    const I = out.index;
    let i0 = ids[0], i1 = ids[1], i2 = ids[2], i3 = ids[3];
    if (!inLow) { const t = i1; i1 = i3; i3 = t; }
    // Split along the shorter diagonal.
    const P = out.positions;
    const d02 = dist2(P, i0, i2);
    const d13 = dist2(P, i1, i3);
    let m = out.indices;
    if (d02 <= d13) {
      I[m++] = i0; I[m++] = i1; I[m++] = i2;
      I[m++] = i0; I[m++] = i2; I[m++] = i3;
    } else {
      I[m++] = i0; I[m++] = i1; I[m++] = i3;
      I[m++] = i1; I[m++] = i2; I[m++] = i3;
    }
    out.indices = m;
  }

  /** The vertex of local cell (cu, cv, cw), made the first time it is asked for. */
  vertex(cu, cv, cw) {
    const L1 = this.L - 1;
    const key = (cw * L1 + cv) * L1 + cu;
    if (this.vStamp[key] === this.stamp) return this.vIndex[key];
    this.vStamp[key] = this.stamp;
    const L = this.L;
    const occ = this.occ;
    // Gather the crossings on the cell's twelve edges.
    let n = 0;
    const G = GATHER;
    const n0 = this.n0;
    for (let a = 0; a < 3; a++) {
      const stride = a === 0 ? 1 : a === 1 ? L : L * L;
      for (let e = 0; e < 4; e++) {
        const t = 12 * a + 3 * e;
        const pu = cu + EDGE_OFF[t], pv = cv + EDGE_OFF[t + 1], pw = cw + EDGE_OFF[t + 2];
        const i = (pw * L + pv) * L + pu;
        const inLow = occ[i];
        if (inLow === occ[i + stride]) continue;
        this.crossing(a, pu, pv, pw, i, inLow);
        const cv3 = this.cNrm[a];
        // The crossing point, from the stock's low corner.
        G[7 * n] = this.pos(0, n0[0] + pu);
        G[7 * n + 1] = this.pos(1, n0[1] + pv);
        G[7 * n + 2] = this.pos(2, n0[2] + pw);
        G[7 * n + a] = this.cVal[a][i];
        G[7 * n + 3] = cv3[3 * i];
        G[7 * n + 4] = cv3[3 * i + 1];
        G[7 * n + 5] = cv3[3 * i + 2];
        G[7 * n + 6] = this.cWho[a][i];
        n++;
      }
    }
    if (!n) { this.vIndex[key] = -1; return -1; }

    // The middle of the crossings, then the best fit to their planes,
    // solved relative to it.
    let mx = 0, my = 0, mz = 0, nx = 0, ny = 0, nz = 0;
    for (let q = 0; q < n; q++) {
      mx += G[7 * q]; my += G[7 * q + 1]; mz += G[7 * q + 2];
      nx += G[7 * q + 3]; ny += G[7 * q + 4]; nz += G[7 * q + 5];
    }
    mx /= n; my /= n; mz /= n;
    const lam = LAMBDA * n;
    let a00 = lam, a01 = 0, a02 = 0, a11 = lam, a12 = 0, a22 = lam;
    let b0 = 0, b1 = 0, b2 = 0;
    for (let q = 0; q < n; q++) {
      const gx = G[7 * q + 3], gy = G[7 * q + 4], gz = G[7 * q + 5];
      const dd = gx * (G[7 * q] - mx) + gy * (G[7 * q + 1] - my) + gz * (G[7 * q + 2] - mz);
      a00 += gx * gx; a01 += gx * gy; a02 += gx * gz;
      a11 += gy * gy; a12 += gy * gz; a22 += gz * gz;
      b0 += gx * dd; b1 += gy * dd; b2 += gz * dd;
    }
    const c00 = a11 * a22 - a12 * a12;
    const c01 = a02 * a12 - a01 * a22;
    const c02 = a01 * a12 - a02 * a11;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    let x = mx, y = my, z = mz;
    if (Math.abs(det) > 1e-12) {
      const c11 = a00 * a22 - a02 * a02;
      const c12 = a01 * a02 - a00 * a12;
      const c22 = a00 * a11 - a01 * a01;
      // The pull towards the middle also shortens the way to a corner the
      // planes pin down exactly. Pulling instead towards the last answer,
      // twice more, takes that back where they do and leaves the middle
      // where they do not.
      let yx = 0, yy = 0, yz = 0;
      for (let it = 0; it < 3; it++) {
        const r0 = b0 + lam * yx, r1 = b1 + lam * yy, r2 = b2 + lam * yz;
        yx = (c00 * r0 + c01 * r1 + c02 * r2) / det;
        yy = (c01 * r0 + c11 * r1 + c12 * r2) / det;
        yz = (c02 * r0 + c12 * r1 + c22 * r2) / det;
      }
      // A fit far outside the cell is planes meeting far off — nearly
      // parallel ones — and the middle is the honest answer. One just
      // outside is a face that only clips the cell's corner, and belongs
      // at the edge of the cell nearest it.
      const px = this.toCell(0, cu, mx + yx);
      const py = this.toCell(1, cv, my + yy);
      const pz = this.toCell(2, cw, mz + yz);
      if (px === px && py === py && pz === pz) { x = px; y = py; z = pz; }
    }

    // Which tool the face here belongs to: the one most of its crossings say.
    let who = 0;
    let best = 0;
    for (let q = 0; q < n; q++) {
      const w = G[7 * q + 6];
      let c = 0;
      for (let r = 0; r < n; r++) if (G[7 * r + 6] === w) c++;
      if (c > best || (c === best && w > who)) { best = c; who = w; }
    }

    const out = this.out;
    const v = out.vertices;
    if (v + 1 > out.who.length) {
      const m = out.who.length * 2;
      out.positions = growF(out.positions, 3 * m);
      out.normals = growF(out.normals, 3 * m);
      out.who = grow8(out.who, m);
    }
    const o3 = this.stock.o3;
    out.positions[3 * v] = o3[0] + x;
    out.positions[3 * v + 1] = o3[1] + y;
    out.positions[3 * v + 2] = o3[2] + z;
    const nl = Math.hypot(nx, ny, nz) || 1;
    out.normals[3 * v] = nx / nl;
    out.normals[3 * v + 1] = ny / nl;
    out.normals[3 * v + 2] = nz / nl;
    out.who[v] = who;
    out.vertices = v + 1;
    this.vIndex[key] = v;
    return v;
  }

  /**
   * Position x along axis a brought inside local cell c (give or take a
   * little), or NaN when it is more than half the cell outside.
   */
  toCell(a, c, x) {
    const lo = this.pos(a, this.n0[a] + c);
    const hi = this.pos(a, this.n0[a] + c + 1);
    const w = hi - lo;
    if (x < lo - 0.5 * w || x > hi + 0.5 * w) return NaN;
    const m = w * 0.05;
    return x < lo - m ? lo - m : x > hi + m ? hi + m : x;
  }

  /**
   * Where the edge from local point (lu, lv, lw) along axis a leaves the
   * metal, its facing and the tool that made it — the end of a stretch on
   * that edge's own line. Kept per edge: up to four cells ask.
   */
  crossing(a, lu, lv, lw, i, inLow) {
    if (this.cStamp[a][i] === this.stamp) return;
    this.cStamp[a][i] = this.stamp;
    const stock = this.stock;
    const F = stock.fam[a];
    const s = this.step;
    const node = [this.n0[0] + lu, this.n0[1] + lv, this.n0[2] + lw];
    const li = s * node[F.b];
    const lj = s * node[F.c];
    const r = lj * F.nb + li;
    const lo = this.pos(a, node[a]);
    const hi = this.pos(a, node[a] + 1);
    const n = F.cnt[r];
    const o = F.off[r];
    const P = F.pool;
    let at = -1;
    // The material at the low end ends in an exit; the material at the
    // high end starts with an entry. Of several in the edge — a fin thinner
    // than the lattice — the one nearest the metal end.
    if (inLow) {
      for (let k = 1; k < 2 * n; k += 2) {
        const v = P[o + k];
        if (v > hi + EPS) break;
        if (v >= lo - EPS) { at = k; break; }
      }
    } else {
      for (let k = 0; k < 2 * n; k += 2) {
        const v = P[o + k];
        if (v > hi + EPS) break;
        if (v >= lo - EPS) at = k;
      }
    }
    if (at < 0) {
      // The lines disagree by a rounding: the point is on the surface to
      // within the stretches' precision. Any end in the edge will do.
      let bd = Infinity;
      const mid = (lo + hi) / 2;
      for (let k = 0; k < 2 * n; k++) {
        const v = P[o + k];
        if (v < lo - EPS || v > hi + EPS) continue;
        if (Math.abs(v - mid) < bd) { bd = Math.abs(v - mid); at = k; }
      }
    }
    const nrm = this.cNrm[a];
    if (at < 0) {
      this.cVal[a][i] = (lo + hi) / 2;
      nrm[3 * i] = 0; nrm[3 * i + 1] = 0; nrm[3 * i + 2] = 0;
      nrm[3 * i + a] = inLow ? 1 : -1;
      this.cWho[a][i] = 0;
      return;
    }
    const v = P[o + at];
    this.cVal[a][i] = Math.min(hi, Math.max(lo, v));
    this.cWho[a][i] = F.who[o + at];
    const exit = at & 1;
    // Facing: the slope of the surface across the grid, from the lines
    // beside this one at full resolution.
    const tol = 4 * Math.max(F.db, F.dc);
    const gb = slope(F, li, lj, 0, v, exit, tol) / F.db;
    const gc = slope(F, li, lj, 1, v, exit, tol) / F.dc;
    const sgn = exit ? 1 : -1;
    const g = [0, 0, 0];
    g[a] = sgn;
    g[F.b] = -sgn * gb;
    g[F.c] = -sgn * gc;
    const len = Math.hypot(g[0], g[1], g[2]);
    nrm[3 * i] = g[0] / len;
    nrm[3 * i + 1] = g[1] / len;
    nrm[3 * i + 2] = g[2] / len;
  }
}

const QUAD_IDS = [0, 0, 0, 0];
/** Up to twelve crossings: x, y, z, normal, tool. */
const GATHER = new Float64Array(7 * 12);

/**
 * Per axis a, offsets (du, dv, dw) of: the four cells round an edge along
 * a, counter-clockwise seen from +a (QUAD_OFF); and the low ends of a
 * cell's four edges along a (EDGE_OFF). The other two axes are taken in
 * turn after a — y then z round X, z then x round Y, x then y round Z — so
 * every quad winds the same way about its own axis.
 */
const QUAD_OFF = new Int8Array(36);
const EDGE_OFF = new Int8Array(36);
for (let a = 0; a < 3; a++) {
  const a1 = (a + 1) % 3;
  const a2 = (a + 2) % 3;
  const around = [[-1, -1], [0, -1], [0, 0], [-1, 0]];
  for (let q = 0; q < 4; q++) {
    QUAD_OFF[12 * a + 3 * q + a1] = around[q][0];
    QUAD_OFF[12 * a + 3 * q + a2] = around[q][1];
    EDGE_OFF[12 * a + 3 * q + a1] = q & 1;
    EDGE_OFF[12 * a + 3 * q + a2] = q >> 1;
  }
}

function dist2(P, i, j) {
  const x = P[3 * i] - P[3 * j], y = P[3 * i + 1] - P[3 * j + 1], z = P[3 * i + 2] - P[3 * j + 2];
  return x * x + y * y + z * z;
}

function grow(a, n) { const b = new Uint32Array(n); b.set(a); return b; }
function growF(a, n) { const b = new Float32Array(n); b.set(a); return b; }
function grow8(a, n) { const b = new Uint8Array(n); b.set(a); return b; }

/**
 * How far the surface moves from line (i, j) to its neighbours along one
 * grid direction, at the endpoint `v` of the given kind. Central where both
 * neighbours carry on smoothly; where one side bends away — the line beside
 * an edge, across a corner — the side that carries on straight, so a face
 * keeps its own facing right up to the corner it meets another in.
 */
function slope(F, i, j, dir, v, exit, tol) {
  const plus = near(F, dir ? i : i + 1, dir ? j + 1 : j, v, exit, tol);
  const minus = near(F, dir ? i : i - 1, dir ? j - 1 : j, v, exit, tol);
  if (plus !== null && minus !== null) {
    const d1 = plus - v;
    const d2 = v - minus;
    if (Math.abs(d1 - d2) > (dir ? F.dc : F.db)) return Math.abs(d1) < Math.abs(d2) ? d1 : d2;
    return (d1 + d2) / 2;
  }
  if (plus !== null) return plus - v;
  if (minus !== null) return v - minus;
  return 0;
}

/** The endpoint of the same kind on line (i, j) nearest v, or null. */
function near(F, i, j, v, exit, tol) {
  if (i < 0 || j < 0 || i >= F.nb || j >= F.nc) return null;
  const r = j * F.nb + i;
  const cnt = F.cnt[r];
  const o = F.off[r];
  let best = null;
  let bd = tol;
  for (let k = exit; k < 2 * cnt; k += 2) {
    const d = Math.abs(F.pool[o + k] - v);
    if (d <= bd) { bd = d; best = F.pool[o + k]; }
  }
  return best;
}

/**
 * The whole stock as a triangle soup, for export: every block, every
 * triangle written out with its three corners.
 *
 * @param {import('./triDexel.js').TriDexelStock} stock
 * @param {{decimate?:number}} [opts] use every Nth line (1 = full detail)
 * @returns {{positions:Float32Array, triangles:number}}
 */
export function dexelTriangles(stock, opts = {}) {
  const mesher = new DexelMesher(stock, { step: opts.decimate || 1 });
  const parts = [];
  let total = 0;
  for (let k = 0; k < mesher.blockCount; k++) {
    const m = mesher.buildBlock(k);
    if (!m.indices) continue;
    const soup = new Float32Array(m.indices * 3);
    for (let q = 0; q < m.indices; q++) {
      const v = m.index[q];
      soup[3 * q] = m.positions[3 * v];
      soup[3 * q + 1] = m.positions[3 * v + 1];
      soup[3 * q + 2] = m.positions[3 * v + 2];
    }
    parts.push(soup);
    total += soup.length;
  }
  const positions = new Float32Array(total);
  let o = 0;
  for (const p of parts) { positions.set(p, o); o += p.length; }
  return { positions, triangles: total / 9 };
}
