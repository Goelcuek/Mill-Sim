// Collision primitives.
//
// The tool assembly is carried as a chain of samples taken from its
// silhouette: a height up the tool and the radius there. Read as spheres
// they are cheap to test against a box at any angle — but a sphere at a
// flat end reaches a whole radius past it, so a Ø10 end mill 2 mm over a
// clamp read as 3 mm into it, and a face mill as 23. So the common cases
// are answered exactly from the same samples read as discs: the table at
// any lean, and a box whenever the tool stands square to it, which is
// every upright tool over a clamp that has not been tilted. Spheres are
// left for the tool leaning at a box, where they err towards a crash.

/** World up, and the tool axis of any machine whose rotaries are at zero. */
const UP = [0, 0, 1];

/**
 * Sample an assembly silhouette into spheres.
 *
 * @param {Array<{r:number,z:number}>} points  silhouette, tip at z=0
 * @param {number} [maxSpacing]
 * @returns {Float32Array} triplets of [z, r] flattened as [z0,r0, z1,r1, ...]
 */
export function silhouetteSpheres(points, maxSpacing = 3) {
  const out = [];
  if (!points || points.length < 2) return Float32Array.from(out);

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dz = b.z - a.z;
    if (Math.abs(dz) < 1e-9) continue;
    const rMaxSeg = Math.max(a.r, b.r);
    const spacing = Math.max(0.35, Math.min(maxSpacing, rMaxSeg * 0.9 || maxSpacing));
    const n = Math.max(1, Math.ceil(Math.abs(dz) / spacing));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const z = a.z + dz * t;
      const r = a.r + (b.r - a.r) * t;
      if (r <= 0) continue;
      out.push(z, r);
    }
  }
  return Float32Array.from(out);
}

/**
 * Signed distance from a point to an axis-aligned box centred on the
 * origin. Negative inside.
 */
function pointBoxDistance(px, py, pz, hx, hy, hz) {
  const dx = Math.abs(px) - hx;
  const dy = Math.abs(py) - hy;
  const dz = Math.abs(pz) - hz;
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0), oz = Math.max(dz, 0);
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
  return outside + inside;
}

/**
 * Signed distance from a box centred on the origin to a disc square to its
 * Z axis — the box grown by the disc's radius in X and Y. Negative inside.
 */
function discBoxDistance(cx, cy, cz, rho, hx, hy, hz) {
  const dx = Math.abs(cx) - hx;
  const dy = Math.abs(cy) - hy;
  const flat = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
  const qx = flat - rho;
  const qz = Math.abs(cz) - hz;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
}

/**
 * The closest a slice of the tool — a frustum running along the box's Z
 * from a disc of radius ra at height za to one of rb at zb — comes to the
 * box, as [signed distance, fraction of the way from a to b].
 *
 * The distance along the slice is made of straight pieces and of the
 * length of a straight line in two variables, so its least value is at an
 * end, at a corner between pieces, or where that length bottoms out — and
 * those are all the places looked at.
 */
function frustumBoxDistance(cx, cy, za, zb, ra, rb, hx, hy, hz) {
  const dz = zb - za;
  const dr = rb - ra;
  const dx = Math.abs(cx) - hx;
  const dy = Math.abs(cy) - hy;
  const flat = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
  const ts = [0, 1];
  if (Math.abs(dz) > 1e-12) {
    ts.push((hz - za) / dz, (-hz - za) / dz, -za / dz);
    // The other piece: straight lines in both directions at once.
    for (const sgn of [1, -1]) {
      const ax = flat - ra, bx = -dr;
      const az = sgn * za - hz, bz = sgn * dz;
      const bb = bx * bx + bz * bz;
      if (bb > 1e-18) ts.push(-(ax * bx + az * bz) / bb);
    }
  }
  if (Math.abs(dr) > 1e-12) ts.push((flat - ra) / dr);
  let best = Infinity;
  let at = 0;
  for (const raw of ts) {
    const t = Math.min(1, Math.max(0, raw));
    const d = discBoxDistance(cx, cy, za + dz * t, ra + dr * t, hx, hy, hz);
    if (d < best) { best = d; at = t; }
  }
  return [best, at];
}

/**
 * How a box's own frame sees a tool standing along `dir`: the scale from
 * world millimetres to the box's, when it is the same every way, and
 * whether the tool runs straight along the box's Z. Null when either is
 * not so, and the box is asked with spheres instead.
 */
function squareTo(inv, dir) {
  const k0 = Math.hypot(inv[0], inv[4], inv[8]);
  const k1 = Math.hypot(inv[1], inv[5], inv[9]);
  const k2 = Math.hypot(inv[2], inv[6], inv[10]);
  if (!(k0 > 0) || Math.abs(k1 - k0) > 1e-6 * k0 || Math.abs(k2 - k0) > 1e-6 * k0) return null;
  const lx = inv[0] * dir[0] + inv[4] * dir[1] + inv[8] * dir[2];
  const ly = inv[1] * dir[0] + inv[5] * dir[1] + inv[9] * dir[2];
  if (Math.hypot(lx, ly) > 1e-7 * k0) return null;
  return k0;
}

/** Apply a row-major-free three.js style column-major 4x4 matrix to a point. */
function applyMatrix(m, x, y, z, out) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

/**
 * @typedef {{
 *   id:string, name:string,
 *   inverse:ArrayLike<number>,  world -> local matrix (column major, 16)
 *   half:[number,number,number], centre:[number,number,number],
 *   scale:number                largest axis scale, to un-scale distances
 * }} FixtureBox
 */

/**
 * Test a sphere chain positioned at a tool tip against fixture boxes.
 *
 * @param {Float32Array} spheres  [z0,r0, z1,r1, ...] in tool-local mm
 * @param {[number,number,number]} tip  world position of the tool tip
 * @param {FixtureBox[]} fixtures
 * @param {number} [skipBelow] ignore the chain below this height up the tool
 * @param {number} [clearance] room to ask for beyond metal-in-metal
 * @param {number[]} [dir] unit vector up the tool; world up by default
 * @param {number} [skipBelow]  ignore spheres below this local z (the flutes,
 *                              which are allowed to touch the stock but never
 *                              a clamp — pass 0 to test everything)
 * @returns {null|{fixture:FixtureBox, depth:number, point:[number,number,number], localZ:number}}
 */
export function checkFixtures(spheres, tip, fixtures, skipBelow = 0, clearance = 0, dir = UP) {
  if (!fixtures || !fixtures.length || !spheres.length) return null;
  const p = [0, 0, 0];
  let worst = null;

  for (const f of fixtures) {
    if (f.ignore) continue;
    const s = f.scale || 1;
    // A fixture may ask for more room than the global setting — a fragile
    // probe or a delicate casting — but never less than nothing.
    const want = Math.max(Number.isFinite(f.clearance) ? f.clearance : clearance, 0);
    const k = squareTo(f.inverse, dir);
    if (k) {
      // Square to the box: each pair of samples is a slice of the tool,
      // and the slice is measured exactly. A pair that steps back down the
      // tool is where one part's outline hands over to the next, so each
      // of its ends stands alone instead.
      const local = [];
      for (let i = 0; i < spheres.length; i += 2) {
        const lz = spheres[i];
        const q = applyMatrix(f.inverse, tip[0] + dir[0] * lz, tip[1] + dir[1] * lz, tip[2] + dir[2] * lz, [0, 0, 0]);
        local.push(q[0] - f.centre[0], q[1] - f.centre[1], q[2] - f.centre[2]);
      }
      for (let i = 0; i < spheres.length; i += 2) {
        const j = i + 2 < spheres.length && spheres[i + 2] >= spheres[i] ? i + 2 : i;
        if (spheres[i] < skipBelow) continue;
        const a = (i / 2) * 3, b = (j / 2) * 3;
        const [dl, t] = frustumBoxDistance(
          local[a], local[a + 1], local[a + 2], local[b + 2],
          spheres[i + 1] * k, spheres[j + 1] * k, f.half[0], f.half[1], f.half[2],
        );
        const gap = dl / k;
        if (gap < want && (!worst || gap < worst.gap)) {
          const lz = spheres[i] + (spheres[j] - spheres[i]) * t;
          worst = {
            fixture: f,
            gap,
            clearance: want,
            depth: Math.max(-gap, 0),
            point: [tip[0] + dir[0] * lz, tip[1] + dir[1] * lz, tip[2] + dir[2] * lz],
            localZ: lz,
          };
        }
      }
      continue;
    }
    for (let i = 0; i < spheres.length; i += 2) {
      const lz = spheres[i];
      if (lz < skipBelow) continue;
      const r = spheres[i + 1];
      // Up the tool, not up the world: the two are the same thing only
      // while the rotaries sit at zero.
      const cx = tip[0] + dir[0] * lz;
      const cy = tip[1] + dir[1] * lz;
      const cz = tip[2] + dir[2] * lz;
      applyMatrix(f.inverse, cx, cy, cz, p);
      const d = pointBoxDistance(p[0] - f.centre[0], p[1] - f.centre[1], p[2] - f.centre[2], f.half[0], f.half[1], f.half[2]) * s;
      // Negative gap is metal in metal; a small positive one is the near
      // miss that the operator would have watched with a hand on the feed
      // hold. Both come back here; which of them is worth reporting is the
      // caller's business.
      const gap = d - r;
      if (gap < want && (!worst || gap < worst.gap)) {
        worst = {
          fixture: f,
          gap,
          clearance: want,
          depth: Math.max(-gap, 0),
          point: [cx, cy, cz],
          localZ: lz,
        };
      }
    }
  }
  return worst;
}

/**
 * Test the sphere chain against a horizontal table surface.
 *
 * @param {Float32Array} spheres
 * @param {[number,number,number]} tip
 * @param {object} table
 * @param {number} [clearance]
 * @param {number[]} [dir] unit vector up the tool; world up by default
 * @returns {null|{depth:number, z:number, localZ:number, x:number, y:number}}
 */
export function checkTable(spheres, tip, table, clearance = 0, dir = UP) {
  if (!table || !table.enabled) return null;
  const { z, xMin, xMax, yMin, yMax, round } = table;
  const want = Math.max(clearance, 0);
  let worst = null;
  // Each part of the assembly is asked about where it is, not where the
  // tip is: leaned over, the holder can be past the edge of the table
  // while the tip is over it, and the other way about.
  const consider = (x, y, bottom, localZ) => {
    // On the edge of the table is beside it, not over it: a tool laid flat
    // against the table's side face touches it and is not in it.
    const e = 1e-6;
    if (round) {
      // A rotary table's platter: round, whatever angle it is at.
      const dx = x - round.cx;
      const dy = y - round.cy;
      if (dx * dx + dy * dy >= (round.r - e) * (round.r - e)) return;
    } else if (x <= xMin + e || x >= xMax - e || y <= yMin + e || y >= yMax - e) return;
    const gap = bottom - z;
    if (gap < want && (!worst || gap < worst.gap)) {
      worst = { gap, clearance: want, depth: Math.max(-gap, 0), z: bottom, localZ, x, y };
    }
  };
  // Each sample is a disc square to the tool, and the lowest point of a
  // disc is its rim on the downhill side — exactly level with its centre
  // when the tool stands upright. A sphere there would hang a whole radius
  // lower, which is a flat end mill sitting a radius into a table it is
  // clear of. Between two discs the outline is straight, so its lowest
  // point is at one of them, and the discs are the whole answer.
  const horiz = Math.hypot(dir[0], dir[1]);
  const sin = Math.min(1, horiz);
  // Downhill in the disc's plane: straight down, less its part along the tool.
  const wx = horiz > 1e-9 ? dir[0] * dir[2] / horiz : 0;
  const wy = horiz > 1e-9 ? dir[1] * dir[2] / horiz : 0;
  for (let i = 0; i < spheres.length; i += 2) {
    const lz = spheres[i];
    const r = spheres[i + 1];
    consider(
      tip[0] + dir[0] * lz + wx * r,
      tip[1] + dir[1] * lz + wy * r,
      tip[2] + dir[2] * lz - r * sin,
      lz,
    );
  }
  consider(tip[0], tip[1], tip[2], 0);      // the tip itself, which has no radius
  return worst;
}

/**
 * Travel-limit check, at the gauge line.
 *
 * A travel limit is how far the *axis* goes, and an axis position is read
 * at the gauge line — the spindle's own face — not at the tip of whatever
 * is in it. So what is compared is the point a gauge length up the tool
 * from the tip, which is the same point G53 puts on a machine coordinate.
 * Checking the tip instead moved the whole envelope with every tool
 * change: a long tool could not reach the bottom of its own travel, and a
 * short one ran past the top of it.
 *
 * `limits` are scene coordinates — see limitsInScene, which is what turns a
 * machine's own envelope into them. `home` is only used to report the
 * answer the way a control would: as a machine coordinate.
 *
 * @param {number[]} gauge the gauge point, in the same coordinates
 * @returns {null|{axis:string, value:number, limit:number}}
 */
export function checkLimits(gauge, limits, home = [0, 0, 0]) {
  if (!limits || !limits.enabled) return null;
  const names = ['X', 'Y', 'Z'];
  for (let a = 0; a < 3; a++) {
    // Compared where the axis is, reported where the control would say it
    // is: the machine coordinate, measured from home.
    if (gauge[a] < limits.min[a] - 1e-6) return { axis: names[a], value: gauge[a] - home[a], limit: limits.min[a] - home[a] };
    if (gauge[a] > limits.max[a] + 1e-6) return { axis: names[a], value: gauge[a] - home[a], limit: limits.max[a] - home[a] };
  }
  return null;
}

// ---- the machine's own castings -------------------------------------------
//
// What the machine draws is what it is checked against: the stand-in
// castings are boxes and cylinders, and a body the shop imported is its
// own triangles. Each solid is stated in the frame of the axis that carries
// it; the caller hands over, for the pose being asked about, the matrix
// that carries a point on the part into that solid's own frame.

/**
 * Signed distance from a point to a solid cylinder or cone standing along
 * its own Y, centred on the origin: `h` long, radius r0 at −h/2 and r1 at
 * +h/2 — which is how a three.js CylinderGeometry is laid out. Negative
 * inside.
 */
export function pointConeDistance(x, y, z, r0, r1, h) {
  const rho = Math.hypot(x, z);
  const hh = h / 2;
  // The outline in (radius, height): bottom, side and top. The axis side
  // is inside the solid, and the point is never across it.
  const d = Math.min(
    segment2(rho, y, 0, -hh, r0, -hh),
    segment2(rho, y, r0, -hh, r1, hh),
    segment2(rho, y, 0, hh, r1, hh),
  );
  const inside = Math.abs(y) <= hh && rho <= r0 + ((r1 - r0) * (y + hh)) / (h || 1);
  return inside ? -d : d;
}

function segment2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const ll = dx * dx + dy * dy;
  let t = ll > 0 ? ((px - ax) * dx + (py - ay) * dy) / ll : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** Squared distance from p to the triangle (a, b, c), after Ericson. */
export function pointTriangleDistance2(px, py, pz, t, o) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
  const cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const at = (x, y, z) => { const dx = px - x, dy = py - y, dz = pz - z; return dx * dx + dy * dy + dz * dz; };
  if (d1 <= 0 && d2 <= 0) return at(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return at(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return at(ax + abx * v, ay + aby * v, az + abz * v);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return at(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return at(ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return at(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return at(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/**
 * A grid over a triangle soup, so asking how close a point is looks at the
 * triangles near it and not at all of them.
 *
 * @param {Float32Array} tris  nine numbers a triangle
 */
export function meshGrid(tris) {
  const n = Math.floor(tris.length / 9);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 9; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  if (!n) return { tris, n: 0, lo, hi, cell: 1, dims: [1, 1, 1], start: new Uint32Array(2), items: new Uint32Array(0), stamp: new Uint32Array(0), query: 0 };
  const ext = [0, 1, 2].map((a) => Math.max(hi[a] - lo[a], 1e-3));
  // About two triangles a cell, at most 64 cells a side.
  const vol = ext[0] * ext[1] * ext[2];
  let cell = Math.cbrt(vol / Math.max(n / 2, 1));
  cell = Math.max(cell, Math.max(...ext) / 64, 0.5);
  const dims = ext.map((e) => Math.max(1, Math.ceil(e / cell)));
  const idx = (i, j, k) => (k * dims[1] + j) * dims[0] + i;
  const clampCell = (v, a) => Math.min(dims[a] - 1, Math.max(0, Math.floor((v - lo[a]) / cell)));
  const total = dims[0] * dims[1] * dims[2];
  const count = new Uint32Array(total + 1);
  const range = new Int32Array(6);
  const span = (t) => {
    const o = t * 9;
    for (let a = 0; a < 3; a++) {
      const v0 = tris[o + a], v1 = tris[o + 3 + a], v2 = tris[o + 6 + a];
      range[a] = clampCell(Math.min(v0, v1, v2), a);
      range[a + 3] = clampCell(Math.max(v0, v1, v2), a);
    }
  };
  for (let t = 0; t < n; t++) {
    span(t);
    for (let k = range[2]; k <= range[5]; k++) for (let j = range[1]; j <= range[4]; j++) for (let i = range[0]; i <= range[3]; i++) count[idx(i, j, k) + 1]++;
  }
  for (let c = 0; c < total; c++) count[c + 1] += count[c];
  const items = new Uint32Array(count[total]);
  const fill = count.slice(0, total);
  for (let t = 0; t < n; t++) {
    span(t);
    for (let k = range[2]; k <= range[5]; k++) for (let j = range[1]; j <= range[4]; j++) for (let i = range[0]; i <= range[3]; i++) items[fill[idx(i, j, k)]++] = t;
  }
  return { tris, n, lo, hi, cell, dims, start: count, items, stamp: new Uint32Array(n), query: 0 };
}

/** The closest any triangle of the grid comes to p, looking no further than maxD. */
export function meshDistance(g, px, py, pz, maxD) {
  if (!g.n) return Infinity;
  if (px < g.lo[0] - maxD || px > g.hi[0] + maxD || py < g.lo[1] - maxD || py > g.hi[1] + maxD
    || pz < g.lo[2] - maxD || pz > g.hi[2] + maxD) return Infinity;
  const { dims, cell, lo } = g;
  const c0 = (v, a) => Math.min(dims[a] - 1, Math.max(0, Math.floor((v - maxD - lo[a]) / cell)));
  const c1 = (v, a) => Math.min(dims[a] - 1, Math.max(0, Math.floor((v + maxD - lo[a]) / cell)));
  const i0 = c0(px, 0), i1 = c1(px, 0), j0 = c0(py, 1), j1 = c1(py, 1), k0 = c0(pz, 2), k1 = c1(pz, 2);
  if (++g.query === 0xffffffff) { g.stamp.fill(0); g.query = 1; }
  const q = g.query;
  let best = maxD * maxD;
  for (let k = k0; k <= k1; k++) {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = (k * dims[1] + j) * dims[0] + i;
        for (let s = g.start[c], e = g.start[c + 1]; s < e; s++) {
          const t = g.items[s];
          if (g.stamp[t] === q) continue;
          g.stamp[t] = q;
          const d2 = pointTriangleDistance2(px, py, pz, g.tris, t * 9);
          if (d2 < best) best = d2;
        }
      }
    }
  }
  return best < maxD * maxD ? Math.sqrt(best) : Infinity;
}

/**
 * The sphere chain against cylinders and triangle meshes, each carrying
 * `inverse`, the matrix from the part into its own frame for this pose.
 * Boxes go through checkFixtures, which answers a square tool exactly.
 *
 * A mesh is measured to its skin: a tool sunk deep inside a body without
 * having crossed its surface between two poses would not be seen, which
 * the pose spacing (a millimetre and a half) makes a casting's worth of
 * metal to pass through unnoticed.
 *
 * @returns {null|{solid:object, gap:number, clearance:number, depth:number, point:number[], localZ:number}}
 */
export function checkSolids(spheres, tip, solids, clearance = 0, dir = UP) {
  if (!solids || !solids.length || !spheres.length) return null;
  const want = Math.max(clearance, 0);
  const q = [0, 0, 0];
  let worst = null;
  for (const s of solids) {
    for (let i = 0; i < spheres.length; i += 2) {
      const lz = spheres[i];
      const r = spheres[i + 1];
      const cx = tip[0] + dir[0] * lz;
      const cy = tip[1] + dir[1] * lz;
      const cz = tip[2] + dir[2] * lz;
      applyMatrix(s.inverse, cx, cy, cz, q);
      const d = s.kind === 'cyl'
        ? pointConeDistance(q[0], q[1], q[2], s.r0, s.r1, s.h)
        : meshDistance(s.grid, q[0], q[1], q[2], r + want);
      const gap = d - r;
      if (gap < want && (!worst || gap < worst.gap)) {
        worst = { solid: s, gap, clearance: want, depth: Math.max(-gap, 0), point: [cx, cy, cz], localZ: lz };
      }
    }
  }
  return worst;
}
