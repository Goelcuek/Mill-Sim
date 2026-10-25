import test from 'node:test';
import assert from 'node:assert/strict';

import { Stock } from '../src/sim/stock.js';
import {
  buildTargetMap, compareToTarget, columnDeviation, blockDeviation, pointDeviation, insidePart,
  DEV_OUTSIDE, DEV_JUDGED,
} from '../src/sim/target.js';
import { boxToTriangles, latheToTriangles } from '../src/io/mesh.js';
import { TriDexelStock } from '../src/sim/triDexel.js';
import { dexelTriangles } from '../src/sim/dexelMesh.js';
import { buildTool, makeTool } from '../src/tools/toolDefs.js';

/** A flat reference sheet, as triangles: x 0..20, y 0..20, at height z. */
function plate(z, x0 = 0, x1 = 20, y0 = 0, y1 = 20) {
  return { positions: Float32Array.from([x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z]) };
}

/** The column whose centre is nearest a point. */
const colAt = (stock, x, y) => [Math.floor((x - stock.origin[0]) / stock.dx), Math.floor((y - stock.origin[1]) / stock.dy)];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('a column reads how far it stands from the reference, along the normal', () => {
  const stock = new Stock({ origin: [-10, -10, -10], size: [40, 40, 10], resolution: 1 });
  const target = buildTargetMap(stock, [plate(-2)]);
  // Middle of the plate: untouched stock is 2 mm proud of it.
  const mid = columnDeviation(stock, target, 20, 20);
  assert.equal(mid.state, DEV_JUDGED);
  assert.ok(near(mid.deviation, 2));
  // Cut 0.3 mm too deep there.
  stock.height[20 * stock.nx + 20] = -2.3;
  assert.ok(near(columnDeviation(stock, target, 20, 20).deviation, -0.3));
  // Off the plate, the stock beside it is stock left, by its true distance
  // to the plate's corner — unless that is past the reach asked for.
  const off = columnDeviation(stock, target, 2, 2);
  assert.ok(near(off.deviation, Math.hypot(7.5, 7.5, 2), 1e-4), `${off.deviation}`);
  assert.equal(columnDeviation(stock, target, 2, 2, 0.02, 1).state, DEV_OUTSIDE);
  // On the rim, which the vertical check had to leave out, it is judged.
  const rim = columnDeviation(stock, target, 10, 20);
  assert.equal(rim.state, DEV_JUDGED);
  assert.ok(near(rim.deviation, 2));
});

test('a block shows its worst gouge, else the most material left', () => {
  const stock = new Stock({ origin: [-10, -10, -10], size: [40, 40, 10], resolution: 1 });
  const target = buildTargetMap(stock, [plate(-2)]);
  for (let j = 15; j < 19; j++) for (let i = 15; i < 19; i++) stock.height[j * stock.nx + i] = -2 + 0.01 * (i - 15);
  const left = blockDeviation(stock, target, 15, 19, 15, 19, 0.02);
  assert.equal(left.state, DEV_JUDGED);
  assert.ok(near(left.deviation, 0.03), 'most left wins when nothing is gouged');
  stock.height[16 * stock.nx + 17] = -2.5;
  assert.ok(near(blockDeviation(stock, target, 15, 19, 15, 19, 0.02).deviation, -0.5), 'one gouge shows');
  stock.height[16 * stock.nx + 17] = -2.01;
  assert.ok(blockDeviation(stock, target, 15, 19, 15, 19, 0.02).deviation > 0, 'a gouge inside the tolerance is not one');
  assert.equal(blockDeviation(stock, target, 0, 4, 0, 4, 0.02).state, DEV_OUTSIDE, 'far off the part');
});

test('a pocket wall left thick reads its thickness, not the pocket depth', () => {
  // Floor at -5 everywhere, a wall standing up to 0 for x < 0; the pocket is
  // x > 0. The cut left 0.2 mm on the wall: columns at x 0.05 and 0.15
  // still stand full height.
  const stock = new Stock({ origin: [-10, -10, -10], size: [20, 20, 10], resolution: 0.1 });
  const target = buildTargetMap(stock, [boxToTriangles([-10, -10, -10], [10, 10, -5]), boxToTriangles([-10, -10, -5], [0, 10, 0])]);
  for (let j = 0; j < stock.ny; j++) for (let i = 0; i < stock.nx; i++) {
    if (stock.cx(i) > 0.2) stock.height[j * stock.nx + i] = -5;
  }
  const [i, j] = colAt(stock, 0.15, 0);
  const dev = columnDeviation(stock, target, i, j);
  assert.equal(dev.state, DEV_JUDGED);
  assert.ok(near(dev.deviation, 0.15, 1e-4), `the wall reads ${dev.deviation}, the vertical gap was 5`);
  const cmp = compareToTarget(stock, target, 0.02);
  assert.equal(cmp.gougeCells, 0);
  assert.ok(near(cmp.maxExcess, 0.15, 1e-4), `stock left ${cmp.maxExcess}`);
  assert.equal(cmp.skippedCells, 0, 'nothing is left out any more');
});

test('a slope is measured square to it, not straight down', () => {
  // z = -x over the stock: a 45° face. Every column stands 0.1 mm proud
  // vertically, which is 0.1·cos45 along the normal.
  const stock = new Stock({ origin: [-5, -5, -10], size: [10, 10, 15], resolution: 0.25 });
  const ramp = { positions: Float32Array.from([-6, -6, 6, 6, -6, -6, 6, 6, -6, -6, -6, 6, 6, 6, -6, -6, 6, 6]) };
  const target = buildTargetMap(stock, [ramp]);
  for (let j = 0; j < stock.ny; j++) for (let i = 0; i < stock.nx; i++) stock.height[j * stock.nx + i] = -stock.cx(i) + 0.1;
  const [i, j] = colAt(stock, 0.1, 0.1);
  assert.ok(near(columnDeviation(stock, target, i, j).deviation, 0.1 * Math.SQRT1_2, 1e-4));
});

test('a bore cut oversize is a gouge as deep as the oversize, not the bore', () => {
  // A ring with a Ø5 bore, cut through with a Ø6 drill. The columns in the
  // 0.5 mm sleeve between them reach the stock floor, which is the ring's
  // own underside: measured at the floor they read nothing. The sleeve is
  // a gouge half a millimetre into the wall.
  const ring = latheToTriangles([{ r: 2.5, z: -10 }, { r: 2.5, z: 0 }, { r: 15, z: 0 }, { r: 15, z: -10 }, { r: 2.5, z: -10 }], { segments: 128 });
  const stock = new Stock({ origin: [-12, -12, -10], size: [24, 24, 10], resolution: 0.1 });
  const target = buildTargetMap(stock, [ring]);
  for (let j = 0; j < stock.ny; j++) for (let i = 0; i < stock.nx; i++) {
    stock.height[j * stock.nx + i] = Math.hypot(stock.cx(i), stock.cy(j)) < 3 ? stock.base : 0;
  }
  const [i, j] = colAt(stock, 2.95, 0);
  const dev = columnDeviation(stock, target, i, j);
  assert.ok(dev.deviation < -0.4 && dev.deviation > -0.5, `the sleeve reads ${dev.deviation}`);
  const cmp = compareToTarget(stock, target, 0.02);
  assert.ok(cmp.maxGouge > 0.4 && cmp.maxGouge <= 0.5, `max gouge ${cmp.maxGouge}`);
  // And the bore itself, where the part never was, is air.
  const [ci, cj] = colAt(stock, 0.05, 0.05);
  assert.equal(columnDeviation(stock, target, ci, cj).state, DEV_OUTSIDE);
});

// ---- in three dimensions ----------------------------------------------------

test('in 3D a point under an overhang of the part is outside it, measured to the nearest face', () => {
  // A base, a post at one end and a roof over the lot: a slot under the roof
  // that a top-down view takes for solid.
  const parts = [
    boxToTriangles([0, 0, -10], [20, 20, -8]),
    boxToTriangles([0, 0, -8], [4, 20, 0]),
    boxToTriangles([0, 0, 0], [20, 20, 2]),
  ];
  const stock = new Stock({ origin: [-5, -5, -10], size: [30, 30, 15], resolution: 0.5 });
  const target = buildTargetMap(stock, parts);
  assert.ok(target.closed, 'boxes are closed solids');
  assert.equal(insidePart(target, 10, 10, -4), false, 'under the roof is air');
  const slot = pointDeviation(target, 10, 10, -4);
  assert.equal(slot.state, DEV_JUDGED);
  assert.ok(near(slot.deviation, 4, 1e-6), `stock left in the slot: ${slot.deviation}`);
  assert.ok(near(pointDeviation(target, 10, 10, 1).deviation, -1, 1e-6), 'a cut into the roof');
  assert.ok(near(pointDeviation(target, 2, 10, -4).deviation, -2, 1e-6), 'a cut into the post');
  assert.ok(near(pointDeviation(target, 10, 10, 3).deviation, 1, 1e-6), 'stock over the roof');
  // Over the part but further than the reach: stock left, beyond the scale.
  const high = pointDeviation(target, 10, 10, 9, 2);
  assert.ok(high.beyond && high.deviation === 2);
  // Off the part's footprint and out of reach: none of its business.
  assert.equal(pointDeviation(target, -4.5, -4.5, -9, 1).state, DEV_OUTSIDE);
});

test('an open sheet has only a top: under it is inside', () => {
  const stock = new Stock({ origin: [-10, -10, -10], size: [40, 40, 10], resolution: 1 });
  const target = buildTargetMap(stock, [plate(-2)]);
  assert.equal(target.closed, false);
  assert.ok(near(pointDeviation(target, 10, 10, -2.3).deviation, -0.3, 1e-6));
  assert.ok(near(pointDeviation(target, 10, 10, -1.6).deviation, 0.4, 1e-6));
});

test('a side hole in the part: undersize reads stock left on its wall, oversize a gouge', () => {
  const tool = (d) => buildTool(makeTool({ type: 'flat', diameter: d, fluteLength: 40 }));
  const make = () => new TriDexelStock({ origin: [-20, -20, -30], size: [40, 40, 30], resolution: 0.25 });
  // The finished part: a Ø6 hole 20 deep into the right face, 15 down.
  const part = make();
  part.carveLinear(tool(6).cutEnvelope, [25, 0, -15], [0, 0, -15], [1, 0, 0], 0);
  const reference = { positions: dexelTriangles(part).positions };
  for (const [d, want] of [[5.4, 0.3], [6.6, -0.3]]) {
    const cut = make();
    cut.carveLinear(tool(d).cutEnvelope, [25, 0, -15], [0, 0, -15], [1, 0, 0], 0);
    const target = buildTargetMap(cut, [reference]);
    assert.ok(target.closed, 'the reference is a closed solid');
    // Round the wall of the hole that was cut, halfway in.
    const r = d / 2;
    for (const a of [0, 1, 2, 3, 4, 5]) {
      const t = (a / 6) * 2 * Math.PI + 0.1;
      const dev = pointDeviation(target, 10, r * Math.cos(t), -15 + r * Math.sin(t));
      assert.equal(dev.state, DEV_JUDGED);
      assert.ok(Math.abs(dev.deviation - want) < 0.03, `Ø${d} at ${a}: ${dev.deviation} (want ${want})`);
    }
    // Straight down, the top over the hole reads its own distance to the
    // part's top face, not the hole under it.
    assert.ok(Math.abs(pointDeviation(target, 10, 0, 0.5).deviation - 0.5) < 0.03);
  }
});
