// The surface of a tri-dexel stock: closed, the same volume as its lines,
// sharp where the part is sharp, and remade only where a cut went.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TriDexelStock } from '../src/sim/triDexel.js';
import { DexelMesher, dexelTriangles } from '../src/sim/dexelMesh.js';
import { stockToTriangles } from '../src/io/mesh.js';
import { buildTool, makeTool } from '../src/tools/toolDefs.js';

const tool = (def) => buildTool(makeTool(def));
const flat6 = tool({ type: 'flat', diameter: 6, fluteLength: 40 });
const flat10 = tool({ type: 'flat', diameter: 10, fluteLength: 30 });
const ball6 = tool({ type: 'ball', diameter: 6, fluteLength: 20 });

const block = (res = 0.25, size = [40, 40, 30]) => new TriDexelStock({
  origin: [-size[0] / 2, -size[1] / 2, -size[2]], size, resolution: res,
});
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

/**
 * Volume by the divergence theorem, and the edges that do not pair up
 * with one going the other way — none, for a closed surface.
 */
function measure(positions) {
  const tris = positions.length / 9;
  let volume = 0;
  const edges = new Map();
  const key = (i) => `${positions[3 * i]},${positions[3 * i + 1]},${positions[3 * i + 2]}`;
  for (let t = 0; t < tris; t++) {
    const o = 9 * t;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.subarray(o, o + 9);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ks = [key(3 * t), key(3 * t + 1), key(3 * t + 2)];
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
    for (let k = 0; k < 3; k++) {
      const a = ks[k];
      const b = ks[(k + 1) % 3];
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) || 0) + (a < b ? 1 : -1));
    }
  }
  let open = 0;
  for (const v of edges.values()) if (v !== 0) open++;
  return { volume, open, tris };
}

test('a plain block: closed, its own volume, and its corners square', () => {
  const td = block(0.25);
  const { positions } = dexelTriangles(td);
  const m = measure(positions);
  assert.equal(m.open, 0, 'every edge pairs up');
  near(m.volume, 40 * 40 * 30, 40 * 40 * 30 * 1e-4, 'volume');
  // Every vertex on a face of the box — the corners and edges included,
  // which a mesh placed at the middle of its crossings would bevel.
  let worst = 0;
  for (let q = 0; q < positions.length; q += 3) {
    const x = positions[q], y = positions[q + 1], z = positions[q + 2];
    const d = Math.min(Math.abs(Math.abs(x) - 20), Math.abs(Math.abs(y) - 20), Math.abs(z), Math.abs(z + 30));
    if (d > worst) worst = d;
  }
  assert.ok(worst < 1e-3, `vertices off the box by up to ${worst}`);
});

test('holes from the side, a cross hole and a ball ramp: closed, and the volume the lines hold', () => {
  const td = block(0.25);
  td.carveLinear(flat6.cutEnvelope, [25, 0, -15], [0, 0, -15], [1, 0, 0], 0);
  td.carveLinear(flat6.cutEnvelope, [0, 25, -15], [0, -25, -15], [0, 1, 0], 1);
  td.carveLinear(ball6.cutEnvelope, [-15, -15, -4], [15, 10, -8], [0, 0, 1], 2);
  const want = td.remainingVolume();
  for (const step of [1, 2]) {
    const m = measure(dexelTriangles(td, { decimate: step }).positions);
    assert.equal(m.open, 0, `closed at step ${step}`);
    near(m.volume, want, want * 1e-3, `volume at step ${step}`);
  }
});

test('a slot: floor and walls meet in a sharp corner, where the tool left them', () => {
  const td = block(0.25);
  // A Ø10 slot 5 deep along X, its walls at y = ±5 between grid lines.
  td.carveLinear(flat10.cutEnvelope, [-10, 0.13, -5.07], [10, 0.13, -5.07], [0, 0, 1], 0);
  const { positions } = dexelTriangles(td);
  assert.equal(measure(positions).open, 0);
  // Signed distance to the box less the slot (a stadium in plan, from the
  // floor up): near enough the true distance close to the surface.
  const sdf = (x, y, z) => {
    const box = Math.max(Math.abs(x) - 20, Math.abs(y) - 20, z, -30 - z);
    const sx = Math.max(Math.abs(x) - 10, 0);
    const slot = Math.max(Math.hypot(sx, y - 0.13) - 5, -5.07 - z);
    return Math.max(box, -slot);
  };
  let worst = 0;
  for (let q = 0; q < positions.length; q += 3) {
    const d = Math.abs(sdf(positions[q], positions[q + 1], positions[q + 2]));
    if (d > worst) worst = d;
  }
  assert.ok(worst < 0.02, `vertices off the part by up to ${worst} at a 0.25 lattice`);
});

test('a cut remakes only blocks it can reach: the rest are as they were', () => {
  const td = block(0.25, [30, 24, 20]);
  const before = new DexelMesher(td, { block: 8 });
  const snapshot = [];
  for (let k = 0; k < before.blockCount; k++) {
    const o = before.buildBlock(k);
    snapshot.push(Array.from(o.positions.subarray(0, 3 * o.vertices)).join(',') + '|' + Array.from(o.index.subarray(0, o.indices)).join(','));
  }
  td.takeDirty3();
  td.takeDirtyCells();
  td.carveLinear(ball6.cutEnvelope, [-4, -2, -3], [5, 3, -5], [0, 0, 1], 0);
  td.carveLinear(flat6.cutEnvelope, [20, 1, -9], [6, 1, -9], [1, 0, 0], 1);
  // The cells the cuts changed, not one box round both.
  const cells = td.takeDirtyCells();
  assert.ok(cells.length, 'the cuts say where they were');
  const after = new DexelMesher(td, { block: 8 });
  const marked = new Set();
  for (const box of cells) {
    const [bx0, by0, bz0, bx1, by1, bz1] = after.blocksFor(box);
    for (let z = bz0; z <= bz1; z++) for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) marked.add(after.blockIndex(x, y, z));
  }
  let remade = 0;
  let same = 0;
  for (let k = 0; k < after.blockCount; k++) {
    const inside = marked.has(k);
    const o = after.buildBlock(k);
    const now = Array.from(o.positions.subarray(0, 3 * o.vertices)).join(',') + '|' + Array.from(o.index.subarray(0, o.indices)).join(',');
    if (inside) { remade++; continue; }
    assert.equal(now, snapshot[k], `block ${k} changed outside the box the cuts gave`);
    same++;
  }
  assert.ok(remade > 0 && same > remade, `remade ${remade}, kept ${same}`);
});

test('a ray finds the bottom of a side hole, a wall, and nothing down a hole right through', () => {
  const td = block(0.25);
  td.carveLinear(flat6.cutEnvelope, [25, 0, -15], [0, 0, -15], [1, 0, 0], 0);
  td.carveLinear(flat6.cutEnvelope, [0, 25, -22], [0, -25, -22], [0, 1, 0], 1);
  // Down the side hole from outside the right face: its flat bottom at x = 0.
  const bottom = td.raycast([60, 0.05, -15.05], [-1, 0, 0]);
  assert.ok(bottom, 'hits');
  near(bottom.point[0], 0, 1e-3, 'bottom of the hole');
  // Beside the hole, the right face of the block.
  const face = td.raycast([60, 0.05, -10], [-1, 0, 0]);
  near(face.point[0], 20, 1e-3, 'the right face');
  // From above, the top — the holes are under it.
  const top = td.raycast([10, 0.05, 50], [0, 0, -1]);
  near(top.point[2], 0, 1e-3, 'the top over the hole');
  // A leaning ray at the wall of the side hole, from inside it.
  const d = [-Math.SQRT1_2, 0, -Math.SQRT1_2];
  const wall = td.raycast([10, 0.05, -15], d);
  assert.ok(wall, 'hits the wall');
  near(Math.hypot(wall.point[1], wall.point[2] + 15), 3, 0.05, 'on the hole radius');
  // Straight down the through hole: air all the way.
  assert.equal(td.raycast([0.05, 60, -22.05], [0, -1, 0]), null, 'a hole right through is open');
});

test('the export of a Full 3D stock is its closed surface', () => {
  const td = block(0.5);
  td.carveLinear(flat6.cutEnvelope, [25, 0, -15], [0, 0, -15], [1, 0, 0], 0);
  const mesh = stockToTriangles(td, { decimate: 1 });
  assert.ok(mesh.triangles > 1000);
  const m = measure(mesh.positions);
  assert.equal(m.open, 0, 'closed');
  near(m.volume, td.remainingVolume(), td.remainingVolume() * 2e-3, 'volume');
});
