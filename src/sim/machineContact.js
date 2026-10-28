// The machine against itself: a head casting against the table, a cradle,
// a cheek — or the part.
//
// Every solid here is convex (a box, a cylinder or cone) or the skin of an
// imported body, and each lives in the frame of the axis that carries it.
// Two of them are compared where they could touch at all: the box round
// one, carried into the other's frame, cuts down the part of its surface
// worth looking at; that part is sampled, and each sample's signed
// distance to the other is measured exactly. Then the same the other way
// round, so a corner of either poking into a face of the other is found.
//
// Sampling, rather than an exact solid-against-solid test, keeps one way
// of asking for boxes, cylinders and triangles alike. The spacing follows
// the size of the overlap, so a touch is found to a fraction of a
// millimetre wherever two castings actually meet, and a glancing pass over
// a large face costs no more than a few hundred samples.

import * as m4 from '../core/mat4.js';
import { pointConeDistance, meshDistance } from './collision.js';

/** Samples across an overlap, each way. */
const SAMPLES = 24;
/** Never finer than this, mm. */
const FINEST = 0.5;

/** Signed distance from a box centred on the origin. Negative inside. */
function boxDistance(x, y, z, h) {
  const dx = Math.abs(x) - h[0];
  const dy = Math.abs(y) - h[1];
  const dz = Math.abs(z) - h[2];
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
  return outside + Math.min(Math.max(dx, dy, dz), 0);
}

function apply(m, x, y, z, out) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/**
 * How a solid sits for one pose of the chain: the matrices between the
 * scene and its own frames, and its box in the scene.
 *
 * @param {object} s     a solid, as Simulator.setCastings keeps it
 * @param {ArrayLike<number>} world  its axis's matrix in the scene
 */
export function placeSolid(s, world) {
  const fromNode = m4.invertRigid(m4.create(), world);
  // Into the frame its distance is measured in, and into its box's.
  const toQuery = s.kind === 'mesh' ? fromNode : m4.multiply(m4.create(), s.toLocal, fromNode);
  const toBox = m4.multiply(m4.create(), s.toBox, fromNode);
  const fromBox = m4.invertRigid(m4.create(), toBox);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const q = [0, 0, 0];
  const h = s.boxHalf;
  for (let c = 0; c < 8; c++) {
    apply(fromBox, c & 1 ? h[0] : -h[0], c & 2 ? h[1] : -h[1], c & 4 ? h[2] : -h[2], q);
    for (let k = 0; k < 3; k++) {
      if (q[k] < lo[k]) lo[k] = q[k];
      if (q[k] > hi[k]) hi[k] = q[k];
    }
  }
  return { s, toQuery, toBox, fromBox, lo, hi };
}

/** Do two scene boxes come within `pad` of each other? */
export function boxesMeet(a, b, pad) {
  for (let k = 0; k < 3; k++) if (a.lo[k] - pad > b.hi[k] || b.lo[k] - pad > a.hi[k]) return false;
  return true;
}

/** Signed distance from a scene point to a placed solid (unsigned for a mesh). */
function distanceTo(P, x, y, z, reach) {
  const q = apply(P.toQuery, x, y, z, [0, 0, 0]);
  const s = P.s;
  if (s.kind === 'box') return boxDistance(q[0], q[1], q[2], s.half);
  if (s.kind === 'cyl') return pointConeDistance(q[0], q[1], q[2], s.r0, s.r1, s.h);
  return meshDistance(s.grid, q[0], q[1], q[2], reach);
}

/**
 * The part of P's box, in P's box frame, that the scene box `lo`–`hi`
 * (grown by pad) overlaps — or null.
 */
function overlapIn(P, lo, hi, pad) {
  const a = [Infinity, Infinity, Infinity];
  const b = [-Infinity, -Infinity, -Infinity];
  const q = [0, 0, 0];
  for (let c = 0; c < 8; c++) {
    apply(P.toBox, c & 1 ? hi[0] + pad : lo[0] - pad, c & 2 ? hi[1] + pad : lo[1] - pad, c & 4 ? hi[2] + pad : lo[2] - pad, q);
    for (let k = 0; k < 3; k++) {
      if (q[k] < a[k]) a[k] = q[k];
      if (q[k] > b[k]) b[k] = q[k];
    }
  }
  const h = P.s.boxHalf;
  for (let k = 0; k < 3; k++) {
    a[k] = Math.max(a[k], -h[k]);
    b[k] = Math.min(b[k], h[k]);
    if (a[k] > b[k]) return null;
  }
  return { a, b };
}

const steps = (from, to, sp) => {
  const n = Math.max(1, Math.ceil((to - from) / sp));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(from + ((to - from) * i) / n);
  return out;
};

/**
 * Points on P's surface inside the region (P's box frame), handed to
 * `visit` in the scene. Stops early when visit returns true.
 */
function eachSurfacePoint(P, region, visit) {
  const { a, b } = region;
  const sp = Math.max(FINEST, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / SAMPLES);
  const s = P.s;
  const w = [0, 0, 0];
  const emit = (x, y, z) => { apply(P.fromBox, x, y, z, w); return visit(w[0], w[1], w[2]); };
  if (s.kind === 'box') {
    const h = s.half;
    for (let k = 0; k < 3; k++) {
      const u = (k + 1) % 3;
      const v = (k + 2) % 3;
      for (const sign of [-1, 1]) {
        const f = sign * h[k];
        if (f < a[k] || f > b[k]) continue;
        for (const pu of steps(a[u], b[u], sp)) {
          for (const pv of steps(a[v], b[v], sp)) {
            const p = [0, 0, 0];
            p[k] = f; p[u] = pu; p[v] = pv;
            if (emit(p[0], p[1], p[2])) return;
          }
        }
      }
    }
    return;
  }
  if (s.kind === 'cyl') {
    const hh = s.h / 2;
    const rAt = (y) => s.r0 + ((s.r1 - s.r0) * (y + hh)) / (s.h || 1);
    const inside = (x, z) => x >= a[0] && x <= b[0] && z >= a[2] && z <= b[2];
    for (const y of steps(Math.max(a[1], -hh), Math.min(b[1], hh), sp)) {
      const r = rAt(y);
      const n = Math.max(12, Math.ceil((2 * Math.PI * r) / sp));
      for (let i = 0; i < n; i++) {
        const t = (2 * Math.PI * i) / n;
        const x = r * Math.cos(t);
        const z = r * Math.sin(t);
        if (inside(x, z) && emit(x, y, z)) return;
      }
    }
    for (const y of [-hh, hh]) {
      if (y < a[1] || y > b[1]) continue;
      const R = rAt(y);
      for (const r of steps(0, R, sp)) {
        const n = Math.max(1, Math.ceil((2 * Math.PI * r) / sp));
        for (let i = 0; i < n; i++) {
          const t = (2 * Math.PI * i) / n;
          const x = r * Math.cos(t);
          const z = r * Math.sin(t);
          if (inside(x, z) && emit(x, y, z)) return;
        }
      }
    }
    return;
  }
  // A mesh: its triangles, sampled across, where they cross the region.
  const t = s.tris;
  const box = P.s.toBox;
  const q = [0, 0, 0];
  const corner = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let o = 0; o + 8 < t.length; o += 9) {
    let out = false;
    for (let c = 0; c < 3; c++) apply(box, t[o + 3 * c], t[o + 3 * c + 1], t[o + 3 * c + 2], corner[c]);
    for (let k = 0; k < 3 && !out; k++) {
      const mn = Math.min(corner[0][k], corner[1][k], corner[2][k]);
      const mx = Math.max(corner[0][k], corner[1][k], corner[2][k]);
      if (mx < a[k] || mn > b[k]) out = true;
    }
    if (out) continue;
    const e1 = Math.hypot(corner[1][0] - corner[0][0], corner[1][1] - corner[0][1], corner[1][2] - corner[0][2]);
    const e2 = Math.hypot(corner[2][0] - corner[0][0], corner[2][1] - corner[0][1], corner[2][2] - corner[0][2]);
    const n = Math.min(64, Math.max(1, Math.ceil(Math.max(e1, e2) / sp)));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n;
        const v = j / n;
        for (let k = 0; k < 3; k++) q[k] = corner[0][k] + (corner[1][k] - corner[0][k]) * u + (corner[2][k] - corner[0][k]) * v;
        if (q[0] < a[0] || q[0] > b[0] || q[1] < a[1] || q[1] > b[1] || q[2] < a[2] || q[2] > b[2]) continue;
        if (emit(q[0], q[1], q[2])) return;
      }
    }
  }
}

/**
 * How close two placed solids come: the least signed distance found from
 * either one's surface to the other — negative when they overlap, by about
 * how far — and where. Null when they are further apart than `pad`. Two
 * imported meshes have only skins to go on, and touch at no more than 0.
 *
 * @returns {null | {gap:number, point:number[]}}
 */
export function solidContact(P, Q, pad) {
  if (!boxesMeet(P, Q, pad)) return null;
  let best = null;
  const look = (A, B) => {
    const region = overlapIn(A, B.lo, B.hi, pad);
    if (!region) return;
    eachSurfacePoint(A, region, (x, y, z) => {
      const d = distanceTo(B, x, y, z, pad + 1);
      if (d < pad && (!best || d < best.gap)) best = { gap: d, point: [x, y, z] };
      return false;
    });
  };
  look(P, Q);
  look(Q, P);
  return best;
}

/**
 * A placed solid against the stock: the deepest any of its surface goes
 * into material, measured along the Z line through the point, which is
 * how far it would have to rise to be clear.
 *
 * @param {ArrayLike<number>} fromScene  the scene into the part's frame
 * @param {ArrayLike<number>} toScene    the other way
 * @returns {null | {depth:number, point:number[]}}  point in the part frame
 */
export function solidIntoStock(P, stock, fromScene, toScene) {
  const lo = [stock.origin[0], stock.origin[1], stock.base];
  const hi = [stock.origin[0] + stock.size[0], stock.origin[1] + stock.size[1], stock.top];
  // The stock's box in the scene.
  const slo = [Infinity, Infinity, Infinity];
  const shi = [-Infinity, -Infinity, -Infinity];
  const q = [0, 0, 0];
  for (let c = 0; c < 8; c++) {
    apply(toScene, c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2], q);
    for (let k = 0; k < 3; k++) {
      if (q[k] < slo[k]) slo[k] = q[k];
      if (q[k] > shi[k]) shi[k] = q[k];
    }
  }
  if (!boxesMeet(P, { lo: slo, hi: shi }, 0)) return null;
  const region = overlapIn(P, slo, shi, 0);
  if (!region) return null;
  let best = null;
  eachSurfacePoint(P, region, (x, y, z) => {
    apply(fromScene, x, y, z, q);
    for (const [s, e] of stock.stretchesAt(2, q)) {
      if (q[2] > s && q[2] < e) {
        const depth = Math.min(e - q[2], q[2] - s);
        if (!best || depth > best.depth) best = { depth, point: q.slice() };
      }
    }
    return false;
  });
  return best;
}
