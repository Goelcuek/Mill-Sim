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

import { insideSolid, nearestWithin } from './surfaceIndex.js';

const RINGS = [[1, 16], [0.5, 8]];

/**
 * The reference part's skyline: the highest point of it over each block of
 * the stock grid, each block taking in its neighbours too, so a sliver of
 * part between two column centres is not lost. A disc whose lowest point
 * stands above the skyline under it cannot be touching the part, and that
 * one look is all most of a run ever needs — the holder is above the part
 * nearly all the time, and asking the surface how far away it is, on a
 * million triangles, is what made a run sixty times slower.
 *
 * @param {object} target from buildTargetMap: its top-down map on the grid
 */
export function referenceSkyline(target) {
  if (!target || !target.map || !target.grid) return null;
  if (target.skyline !== undefined) return target.skyline;
  const { ox, oy, dx, dy, nx, ny } = target.grid;
  const per = Math.max(1, Math.round(4 / Math.max(dx, dy)));
  const bx = Math.ceil(nx / per), by = Math.ceil(ny / per);
  const raw = new Float32Array(bx * by).fill(-Infinity);
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    const bj = Math.floor(j / per) * bx;
    for (let i = 0; i < nx; i++) {
      const z = target.map[row + i];
      const k = bj + Math.floor(i / per);
      if (z > raw[k]) raw[k] = z;
    }
  }
  const max = new Float32Array(bx * by).fill(-Infinity);
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      let m = -Infinity;
      for (let q = Math.max(0, j - 1); q <= Math.min(by - 1, j + 1); q++) {
        for (let p = Math.max(0, i - 1); p <= Math.min(bx - 1, i + 1); p++) if (raw[q * bx + p] > m) m = raw[q * bx + p];
      }
      max[j * bx + i] = m;
    }
  }
  const b = target.surface && target.surface.bounds;
  // A part that reaches off the grid has no skyline out there; the top of
  // its bounds stands in for it.
  const off = b ? (b[0] < ox || b[1] < oy || b[3] > ox + nx * dx || b[4] > oy + ny * dy) : false;
  target.skyline = { ox, oy, size: [per * dx, per * dy], bx, by, max, off, top: b ? b[5] : Infinity };
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
export function checkReference(spheres, tip, dir, index, { skipBelow = 0, clearance = 0, closed = true, sky = null } = {}) {
  if (!index || !spheres.length) return null;
  const want = Math.max(clearance, 0);
  const b = index.bounds;
  const [u, v] = across(dir);
  // How far below its centre a disc reaches when the tool leans.
  const drop = Math.sqrt(Math.max(0, 1 - dir[2] * dir[2]));
  let worst = null;
  const consider = (x, y, z, reach) => {
    const inside = closed && insideSolid(index, x, y, z);
    const d = nearestWithin(index, x, y, z, reach);
    if (!inside && !(d < want)) return;
    const gap = inside ? -(Number.isFinite(d) ? d : reach) : d;
    if (!worst || gap < worst.gap) worst = { gap, depth: Math.max(-gap, 0), clearance: want, point: [x, y, z] };
  };

  for (let i = 0; i < spheres.length; i += 2) {
    const lz = spheres[i];
    const r = spheres[i + 1];
    if (lz < skipBelow - 1e-9) continue;
    const cx = tip[0] + dir[0] * lz;
    const cy = tip[1] + dir[1] * lz;
    const cz = tip[2] + dir[2] * lz;
    const m = r + want + 1e-6;
    if (cx < b[0] - m || cy < b[1] - m || cz < b[2] - m || cx > b[3] + m || cy > b[4] + m || cz > b[5] + m) continue;
    if (sky && cz - r * drop > skylineOver(sky, cx - m, cy - m, cx + m, cy + m) + want + 0.05) continue;
    const near = nearestWithin(index, cx, cy, cz, m);
    if (!Number.isFinite(near)) {
      // Nothing within the disc's reach: clear of the part, or inside it
      // all round.
      if (closed && (!worst || -r < worst.gap) && insideSolid(index, cx, cy, cz)) {
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
