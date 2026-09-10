// Turning simulation data into real triangles.
//
// The viewport draws the stock as a GPU-displaced grid, which is fast but
// exists only on the graphics card. Exporting the finished part needs
// actual geometry, so the heightmap is triangulated here: top surface,
// four side walls and a bottom, giving a closed solid.

/**
 * Triangulate a stock heightmap into a watertight mesh.
 *
 * @param {import('../sim/stock.js').Stock} stock
 * @param {{decimate?:number}} [opts] keep every Nth column (1 = full detail)
 * @returns {{positions:Float32Array, triangles:number}}
 */
export function heightmapToTriangles(stock, opts = {}) {
  const step = Math.max(1, Math.floor(opts.decimate || 1));
  const nx = stock.nx;
  const ny = stock.ny;

  // Sample indices along each axis, always including the last column so the
  // exported part keeps its true outer dimensions.
  const xs = [];
  for (let i = 0; i < nx; i += step) xs.push(i);
  if (xs[xs.length - 1] !== nx - 1) xs.push(nx - 1);
  const ys = [];
  for (let j = 0; j < ny; j += step) ys.push(j);
  if (ys[ys.length - 1] !== ny - 1) ys.push(ny - 1);

  const gw = xs.length;
  const gh = ys.length;
  const h = (gi, gj) => stock.height[ys[gj] * nx + xs[gi]];
  // Snap the outer ring to the true stock boundary rather than cell centres.
  const px = (gi) => (gi === 0 ? stock.origin[0] : gi === gw - 1 ? stock.origin[0] + stock.size[0] : stock.cx(xs[gi]));
  const py = (gj) => (gj === 0 ? stock.origin[1] : gj === gh - 1 ? stock.origin[1] + stock.size[1] : stock.cy(ys[gj]));

  const quadCount = (gw - 1) * (gh - 1) + (gw - 1) * 2 + (gh - 1) * 2 + 1;
  const positions = new Float32Array(quadCount * 6 * 3);
  let o = 0;
  const put = (x, y, z) => {
    positions[o++] = x;
    positions[o++] = y;
    positions[o++] = z;
  };
  const quad = (a, b, c, d) => {
    put(a[0], a[1], a[2]); put(b[0], b[1], b[2]); put(c[0], c[1], c[2]);
    put(a[0], a[1], a[2]); put(c[0], c[1], c[2]); put(d[0], d[1], d[2]);
  };
  /** Same quad wound the other way, so side walls face outwards. */
  const quadOut = (a, b, c, d) => quad(d, c, b, a);

  // Top surface, wound counter-clockwise seen from +Z.
  for (let gj = 0; gj < gh - 1; gj++) {
    for (let gi = 0; gi < gw - 1; gi++) {
      const x0 = px(gi), x1 = px(gi + 1);
      const y0 = py(gj), y1 = py(gj + 1);
      quad(
        [x0, y0, h(gi, gj)],
        [x1, y0, h(gi + 1, gj)],
        [x1, y1, h(gi + 1, gj + 1)],
        [x0, y1, h(gi, gj + 1)],
      );
    }
  }

  const base = stock.base;
  const yMin = stock.origin[1];
  const yMax = stock.origin[1] + stock.size[1];
  const xMin = stock.origin[0];
  const xMax = stock.origin[0] + stock.size[0];

  // Side walls.
  for (let gi = 0; gi < gw - 1; gi++) {
    const x0 = px(gi), x1 = px(gi + 1);
    quadOut([x0, yMin, base], [x0, yMin, h(gi, 0)], [x1, yMin, h(gi + 1, 0)], [x1, yMin, base]);
    quadOut([x1, yMax, base], [x1, yMax, h(gi + 1, gh - 1)], [x0, yMax, h(gi, gh - 1)], [x0, yMax, base]);
  }
  for (let gj = 0; gj < gh - 1; gj++) {
    const y0 = py(gj), y1 = py(gj + 1);
    quadOut([xMin, y1, base], [xMin, y1, h(0, gj + 1)], [xMin, y0, h(0, gj)], [xMin, y0, base]);
    quadOut([xMax, y0, base], [xMax, y0, h(gw - 1, gj)], [xMax, y1, h(gw - 1, gj + 1)], [xMax, y1, base]);
  }

  // Bottom, wound clockwise seen from +Z so its normal points down.
  quad([xMin, yMin, base], [xMin, yMax, base], [xMax, yMax, base], [xMax, yMin, base]);

  return { positions: positions.subarray(0, o), triangles: o / 9 };
}

/**
 * Triangulate a solid of revolution from a silhouette, for exporting tools
 * and holders as models.
 *
 * @param {Array<{r:number,z:number}>} points
 * @param {{segments?:number, transform?:(p:number[])=>number[]}} [opts]
 */
export function latheToTriangles(points, opts = {}) {
  const seg = Math.max(8, Math.min(opts.segments || 64, 256));
  const pts = points.filter((p) => Number.isFinite(p.r) && Number.isFinite(p.z));
  if (pts.length < 2) return { positions: new Float32Array(0), triangles: 0 };

  const out = [];
  const at = (p, a) => [p.r * Math.cos(a), p.r * Math.sin(a), p.z];
  const push = (v) => {
    const t = opts.transform ? opts.transform(v) : v;
    out.push(t[0], t[1], t[2]);
  };

  for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * Math.PI * 2;
    const a1 = ((s + 1) / seg) * Math.PI * 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const A = at(p, a0), B = at(p, a1), C = at(q, a1), D = at(q, a0);
      if (p.r > 1e-9) { push(A); push(B); push(C); }
      if (q.r > 1e-9) { push(A); push(C); push(D); }
    }
  }
  return { positions: Float32Array.from(out), triangles: out.length / 9 };
}

/** Triangulate an axis-aligned box, used for fixtures and the table. */
export function boxToTriangles(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const out = [];
  for (const f of faces) {
    const [a, b, c, d] = f.map((i) => v[i]);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return { positions: Float32Array.from(out), triangles: out.length / 9 };
}
