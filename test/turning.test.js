// Turning on a mill-turn table: material removed as an outline turned
// round the table's axis, checked against volumes worked out by hand.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TriDexelStock } from '../src/sim/triDexel.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
// A 100 × 100 × 50 block on a vertical axis through its middle, top at Z0.
const block = (res = 0.25) => new TriDexelStock({ origin: [-50, -50, -50], size: [100, 100, 50], resolution: res });
const UP = { point: [0, 0, 0], dir: [0, 0, 1] };
// The outline [r, z] of a rectangle.
const rect = (r0, r1, z0, z1) => [[r0, z0], [r1, z0], [r1, z1], [r0, z1]];

test('turning a diameter: everything outside Ø60 down to Z-10 goes, round, at every angle', () => {
  const s = block();
  const before = s.remainingVolume();
  const { volume } = s.carveRevolved(rect(30, 100, -10, 5), UP);
  // The block's 100 × 100 less the Ø60 that stays, ten deep.
  const want = (100 * 100 - Math.PI * 30 * 30) * 10;
  near(volume, want, want * 0.01, 'volume taken');
  near(before - s.remainingVolume(), volume, 1e-6 * before, 'the stock agrees');
  // Through the middle, at Z-5, X runs from −30 to 30 and no further.
  const across = s.stretchesAt(0, [0, 0.125, -5]);
  assert.equal(across.length, 1, JSON.stringify(across));
  near(across[0][0], -30, 0.01, 'left wall');
  near(across[0][1], 30, 0.01, 'right wall');
  // And at 45°, the same radius.
  // (Lines run through cell centres: Y21.125 is one.)
  const diag = s.stretchesAt(0, [0, 21.125, -5]);
  near(diag[0][1], Math.sqrt(30 * 30 - 21.125 ** 2), 0.01, 'round, not square');
  // Below the cut, untouched.
  assert.deepEqual(s.stretchesAt(0, [0, 0.125, -20]).map((r) => r.map((v) => +v.toFixed(3))), [[-50, 50]]);
});

test('facing past centre takes the whole face; a groove takes a ring', () => {
  const s = block();
  const face = s.carveRevolved(rect(-2, 80, -3, 5), UP).volume;
  near(face, 100 * 100 * 3, 100 * 100 * 3 * 0.005, 'the whole face, 3 deep');
  // A 4 wide groove from Ø80 in to Ø60, at Z-20..-16, on the side of a turned Ø80.
  s.carveRevolved(rect(40, 100, -30, -3), UP);
  const before = s.remainingVolume();
  const groove = s.carveRevolved(rect(30, 41, -20, -16), UP).volume;
  const want = Math.PI * (40 * 40 - 30 * 30) * 4;
  near(groove, want, want * 0.015, 'groove ring');
  near(before - s.remainingVolume(), groove, 1e-6 * before, 'the stock agrees');
});

test('an axis along X: the same cut, on its side', () => {
  const s = new TriDexelStock({ origin: [0, -30, -30], size: [50, 60, 60], resolution: 0.25 });
  const { volume } = s.carveRevolved(rect(20, 60, 10, 30), { point: [0, 0, 0], dir: [1, 0, 0] });
  const want = (60 * 60 - Math.PI * 20 * 20) * 20;
  near(volume, want, want * 0.01, 'volume');
  const down = s.stretchesAt(2, [20, 0.125, 0]);
  near(down[0][0], -20, 0.01, 'bottom of Ø40');
  near(down[0][1], 20, 0.01, 'top of Ø40');
});

test('a sloped outline — a chamfer — leaves a cone', () => {
  const s = block();
  // A 45° chamfer: everything outside r = 40 + z goes, from Z-10 up.
  const tri = [[30, -10], [100, -10], [100, 5], [45, 5]];
  s.carveRevolved(tri, UP);
  for (const z of [-1.875, -4.875, -7.875]) {
    const across = s.stretchesAt(0, [0, 0.125, z]);
    near(across[0][1], Math.sqrt((40 + z) ** 2 - 0.125 ** 2), 0.01, `radius at Z${z}`);
  }
});
