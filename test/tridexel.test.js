// The tri-dexel model against answers worked out by hand.
//
// A heightmap keeps the top of each column and nothing under it. These
// check that a model keeping the material along X, Y and Z holds what a
// heightmap cannot — a hole from the side, a tunnel under a ledge, a wall
// leaning under itself — and that where both can answer, they agree.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TriDexelStock } from '../src/sim/triDexel.js';
import { Stock } from '../src/sim/stock.js';
import { buildTool, makeTool } from '../src/tools/toolDefs.js';
import { buildProfile } from '../src/tools/profile.js';

const tool = (def) => buildTool(makeTool(def));
const flat6 = tool({ type: 'flat', diameter: 6, fluteLength: 40 });
const flat10 = tool({ type: 'flat', diameter: 10, fluteLength: 30 });
const ball6 = tool({ type: 'ball', diameter: 6, fluteLength: 20 });
const drill8 = tool({ type: 'drill', diameter: 8, fluteLength: 40, tipAngle: 118 });
const lolly6 = tool({ type: 'lollipop', diameter: 6 });

const block = (res = 0.1, size = [40, 40, 30]) => new TriDexelStock({
  origin: [-size[0] / 2, -size[1] / 2, -size[2]], size, resolution: res,
});
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

test('profiles are exact pieces: a ball nose is a sphere, not a polyline', () => {
  const p = buildProfile(ball6.cuttingPoints);
  assert.equal(p.pieces[2], 1, 'the first piece is a sphere');
  near(p.radiusAt(1), Math.sqrt(9 - 4), 1e-12, 'radius one above the tip');
  const out = [0, 0];
  // A line across the ball one above the tip, the tool upright at the origin.
  assert.ok(p.hit(-10, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, out));
  near(out[0] - 10, -Math.sqrt(5), 1e-12, 'enters');
  near(out[1] - 10, Math.sqrt(5), 1e-12, 'leaves');
  assert.ok(p.convex);
  assert.ok(buildProfile(lolly6.cuttingPoints).convex);
  assert.equal(buildProfile(lolly6.cuttingPoints).upperConstant, false, 'a lollipop closes over at the top');
});

test('a hole drilled from the side leaves the top alone and the metal over it', () => {
  const td = block(0.1);
  // A Ø6 flat end pointing along -X, centre 15 below the top, 20 into the block.
  const r = td.carveLinear(flat6.cutEnvelope, [25, 0, -15], [0, 0, -15], [1, 0, 0], 0);
  near(r.volume, Math.PI * 9 * 20, 565.49 * 0.003, 'volume of the hole');
  near(td.heightAt(10, 0), 0, 1e-9, 'the top over the hole');
  const z = td.stretchesAt(2, [10.05, 0.05, 0]);
  assert.equal(z.length, 2, 'the Z line through the hole has metal above and below it');
  near(z[0][1], -15 - Math.sqrt(9 - 0.05 ** 2), 1e-4, 'bottom of the hole');
  near(z[1][0], -15 + Math.sqrt(9 - 0.05 ** 2), 1e-4, 'top of the hole');
  // Along the hole the line stops where the tip did.
  const x = td.stretchesAt(0, [0, 0.05, -14.95]);
  assert.deepEqual(x.length, 1);
  near(x[0][1], 0, 1e-4, 'the end of the hole, on the line along it');
  // A heightmap is asked the same and loses it.
  const hm = new Stock({ origin: [-20, -20, -30], size: [40, 40, 30], resolution: 0.1 });
  const lost = hm.carveTilted(flat6.cutEnvelope, [10, 0, -15], [1, 0, 0], 40, 0).volume;
  assert.equal(lost, 0, 'which is the reason for all this');
});

test('two holes crossing: the volume of the pair, less the Steinmetz solid they share', () => {
  const td = block(0.1, [40, 40, 30]);
  td.carveLinear(flat6.cutEnvelope, [25, 0, -15], [-25, 0, -15], [1, 0, 0], 0);
  td.carveLinear(flat6.cutEnvelope, [0, 25, -15], [0, -25, -15], [0, 1, 0], 1);
  const r = 3;
  const exact = 2 * Math.PI * r * r * 40 - (16 / 3) * r ** 3;
  const removed = 40 * 40 * 30 - td.remainingVolume();
  near(removed, exact, exact * 0.003, 'two crossing Ø6 holes');
});

test('a lollipop cuts a tunnel under the surface, and the metal over it stays', () => {
  const td = block(0.1);
  // Tool upright, ball centred 10 down, moving along X right through.
  td.carveLinear(lolly6.cutEnvelope, [-25, 0, -13], [25, 0, -13], [0, 0, 1], 0);
  const z = td.stretchesAt(2, [0.05, 0.05, 0]);
  assert.equal(z.length, 2, 'material under and over the tunnel');
  near(z[0][1], -13, 0.01, 'floor of the tunnel');
  near(z[1][0], -7, 0.01, 'roof of the tunnel');
  near(td.heightAt(0, 0), 0, 1e-9, 'the top is untouched');
  const exact = Math.PI * 9 * 40;
  near(40 * 40 * 30 - td.remainingVolume(), exact, exact * 0.003, 'a Ø6 tunnel 40 long');
});

test('walls are where the tool put them, along X and Y as well as down Z', () => {
  for (const res of [0.25, 0.1]) {
    const td = block(res);
    // A 30 x 20 pocket, 5 deep, its walls finished by a Ø10 at x = ±15, y = ±10,
    // placed so the walls fall between grid lines.
    const off = 0.0371;
    const cut = (a, b) => td.carveSweep(flat10.cutEnvelope, a, b, 0);
    const xs = [-10 + off, 10 + off];
    const ys = [-5 + off, 5 + off];
    for (let y = ys[0]; y <= ys[1] + 1e-9; y += 2) cut([xs[0], y, -5], [xs[1], y, -5]);
    cut([xs[0], ys[0], -5], [xs[1], ys[0], -5]);
    cut([xs[1], ys[0], -5], [xs[1], ys[1], -5]);
    cut([xs[1], ys[1], -5], [xs[0], ys[1], -5]);
    cut([xs[0], ys[1], -5], [xs[0], ys[0], -5]);
    // The X line through the middle of the pocket, 2.5 down: wall to wall.
    const x = td.stretchesAt(0, [0, off, -2.5]);
    assert.equal(x.length, 2, `cell ${res}: two pieces of wall on the X line`);
    near(x[0][1], -15 + off, 1e-4, `cell ${res}: left wall from the X line`);
    near(x[1][0], 15 + off, 1e-4, `cell ${res}: right wall from the X line`);
    const y = td.stretchesAt(1, [off, 0, -2.5]);
    near(y[0][1], -10 + off, 1e-4, `cell ${res}: near wall from the Y line`);
    near(y[1][0], 10 + off, 1e-4, `cell ${res}: far wall from the Y line`);
  }
});

test('a wall leaning 20°, cut with the side of a tilted end mill', () => {
  const td = block(0.1);
  const tilt = (20 * Math.PI) / 180;
  const d = [Math.sin(tilt), 0, Math.cos(tilt)];
  // Tip 12 down at x = -8, sweeping along Y right through the block.
  const x0 = -8, z0 = -12;
  td.carveLinear(flat10.cutEnvelope, [x0, -25, z0], [x0, 25, z0], d, 0);
  // The wall on the +X side of the tool is a plane at R from the axis,
  // read off the X line nearest each height — at that line's own height.
  for (const zAsk of [-9, -6, -3]) {
    const z = td.base + (Math.floor((zAsk - td.base) / td.d3[2]) + 0.5) * td.d3[2];
    const want = x0 + ((z - z0) * Math.sin(tilt) + 5) / Math.cos(tilt);
    const x = td.stretchesAt(0, [0, 0.05, z]);
    const wall = x.find((s) => s[0] > -15)[0];
    near(wall, want, 2e-3, `the leaning wall at z = ${z}`);
  }
  // Under the leaning side of the cutter, metal over air: the heightmap's
  // one surface a column cannot hold this.
  const xLow = x0 + ((-11 - z0) * Math.sin(tilt) + 5) / Math.cos(tilt) - 0.3;
  const z = td.stretchesAt(2, [xLow, 0.05, 0]);
  assert.ok(z.length >= 1);
});

test('a tilted ball reaches exactly as low as its sphere', () => {
  const td = block(0.1);
  const d = unit([0.3, -0.4, 0.8]);
  const tip = [1.23, -2.34, -5];
  td.carveLinear(ball6.cutEnvelope, tip, tip, d, 0);
  const c = tip.map((v, k) => v + 3 * d[k]);
  const z = td.stretchesAt(2, [c[0], c[1], 0]);
  // The Z line nearest the centre: its lowest cut is the bottom of the ball
  // at that line, which is within a cell of the centre.
  const gx = Math.floor((c[0] + 20) / td.dx), gy = Math.floor((c[1] + 20) / td.dy);
  const lx = -20 + (gx + 0.5) * td.dx, ly = -20 + (gy + 0.5) * td.dy;
  const want = c[2] - Math.sqrt(9 - (lx - c[0]) ** 2 - (ly - c[1]) ** 2);
  near(z[0][1], want, 1e-4, 'the bottom of the tilted ball');
});

test('a hole at a compound angle is round', () => {
  const td = block(0.1, [40, 40, 40]);
  const d = unit([1, 1, 1]);
  const entry = [0, 0, -20];
  td.carveLinear(flat6.cutEnvelope, entry.map((v, k) => v + 30 * d[k]), entry.map((v, k) => v - 10 * d[k]), d, 0);
  // Points on circles round the axis: inside 2.9 from it is air, outside 3.1 is metal.
  const n1 = unit([1, -1, 0]);
  const n2 = [d[1] * n1[2] - d[2] * n1[1], d[2] * n1[0] - d[0] * n1[2], d[0] * n1[1] - d[1] * n1[0]];
  let wrong = 0;
  for (let s = -5; s <= 5; s += 2.5) {
    for (let k = 0; k < 24; k++) {
      const th = (k / 24) * 2 * Math.PI;
      for (const [rad, metal] of [[2.85, false], [3.15, true]]) {
        const p = entry.map((v, m) => v + s * d[m] + rad * (Math.cos(th) * n1[m] + Math.sin(th) * n2[m]));
        if (td.inside(p[0], p[1], p[2]) !== metal) wrong++;
      }
    }
  }
  assert.equal(wrong, 0, `${wrong} points on the wrong side of a Ø6 hole along (1, 1, 1)`);
});

test('a drill plunge leaves its point at the bottom and its width on the side lines', () => {
  const td = block(0.1);
  td.carveSweep(drill8.cutEnvelope, [0.05, 0.05, 5], [0.05, 0.05, -10], 0);
  const rise = 4 / Math.tan((59 * Math.PI) / 180);
  const z = td.stretchesAt(2, [0.05, 0.05, 0]);
  near(z[0][1], -10, 1e-3, 'the point');
  // An X line through the axis, about half way up the cone: the cone's
  // radius at that line's own height.
  const zc = td.base + (Math.floor((-10 + rise / 2 - td.base) / td.d3[2]) + 0.5) * td.d3[2];
  const radius = (zc + 10) * Math.tan((59 * Math.PI) / 180);
  const x = td.stretchesAt(0, [0, 0.05, zc]);
  near(x[0][1], 0.05 - radius, 2e-3, 'the cone, half way up, seen along X');
  near(x[1][0], 0.05 + radius, 2e-3, 'and on the other side');
});

test('every exact sweep agrees with stamping it eight hundred times', () => {
  // The closed forms and the searches against brute force, on moves that
  // use each of them: along the tool axis, square to it, a plunge, a ramp,
  // a leaning tool along a line at an angle to it.
  const cases = [
    ['flat 3-axis', flat10, [-12, -3, -4], [9, 4, -4], [0, 0, 1]],
    ['ball ramp', ball6, [-10, -2, -1], [10, 3, -6], [0, 0, 1]],
    ['drill plunge', drill8, [1, 1, 2], [1, 1, -12], [0, 0, 1]],
    ['lollipop ramp', lolly6, [-8, 0, -6], [8, 2, -9], [0, 0, 1]],
    ['side ramp', flat6, [24, -2, -10], [4, 3, -13], [1, 0, 0]],
    ['leaning ball', ball6, [-8, -6, -6], [7, 5, -8], unit([0.2, -0.3, 0.9])],
    ['drill ramp', drill8, [-9, -4, 1], [8, 5, -9], [0, 0, 1]],
    ['bull nose ramp', tool({ type: 'bull', diameter: 10, cornerRadius: 1.5, fluteLength: 25 }), [-9, 3, -1], [9, -4, -7], [0, 0, 1]],
    ['short ball ramp', tool({ type: 'ball', diameter: 10, fluteLength: 6 }), [-9, -2, -2], [9, 3, -7], [0, 0, 1]],
  ];
  for (const [name, t, a, b, d] of cases) {
    const exact = block(0.25);
    const stamped = block(0.25);
    exact.carveLinear(t.cutEnvelope, a, b, d, 0);
    const n = 800;
    for (let k = 0; k <= n; k++) {
      const p = a.map((v, m) => v + ((b[m] - v) * k) / n);
      stamped.carveLinear(t.cutEnvelope, p, p, d, 0);
    }
    for (let f = 0; f < 3; f++) {
      const ve = exact.familyVolume(exact.fam[f]);
      const vs = stamped.familyVolume(stamped.fam[f]);
      near(ve, vs, 0.02 + 1e-5 * ve, `${name}: volume along ${'XYZ'[f]}`);
    }
  }
});

test('on a 3-axis job the heightmap and the tri-dexel agree', () => {
  const hm = new Stock({ origin: [-30, -20, -20], size: [60, 40, 20], resolution: 0.25 });
  const td = new TriDexelStock({ origin: [-30, -20, -20], size: [60, 40, 20], resolution: 0.25 });
  const moves = [];
  for (let y = -12; y <= 12; y += 3) moves.push([[-20, y, -3], [20, y, -3]]);
  for (let y = -10; y <= 10; y += 0.5) moves.push([[-10, y, -1], [10, y + 0.3, -6]]);
  for (const [a, b] of moves) {
    hm.carveSweep(ball6.cutEnvelope, a, b, 0);
    td.carveSweep(ball6.cutEnvelope, a, b, 0);
  }
  near(td.remainingVolume(), hm.remainingVolume(), hm.remainingVolume() * 1e-4, 'what is left');
  // Where the two tops differ at all, it is on the ball's steep flanks,
  // and the exact answer — the lowest the true sphere reaches over the
  // column, by brute force — says which is right.
  const exactTop = (x, y) => {
    let best = 0;
    for (const [a, b] of moves) {
      const f = (u) => {
        const cx = a[0] + (b[0] - a[0]) * u, cy = a[1] + (b[1] - a[1]) * u, cz = a[2] + (b[2] - a[2]) * u + 3;
        const r2 = (x - cx) ** 2 + (y - cy) ** 2;
        return r2 >= 9 ? Infinity : cz - Math.sqrt(9 - r2);
      };
      let bu = 0, bf = Infinity;
      for (let k = 0; k <= 1000; k++) { const v = f(k / 1000); if (v < bf) { bf = v; bu = k / 1000; } }
      let lo = Math.max(0, bu - 1e-3), hi = Math.min(1, bu + 1e-3);
      for (let it = 0; it < 60; it++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (f(m1) < f(m2)) hi = m2; else lo = m1;
      }
      best = Math.min(best, bf, f((lo + hi) / 2));
    }
    return best;
  };
  let differ = 0;
  let worstTd = 0;
  for (let k = 0; k < hm.height.length; k++) {
    if (Math.abs(hm.height[k] - td.height[k]) < 1e-3) continue;
    differ++;
    const want = exactTop(hm.cx(k % hm.nx), hm.cy(Math.floor(k / hm.nx)));
    const errTd = Math.abs(td.height[k] - want);
    worstTd = Math.max(worstTd, errTd);
    assert.ok(errTd <= Math.abs(hm.height[k] - want) + 1e-9, 'the tri-dexel is never the further from the truth');
  }
  assert.ok(differ / hm.height.length < 0.01, `${differ} tops differ`);
  assert.ok(worstTd < 1e-3, `the tri-dexel is within a micron of the true sphere, and was ${worstTd}`);
});

test('a side hole is not a collision for a holder passing over it', () => {
  const td = block(0.25);
  td.carveLinear(flat6.cutEnvelope, [25, 0, -15], [-25, 0, -15], [1, 0, 0], 0);
  // A Ø4 body 2 tall, from 16 to 14 down, fits inside the Ø6 hole.
  const body = buildTool(makeTool({ type: 'flat', diameter: 4, fluteLength: 2 })).cutEnvelope;
  assert.equal(td.probeBody(body, 0, 0, -16), null, 'inside the hole');
  assert.ok(td.probeBody(body, 0, 8, -16), 'beside it, in metal');
});

// ---- gouges found along the lines -----------------------------------------

import { buildTargetMap } from '../src/sim/target.js';

/** A closed box as triangles, outward faces. */
function boxTris(lo, hi) {
  const v = (i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const t = [];
  for (const [a, b, c, d] of faces) t.push(...v(a), ...v(b), ...v(c), ...v(a), ...v(c), ...v(d));
  return Float32Array.from(t);
}

test('a gouge in a wall under the top is found while cutting, at its true depth', () => {
  const td = block(0.25);
  // The part is the block less its right-hand 10 mm: a wall at X10.
  const target = buildTargetMap(td, [{ positions: boxTris([-20, -20, -30], [10, 20, 0]) }]);
  assert.ok(target.closed, 'the reference is a solid');
  const opts = { target, tolerance: 0.02 };
  // From the side, 15 down, to X5: five into the wall, under a top that
  // nothing touched — which is all a look from above can see.
  const r = td.carveLinear(flat6.cutEnvelope, [25, 0, -15], [5, 0, -15], [1, 0, 0], 0, opts);
  assert.ok(r.volume > 0);
  assert.equal(r.gouge, null, 'the tops never changed, so the look from above sees nothing');
  assert.ok(r.gouge3, 'found along the lines');
  near(r.gouge3.depth, 5, 0.3, 'as deep as the cutter went past the wall');
  near(r.gouge3.x, 5, 0.3, 'at the end of the cutter');

  // Stopping 0.01 short of the wall is on size, and says nothing.
  const clean = block(0.25);
  const ok = clean.carveLinear(flat6.cutEnvelope, [25, 0, -15], [10.01, 0, -15], [1, 0, 0], 0, { target: buildTargetMap(clean, [{ positions: boxTris([-20, -20, -30], [10, 20, 0]) }]), tolerance: 0.02 });
  assert.ok(ok.volume > 0);
  assert.equal(ok.gouge3, null);
});

test('a line running just inside a wall is not a deep gouge', () => {
  // Cutting 0.05 into the part's wall along it: every Y line through the
  // cut is inside the part end to end, 40 long — but the cut is 0.05 deep,
  // and that is what is reported.
  const td = block(0.25);
  const target = buildTargetMap(td, [{ positions: boxTris([-20, -20, -30], [10, 20, 0]) }]);
  const r = td.carveLinear(flat6.cutEnvelope, [12.95, -25, -15], [12.95, 25, -15], [0, 0, 1], 0, { target, tolerance: 0.02 });
  assert.ok(r.volume > 0);
  assert.ok(r.gouge3, 'a gouge');
  assert.ok(r.gouge3.depth < 0.3, `reported as ${r.gouge3.depth}, not the length of the line`);
});

test('a body lying flat is not a chain of spheres bulging back past its own faces', () => {
  // A Ø10 shank with a Ø110 nose 100 up it, lying along +Y 30 over the top
  // of the stock (Y−20 to Y20), the nose's face 10 past its far edge. A
  // sphere standing at that face would reach 55 back towards the tip and
  // 25 into the stock; the nose itself is clear of it.
  const td = block(0.25);
  const chain = Float32Array.from([0, 5, 50, 5, 100, 5, 100, 55, 130, 55, 160, 55]);
  const flat = td.probeChain(chain, [0, -70, 30], [0, 1, 0]);
  assert.equal(flat, null, JSON.stringify(flat));
  // Five further on, the nose is over the stock, 25 into it.
  const sunk = td.probeChain(chain, [0, -85, 30], [0, 1, 0]);
  assert.ok(sunk && Math.abs(sunk.depth - 25) < 0.5, JSON.stringify(sunk));
  // Pointing down along −Z from under the block — the tool upside down —
  // the band is taken from above: the nose's face is 100 below the tip.
  const up = td.probeChain(chain, [0, 0, -40], [0, 0, -1]);
  assert.equal(up, null);
});
