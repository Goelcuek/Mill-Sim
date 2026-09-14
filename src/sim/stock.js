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
   *          resolution?:number, maxCells?:number,
   *          column?:(x:number, y:number) => number|null}} opts
   *   `origin` is the minimum corner (x, y, z) in scene millimetres;
   *   `resolution` is the requested cell size in millimetres.
   *
   *   `column` is the shape: given a point on the grid it returns the
   *   height the material starts at, or null where there is none. Omitted,
   *   every column starts at the top and the stock is a plain block — which
   *   is the same answer, written out for the case that does not need
   *   asking. See sim/stockShape.js.
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

    /**
     * Where each column starts, which is what the shape means.
     *
     * A plain block shares one value and keeps no array for it: at a fine
     * resolution that would be another 80 MB to say "the top" twenty
     * million times. Anything else is read off the sampler once, here, and
     * never thought about again.
     */
    this.shaped = typeof opts.column === 'function';
    this.initial = null;
    if (!this.shaped) {
      this.initialVolume = size[0] * size[1] * size[2];
    } else {
      this.initial = new Float32Array(nx * ny);
      let filled = 0;
      let sum = 0;
      for (let j = 0; j < ny; j++) {
        const y = this.origin[1] + (j + 0.5) * this.dy;
        for (let i = 0; i < nx; i++) {
          const x = this.origin[0] + (i + 0.5) * this.dx;
          const z = opts.column(x, y);
          const h = z === null || !Number.isFinite(z)
            ? this.base
            : Math.min(Math.max(z, this.base), this.top);
          this.initial[j * nx + i] = h;
          if (h > this.base) { filled++; sum += h - this.base; }
        }
      }
      this.filledColumns = filled;
      this.initialVolume = sum * this.dx * this.dy;
    }

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
  get stockVolume() { return this.initialVolume; }

  /** Columns that started with material in them. */
  get filled() { return this.shaped ? this.filledColumns : this.cellCount; }

  reset() {
    if (this.initial) this.height.set(this.initial);
    else this.height.fill(this.top);
    this.cutBy.fill(0);
    this.removedVolume = 0;
    this.version++;
    if (this.shaped) {
      // A shaped stock has no single starting height, so the tile maxima
      // are read back off the grid rather than assumed.
      this.tileMax.fill(this.base);
      this.tileDirty.fill(1);
      this.refreshTiles();
    } else {
      this.tileMax.fill(this.top);
      this.tileDirty.fill(0);
    }
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
   * @param {{target?:{map:Float32Array, edge:Uint8Array}, tolerance?:number}} [opts]
   *   `target` is a reference-part heightmap on this same grid; cutting
   *   below it by more than `tolerance` is a gouge. Columns flagged in
   *   `edge` stand on a wall of the reference and cannot be judged from
   *   above, so they are left out — see sim/target.js.
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
    const targetMap = target ? target.map : null;
    const targetEdge = target ? target.edge : null;
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

        if (targetMap !== null && targetEdge[k] === 0) {
          const want = targetMap[k];
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
   * Remove material under a tool whose axis is not vertical.
   *
   * The heightmap still stores one surface per column, so the question for
   * each column is the same as ever — what is the lowest point of the tool
   * solid above it — but with the tool tilted that point no longer comes
   * from a table lookup.
   *
   * Working along the vertical line through the column, with `u` the height
   * above the tool tip's plane:
   *
   *     s(u)       = k + u*az                distance along the tool axis
   *     radial²(u) = A + B*u + C*u²          distance from the axis
   *
   * both quadratic, with C = 1 - az² vanishing when the tool stands
   * upright. The point is inside the cutter where s >= LE(radial²), and
   * since every cutter shape here is convex that region is a single
   * interval — so the search is: bracket where the tool could reach at all,
   * find the deepest point of penetration, then bisect down to where the
   * surface actually is.
   *
   * @param {import('../tools/envelope.js').Envelope} env
   * @param {number[]} tip   tool tip in stock coordinates
   * @param {number[]} dir   unit vector pointing up the tool from the tip
   * @param {number} fluteLength
   * @param {number} [toolIndex]
   * @param {{target?:{map:Float32Array, edge:Uint8Array}, tolerance?:number}} [opts]
   */
  carveTilted(env, tip, dir, fluteLength, toolIndex = 0, opts = {}) {
    const none = { volume: 0, gouge: null };
    if (env.isEmpty) return none;

    const ax = dir[0], ay = dir[1], az = dir[2];
    const rMax = env.rMax;
    const rMax2 = env.rMax2;
    const L = Math.max(fluteLength, 1e-6);

    // Footprint: the tip disc and the disc at the top of the flutes.
    const topX = tip[0] + ax * L;
    const topY = tip[1] + ay * L;
    const minX = Math.min(tip[0], topX) - rMax;
    const maxX = Math.max(tip[0], topX) + rMax;
    const minY = Math.min(tip[1], topY) - rMax;
    const maxY = Math.max(tip[1], topY) + rMax;
    const reach = Math.min(tip[2], tip[2] + az * L) - rMax;
    if (reach >= this.maxHeightIn(minX, minY, maxX, maxY)) return none;

    const i0 = Math.max(0, Math.floor((minX - this.origin[0]) / this.dx - 0.5));
    const i1 = Math.min(this.nx - 1, Math.ceil((maxX - this.origin[0]) / this.dx - 0.5));
    const j0 = Math.max(0, Math.floor((minY - this.origin[1]) / this.dy - 0.5));
    const j1 = Math.min(this.ny - 1, Math.ceil((maxY - this.origin[1]) / this.dy - 0.5));
    if (i0 > i1 || j0 > j1) return none;

    const lut = env.lut;
    const nLut = env.n;
    const invStep = env.invStep;
    const height = this.height;
    const cutBy = this.cutBy;
    const nx = this.nx;
    const base = this.base;
    const top = this.top;
    const tilesX = this.tilesX;
    const tileDirty = this.tileDirty;
    const flag = Math.min(255, toolIndex + 1);
    const target = opts.target || null;
    const targetMap = target ? target.map : null;
    const targetEdge = target ? target.edge : null;
    const tolerance = opts.tolerance || 0;

    const le = (r2) => {
      if (r2 >= rMax2) return Infinity;
      const x = r2 * invStep;
      const kk = x | 0;
      if (kk >= nLut) return lut[nLut];
      const a0 = lut[kk];
      const b0 = lut[kk + 1];
      return b0 === Infinity ? a0 : a0 + (b0 - a0) * (x - kk);
    };

    const C = 1 - az * az;

    // The lowest point the whole tilted solid can reach, computed once.
    // Most columns in a second pass are already below it, and rejecting
    // those on a single compare is what keeps a tilted cut affordable —
    // without it every column pays for a bracketed search.
    const sinT = Math.sqrt(C > 0 ? C : 0);
    let floorOffset = Infinity;
    for (let b = 0; b <= nLut; b++) {
      const sv = lut[b];
      if (!Number.isFinite(sv)) continue;
      const rb = Math.sqrt((b / nLut) * rMax2);
      const zb = sv * az - rb * sinT;
      if (zb < floorOffset) floorOffset = zb;
    }
    const zFloor = tip[2] + floorOffset;

    let removed = 0;
    let touched = false;
    let ti0 = 0, tj0 = 0, ti1 = 0, tj1 = 0;
    let gouge = null;

    for (let j = j0; j <= j1; j++) {
      const py = this.origin[1] + (j + 0.5) * this.dy;
      const dy0 = py - tip[1];
      const row = j * nx;
      const tileRow = ((j / TILE) | 0) * tilesX;

      for (let i = i0; i <= i1; i++) {
        const px = this.origin[0] + (i + 0.5) * this.dx;
        const dx0 = px - tip[0];

        const k = dx0 * ax + dy0 * ay;
        const P = dx0 * dx0 + dy0 * dy0;
        const A = P - k * k;
        const B = -2 * k * az;

        // Where can the tool reach this column at all?
        let uLo;
        let uHi;
        if (C > 1e-12) {
          const disc = B * B - 4 * C * (A - rMax2);
          if (disc <= 0) continue;
          const sq = Math.sqrt(disc);
          uLo = (-B - sq) / (2 * C);
          uHi = (-B + sq) / (2 * C);
        } else {
          if (A >= rMax2) continue;              // upright and outside the disc
          uLo = -1e6;
          uHi = 1e6;
        }

        // Clip to the flute band along the tool axis.
        if (Math.abs(az) > 1e-9) {
          const a1 = (0 - k) / az;
          const a2 = (L - k) / az;
          const bLo = Math.min(a1, a2);
          const bHi = Math.max(a1, a2);
          if (bLo > uLo) uLo = bLo;
          if (bHi < uHi) uHi = bHi;
        } else if (k < 0 || k > L) {
          continue;                              // tool lies flat, column off the band
        }
        if (uLo > uHi) continue;

        const cell = row + i;
        const h = height[cell];
        if (h <= zFloor) continue;               // below anything the tool can reach
        if (h <= tip[2] + uLo) continue;         // below anything reachable here

        const g = (u) => {
          const r2 = A + B * u + C * u * u;
          const sv = k + u * az;
          return sv - le(r2 < 0 ? 0 : r2);
        };

        // Deepest penetration first: g is quasi-concave on the bracket.
        let lo = uLo;
        let hi = uHi;
        const R = 0.6180339887498949;
        let x1 = hi - R * (hi - lo);
        let x2 = lo + R * (hi - lo);
        let f1 = g(x1);
        let f2 = g(x2);
        for (let it = 0; it < 14; it++) {
          if (f1 > f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - R * (hi - lo); f1 = g(x1); }
          else { lo = x1; x1 = x2; f1 = f2; x2 = lo + R * (hi - lo); f2 = g(x2); }
        }
        const uPeak = f1 > f2 ? x1 : x2;
        if (Math.max(f1, f2) < 0) continue;      // the line misses the cutter

        // A tilted tool can sit entirely below the surface without having
        // touched it — the overhanging side of the cutter passes under
        // standing material. A heightmap cannot hold that undercut, but it
        // must not pretend the material was removed either. Since the solid
        // meets this column in a single interval, the tool reaches the
        // surface unless the surface is past the peak and outside it, which
        // is one more evaluation rather than a second bisection.
        const hU = h - tip[2];
        if (hU > uHi) continue;
        if (hU > uPeak && g(hU) < 0) continue;

        // Then the lower crossing, which is the surface the tool leaves.
        let a = uLo;
        let b = uPeak;
        if (g(a) >= 0) b = a;                    // already inside at the bracket end
        else {
          for (let it = 0; it < 20; it++) {
            const mid = (a + b) * 0.5;
            if (g(mid) >= 0) b = mid; else a = mid;
          }
        }
        const zt = tip[2] + b;

        if (h - zt <= MIN_CUT) continue;

        const cut = (h < top ? h : top) - (zt > base ? zt : base);
        if (cut > 0) removed += cut;
        height[cell] = zt < base ? base : zt;
        cutBy[cell] = flag;

        if (targetMap !== null && targetEdge[cell] === 0) {
          const want = targetMap[cell];
          if (want > -Infinity) {
            const depth = want - height[cell];
            if (depth > tolerance && (gouge === null || depth > gouge.depth)) {
              gouge = { depth, x: px, y: py, z: height[cell] };
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
    const volume = removed * this.dx * this.dy;
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

  /**
   * Probe a sphere chain hung on the tool axis against the stock.
   *
   * probeBody asks the same question of an upright tool and asks it faster,
   * but it can only ask it about an upright one: an envelope is a profile
   * measured up the tool axis, so probing it at a tip position takes that
   * axis to be world Z. The moment the rotaries move it is not, and the
   * body has to be carried along the axis it actually stands on. A chain of
   * spheres can be carried like that, and encloses the solid it was sampled
   * from, so what it reports is a crash on the machine.
   *
   * @param {Float32Array} spheres [z0,r0, z1,r1, ...] in tool-local mm
   * @param {number[]} tip world position of the tool tip
   * @param {number[]} dir unit vector pointing up the tool from the tip
   * @returns {null|{x:number, y:number, z:number, depth:number}}
   */
  probeChain(spheres, tip, dir) {
    if (!spheres || !spheres.length) return null;
    // A collision worth reporting is never a quarter of a millimetre
    // across, so the survivors are sampled on a physical spacing rather
    // than per column — the same bargain probeBody makes.
    const stride = Math.max(1, Math.round(0.25 / this.cell));
    const ax = dir[0], ay = dir[1], az = dir[2];
    let worst = null;
    let prevLz = spheres[0];

    for (let s = 0; s < spheres.length; s += 2) {
      const r = spheres[s + 1];
      const lz = spheres[s];
      // Each ball answers only for its own slice of the tool. A ball hangs
      // half its diameter below the end of the solid it stands for, so the
      // nose of a Ø90 spindle would otherwise report a crash 45 mm before
      // it touched anything; below its slice, the body ends in a face, and
      // that face is where the underside is.
      const bandLo = s === 0 ? lz : (prevLz + lz) * 0.5;
      prevLz = lz;
      if (r <= 0) continue;
      const cx = tip[0] + dir[0] * lz;
      const cy = tip[1] + dir[1] * lz;
      const cz = tip[2] + dir[2] * lz;

      // One pyramid lookup clears a sphere that is nowhere near material,
      // which is most of them for most of the program.
      if (cz - r >= this.maxHeightIn(cx - r, cy - r, cx + r, cy + r)) continue;

      const i0 = Math.max(0, Math.floor((cx - r - this.origin[0]) / this.dx - 0.5));
      const i1 = Math.min(this.nx - 1, Math.ceil((cx + r - this.origin[0]) / this.dx - 0.5));
      const j0 = Math.max(0, Math.floor((cy - r - this.origin[1]) / this.dy - 0.5));
      const j1 = Math.min(this.ny - 1, Math.ceil((cy + r - this.origin[1]) / this.dy - 0.5));
      if (i0 > i1 || j0 > j1) continue;
      const r2 = r * r;

      // Where this column's vertical line crosses the plane that closes the
      // slice off at the bottom. Sideways on, there is no such crossing and
      // the ball stands unclipped, which errs towards reporting.
      const cut = Math.abs(az) > 1e-6;

      for (let j = j0; j <= j1; j += stride) {
        const wy = this.origin[1] + (j + 0.5) * this.dy;
        const py = wy - cy;
        const py2 = py * py;
        if (py2 >= r2) continue;
        const row = j * this.nx;
        const qy = (wy - tip[1]) * ay;
        for (let i = i0; i <= i1; i += stride) {
          const wx = this.origin[0] + (i + 0.5) * this.dx;
          const px = wx - cx;
          const d2 = px * px + py2;
          if (d2 >= r2) continue;
          const h = this.height[row + i];
          if (h <= this.base) continue;
          let zb = cz - Math.sqrt(r2 - d2);         // the ball's underside here
          if (cut) {
            const face = tip[2] + (bandLo - ((wx - tip[0]) * ax + qy)) / az;
            if (face > zb) zb = face;
          }
          const depth = h - zb;
          if (depth > 0 && (!worst || depth > worst.depth)) worst = { x: wx, y: wy, z: zb, depth };
        }
      }
    }
    return worst;
  }

  /** Height of the material at a world XY point, or the base when outside. */
  /**
   * Snap candidates on the nominal stock block: corners, edge midpoints and
   * face centres. These are what people actually reach for when setting a
   * work offset, so they are offered independently of the machined surface.
   */
  snapPoints() {
    // The corners of a block are real. The corners of the box around a
    // round bar are in mid-air, so a shaped stock only offers the middle of
    // its faces and its own top.
    if (this.shaped) {
      const cx = this.origin[0] + this.size[0] / 2;
      const cy = this.origin[1] + this.size[1] / 2;
      return [
        { point: [cx, cy, this.top], kind: 'centre' },
        { point: [cx, cy, this.base], kind: 'centre' },
      ];
    }
    const x = [this.origin[0], this.origin[0] + this.size[0] / 2, this.origin[0] + this.size[0]];
    const y = [this.origin[1], this.origin[1] + this.size[1] / 2, this.origin[1] + this.size[1]];
    const z = [this.base, (this.base + this.top) / 2, this.top];
    const out = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          const edges = (i === 1 ? 1 : 0) + (j === 1 ? 1 : 0) + (k === 1 ? 1 : 0);
          if (edges === 3) continue;                       // the block centre
          const kind = edges === 0 ? 'corner' : edges === 1 ? 'edge' : 'face';
          out.push({ point: [x[i], y[j], z[k]], kind });
        }
      }
    }
    return out;
  }

  /**
   * The rim of the nearest step in the surface.
   *
   * The wall of a bore or a pocket is one column wide in a heightmap, so a
   * raw surface hit on it lands anywhere between the floor and the top —
   * which is no good for measuring a hole. What anybody actually points at
   * is the rim: the top edge where the wall meets the face above it. This
   * finds the biggest height step within a few columns of the cursor and
   * returns the point at the top of it.
   *
   * @param {number} x world mm
   * @param {number} y world mm
   * @param {number} [cells] how far to look, in columns
   * @returns {null | {point:[number,number,number], drop:number}}
   */
  rimNear(x, y, cells = 6) {
    const ci = Math.floor((x - this.origin[0]) / this.dx);
    const cj = Math.floor((y - this.origin[1]) / this.dy);
    if (ci < 0 || cj < 0 || ci >= this.nx || cj >= this.ny) return null;

    // A step worth snapping to is taller than the grid is coarse; anything
    // smaller is the staircase of a slope, not an edge.
    const least = Math.max(this.cell * 2, 0.05);
    let best = null;
    const i0 = Math.max(1, ci - cells);
    const i1 = Math.min(this.nx - 2, ci + cells);
    const j0 = Math.max(1, cj - cells);
    const j1 = Math.min(this.ny - 2, cj + cells);

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        const h = this.height[k];
        if (h <= this.base) continue;
        const drops = [h - this.height[k - 1], h - this.height[k + 1],
          h - this.height[k - this.nx], h - this.height[k + this.nx]];
        let side = 0;
        for (let n = 1; n < 4; n++) if (drops[n] > drops[side]) side = n;
        const drop = drops[side];
        if (drop < least) continue;
        // The edge is the boundary between this column and the one that
        // falls away, not the middle of either, so the point lands half a
        // cell over — which is the difference between a bore measuring its
        // own diameter and measuring it a cell wide.
        const px = this.cx(i) + (side === 0 ? -this.dx / 2 : side === 1 ? this.dx / 2 : 0);
        const py = this.cy(j) + (side === 2 ? -this.dy / 2 : side === 3 ? this.dy / 2 : 0);
        // Nearest to the cursor wins, so the rim under the pointer is the
        // one that snaps rather than the deepest step in the window.
        const d = Math.hypot(px - x, py - y);
        if (!best || d < best.d) best = { d, point: [px, py, h], drop };
      }
    }
    return best ? { point: best.point, drop: best.drop } : null;
  }

  /**
   * Cast a ray at the machined surface.
   *
   * The rendered stock is displaced on the GPU, so the CPU-side geometry a
   * normal raycaster would hit is flat and useless for picking. This walks
   * the ray through the heightmap instead, which gives the surface the user
   * can actually see — including the floor of a pocket.
   *
   * @param {[number,number,number]} origin ray origin, world mm
   * @param {[number,number,number]} dir    normalised direction
   * @returns {null | {point:[number,number,number], distance:number, face:string}}
   */
  raycast(origin, dir) {
    const min = [this.origin[0], this.origin[1], this.base];
    const max = [this.origin[0] + this.size[0], this.origin[1] + this.size[1], this.top];

    // Clip to the stock's bounding box first.
    let t0 = 0;
    let t1 = Infinity;
    let entryAxis = -1;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-12) {
        if (origin[a] < min[a] || origin[a] > max[a]) return null;
        continue;
      }
      const inv = 1 / dir[a];
      let near = (min[a] - origin[a]) * inv;
      let far = (max[a] - origin[a]) * inv;
      if (near > far) { const t = near; near = far; far = t; }
      if (near > t0) { t0 = near; entryAxis = a; }
      if (far < t1) t1 = far;
      if (t0 > t1) return null;
    }
    if (t1 < 0) return null;
    t0 = Math.max(t0, 0);

    const at = (t) => [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    const below = (p) => {
      const h = this.heightAt(p[0], p[1]);
      // A column with nothing in it — outside a round bar, or cut clean
      // through — is air. Without this the ray lands on a floor that is
      // not there and "click the stock" points into space.
      return Number.isFinite(h) && h > this.base && p[2] <= h;
    };

    // Entering already inside the material: the entry face is the hit.
    const entry = at(t0);
    if (below(entry)) {
      const face = entryAxis < 0 ? 'surface' : ['x', 'y', 'z'][entryAxis];
      return { point: entry, distance: t0, face };
    }

    // March in steps smaller than a column, then bisect the crossing.
    const step = Math.max(this.cell * 0.6, 1e-3);
    let prev = t0;
    for (let t = t0 + step; t <= t1 + step; t += step) {
      const tc = Math.min(t, t1);
      if (below(at(tc))) {
        let lo = prev;
        let hi = tc;
        for (let k = 0; k < 24; k++) {
          const mid = (lo + hi) * 0.5;
          if (below(at(mid))) hi = mid; else lo = mid;
        }
        return { point: at(hi), distance: hi, face: 'surface' };
      }
      if (tc >= t1) break;
      prev = tc;
    }
    return null;
  }

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
      filled: this.filled,
      volume: this.stockVolume,
    };
  }
}
