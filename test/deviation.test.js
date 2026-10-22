import test from 'node:test';
import assert from 'node:assert/strict';

import { Stock } from '../src/sim/stock.js';
import {
  buildTargetMap, columnDeviation, blockDeviation, DEV_OUTSIDE, DEV_WALL, DEV_JUDGED,
} from '../src/sim/target.js';

/** A flat reference plate, as triangles: x 0..20, y 0..20, top at z. */
function plate(z, x0 = 0, x1 = 20, y0 = 0, y1 = 20) {
  return { positions: Float32Array.from([x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z]) };
}

test('a column reads how far it stands above or below the reference', () => {
  const stock = new Stock({ origin: [-10, -10, -10], size: [40, 40, 10], resolution: 1 });
  const target = buildTargetMap(stock, [plate(-2)]);
  // Middle of the plate: untouched stock is 2 mm proud of it.
  const mid = columnDeviation(stock, target, 20, 20);
  assert.equal(mid.state, DEV_JUDGED);
  assert.ok(Math.abs(mid.deviation - 2) < 1e-6);
  // Cut it 0.3 mm too deep there.
  stock.height[20 * stock.nx + 20] = -2.3;
  assert.ok(Math.abs(columnDeviation(stock, target, 20, 20).deviation + 0.3) < 1e-6);
  // Off the plate, and on its rim.
  assert.equal(columnDeviation(stock, target, 2, 2).state, DEV_OUTSIDE);
  assert.equal(columnDeviation(stock, target, 10, 20).state, DEV_WALL);
});

test('a block shows its worst gouge, else the most material left', () => {
  const stock = new Stock({ origin: [-10, -10, -10], size: [40, 40, 10], resolution: 1 });
  const target = buildTargetMap(stock, [plate(-2)]);
  for (let j = 15; j < 19; j++) for (let i = 15; i < 19; i++) stock.height[j * stock.nx + i] = -2 + 0.01 * (i - 15);
  const left = blockDeviation(stock, target, 15, 19, 15, 19, 0.02);
  assert.equal(left.state, DEV_JUDGED);
  assert.ok(Math.abs(left.deviation - 0.03) < 1e-6, 'most left wins when nothing is gouged');
  stock.height[16 * stock.nx + 17] = -2.5;
  assert.ok(Math.abs(blockDeviation(stock, target, 15, 19, 15, 19, 0.02).deviation + 0.5) < 1e-6, 'one gouge shows');
  // A gouge inside the tolerance is not one.
  stock.height[16 * stock.nx + 17] = -2.01;
  assert.ok(blockDeviation(stock, target, 15, 19, 15, 19, 0.02).deviation > 0);
  // Blocks that are all wall, or all outside.
  assert.equal(blockDeviation(stock, target, 10, 11, 12, 14, 0.02).state, DEV_WALL);
  assert.equal(blockDeviation(stock, target, 0, 4, 0, 4, 0.02).state, DEV_OUTSIDE);
});
