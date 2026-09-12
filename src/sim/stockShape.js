// What shape the stock starts as.
//
// The simulation is a field of vertical columns, so a shape is nothing more
// than a function: given a point on the XY grid, how high does the material
// start there, or is there no material at all? A rectangular block answers
// "the top, everywhere"; a bar answers "the top, inside the circle"; a
// casting answers with its own upper surface, read off the model.
//
// That is the whole extension point. Everything downstream — cutting,
// collision, volume, the rendered surface — already works column by column
// and needs to know nothing about which of the three it is looking at.

/** A round bar: the circle inscribed in the stock's own footprint. */
export function cylinderColumn({ centre, radius, top }) {
  const r2 = radius * radius;
  return (x, y) => {
    const dx = x - centre[0];
    const dy = y - centre[1];
    return dx * dx + dy * dy <= r2 ? top : null;
  };
}

/**
 * The upper surface of a mesh, as a function of x and y.
 *
 * Triangles are bucketed by their XY extent once, so a lookup only tests
 * the few that could cover the point. The answer is the highest triangle
 * over that point, which is the top surface of whatever was imported —
 * and, like everything else in this model, it cannot represent an
 * overhang: what hides under the top surface is solid.
 *
 * @param {Float32Array} positions flat xyz triples, millimetres
 * @param {{buckets?:number}} [opts]
 */
export function meshColumn(positions, opts = {}) {
  const count = Math.floor(positions.length / 9);
  if (!count) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const n = Math.max(1, Math.min(opts.buckets || Math.ceil(Math.sqrt(count / 2)), 256));
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const buckets = Array.from({ length: n * n }, () => []);
  const at = (x, y) => {
    const bi = Math.min(n - 1, Math.max(0, Math.floor(((x - minX) / spanX) * n)));
    const bj = Math.min(n - 1, Math.max(0, Math.floor(((y - minY) / spanY) * n)));
    return bj * n + bi;
  };

  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1];
    const bx = positions[o + 3], by = positions[o + 4];
    const cx = positions[o + 6], cy = positions[o + 7];
    // A triangle standing on edge projects to a line and can never be the
    // top of a column, so it is left out of the buckets entirely.
    const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area2) < 1e-12) continue;
    const i0 = at(Math.min(ax, bx, cx), Math.min(ay, by, cy));
    const i1 = at(Math.max(ax, bx, cx), Math.max(ay, by, cy));
    const bi0 = i0 % n, bj0 = (i0 - bi0) / n;
    const bi1 = i1 % n, bj1 = (i1 - bi1) / n;
    for (let bj = bj0; bj <= bj1; bj++) {
      for (let bi = bi0; bi <= bi1; bi++) buckets[bj * n + bi].push(o);
    }
  }

  const column = (x, y) => {
    const list = buckets[at(x, y)];
    let best = null;
    for (let k = 0; k < list.length; k++) {
      const o = list[k];
      const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
      const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
      const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
      // Barycentric, in the plan view.
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      const w = 1 - u - v;
      if (w < -1e-9) continue;
      const z = u * az + v * bz + w * cz;
      if (best === null || z > best) best = z;
    }
    return best;
  };

  column.bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  column.triangles = count;
  return column;
}

/**
 * Build the sampler a Stock wants from the description the UI holds.
 *
 * @param {{shape?:string, origin:number[], size:number[],
 *          diameter?:number, model?:{positions:Float32Array}}} spec
 * @returns {null | ((x:number, y:number) => number|null)}
 *   null means "a plain rectangular block", which needs no sampler at all.
 */
export function columnFor(spec) {
  const kind = spec.shape || 'box';
  const top = spec.origin[2] + spec.size[2];

  if (kind === 'round') {
    const radius = Math.max((spec.diameter ?? Math.min(spec.size[0], spec.size[1])) / 2, 0.05);
    return cylinderColumn({
      centre: [spec.origin[0] + spec.size[0] / 2, spec.origin[1] + spec.size[1] / 2],
      radius,
      top,
    });
  }

  if (kind === 'model' && spec.model && spec.model.positions) {
    const sample = meshColumn(spec.model.positions);
    if (!sample) return null;
    // The model is sampled in its own frame; the stock's origin says where
    // that frame has been put, so moving the stock moves the shape with it.
    const b = sample.bounds;
    const ox = spec.origin[0] - b.min[0];
    const oy = spec.origin[1] - b.min[1];
    const oz = spec.origin[2] - b.min[2];
    const fn = (x, y) => {
      const z = sample(x - ox, y - oy);
      return z === null ? null : z + oz;
    };
    fn.bounds = b;
    fn.triangles = sample.triangles;
    return fn;
  }

  return null;
}

/** What to call this shape in the interface. */
export function describeShape(spec) {
  if (spec.shape === 'round') return `Ø${spec.diameter ?? Math.min(spec.size[0], spec.size[1])} bar`;
  if (spec.shape === 'model') return spec.model ? `${spec.model.name}` : 'model';
  return 'rectangular block';
}
