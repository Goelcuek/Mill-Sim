// The holder, the shank above the flutes and the spindle against the
// reference part — the finished shape, measured as it is rather than as a
// box round it.
//
// The cutting edge is left out: it is meant to meet the part, and where it
// goes past it that is the gouge check's to say. Everything above the
// flutes is not, and a holder that touches the finished part is a crash
// whatever the stock round it still looks like.
//
// The assembly is a solid of revolution, so each sample of its outline is
// a disc square to the tool: its centre and two rings round it are asked
// whether they are inside the part, and how far they are from its skin.
// A disc with no surface within its own radius of its centre is clear, or
// wholly buried — one inside test says which — so only the discs next to
// the part cost anything.

import { insideSolid, nearestWithin, lineInside } from './surfaceIndex.js';

/** Column spacing of the part's inside, mm; see insideColumns. */
const COLUMN = 0.25;
/** Columns kept before the cache starts again: a few hundred MB at most. */
const COLUMN_CAP = 1500000;

/**
 * Inside the part, asked a column at a time: the stretches of Z the part
 * fills along a vertical line, worked out once for each 0.25 mm square the
 * tool goes over and kept. A point is then inside when its Z falls in one
 * of its column's stretches — a lookup, where a ray fired up through a
 * million triangles for every point of the cutter made a run take minutes.
 *
 * A point is judged by the column it stands in, which can call one a
 * fraction of a column inside a wall it is really just outside of; how deep
 * a point is, is measured to the real surface afterwards, so that is never
 * reported as a gouge.
 */
export function insideColumns(target) {
  if (!target || !target.surface) return null;
  if (target.columns) return target.columns;
  const index = target.surface;
  const b = index.bounds;
  let cache = new Map();
  const fn = (x, y, z) => {
    if (x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5]) return false;
    const i = Math.floor((x - b[0]) / COLUMN);
    const j = Math.floor((y - b[1]) / COLUMN);
    const key = j * 4194304 + i;
    let runs = cache.get(key);
    if (!runs) {
      if (cache.size >= COLUMN_CAP) cache = new Map();
      runs = lineInside(index, 2, b[0] + (i + 0.5) * COLUMN, b[1] + (j + 0.5) * COLUMN);
      cache.set(key, runs);
    }
    for (let k = 0; k + 1 < runs.length; k += 2) {
      if (z < runs[k]) return false;
      if (z <= runs[k + 1]) return true;
    }
    return false;
  };
  target.columns = fn;
  return fn;
}

const RINGS = [[1, 16], [0.5, 8]];
/** How far round an inside point its depth is looked for first, mm. */
const NEAR = 0.5;

/**
 * The reference part's skyline: the highest any of its triangles stands
 * over each square of a grid laid over the part itself — each triangle
 * counted at its top over every square its outline crosses, so the skyline
 * is never below the part. A disc whose lowest point stands above the
 * skyline under it cannot be touching the part, and that one look is all
 * most of a run ever needs: the holder is above the part nearly all the
 * time, and asking the surface how far away it is, on a million
 * triangles, is what made a run sixty times slower.
 *
 * Built from the part and not from the stock's grid, so it is there
 * whether or not a stock covers the part.
 *
 * @param {object} target anything with a surface index
 */
export function referenceSkyline(target) {
  if (!target || !target.surface) return null;
  if (target.skyline !== undefined) return target.skyline;
  const { tris, count, bounds } = target.surface;
  const span = Math.max(bounds[3] - bounds[0], bounds[4] - bounds[1], 1e-6);
  const cell = Math.max(4, span / 512);
  const bx = Math.max(1, Math.ceil((bounds[3] - bounds[0]) / cell) + 1);
  const by = Math.max(1, Math.ceil((bounds[4] - bounds[1]) / cell) + 1);
  const max = new Float32Array(bx * by).fill(-Infinity);
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]), x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
    const y0 = Math.min(tris[o + 1], tris[o + 4], tris[o + 7]), y1 = Math.max(tris[o + 1], tris[o + 4], tris[o + 7]);
    const z1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
    const i0 = Math.floor((x0 - bounds[0]) / cell), i1 = Math.floor((x1 - bounds[0]) / cell);
    const j0 = Math.floor((y0 - bounds[1]) / cell), j1 = Math.floor((y1 - bounds[1]) / cell);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) if (z1 > max[j * bx + i]) max[j * bx + i] = z1;
    }
  }
  target.skyline = { ox: bounds[0], oy: bounds[1], size: [cell, cell], bx, by, max, off: false, top: bounds[5] };
  return target.skyline;
}

/** The highest the part stands anywhere over a box in XY, or -Infinity. */
export function skylineOver(sky, x0, y0, x1, y1) {
  const i0 = Math.floor((x0 - sky.ox) / sky.size[0]);
  const i1 = Math.floor((x1 - sky.ox) / sky.size[0]);
  const j0 = Math.floor((y0 - sky.oy) / sky.size[1]);
  const j1 = Math.floor((y1 - sky.oy) / sky.size[1]);
  if (sky.off && (i0 < 0 || j0 < 0 || i1 >= sky.bx || j1 >= sky.by)) return sky.top;
  let m = -Infinity;
  for (let j = Math.max(0, j0); j <= Math.min(sky.by - 1, j1); j++) {
    for (let i = Math.max(0, i0); i <= Math.min(sky.bx - 1, i1); i++) if (sky.max[j * sky.bx + i] > m) m = sky.max[j * sky.bx + i];
  }
  return m;
}

/** Two directions square to the tool and to each other. */
function across(dir) {
  const [x, y, z] = dir;
  // Whichever world axis is least along the tool, crossed with it.
  const a = Math.abs(x) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [y * a[2] - z * a[1], z * a[0] - x * a[2], x * a[1] - y * a[0]];
  const n = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / n, u[1] / n, u[2] / n];
  const v = [y * u[2] - z * u[1], z * u[0] - x * u[2], x * u[1] - y * u[0]];
  return [u, v];
}

/**
 * @param {number[]} spheres the assembly's outline, [z along the tool, radius, …]
 * @param {number[]} tip
 * @param {number[]} dir up the tool
 * @param {object} index the reference part's surface index
 * @param {{skipBelow:number, clearance:number, closed:boolean}} opts
 * @returns {null|{gap:number, depth:number, clearance:number, point:number[]}}
 *   the worst place, when it is in the part (gap < 0) or nearer than asked
 */
export function checkReference(spheres, tip, dir, index, { skipBelow = 0, skipAbove = Infinity, clearance = 0, closed = true, sky = null, inside = null } = {}) {
  if (!index || !spheres.length) return null;
  const want = Math.max(clearance, 0);
  const b = index.bounds;
  const [u, v] = across(dir);
  // How far below its centre a disc reaches when the tool leans.
  const drop = Math.sqrt(Math.max(0, 1 - dir[2] * dir[2]));
  let worst = null;
  const isIn = (x, y, z) => closed && (inside ? inside(x, y, z) : insideSolid(index, x, y, z));
  // Asked only whether it is in the part — no room wanted — a point
  // outside costs one lookup, and only a point inside is measured.
  const quick = !!inside && want <= 0;
  const consider = (x, y, z, reach) => {
    const into = isIn(x, y, z);
    if (!into && quick) return;
    // Inside, the depth is looked for close by first: a point just inside
    // a wall — most of them, a cutter running along a hole — is measured
    // within half a millimetre, and only one deeper than that needs the
    // long search.
    let d = nearestWithin(index, x, y, z, into ? Math.min(NEAR, reach) : Math.max(want, 1e-9));
    if (into && !Number.isFinite(d) && reach > NEAR) d = nearestWithin(index, x, y, z, reach);
    if (!into && !(d < want)) return;
    const gap = into ? -(Number.isFinite(d) ? d : reach) : d;
    if (!worst || gap < worst.gap) worst = { gap, depth: Math.max(-gap, 0), clearance: want, point: [x, y, z] };
  };

  for (let i = 0; i < spheres.length; i += 2) {
    const lz = spheres[i];
    const r = spheres[i + 1];
    if (lz < skipBelow - 1e-9 || lz > skipAbove + 1e-9) continue;
    const cx = tip[0] + dir[0] * lz;
    const cy = tip[1] + dir[1] * lz;
    const cz = tip[2] + dir[2] * lz;
    const m = r + want + 1e-6;
    if (cx < b[0] - m || cy < b[1] - m || cz < b[2] - m || cx > b[3] + m || cy > b[4] + m || cz > b[5] + m) continue;
    if (sky && cz - r * drop > skylineOver(sky, cx - m, cy - m, cx + m, cy + m) + want + 0.05) continue;
    const near = quick ? 0 : nearestWithin(index, cx, cy, cz, m);
    if (!Number.isFinite(near)) {
      // Nothing within the disc's reach: clear of the part, or inside it
      // all round.
      if (closed && (!worst || -r < worst.gap) && isIn(cx, cy, cz)) {
        worst = { gap: -r, depth: r, clearance: want, point: [cx, cy, cz] };
      }
      continue;
    }
    const reach = Math.max(r, 1) + want + 1;
    consider(cx, cy, cz, reach);
    for (const [f, n] of RINGS) {
      const rr = r * f;
      if (rr < 1e-6) continue;
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        const c = Math.cos(a) * rr, s = Math.sin(a) * rr;
        consider(cx + u[0] * c + v[0] * s, cy + u[1] * c + v[1] * s, cz + u[2] * c + v[2] * s, reach);
      }
    }
  }
  return worst;
}
