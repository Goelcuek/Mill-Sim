// The reference part, projected onto the stock grid.
//
// A reference model is the shape the finished part should be. Comparing
// against it is what turns "the cutter went somewhere" into "the cutter
// went somewhere it must not": cut below the reference surface and you have
// gouged the part; leave material above it and you have stock still to
// remove.
//
// The comparison lives on the stock's own grid so the check costs one array
// read inside the carving loop that is running anyway. Building it is a
// plain z-buffer rasterisation of every reference triangle, keeping the
// highest surface over each column — the same top-down view the 3-axis
// cutting model works in.

/**
 * Rasterise reference triangles into a target heightmap.
 *
 * @param {import('./stock.js').Stock} stock
 * @param {Array<{positions:Float32Array}>} parts world-space triangle soups
 * @returns {null | Float32Array} height per column, -Infinity where the
 *   reference part does not cover the stock at all
 */
export function buildTargetMap(stock, parts) {
  if (!stock || !parts || !parts.length) return null;

  const nx = stock.nx;
  const ny = stock.ny;
  const map = new Float32Array(nx * ny).fill(-Infinity);
  const ox = stock.origin[0];
  const oy = stock.origin[1];
  const dx = stock.dx;
  const dy = stock.dy;
  let covered = 0;

  for (const part of parts) {
    const p = part.positions;
    for (let t = 0; t < p.length; t += 9) {
      const ax = p[t], ay = p[t + 1], az = p[t + 2];
      const bx = p[t + 3], by = p[t + 4], bz = p[t + 5];
      const cx = p[t + 6], cy = p[t + 7], cz = p[t + 8];

      // Column range this triangle can possibly touch.
      const minX = Math.min(ax, bx, cx);
      const maxX = Math.max(ax, bx, cx);
      const minY = Math.min(ay, by, cy);
      const maxY = Math.max(ay, by, cy);

      let i0 = Math.ceil((minX - ox) / dx - 0.5);
      let i1 = Math.floor((maxX - ox) / dx - 0.5);
      let j0 = Math.ceil((minY - oy) / dy - 0.5);
      let j1 = Math.floor((maxY - oy) / dy - 0.5);
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (i1 > nx - 1) i1 = nx - 1;
      if (j1 > ny - 1) j1 = ny - 1;
      if (i0 > i1 || j0 > j1) continue;

      // Barycentric setup in XY. A degenerate (edge-on) triangle contributes
      // nothing from above, so it is skipped rather than divided by zero.
      const v0x = bx - ax, v0y = by - ay;
      const v1x = cx - ax, v1y = cy - ay;
      const den = v0x * v1y - v1x * v0y;
      if (Math.abs(den) < 1e-12) continue;
      const invDen = 1 / den;

      for (let j = j0; j <= j1; j++) {
        const py = oy + (j + 0.5) * dy;
        const qy = py - ay;
        const row = j * nx;
        for (let i = i0; i <= i1; i++) {
          const px = ox + (i + 0.5) * dx;
          const qx = px - ax;

          const u = (qx * v1y - v1x * qy) * invDen;
          if (u < 0 || u > 1) continue;
          const v = (v0x * qy - qx * v0y) * invDen;
          if (v < 0 || u + v > 1) continue;

          const z = az + u * (bz - az) + v * (cz - az);
          const k = row + i;
          if (z > map[k]) {
            if (map[k] === -Infinity) covered++;
            map[k] = z;
          }
        }
      }
    }
  }

  return covered ? map : null;
}

/**
 * Compare the cut stock against the reference surface.
 *
 * @param {import('./stock.js').Stock} stock
 * @param {Float32Array} target
 * @param {number} tolerance mm the cut may pass the surface before it counts
 * @returns {{gougeCells:number, maxGouge:number, excessCells:number,
 *            maxExcess:number, comparedCells:number, gougeAt:number[]|null}}
 */
export function compareToTarget(stock, target, tolerance = 0.02) {
  const out = {
    gougeCells: 0, maxGouge: 0, excessCells: 0, maxExcess: 0,
    comparedCells: 0, gougeAt: null,
  };
  if (!target) return out;

  const h = stock.height;
  for (let j = 0; j < stock.ny; j++) {
    const row = j * stock.nx;
    for (let i = 0; i < stock.nx; i++) {
      const k = row + i;
      const want = target[k];
      if (want === -Infinity) continue;
      out.comparedCells++;
      const d = want - h[k];
      if (d > tolerance) {
        out.gougeCells++;
        if (d > out.maxGouge) {
          out.maxGouge = d;
          out.gougeAt = [stock.cx(i), stock.cy(j), h[k]];
        }
      } else if (-d > tolerance) {
        out.excessCells++;
        if (-d > out.maxExcess) out.maxExcess = -d;
      }
    }
  }
  return out;
}
