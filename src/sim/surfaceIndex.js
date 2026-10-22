// The reference part's triangles, indexed for "how far is the nearest
// surface from here".
//
// Measuring a cut against a finished part straight down is only right on a
// flat floor: on a 45° face it reads 41 % too much, and at a wall it reads
// the wall's whole height for what is really a few hundredths sideways. The
// distance that means something is the shortest one, along the surface
// normal, and finding it is a nearest-triangle search. This makes that
// search cheap enough to run on every column the cutter touches: triangles
// are bucketed on an XY grid, a query only opens the buckets within its
// radius, and the radius is always small — the vertical gap is an upper
// bound on the true one, and beyond the colour scale the exact figure is
// not needed.

/**
 * @param {Array<{positions:ArrayLike<number>}>} parts triangle soups in the
 *   stock's frame
 * @param {number} [cell] bucket size, mm
 * @returns {null | object} an index for nearestWithin
 */
export function buildSurfaceIndex(parts, cell = 2) {
  let count = 0;
  for (const p of parts || []) count += Math.floor(p.positions.length / 9);
  if (!count) return null;

  const tris = new Float64Array(count * 9);
  const box = new Float64Array(count * 6);   // minX minY minZ maxX maxY maxZ
  let t = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) {
    const a = p.positions;
    for (let o = 0; o + 8 < a.length; o += 9, t++) {
      for (let k = 0; k < 9; k++) tris[t * 9 + k] = a[o + k];
      const x0 = Math.min(a[o], a[o + 3], a[o + 6]), x1 = Math.max(a[o], a[o + 3], a[o + 6]);
      const y0 = Math.min(a[o + 1], a[o + 4], a[o + 7]), y1 = Math.max(a[o + 1], a[o + 4], a[o + 7]);
      const z0 = Math.min(a[o + 2], a[o + 5], a[o + 8]), z1 = Math.max(a[o + 2], a[o + 5], a[o + 8]);
      box[t * 6] = x0; box[t * 6 + 1] = y0; box[t * 6 + 2] = z0;
      box[t * 6 + 3] = x1; box[t * 6 + 4] = y1; box[t * 6 + 5] = z1;
      if (x0 < minX) minX = x0; if (x1 > maxX) maxX = x1;
      if (y0 < minY) minY = y0; if (y1 > maxY) maxY = y1;
    }
  }

  // A grid no more than about a thousand buckets a side: a two-metre part
  // at 2 mm buckets is that already, and finer would only cost memory.
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const size = Math.max(cell, span / 1024);
  const gx = Math.max(1, Math.ceil((maxX - minX) / size) + 1);
  const gy = Math.max(1, Math.ceil((maxY - minY) / size) + 1);
  const cellOf = (v, lo, n) => Math.min(n - 1, Math.max(0, Math.floor((v - lo) / size)));

  // A triangle that would sit in a great many buckets — the big flat faces
  // a CAD export is made of — is kept on a short list everyone checks
  // instead, behind its bounding box.
  const BIG = 256;
  const big = [];
  const counts = new Uint32Array(gx * gy + 1);
  for (let i = 0; i < count; i++) {
    const i0 = cellOf(box[i * 6], minX, gx), i1 = cellOf(box[i * 6 + 3], minX, gx);
    const j0 = cellOf(box[i * 6 + 1], minY, gy), j1 = cellOf(box[i * 6 + 4], minY, gy);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > BIG) { big.push(i); continue; }
    for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) counts[j * gx + k + 1]++;
  }
  for (let c = 1; c <= gx * gy; c++) counts[c] += counts[c - 1];
  const items = new Uint32Array(counts[gx * gy]);
  const fill = counts.slice(0, gx * gy);
  const bigSet = new Uint8Array(count);
  for (const i of big) bigSet[i] = 1;
  for (let i = 0; i < count; i++) {
    if (bigSet[i]) continue;
    const i0 = cellOf(box[i * 6], minX, gx), i1 = cellOf(box[i * 6 + 3], minX, gx);
    const j0 = cellOf(box[i * 6 + 1], minY, gy), j1 = cellOf(box[i * 6 + 4], minY, gy);
    for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) items[fill[j * gx + k]++] = i;
  }

  return {
    tris, box, count, minX, minY, size, gx, gy, starts: counts, items,
    big: Uint32Array.from(big),
    /** Which query last looked at each triangle, so a shared one is measured once. */
    seen: new Uint32Array(count),
    stamp: 0,
  };
}

/**
 * Squared distance from a point to a triangle (Ericson, Real-Time Collision
 * Detection, 5.1.5: the closest point by Voronoi region).
 */
function pointTriangle2(px, py, pz, t, o) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
  const cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w;
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Distance from a point to the nearest reference surface, if there is one
 * within `r`; Infinity otherwise.
 */
export function nearestWithin(index, px, py, pz, r) {
  if (!index || !(r > 0)) return Infinity;
  let best2 = r * r;
  let found = false;
  const { tris, box, size, gx, gy, minX, minY, starts, items, big, seen } = index;
  const stamp = ++index.stamp;
  if (stamp === 0xffffffff) { seen.fill(0); index.stamp = 1; }

  const test = (i) => {
    if (seen[i] === index.stamp) return;
    seen[i] = index.stamp;
    const b = i * 6;
    // Nearest the triangle's box can be; a box further than the best so
    // far cannot hold anything better.
    const ox = px < box[b] ? box[b] - px : px > box[b + 3] ? px - box[b + 3] : 0;
    const oy = py < box[b + 1] ? box[b + 1] - py : py > box[b + 4] ? py - box[b + 4] : 0;
    const oz = pz < box[b + 2] ? box[b + 2] - pz : pz > box[b + 5] ? pz - box[b + 5] : 0;
    if (ox * ox + oy * oy + oz * oz >= best2) return;
    const d2 = pointTriangle2(px, py, pz, tris, i * 9);
    if (d2 < best2) { best2 = d2; found = true; }
  };

  for (let n = 0; n < big.length; n++) test(big[n]);
  const i0 = Math.max(0, Math.floor((px - r - minX) / size));
  const i1 = Math.min(gx - 1, Math.floor((px + r - minX) / size));
  const j0 = Math.max(0, Math.floor((py - r - minY) / size));
  const j1 = Math.min(gy - 1, Math.floor((py + r - minY) / size));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * gx + i;
      for (let n = starts[c]; n < starts[c + 1]; n++) test(items[n]);
    }
  }
  return found ? Math.sqrt(best2) : Infinity;
}
