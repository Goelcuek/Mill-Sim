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
    const maxCells = opts.maxCells || 4_500_000;

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
        if (h > zt) {
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
   * Test the non-cutting body of an assembly against remaining material.
   *
   * @returns {null | {x:number, y:number, z:number, depth:number}}
   *   the worst offending column, or null when clear.
   */
  probeBody(env, x, y, z) {
    if (env.isEmpty) return null;
    const rMax = env.rMax;
    if (z + env.zMin >= this.maxHeightIn(x - rMax, y - rMax, x + rMax, y + rMax)) return null;

    const i0 = Math.max(0, Math.floor((x - rMax - this.origin[0]) / this.dx - 0.5));
    const i1 = Math.min(this.nx - 1, Math.ceil((x + rMax - this.origin[0]) / this.dx - 0.5));
    const j0 = Math.max(0, Math.floor((y - rMax - this.origin[1]) / this.dy - 0.5));
    const j1 = Math.min(this.ny - 1, Math.ceil((y + rMax - this.origin[1]) / this.dy - 0.5));
    const rMax2 = env.rMax2;

    let worst = null;
    for (let j = j0; j <= j1; j++) {
      const wy = this.origin[1] + (j + 0.5) * this.dy;
      const py = wy - y;
      const py2 = py * py;
      if (py2 > rMax2) continue;
      const row = j * this.nx;
      for (let i = i0; i <= i1; i++) {
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
