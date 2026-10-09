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
  const { z, xMin, xMax, yMin, yMax } = table;
  const want = Math.max(clearance, 0);
  let worst = null;
  // Each part of the assembly is asked about where it is, not where the
  // tip is: leaned over, the holder can be past the edge of the table
  // while the tip is over it, and the other way about.
  const consider = (x, y, bottom, localZ) => {
    if (x < xMin || x > xMax || y < yMin || y > yMax) return;
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
