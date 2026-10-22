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
//
// That top-down map answers "is this point inside the part?" and gives an
// upper bound on how far it is from it. The distance itself is measured
// along the surface normal against the triangles — see surfaceIndex.js —
// which is what lets walls, slopes and bores be judged at all.

import { buildSurfaceIndex, nearestWithin } from './surfaceIndex.js';

/**
 * Rasterise reference triangles into a target heightmap.
 *
 * @param {import('./stock.js').Stock} stock
 * @param {Array<{positions:Float32Array}>} parts world-space triangle soups
 * @returns {null | {map:Float32Array, edge:Uint8Array, edgeCells:number,
 *   lateral:number}} the surface height per column, -Infinity where the
 *   reference does not cover the stock, and which columns stand on an edge
 *   of it — see markEdges.
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

  if (!covered) return null;
  const { edge, edgeCells } = markEdges(stock, map);
  return {
    map, edge, edgeCells, lateral: Math.max(stock.dx, stock.dy),
    surface: buildSurfaceIndex(parts, Math.max(2, stock.dx * 8, stock.dy * 8)),
  };
}

/**
 * Which columns stand on an edge of the reference, and cannot be judged
 * from above.
 *
 * This is the whole difficulty with comparing a cut to a design surface in
 * a field of vertical columns, and it is not a rounding error: it is the
 * shape of the model. Drill a 5 mm hole with a 5 mm drill and the drill is
 * round while the reference hole is a polygon — twenty-four flats, say,
 * inscribed in the circle, so every flat sits two hundredths *inside* the
 * true bore. A column whose centre falls in that sliver is material as far
 * as the reference is concerned and air as far as the drill is; the
 * difference between them is not two hundredths but the whole depth of the
 * hole, because the disagreement is sideways and the measurement is
 * vertical. The same thing happens at the wall of every pocket and round
 * the outline of every part, and it is what made a correctly drilled hole
 * report a gouge the depth of itself.
 *
 * So a column within one cell of a step in the reference — a missing
 * neighbour, or one more than a couple of cells higher or lower — is left
 * out of the comparison. What remains is every surface a top-down
 * comparison can actually speak about. The cost is stated rather than
 * hidden: the walls are not checked, and how much lateral error could hide
 * there is the width of a column.
 */
function markEdges(stock, map) {
  const nx = stock.nx;
  const ny = stock.ny;
  const edge = new Uint8Array(nx * ny);
  // What counts as a step rather than a slope: more than a couple of cells
  // of fall across one cell, which is steeper than about 60 degrees.
  const step = Math.max(stock.dx, stock.dy) * 2;
  let edgeCells = 0;   // covered columns only

  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const k = row + i;
      const here = map[k];
      let mark = here === -Infinity;
      if (!mark) {
        for (let dj = -1; dj <= 1 && !mark; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= ny) { mark = true; break; }
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx) { mark = true; break; }
            const there = map[jj * nx + ii];
            if (there === -Infinity || Math.abs(there - here) > step) { mark = true; break; }
          }
        }
      }
      if (mark) {
        edge[k] = 1;
        // Only columns the reference actually covers are worth counting:
        // the rest are outside the part and were never compared anyway.
        if (here > -Infinity) edgeCells++;
      }
    }
  }
  return { edge, edgeCells };
}

/**
 * Compare the cut stock against the reference part.
 *
 * Every column with metal in it, walls included, is measured along the
 * surface normal; see columnDeviation. A column is a gouge when it is
 * inside the part by more than the tolerance and stock left when it is
 * outside by more, and the deepest of each is measured exactly. The pass is
 * cheap because nearly every column settles with a search no wider than
 * the tolerance.
 *
 * @param {import('./stock.js').Stock} stock
 * @param {object} target
 * @param {number} tolerance mm the cut may pass the surface before it counts
 * @returns {{gougeCells:number, maxGouge:number, excessCells:number,
 *            maxExcess:number, comparedCells:number, skippedCells:number,
 *            lateral:number, gougeAt:number[]|null, excessCapped:boolean}}
 */
export function compareToTarget(stock, target, tolerance = 0.02) {
  const out = {
    gougeCells: 0, maxGouge: 0, excessCells: 0, maxExcess: 0,
    comparedCells: 0, skippedCells: 0, gougeAt: null, excessCapped: false,
    lateral: target ? target.lateral : 0,
  };
  if (!target) return out;
  const map = target.map;
  const h = stock.height;
  const tol = Math.max(tolerance, 1e-6);
  for (let j = 0; j < stock.ny; j++) {
    const row = j * stock.nx;
    for (let i = 0; i < stock.nx; i++) {
      const k = row + i;
      const want = map[k];
      if (want === -Infinity) continue;
      out.comparedCells++;
      const vertical = h[k] - want;
      if (Math.abs(vertical) <= tol) continue;
      const x = stock.cx(i), y = stock.cy(j), z = h[k];
      if (vertical < 0) {
        const d = gougeDepth(target, x, y, z, want, COMPARE_REACH);
        if (d <= tol) continue;
        out.gougeCells++;
        if (d > out.maxGouge) { out.maxGouge = d; out.gougeAt = [x, y, z]; }
      } else {
        // Anything of the part within the tolerance settles it.
        if (target.surface && nearestWithin(target.surface, x, y, z, tol) < Infinity) continue;
        out.excessCells++;
        if (vertical > out.maxExcess && out.maxExcess < COMPARE_REACH) {
          const d = measure(target, x, y, z, vertical, COMPARE_REACH);
          if (d > out.maxExcess) out.maxExcess = d;
        }
      }
    }
  }
  out.excessCapped = out.maxExcess >= COMPARE_REACH;
  return out;
}

/** Below this much metal a column is air: milled through, or outside a bar. */
const MIN_METAL = 1e-4;
/** How far the comparison looks for the part before saying "more than this". */
const COMPARE_REACH = 25;

/**
 * How deep a cut reaches into the part over one column.
 *
 * The metal taken out of the column runs from where the cut stopped up to
 * the part's surface, and the gouge is the deepest any of it lay inside
 * the part — not the depth of the column's floor alone. A drill 1 mm
 * oversize through a bore takes out a thin sleeve of the part the whole
 * depth of the hole; its floor is the part's own underside, a hair from
 * the surface, while halfway up it is half a millimetre into the wall.
 * So the removed segment is sampled, each sample searched no further than
 * its own vertical distance to the surface, and the deepest kept.
 */
export function gougeDepth(target, x, y, z, want, cap = COMPARE_REACH) {
  let deepest = 0;
  for (const f of [0, 0.25, 0.5, 0.75]) {
    const zs = z + (want - z) * f;
    const d = measure(target, x, y, zs, want - zs, cap);
    if (d > deepest) deepest = d;
  }
  return deepest;
}

/**
 * Normal distance from a point to the part, given an upper bound on it.
 * Beyond `cap` the answer is `cap`, which the caller reads as "at least".
 */
function measure(target, x, y, z, bound, cap) {
  if (!target.surface) return bound;
  const r = Math.min(bound, cap);
  const d = nearestWithin(target.surface, x, y, z, r);
  if (d < Infinity) return d;
  return bound <= cap ? bound : cap;
}

// ---- the deviation map ------------------------------------------------------
//
// The same comparison, kept per column rather than counted: how far the cut
// surface stands above the reference (material still to come off) or below
// it (a gouge), so the whole part can be coloured by it.

/** A column the reference does not cover: nothing to say about it. */
export const DEV_OUTSIDE = 0;
/** A column on a wall of the reference, which a vertical measure cannot judge. */
export const DEV_WALL = 0.5;
/** A column with a deviation worth showing. */
export const DEV_JUDGED = 1;

/**
 * How one column stands against the reference part, measured along the
 * surface normal.
 *
 * The point measured is the top of the column — where the cut left it. It
 * is inside the part when it is below the part's top surface over that
 * column, which makes the distance a gouge (negative); otherwise it is
 * stock still to come off (positive). The vertical gap to that surface is
 * an upper bound on the true distance, so the search never looks further
 * than it, and never further than `cap`: past that the colour scale is
 * already full, and the answer is reported as `cap` with `beyond` set.
 *
 * @param {number} [tolerance] a gap this small needs no search at all
 * @param {number} [cap] mm beyond which the exact distance is not wanted
 * @returns {{state:number, deviation:number, beyond?:boolean}}
 */
export function columnDeviation(stock, target, i, j, tolerance = 0.02, cap = 25) {
  if (!stock || !target || i < 0 || j < 0 || i >= stock.nx || j >= stock.ny) {
    return { state: DEV_OUTSIDE, deviation: 0 };
  }
  const k = j * stock.nx + i;
  const h = stock.height[k];
  const want = target.map[k];
  const over = want > -Infinity;
  // A column with no metal in it, off the part, is just air.
  if (!over && h <= stock.base + MIN_METAL) return { state: DEV_OUTSIDE, deviation: 0 };
  const vertical = over ? h - want : Infinity;
  if (over && Math.abs(vertical) <= tolerance) return { state: DEV_JUDGED, deviation: vertical };
  // Without the triangles there is only the vertical measure, which cannot
  // speak at a wall.
  if (!target.surface) {
    if (!over) return { state: DEV_OUTSIDE, deviation: 0 };
    return target.edge[k] ? { state: DEV_WALL, deviation: 0 } : { state: DEV_JUDGED, deviation: vertical };
  }
  if (over && vertical < 0) {
    const g = gougeDepth(target, stock.cx(i), stock.cy(j), h, want, cap);
    return { state: DEV_JUDGED, deviation: -g, beyond: g >= cap };
  }
  const bound = Math.abs(vertical);
  const r = Math.min(bound, cap);
  const d = nearestWithin(target.surface, stock.cx(i), stock.cy(j), h, r);
  const sign = 1;
  if (d < Infinity) return { state: DEV_JUDGED, deviation: sign * d };
  // Off the part, with nothing of it within reach: not the part's business.
  if (!over) return { state: DEV_OUTSIDE, deviation: 0 };
  if (bound <= cap) return { state: DEV_JUDGED, deviation: sign * bound };
  return { state: DEV_JUDGED, deviation: sign * cap, beyond: true };
}

/**
 * How a block of columns stands against the reference, for a display texel
 * that covers several of them.
 *
 * A gouge anywhere in the block is what the block shows, because a gouge is
 * the thing the map exists to find and averaging would hide it. Otherwise
 * the most material left is shown, for the same reason the stock view shows
 * the lowest column in a block: nothing worth knowing is averaged away.
 * A small block is measured column by column; a big one measures its
 * likeliest candidates — the columns standing lowest and highest against
 * the part, and the lowest one off it, where a profile wall would be —
 * which is what keeps a full redraw quick.
 *
 * @param {number} tolerance mm a cut may pass the surface before it counts
 * @param {number} [cap] mm past which the exact distance is not wanted
 * @returns {{state:number, deviation:number}}
 */
export function blockDeviation(stock, target, i0, i1, j0, j1, tolerance = 0.02, cap = 1) {
  let lo = null;
  let hi = null;
  let wall = false;
  const take = (dev) => {
    if (dev.state === DEV_OUTSIDE) return;
    if (dev.state === DEV_WALL) { wall = true; return; }
    if (!lo || dev.deviation < lo.deviation) lo = dev;
    if (!hi || dev.deviation > hi.deviation) hi = dev;
  };
  if ((i1 - i0) * (j1 - j0) <= 4) {
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) take(columnDeviation(stock, target, i, j, tolerance, cap));
  } else {
    let kLo = -1, kHi = -1, kOut = -1, vLo = Infinity, vHi = -Infinity, hOut = Infinity;
    const map = target.map;
    const h = stock.height;
    for (let j = j0; j < j1; j++) {
      const row = j * stock.nx;
      for (let i = i0; i < i1; i++) {
        const k = row + i;
        if (map[k] === -Infinity) {
          if (h[k] > stock.base + MIN_METAL && h[k] < hOut) { hOut = h[k]; kOut = k; }
          continue;
        }
        const v = h[k] - map[k];
        if (v < vLo) { vLo = v; kLo = k; }
        if (v > vHi) { vHi = v; kHi = k; }
      }
    }
    for (const k of new Set([kLo, kHi, kOut])) {
      if (k >= 0) take(columnDeviation(stock, target, k % stock.nx, Math.floor(k / stock.nx), tolerance, cap));
    }
  }
  if (lo) return { state: DEV_JUDGED, deviation: lo.deviation < -tolerance ? lo.deviation : hi.deviation };
  return { state: wall ? DEV_WALL : DEV_OUTSIDE, deviation: 0 };
}
