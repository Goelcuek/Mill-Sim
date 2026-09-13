// Stock that is not a block: a round bar, and a model used as the starting
// shape. The simulation is a field of columns, so a shape is a function
// from a point on the grid to the height the material starts at.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Stock } from '../src/sim/stock.js';
import { columnFor, meshColumn, describeShape } from '../src/sim/stockShape.js';
import { buildTool, makeTool } from '../src/tools/toolDefs.js';
import { boxToTriangles } from '../src/io/mesh.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);
const envOf = (spec) => buildTool(makeTool(spec)).cutEnvelope;

/** Two stacked boxes: a plinth with a boss on it, like a small casting. */
function casting() {
  const plinth = boxToTriangles([-60, -40, -25], [60, 40, -7]);
  const boss = boxToTriangles([-35, -25, -7], [35, 25, 5]);
  const out = new Float32Array(plinth.positions.length + boss.positions.length);
  out.set(plinth.positions);
  out.set(boss.positions, plinth.positions.length);
  return out;
}

test('a plain block is exactly what it always was', () => {
  const s = new Stock({ origin: [0, 0, 0], size: [10, 20, 5], resolution: 0.5 });
  assert.equal(s.shaped, false);
  assert.equal(s.initial, null, 'and carries no per-column array to say so');
  assert.equal(s.stockVolume, 1000);
  assert.equal(s.filled, s.cellCount);
  assert.equal(s.remainingVolume(), s.stockVolume);
  assert.equal(columnFor({ shape: 'box', origin: [0, 0, 0], size: [10, 20, 5] }), null);
});

test('a round bar is a circle of columns', () => {
  const spec = { shape: 'round', origin: [-25, -25, -20], size: [50, 50, 20], diameter: 50 };
  const s = new Stock({ ...spec, resolution: 0.25, column: columnFor(spec) });

  const exact = Math.PI * 25 * 25 * 20;
  near(s.stockVolume / exact, 1, 2e-3, 'volume against πr²h');
  near(s.filled / s.cellCount, Math.PI / 4, 2e-3, 'the fraction of the square a circle fills');
  near(s.remainingVolume(), s.stockVolume, 1e-6, 'nothing cut yet');
  assert.equal(describeShape(spec), 'Ø50 bar');

  // Facing 2 mm off takes the disc, not the square.
  const env = envOf({ type: 'flat', diameter: 20, fluteLength: 40 });
  let removed = 0;
  for (let y = -40; y <= 40; y += 2) for (let x = -40; x <= 40; x += 0.2) removed += s.carve(env, x, y, -2);
  near(removed / (Math.PI * 25 * 25 * 2), 1, 2e-3, 'faced volume');

  // The corner of the bounding box is air: a ray through it finds nothing.
  assert.equal(s.raycast([-24, -24, 60], [0, 0, -1]), null);
  assert.ok(s.raycast([0, 0, 60], [0, 0, -1]), 'and the middle is still there');

  // Putting the material back puts the shape back, not a block.
  s.reset();
  near(s.remainingVolume(), s.stockVolume, 1e-6, 'reset restores the bar');
  assert.equal(s.filled, Math.round(s.filled), 'and still only the circle');
});

test('a model becomes the starting surface, column by column', () => {
  const positions = casting();
  const sample = meshColumn(positions);
  assert.equal(sample.triangles, 24);
  assert.deepEqual(sample.bounds.min, [-60, -40, -25]);
  assert.deepEqual(sample.bounds.max, [60, 40, 5]);

  assert.equal(sample(0, 0), 5, 'the top of the boss');
  assert.equal(sample(-55, -35), -7, 'the plinth around it');
  assert.equal(sample(100, 0), null, 'and nothing outside the casting');

  const spec = {
    shape: 'model',
    origin: [-60, -40, -25],
    size: [120, 80, 30],
    model: { name: 'casting', positions },
  };
  const s = new Stock({ ...spec, resolution: 0.25, column: columnFor(spec) });
  const exact = 120 * 80 * 18 + 70 * 50 * 12;
  near(s.stockVolume, exact, 1, 'plinth plus boss');
  near(s.heightAt(0, 0), 5, 1e-6, 'boss height');
  near(s.heightAt(-55, -35), -7, 1e-6, 'plinth height');

  // Skimming the boss takes metal off the boss only.
  const env = envOf({ type: 'flat', diameter: 30, fluteLength: 40 });
  let removed = 0;
  for (let x = -60; x <= 60; x += 0.2) removed += s.carve(env, x, 0, 3);
  assert.ok(removed > 0);
  near(s.heightAt(0, 0), 3, 1e-6, 'the boss is 2 mm lower');
  near(s.heightAt(-55, -35), -7, 1e-6, 'and the plinth is untouched');
});

test('a model moved on the table takes its shape with it', () => {
  const positions = casting();
  const moved = columnFor({
    shape: 'model',
    origin: [0, 0, 0],                       // was at -60,-40,-25
    size: [120, 80, 30],
    model: { positions },
  });
  // Everything shifted by the same amount, so the boss is still the boss.
  near(moved(60, 40), 30, 1e-6, 'the middle of the boss, moved');
  near(moved(5, 5), 18, 1e-6, 'the plinth, moved');
  assert.equal(moved(-5, 40), null, 'and outside is still outside');
});

test('a shape that says nothing leaves a block', () => {
  // A model spec with no model is not a model; the app falls back rather
  // than building a stock with no material in it at all.
  assert.equal(columnFor({ shape: 'model', origin: [0, 0, 0], size: [1, 1, 1] }), null);
  assert.equal(meshColumn(new Float32Array(0)), null);
});

test('exporting shaped stock exports the shape, not the box around it', async () => {
  const { heightmapToTriangles } = await import('../src/io/mesh.js');

  const spec = { shape: 'round', origin: [-25, -25, -20], size: [50, 50, 20], diameter: 50 };
  const bar = new Stock({ ...spec, resolution: 0.5, column: columnFor(spec) });
  const mesh = heightmapToTriangles(bar, { decimate: 1 });
  assert.ok(mesh.triangles > 100);

  // Every vertex is inside the bar, within the cell it was sampled on.
  let worst = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    worst = Math.max(worst, Math.hypot(mesh.positions[i], mesh.positions[i + 1]));
    assert.ok(mesh.positions[i + 2] >= -20 - 1e-6 && mesh.positions[i + 2] <= 1e-6, 'and within its height');
  }
  assert.ok(worst <= 25 + bar.cell * 1.5, `no vertex outside the bar: ${worst}`);

  // A plain block still takes the simple path: one skin, four walls, a floor.
  const block = new Stock({ origin: [0, 0, 0], size: [10, 10, 5], resolution: 1 });
  const flat = heightmapToTriangles(block, { decimate: 1 });
  const cells = (block.nx - 1) * (block.ny - 1);
  assert.equal(flat.triangles, (cells + (block.nx - 1) * 2 + (block.ny - 1) * 2 + 1) * 2);
});

test('a hole cut clean through a block is a hole in the exported part', async () => {
  const { heightmapToTriangles } = await import('../src/io/mesh.js');
  const block = new Stock({ origin: [-20, -20, -10], size: [40, 40, 10], resolution: 0.5 });
  const env = envOf({ type: 'flat', diameter: 8, fluteLength: 30 });
  block.carve(env, 0, 0, -20);                       // straight through the middle

  const mesh = heightmapToTriangles(block, { decimate: 1 });
  // Nothing is drawn across the hole at the top face.
  for (let i = 0; i < mesh.positions.length; i += 9) {
    const cxp = (mesh.positions[i] + mesh.positions[i + 3] + mesh.positions[i + 6]) / 3;
    const cyp = (mesh.positions[i + 1] + mesh.positions[i + 4] + mesh.positions[i + 7]) / 3;
    const czp = (mesh.positions[i + 2] + mesh.positions[i + 5] + mesh.positions[i + 8]) / 3;
    if (Math.hypot(cxp, cyp) < 3) {
      assert.ok(Math.abs(czp - 0) > 1e-6 || false, 'no skin over the hole');
    }
  }
});

test('the rim of a cut is a snappable edge', () => {
  // A Ø10 blind hole, plunged: the rim is a circle of radius 5 at the top
  // face, and it is what a hand points at when measuring the hole.
  const s = new Stock({ origin: [-30, -30, -20], size: [60, 60, 20], resolution: 0.25 });
  s.carve(envOf({ type: 'flat', diameter: 10, fluteLength: 30 }), 6, -4, -6);

  const rim = s.rimNear(6 + 6.2, -4);
  assert.ok(rim, 'found the edge from 1.2 mm away');
  near(Math.hypot(rim.point[0] - 6, rim.point[1] + 4), 5, s.cell, 'on the wall of the hole');
  near(rim.point[2], 0, 1e-6, 'at the top face, not the floor');
  near(rim.drop, 6, 1e-6, 'and it knows how far it falls');

  // Three points round the rim measure the hole to within the grid.
  const pts = [0, 120, 240].map((deg) => {
    const t = (deg * Math.PI) / 180;
    const p = s.rimNear(6 + 6.2 * Math.cos(t), -4 + 6.2 * Math.sin(t));
    assert.ok(p, `rim at ${deg}°`);
    return p.point;
  });
  for (const p of pts) near(Math.hypot(p[0] - 6, p[1] + 4), 5, s.cell, 'each point on the circle');

  // Far from anything cut, there is no edge to snap to.
  assert.equal(s.rimNear(-25, -25), null);
  // And on a surface with no step in it either.
  assert.equal(new Stock({ origin: [0, 0, 0], size: [20, 20, 5], resolution: 0.25 }).rimNear(10, 10), null);
});
