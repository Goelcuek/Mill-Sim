// Feature edges of a triangle mesh, without three.js.
//
// Kept apart from the outline drawing so it can be tested on its own: it
// takes numbers and gives numbers back. See scene/outlines.js for why it
// exists rather than three's EdgesGeometry.

/** Faces meeting at more than this many degrees have an edge between them. */
export const OUTLINE_ANGLE = 35;

const nextPow2 = (n) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/**
 * The feature edges of a triangle mesh.
 *
 * @param {ArrayLike<number>} positions flat xyz
 * @param {ArrayLike<number>|null} index triangle corners, or null when
 *   every three vertices are a triangle (an STL)
 * @param {number} [angle] degrees between face normals that makes an edge
 * @returns {Float32Array} flat xyz pairs, one pair per edge
 */
export function featureEdgeSegments(positions, index = null, angle = OUTLINE_ANGLE) {
  const corners = index ? index.length : positions.length / 3;
  const triangles = Math.floor(corners / 3);
  if (!triangles) return new Float32Array(0);
  const at = index ? (c) => index[c] : (c) => c;

  // ---- weld corners that are the same point ------------------------------
  //
  // Generated geometry splits its vertices at every seam and an STL never
  // shares one at all, so corners are matched by where they are. The grid
  // the positions are snapped to is a ten-millionth of the model's size:
  // far below any feature, far above float noise.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const nv = positions.length / 3;
  for (let v = 0; v < nv; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const q = Math.max(diag * 1e-7, 1e-9);

  // Snapped, every coordinate is a whole number under ten million, so the
  // keys sit in plain 32-bit integers and the table holds only which welded
  // vertex is in each slot — a million-triangle casting stays at tens of
  // megabytes. A welded vertex is drawn at the first corner that made it.
  const wSize = nextPow2(Math.max(16, nv * 2));
  const wMask = wSize - 1;
  const wId = new Int32Array(wSize).fill(-1);
  const keys = new Int32Array(nv * 3);      // snapped xyz per welded vertex
  const first = new Int32Array(nv);         // welded vertex -> input vertex
  let count = 0;
  const vid = new Int32Array(nv);           // input vertex -> welded vertex
  for (let v = 0; v < nv; v++) {
    const kx = Math.round((positions[v * 3] - minX) / q);
    const ky = Math.round((positions[v * 3 + 1] - minY) / q);
    const kz = Math.round((positions[v * 3 + 2] - minZ) / q);
    let h = (Math.imul(kx, 73856093) ^ Math.imul(ky, 19349663) ^ Math.imul(kz, 83492791)) & wMask;
    for (;;) {
      const id = wId[h];
      if (id < 0) {
        wId[h] = count;
        keys[count * 3] = kx; keys[count * 3 + 1] = ky; keys[count * 3 + 2] = kz;
        first[count] = v;
        vid[v] = count++;
        break;
      }
      if (keys[id * 3] === kx && keys[id * 3 + 1] === ky && keys[id * 3 + 2] === kz) { vid[v] = id; break; }
      h = (h + 1) & wMask;
    }
  }

  // ---- face normals --------------------------------------------------------
  const normals = new Float32Array(triangles * 3);
  const live = new Uint8Array(triangles);
  for (let t = 0; t < triangles; t++) {
    const a = at(t * 3) * 3, b = at(t * 3 + 1) * 3, c = at(t * 3 + 2) * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    // A sliver with no area has no direction, and pairing it with its
    // neighbours would draw edges across the middle of flat faces.
    if (!(len > q * q)) continue;
    const ia = vid[at(t * 3)], ib = vid[at(t * 3 + 1)], ic = vid[at(t * 3 + 2)];
    if (ia === ib || ib === ic || ia === ic) continue;
    live[t] = 1;
    normals[t * 3] = nx / len; normals[t * 3 + 1] = ny / len; normals[t * 3 + 2] = nz / len;
  }

  // ---- pair up the edges -----------------------------------------------------
  const cos = Math.cos((angle * Math.PI) / 180);
  // A closed mesh has one and a half edges per triangle; twice that keeps
  // the table under half full.
  const eSize = nextPow2(Math.max(16, triangles * 3));
  const eMask = eSize - 1;
  const eA = new Int32Array(eSize).fill(-1);
  const eB = new Int32Array(eSize);
  const eFace = new Int32Array(eSize);
  const eCount = new Uint8Array(eSize);
  const out = [];
  const emit = (a, b) => {
    const pa = first[a] * 3, pb = first[b] * 3;
    out.push(positions[pa], positions[pa + 1], positions[pa + 2], positions[pb], positions[pb + 1], positions[pb + 2]);
  };
  for (let t = 0; t < triangles; t++) {
    if (!live[t]) continue;
    for (let k = 0; k < 3; k++) {
      let a = vid[at(t * 3 + k)];
      let b = vid[at(t * 3 + ((k + 1) % 3))];
      if (a > b) { const s = a; a = b; b = s; }
      let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) & eMask;
      for (;;) {
        if (eA[h] < 0) {
          eA[h] = a; eB[h] = b; eFace[h] = t; eCount[h] = 1;
          break;
        }
        if (eA[h] === a && eB[h] === b) {
          if (eCount[h] === 1) {
            const f = eFace[h];
            const dot = normals[f * 3] * normals[t * 3] + normals[f * 3 + 1] * normals[t * 3 + 1] + normals[f * 3 + 2] * normals[t * 3 + 2];
            if (dot < cos) emit(a, b);
          }
          if (eCount[h] < 255) eCount[h]++;
          break;
        }
        h = (h + 1) & eMask;
      }
    }
  }
  // An edge only one face has is where the surface stops: an open STL, the
  // rim of a sheet. That is an outline too.
  for (let h = 0; h < eSize; h++) if (eA[h] >= 0 && eCount[h] === 1) emit(eA[h], eB[h]);

  return Float32Array.from(out);
}
