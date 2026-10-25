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
  /** Which part each triangle came from, for asking each part what is inside it. */
  const part = new Uint16Array(count);
  let t = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let pi = 0; pi < parts.length; pi++) {
    const a = parts[pi].positions;
    for (let o = 0; o + 8 < a.length; o += 9, t++) {
      part[t] = Math.min(pi, 65535);
      for (let k = 0; k < 9; k++) tris[t * 9 + k] = a[o + k];
      const x0 = Math.min(a[o], a[o + 3], a[o + 6]), x1 = Math.max(a[o], a[o + 3], a[o + 6]);
      const y0 = Math.min(a[o + 1], a[o + 4], a[o + 7]), y1 = Math.max(a[o + 1], a[o + 4], a[o + 7]);
      const z0 = Math.min(a[o + 2], a[o + 5], a[o + 8]), z1 = Math.max(a[o + 2], a[o + 5], a[o + 8]);
      box[t * 6] = x0; box[t * 6 + 1] = y0; box[t * 6 + 2] = z0;
      box[t * 6 + 3] = x1; box[t * 6 + 4] = y1; box[t * 6 + 5] = z1;
      if (x0 < minX) minX = x0; if (x1 > maxX) maxX = x1;
      if (y0 < minY) minY = y0; if (y1 > maxY) maxY = y1;
      if (z0 < minZ) minZ = z0; if (z1 > maxZ) maxZ = z1;
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
    part, partCount: parts.length,
    /** The parts' bounds, world mm: [x0, y0, z0, x1, y1, z1]. */
    bounds: [minX, minY, minZ, maxX, maxY, maxZ],
    /** Which query last looked at each triangle, so a shared one is measured once. */
    seen: new Uint32Array(count),
    stamp: 0,
  };
}

/**
 * Does every edge of a triangle soup meet another going the other way —
 * is it the closed skin of a solid, with an inside to ask about? Corners
 * are matched to a micron, which a CAD export's shared vertices meet.
 */
export function isClosed(positions) {
  const n = Math.floor(positions.length / 9);
  if (!n) return false;
  const key = (o) => `${Math.round(positions[o] * 1e3)},${Math.round(positions[o + 1] * 1e3)},${Math.round(positions[o + 2] * 1e3)}`;
  const edges = new Map();
  for (let t = 0; t < n; t++) {
    const k = [key(9 * t), key(9 * t + 3), key(9 * t + 6)];
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = k[e];
      const b = k[(e + 1) % 3];
      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(id, (edges.get(id) || 0) + (a < b ? 1 : -1));
    }
  }
  for (const v of edges.values()) if (v !== 0) return false;
  return true;
}

/**
 * Off-grid nudge for the inside test's ray. Models and lattices are full
 * of round numbers, and a ray straight through a shared edge or corner is
 * counted by both triangles or neither; moved by a few nanometres in no
 * round direction, it all but never is.
 */
const JX = 3.1415926e-6;
const JY = 2.7182818e-6;
const PARITY = new Uint8Array(65536);

/**
 * Is a point inside one of the parts? Counted straight up: a ray leaving
 * a closed solid crosses its skin an odd number of times. Each part is
 * asked on its own, so two that overlap are their union, not a hole where
 * they meet.
 */
export function insideSolid(index, x, y, z) {
  if (!index) return false;
  const px = x + JX;
  const py = y + JY;
  const { tris, box, part, partCount, seen } = index;
  for (let p = 0; p < partCount; p++) PARITY[p] = 0;
  const stamp = nextStamp(index);
  const test = (i) => {
    // A triangle sits in every cube its box touches: counted once.
    if (seen[i] === stamp) return;
    seen[i] = stamp;
    const b = i * 6;
    if (px < box[b] || px > box[b + 3] || py < box[b + 1] || py > box[b + 4] || z > box[b + 5]) return;
    const o = i * 9;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const v0x = tris[o + 3] - ax, v0y = tris[o + 4] - ay;
    const v1x = tris[o + 6] - ax, v1y = tris[o + 7] - ay;
    const den = v0x * v1y - v1x * v0y;
    if (Math.abs(den) < 1e-18) return;           // edge-on from above
    const qx = px - ax, qy = py - ay;
    const u = (qx * v1y - v1x * qy) / den;
    if (u < 0 || u > 1) return;
    const v = (v0x * qy - qx * v0y) / den;
    if (v < 0 || u + v > 1) return;
    const zt = az + u * (tris[o + 5] - az) + v * (tris[o + 8] - az);
    if (zt > z) PARITY[part[i]] ^= 1;
  };
  // Up the column of cubes over the point: only what is above it, and only
  // what is that close to its line.
  const g = grid3(index);
  for (let n = 0; n < g.big.length; n++) test(g.big[n]);
  const a = Math.floor((px - g.x0) / g.cell);
  const b = Math.floor((py - g.y0) / g.cell);
  if (a >= 0 && b >= 0 && a < g.nx && b < g.ny) {
    for (let c = Math.max(0, Math.floor((z - g.z0) / g.cell)); c < g.nz; c++) {
      const k = (c * g.ny + b) * g.nx + a;
      for (let n = g.starts[k]; n < g.starts[k + 1]; n++) test(g.items[n]);
    }
  }
  for (let p = 0; p < partCount; p++) if (PARITY[p]) return true;
  return false;
}

// ---- the same triangles in boxes, for short questions ------------------------
//
// The buckets above are columns: right for a search whose radius runs to
// centimetres, wasteful for one of a millimetre, which opens a column and
// tests every face in it — the top, the floor, the underside — to find the
// one beside the point. A deviation map asks that short question at every
// vertex of a cut surface, so the triangles are also put in small cubes,
// made the first time they are wanted.

/** Most cubes a triangle is put in before it goes on the everybody-checks list. */
const BIG3 = 64;
/** Most cubes the grid may have. */
const MAX_CELLS3 = 2000000;

function grid3(index) {
  if (index.g3) return index.g3;
  const [x0, y0, z0, x1, y1, z1] = index.bounds;
  const ex = Math.max(x1 - x0, 1e-6), ey = Math.max(y1 - y0, 1e-6), ez = Math.max(z1 - z0, 1e-6);
  const cell = Math.max(0.5, Math.cbrt((ex * ey * ez) / MAX_CELLS3));
  const nx = Math.floor(ex / cell) + 1, ny = Math.floor(ey / cell) + 1, nz = Math.floor(ez / cell) + 1;
  const { box, count } = index;
  const at = (v, lo, n) => Math.min(n - 1, Math.max(0, Math.floor((v - lo) / cell)));
  const range = (i) => [
    at(box[i * 6], x0, nx), at(box[i * 6 + 3], x0, nx),
    at(box[i * 6 + 1], y0, ny), at(box[i * 6 + 4], y0, ny),
    at(box[i * 6 + 2], z0, nz), at(box[i * 6 + 5], z0, nz),
  ];
  const starts = new Uint32Array(nx * ny * nz + 1);
  const big = [];
  const isBig = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const [a0, a1, b0, b1, c0, c1] = range(i);
    if ((a1 - a0 + 1) * (b1 - b0 + 1) * (c1 - c0 + 1) > BIG3) { big.push(i); isBig[i] = 1; continue; }
    for (let c = c0; c <= c1; c++) for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) starts[(c * ny + b) * nx + a + 1]++;
  }
  for (let k = 1; k < starts.length; k++) starts[k] += starts[k - 1];
  const items = new Uint32Array(starts[nx * ny * nz]);
  const fill = starts.slice(0, nx * ny * nz);
  for (let i = 0; i < count; i++) {
    if (isBig[i]) continue;
    const [a0, a1, b0, b1, c0, c1] = range(i);
    for (let c = c0; c <= c1; c++) for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) items[fill[(c * ny + b) * nx + a]++] = i;
  }
  index.g3 = { cell, nx, ny, nz, x0, y0, z0, starts, items, big: Uint32Array.from(big) };
  return index.g3;
}

/** A fresh mark for the triangles one query has looked at. */
function nextStamp(index) {
  const stamp = ++index.stamp;
  if (stamp === 0xffffffff) { index.seen.fill(0); index.stamp = 1; }
  return index.stamp;
}

/**
 * Nearest surface within a short radius, by cube: the point's own cube
 * first, then only those cubes nearer than the best found so far — which,
 * for a point on or next to the surface, is very few.
 */
function nearest3(index, px, py, pz, r) {
  const g = grid3(index);
  const { tris, box, seen } = index;
  const stamp = nextStamp(index);
  let best2 = r * r;
  let found = false;
  const test = (i) => {
    if (seen[i] === stamp) return;
    seen[i] = stamp;
    const b = i * 6;
    const ox = px < box[b] ? box[b] - px : px > box[b + 3] ? px - box[b + 3] : 0;
    const oy = py < box[b + 1] ? box[b + 1] - py : py > box[b + 4] ? py - box[b + 4] : 0;
    const oz = pz < box[b + 2] ? box[b + 2] - pz : pz > box[b + 5] ? pz - box[b + 5] : 0;
    if (ox * ox + oy * oy + oz * oz >= best2) return;
    const d2 = pointTriangle2(px, py, pz, tris, i * 9);
    if (d2 < best2) { best2 = d2; found = true; }
  };
  const { cell, nx, ny, nz, x0, y0, z0, starts, items, big } = g;
  const cellAt = (v, lo, n) => Math.floor((v - lo) / cell);
  const ca = cellAt(px, x0), cb = cellAt(py, y0), cc = cellAt(pz, z0);
  const visit = (a, b, c) => {
    const k = (c * ny + b) * nx + a;
    for (let n = starts[k]; n < starts[k + 1]; n++) test(items[n]);
  };
  if (ca >= 0 && cb >= 0 && cc >= 0 && ca < nx && cb < ny && cc < nz) visit(ca, cb, cc);
  for (let n = 0; n < big.length; n++) test(big[n]);
  const a0 = Math.max(0, cellAt(px - r, x0)), a1 = Math.min(nx - 1, cellAt(px + r, x0));
  const b0 = Math.max(0, cellAt(py - r, y0)), b1 = Math.min(ny - 1, cellAt(py + r, y0));
  const c0 = Math.max(0, cellAt(pz - r, z0)), c1 = Math.min(nz - 1, cellAt(pz + r, z0));
  for (let c = c0; c <= c1; c++) {
    const lz = z0 + c * cell;
    const dz = pz < lz ? lz - pz : pz > lz + cell ? pz - lz - cell : 0;
    if (dz * dz >= best2) continue;
    for (let b = b0; b <= b1; b++) {
      const ly = y0 + b * cell;
      const dy = py < ly ? ly - py : py > ly + cell ? py - ly - cell : 0;
      if (dz * dz + dy * dy >= best2) continue;
      for (let a = a0; a <= a1; a++) {
        if (a === ca && b === cb && c === cc) continue;
        const lx = x0 + a * cell;
        const dx = px < lx ? lx - px : px > lx + cell ? px - lx - cell : 0;
        if (dx * dx + dy * dy + dz * dz >= best2) continue;
        visit(a, b, c);
      }
    }
  }
  return found ? Math.sqrt(best2) : Infinity;
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
  // A short reach is answered from the cubes; a long one from the columns,
  // where the cubes it would open run to the hundreds of thousands.
  if (r <= 4 * grid3(index).cell) return nearest3(index, px, py, pz, r);
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
