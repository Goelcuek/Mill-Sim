// Stock model: a Z-heightmap ("dexel field") sampled on a regular XY grid.
//
// Each grid column stores the height of the top surface of the remaining
// material. Cutting is `h = min(h, tipZ + LE_cut(r))` over the columns the
// tool covers, which is exact for 3-axis milling of any tool profile and
// costs one table lookup per column.
//
// The model deliberately cannot represent undercuts: a column has a single
// top surface. That is the standard trade-off for interactive 3-axis
// verification and it is reported in the UI rather than hidden.
//
// A coarse tile grid holds the maximum height of each 16x16 block. Air
// moves — the majority of every program — are rejected against it without
// touching a single column.

export const TILE = 16;

/**
 * Smallest height change counted as a cut, in millimetres.
 *
 * Recomputing a surface the tool already produced can land a fraction of a
 * nanometre below the stored value, and without a floor on that the
 * retract move of every peck cycle reports itself as a rapid that removed
 * material. A nanometre is far below any geometry worth simulating.
 */
const MIN_CUT = 1e-6;

export class Stock {
  /**
   * @param {{origin:[number,number,number], size:[number,number,number],
   *          resolution?:number, maxCells?:number}} opts
   *   `origin` is the minimum corner (x, y, z) in scene millimetres;
   *   `resolution` is the requested cell size in millimetres.
   */
  constructor(opts) {
    const size = opts.size.map((v) => Math.max(Math.abs(v), 0.1));
    const requested = Math.max(opts.resolution || 0.4, 0.02);
    // 20M columns is ~100 MB of height and cut flags, which is the point
    // where a 0.025 mm grid on a palm-sized part is still comfortable.
    const maxCells = opts.maxCells || 20_000_000;

    let cell = requested;
    let nx = Math.max(2, Math.round(size[0] / cell));
    let ny = Math.max(2, Math.round(size[1] / cell));
    if (nx * ny > maxCells) {
      const scale = Math.sqrt((nx * ny) / maxCells);
      cell = requested * scale;
      nx = Math.max(2, Math.round(size[0] / cell));
      ny = Math.max(2, Math.round(size[1] / cell));
    }

    this.origin = [opts.origin[0], opts.origin[1], opts.origin[2]];
    this.size = size;
    this.nx = nx;
    this.ny = ny;
    this.dx = size[0] / nx;
    this.dy = size[1] / ny;
    this.cell = Math.min(this.dx, this.dy);
    this.top = this.origin[2] + size[2];
    this.base = this.origin[2];

    this.height = new Float32Array(nx * ny);
    /** 0 = untouched stock face, otherwise 1 + tool index that cut it. */
    this.cutBy = new Uint8Array(nx * ny);

    this.tilesX = Math.ceil(nx / TILE);
    this.tilesY = Math.ceil(ny / TILE);
    this.tileMax = new Float32Array(this.tilesX * this.tilesY);
    this.tileDirty = new Uint8Array(this.tilesX * this.tilesY);

    this.removedVolume = 0;
    this.version = 0;
    this.dirtyRect = null;

    this.reset();
  }

  get cellCount() { return this.nx * this.ny; }

  /** Volume of one column's footprint, mm^2. */
  get cellArea() { return this.dx * this.dy; }

  /** Initial (uncut) stock volume in mm^3. */
  get stockVolume() { return this.size[0] * this.size[1] * this.size[2]; }

  reset() {
    this.height.fill(this.top);
    this.cutBy.fill(0);
    this.tileMax.fill(this.top);
    this.tileDirty.fill(0);
    this.removedVolume = 0;
    this.version++;
    this.markDirtyRect(0, 0, this.nx - 1, this.ny - 1);
  }

  /** World X of column i (cell centre). */
  cx(i) { return this.origin[0] + (i + 0.5) * this.dx; }
  cy(j) { return this.origin[1] + (j + 0.5) * this.dy; }

  markDirtyRect(i0, j0, i1, j1) {
    const r = this.dirtyRect;
    if (!r) {
      this.dirtyRect = { i0, j0, i1, j1 };
      return;
    }
    if (i0 < r.i0) r.i0 = i0;
    if (j0 < r.j0) r.j0 = j0;
    if (i1 > r.i1) r.i1 = i1;
    if (j1 > r.j1) r.j1 = j1;
  }

  clearDirty() {
    const r = this.dirtyRect;
    this.dirtyRect = null;
    return r;
  }

  /** Recompute the max-height tiles that carving invalidated. */
  refreshTiles() {
    const { nx, ny, tilesX, tilesY } = this;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const t = ty * tilesX + tx;
        if (!this.tileDirty[t]) continue;
        this.tileDirty[t] = 0;
        const i1 = Math.min(nx, (tx + 1) * TILE);
        const j1 = Math.min(ny, (ty + 1) * TILE);
        let m = -Infinity;
        for (let j = ty * TILE; j < j1; j++) {
          const row = j * nx;
          for (let i = tx * TILE; i < i1; i++) {
            const h = this.height[row + i];
            if (h > m) m = h;
          }
        }
        this.tileMax[t] = m;
      }
    }
  }

  /**
   * Highest remaining material inside an XY rectangle.
   * Uses the tile pyramid, so the result is an upper bound that is exact
   * once {@link refreshTiles} has run.
   */
  maxHeightIn(x0, y0, x1, y1) {
    const i0 = Math.max(0, Math.floor((x0 - this.origin[0]) / this.dx));
    const i1 = Math.min(this.nx - 1, Math.ceil((x1 - this.origin[0]) / this.dx));
    const j0 = Math.max(0, Math.floor((y0 - this.origin[1]) / this.dy));
    const j1 = Math.min(this.ny - 1, Math.ceil((y1 - this.origin[1]) / this.dy));
    if (i0 > i1 || j0 > j1) return -Infinity;

    let m = -Infinity;
    const tx0 = (i0 / TILE) | 0, tx1 = (i1 / TILE) | 0;
    const ty0 = (j0 / TILE) | 0, ty1 = (j1 / TILE) | 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      const row = ty * this.tilesX;
      for (let tx = tx0; tx <= tx1; tx++) {
        const v = this.tileMax[row + tx];
        if (v > m) m = v;
      }
    }
    return m;
  }

  /**
   * Remove material under a tool positioned at (x, y) with its tip at z.
   *
   * @param {import('../tools/envelope.js').Envelope} env  cutting envelope
   * @param {number} x
   * @param {number} y
   * @param {number} z  tip height
   * @param {number} [toolIndex] recorded per column for shading
   * @returns {number} volume removed, mm^3
   */
  carve(env, x, y, z, toolIndex = 0) {
    if (env.isEmpty) return 0;
    const rMax = env.rMax;
    if (z + env.zMin >= this.maxHeightIn(x - rMax, y - rMax, x + rMax, y + rMax)) return 0;

    const i0 = Math.max(0, Math.floor((x - rMax - this.origin[0]) / this.dx - 0.5));
    const i1 = Math.min(this.nx - 1, Math.ceil((x + rMax - this.origin[0]) / this.dx - 0.5));
    const j0 = Math.max(0, Math.floor((y - rMax - this.origin[1]) / this.dy - 0.5));
    const j1 = Math.min(this.ny - 1, Math.ceil((y + rMax - this.origin[1]) / this.dy - 0.5));
    if (i0 > i1 || j0 > j1) return 0;

    const rMax2 = env.rMax2;
    const flag = Math.min(255, toolIndex + 1);
    const area = this.dx * this.dy;
    let removed = 0;
    let touched = false;
    let ti0 = 0, tj0 = 0, ti1 = 0, tj1 = 0;

    for (let j = j0; j <= j1; j++) {
      const py = this.origin[1] + (j + 0.5) * this.dy - y;
      const py2 = py * py;
      if (py2 > rMax2) continue;
      const row = j * this.nx;
      for (let i = i0; i <= i1; i++) {
        const px = this.origin[0] + (i + 0.5) * this.dx - x;
        const r2 = px * px + py2;
        if (r2 >= rMax2) continue;
        const k = row + i;
        const h = this.height[k];
        const zt = z + env.at(r2);
        if (h - zt > MIN_CUT) {
          const cut = Math.min(h, this.top) - Math.max(zt, this.base);
          if (cut > 0) removed += cut;
          this.height[k] = zt < this.base ? this.base : zt;
          this.cutBy[k] = flag;
          if (!touched) { ti0 = i; ti1 = i; tj0 = j; tj1 = j; touched = true; }
          else {
            if (i < ti0) ti0 = i; else if (i > ti1) ti1 = i;
            if (j < tj0) tj0 = j; else if (j > tj1) tj1 = j;
          }
          this.tileDirty[((j / TILE) | 0) * this.tilesX + ((i / TILE) | 0)] = 1;
        }
      }
    }

    if (touched) {
      this.markDirtyRect(ti0, tj0, ti1, tj1);
      this.version++;
      const vol = removed * area;
      this.removedVolume += vol;
      return vol;
    }
    return 0;
  }

  /**
   * Remove the volume swept by a tool moving in a straight line.
   *
   * This is the difference between a simulator that can run at 0.025 mm and
   * one that cannot. Carving by repeatedly stamping the tool disc costs
   * O(1/cell^3) — four times the columns and twice the steps for every
   * halving — so a fine grid dies. Sweeping instead visits each column
   * exactly once and solves for the lowest the tool ever gets over that
   * column, which is O(1/cell^2).
   *
   * For a column at distance r(t) from the moving axis, the tool tip is at
   * z(t) = z0 + t*dz and the surface it can reach is z(t) + LE(r(t)^2).
   * r(t)^2 is a parabola in t, so the interval where the tool covers the
   * column at all comes straight out of a quadratic; LE is non-decreasing
   * and convex in r for every cutter shape here, which makes the sum
   * unimodal and a golden-section search exact.
   *
   * @param {import('../tools/envelope.js').Envelope} env
   * @param {number[]} from  [x, y, z] tool tip at the start
   * @param {number[]} to    [x, y, z] tool tip at the end
   * @param {number} [toolIndex]
   * @param {{target?:Float32Array, tolerance?:number}} [opts]
   *   `target` is a reference-part heightmap on this same grid; cutting
   *   below it by more than `tolerance` is a gouge.
   * @returns {{volume:number, gouge:null|{depth:number,x:number,y:number,z:number}}}
   */
  carveSweep(env, from, to, toolIndex = 0, opts = {}) {
    const none = { volume: 0, gouge: null };
    if (env.isEmpty) return none;

    const ax = from[0], ay = from[1], az = from[2];
    const dx = to[0] - ax, dy = to[1] - ay, dz = to[2] - az;
    const rMax = env.rMax;
    const rMax2 = env.rMax2;

    const minX = Math.min(ax, to[0]) - rMax;
    const maxX = Math.max(ax, to[0]) + rMax;
    const minY = Math.min(ay, to[1]) - rMax;
    const maxY = Math.max(ay, to[1]) + rMax;
    const lowest = Math.min(az, to[2]) + env.zMin;
    if (lowest >= this.maxHeightIn(minX, minY, maxX, maxY)) return none;

    const i0 = Math.max(0, Math.floor((minX - this.origin[0]) / this.dx - 0.5));
    const i1 = Math.min(this.nx - 1, Math.ceil((maxX - this.origin[0]) / this.dx - 0.5));
    const j0 = Math.max(0, Math.floor((minY - this.origin[1]) / this.dy - 0.5));
    const j1 = Math.min(this.ny - 1, Math.ceil((maxY - this.origin[1]) / this.dy - 0.5));
    if (i0 > i1 || j0 > j1) return none;

    // Hoist everything the inner loop touches out of property lookups.
    const lut = env.lut;
    const nLut = env.n;
    const invStep = env.invStep;
    const height = this.height;
    const cutBy = this.cutBy;
    const nx = this.nx;
    const cellDx = this.dx;
    const cellDy = this.dy;
    const ox = this.origin[0];
    const oy = this.origin[1];
    const base = this.base;
    const top = this.top;
    const tilesX = this.tilesX;
    const tileMax = this.tileMax;
    const tileDirty = this.tileDirty;
    const flag = Math.min(255, toolIndex + 1);
    const dd = dx * dx + dy * dy;                 // squared XY length
    const flatOnly = env.flatR2 >= rMax2 - 1e-12; // a flat-bottomed cutter
    const target = opts.target || null;
    const tolerance = opts.tolerance || 0;

    const le = (r2) => {
      if (r2 >= rMax2) return Infinity;
      const x = r2 * invStep;
      const k = x | 0;
      if (k >= nLut) return lut[nLut];
      const a0 = lut[k];
      const b0 = lut[k + 1];
      return b0 === Infinity ? a0 : a0 + (b0 - a0) * (x - k);
    };

    let removed = 0;
    let touched = false;
    let ti0 = 0, tj0 = 0, ti1 = 0, tj1 = 0;
    let gouge = null;

    for (let j = j0; j <= j1; j++) {
      const py = oy + (j + 0.5) * cellDy;
      const wy = ay - py;
      const row = j * nx;
      const tileRow = ((j / TILE) | 0) * tilesX;

      for (let i = i0; i <= i1; i++) {
        const px = ox + (i + 0.5) * cellDx;
        const wx = ax - px;

        // Squared distance to the moving axis: c0 + c1 t + c2 t^2.
        const c0 = wx * wx + wy * wy;
        const c1 = 2 * (wx * dx + wy * dy);
        const c2 = dd;

        let t1 = 0;
        let t2 = 1;
        if (c2 > 1e-15) {
          // Where does the tool cover this column at all?
          const disc = c1 * c1 - 4 * c2 * (c0 - rMax2);
          if (disc <= 0) continue;
          const sq = Math.sqrt(disc);
          t1 = (-c1 - sq) / (2 * c2);
          t2 = (-c1 + sq) / (2 * c2);
          if (t1 < 0) t1 = 0;
          if (t2 > 1) t2 = 1;
          if (t1 > t2) continue;
        } else if (c0 >= rMax2) {
          continue;                                // pure plunge, out of reach
        }

        const k = row + i;
        const h = height[k];

        // Cheapest possible outcome over this interval; if the column is
        // already lower, nothing here can remove anything.
        const zA = az + dz * t1;
        const zB = az + dz * t2;
        if (h <= (zA < zB ? zA : zB) + env.zMin) continue;

        let zt;
        if (flatOnly) {
          // Constant envelope: the lowest point is at one end of the pass.
          const l0 = lut[0];
          zt = (zA < zB ? zA : zB) + l0;
        } else {
          // Seed with the ends and the closest approach, then golden-section
          // the convex remainder.
          let lo = t1;
          let hi = t2;
          zt = zA + le(c0 + c1 * t1 + c2 * t1 * t1);
          const fB = zB + le(c0 + c1 * t2 + c2 * t2 * t2);
          if (fB < zt) zt = fB;

          if (hi - lo > 1e-9) {
            const R = 0.6180339887498949;
            let x1 = hi - R * (hi - lo);
            let x2 = lo + R * (hi - lo);
            let f1 = az + dz * x1 + le(c0 + c1 * x1 + c2 * x1 * x1);
            let f2 = az + dz * x2 + le(c0 + c1 * x2 + c2 * x2 * x2);
            for (let it = 0; it < 14; it++) {
              if (f1 < f2) {
                hi = x2; x2 = x1; f2 = f1;
                x1 = hi - R * (hi - lo);
                f1 = az + dz * x1 + le(c0 + c1 * x1 + c2 * x1 * x1);
              } else {
                lo = x1; x1 = x2; f1 = f2;
                x2 = lo + R * (hi - lo);
                f2 = az + dz * x2 + le(c0 + c1 * x2 + c2 * x2 * x2);
              }
            }
            if (f1 < zt) zt = f1;
            if (f2 < zt) zt = f2;
          }
        }

        if (h - zt <= MIN_CUT) continue;

        const cut = (h < top ? h : top) - (zt > base ? zt : base);
        if (cut > 0) removed += cut;
        height[k] = zt < base ? base : zt;
        cutBy[k] = flag;

        if (target !== null) {
          const want = target[k];
          if (want > -Infinity) {
            const depth = want - height[k];
            if (depth > tolerance && (gouge === null || depth > gouge.depth)) {
              gouge = { depth, x: px, y: py, z: height[k] };
            }
          }
        }

        if (!touched) { ti0 = i; ti1 = i; tj0 = j; tj1 = j; touched = true; }
        else {
          if (i < ti0) ti0 = i; else if (i > ti1) ti1 = i;
          if (j < tj0) tj0 = j; else if (j > tj1) tj1 = j;
        }
        tileDirty[tileRow + ((i / TILE) | 0)] = 1;
      }
    }

    if (!touched) return none;
    this.markDirtyRect(ti0, tj0, ti1, tj1);
    this.version++;
    const volume = removed * cellDx * cellDy;
    this.removedVolume += volume;
    return { volume, gouge };
  }

  /**
   * Test the non-cutting body of an assembly against remaining material.
   *
   * @returns {null | {x:number, y:number, z:number, depth:number}}
   *   the worst offending column, or null when clear.
   */
  probeBody(env, x, y, z) {
    if (env.isEmpty) return null;
    const rMax = env.rMax;
    if (z + env.zMin >= this.maxHeightIn(x - rMax, y - rMax, x + rMax, y + rMax)) return null;

    // A Ø63 holder covers 6 million columns at 0.025 mm, so scanning its
    // whole footprint is not an option. Reject whole 16x16 tiles first using
    // the nearest the body ever gets over that tile, then sample the
    // survivors on a fixed physical spacing rather than per column — a
    // collision worth reporting is never a quarter of a millimetre across.
    const i0 = Math.max(0, Math.floor((x - rMax - this.origin[0]) / this.dx - 0.5));
    const i1 = Math.min(this.nx - 1, Math.ceil((x + rMax - this.origin[0]) / this.dx - 0.5));
    const j0 = Math.max(0, Math.floor((y - rMax - this.origin[1]) / this.dy - 0.5));
    const j1 = Math.min(this.ny - 1, Math.ceil((y + rMax - this.origin[1]) / this.dy - 0.5));
    if (i0 > i1 || j0 > j1) return null;

    const stride = Math.max(1, Math.round(0.25 / this.cell));
    const rMax2 = env.rMax2;
    let worst = null;

    const tx0 = (i0 / TILE) | 0, tx1 = (i1 / TILE) | 0;
    const ty0 = (j0 / TILE) | 0, ty1 = (j1 / TILE) | 0;

    for (let ty = ty0; ty <= ty1; ty++) {
      const tjLo = Math.max(j0, ty * TILE);
      const tjHi = Math.min(j1, (ty + 1) * TILE - 1);
      const yLo = this.origin[1] + (tjLo + 0.5) * this.dy;
      const yHi = this.origin[1] + (tjHi + 0.5) * this.dy;
      const dyMin = y < yLo ? yLo - y : y > yHi ? y - yHi : 0;

      for (let tx = tx0; tx <= tx1; tx++) {
        const tiLo = Math.max(i0, tx * TILE);
        const tiHi = Math.min(i1, (tx + 1) * TILE - 1);
        const xLo = this.origin[0] + (tiLo + 0.5) * this.dx;
        const xHi = this.origin[0] + (tiHi + 0.5) * this.dx;
        const dxMin = x < xLo ? xLo - x : x > xHi ? x - xHi : 0;

        // Lowest the body can be anywhere over this tile.
        const nearest2 = dxMin * dxMin + dyMin * dyMin;
        if (nearest2 >= rMax2) continue;
        const floor = z + env.at(nearest2);
        if (this.tileMax[ty * this.tilesX + tx] <= floor) continue;

        for (let j = tjLo; j <= tjHi; j += stride) {
          const wy = this.origin[1] + (j + 0.5) * this.dy;
          const py = wy - y;
          const py2 = py * py;
          if (py2 > rMax2) continue;
          const row = j * this.nx;
          for (let i = tiLo; i <= tiHi; i += stride) {
            const wx = this.origin[0] + (i + 0.5) * this.dx;
            const px = wx - x;
            const r2 = px * px + py2;
            if (r2 >= rMax2) continue;
            const h = this.height[row + i];
            if (h <= this.base) continue;
            const zb = z + env.at(r2);
            const depth = h - zb;
            if (depth > 0 && (!worst || depth > worst.depth)) worst = { x: wx, y: wy, z: zb, depth };
          }
        }
      }
    }
    return worst;
  }

  /** Height of the material at a world XY point, or the base when outside. */
  heightAt(x, y) {
    const i = Math.floor((x - this.origin[0]) / this.dx);
    const j = Math.floor((y - this.origin[1]) / this.dy);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -Infinity;
    return this.height[j * this.nx + i];
  }

  /** Remaining material volume, mm^3. */
  remainingVolume() {
    let sum = 0;
    const a = this.dx * this.dy;
    for (let k = 0; k < this.height.length; k++) sum += this.height[k] - this.base;
    return sum * a;
  }

  /** Serialisable description (not the height data). */
  describe() {
    return {
      origin: this.origin.slice(),
      size: this.size.slice(),
      grid: [this.nx, this.ny],
      cell: this.cell,
      cells: this.cellCount,
    };
  }
}
