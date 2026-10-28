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

import { interpret } from '../src/gcode/interpreter.js';
import { buildPreset } from '../src/machine/presets.js';
import { Simulator } from '../src/sim/simulator.js';
import { silhouetteSpheres } from '../src/sim/collision.js';
import { buildAssembly } from '../src/tools/assembly.js';
import { makeTool, defaultTools } from '../src/tools/toolDefs.js';

const SIEMENS = { controller: { flavour: 'siemens', dialect: 'siemens' } };
const slotOf = (tool, index) => {
  const built = buildAssembly({ stickout: tool.overallLength || 60 }, tool, null, { spindleDiameter: 90, spindleLength: 80 });
  return { built, index, spheres: silhouetteSpheres(built.toolPoints) };
};
const od = defaultTools().find((t) => t.id === 'tool_turn_od');
const flat = makeTool({ type: 'flat', diameter: 10, fluteLength: 30, overallLength: 75 });
// A trunnion, the part a 60 × 60 block on the middle of the table, top at Z0.
const turnRun = (lines, slots = { 11: slotOf(od, 0), 2: slotOf(flat, 1) }) => {
  const kin = buildPreset('tableTable');
  const program = interpret(lines.join('\n'), { ...SIEMENS, kinematics: kin });
  const stock = new TriDexelStock({ origin: [-30, -30, -40], size: [60, 60, 40], resolution: 0.25 });
  const sim = new Simulator();
  sim.haltOnCollision = false;
  const map = new Map(Object.entries(slots).map(([k, v]) => [Number(k), v]));
  sim.load({ program, stock, slots: map, fallbackSlot: map.get(11), kinematics: kin });
  sim.runAll();
  return { program, stock, sim, found: sim.collisions.map((c) => `${c.type}: ${c.message}`) };
};
const DREHEN = ['T11 M6', 'G18 G90', 'CYCLE800(0,"DREHEN",0,57,0,0,0,0,0,0,0,0,0,1)', 'DIAMON', 'G96 S150 M3 LIMS=1500', 'G95 F0.25'];

test('turning the corners off a block: round to Ø84 down to Z-20, nothing in the way', () => {
  const { stock, found, program } = turnRun([...DREHEN, 'G0 X100 Z5', 'G0 X84', 'G1 Z-20', 'G1 X100', 'G0 Z5', 'M30']);
  assert.deepEqual(program.warnings.filter((w) => w.severity === 'error').map((w) => w.message), []);
  assert.deepEqual(found, []);
  // A line near the block's edge, Y29.875: the corner is gone to r 42.
  const row = stock.stretchesAt(0, [0, 29.875, -10.125]);
  near(row[0][1], Math.sqrt(42 * 42 - 29.875 ** 2), 0.05, 'turned to r42 at the corner');
  // Below Z-20 the block is square still.
  near(stock.stretchesAt(0, [0, 29.875, -25.125])[0][1], 30, 1e-3, 'untouched below');
});

test('turning too deep for the bar: the bar runs into the spinning corners', () => {
  const { found } = turnRun([...DREHEN, 'G0 X100 Z5', 'G0 X50', 'G1 Z-10', 'G1 X100', 'G0 Z5', 'M30']);
  assert.ok(found.some((f) => /^holder: The turning bar of OD turning C80 R0.8 runs [\d.]+ mm into the spinning part/.test(f)), found.join('\n'));
});

test('the wrong tool for the mode is said: a milling cutter while the table turns, a turning tool while it does not', () => {
  const milling = turnRun(['T2 M6', 'G18 G90', 'CYCLE800(0,"DREHEN",0,57,0,0,0,0,0,0,0,0,0,1)', 'G96 S150 M3', 'G95 F0.25', 'G0 X40 Z5', 'G1 Z-5', 'M30']);
  assert.ok(milling.found.some((f) => /^turning: .* is a milling cutter, in the spindle while the table turns/.test(f)), milling.found.join('\n'));
  const still = turnRun(['T11 M6', 'G90', 'G0 X25 Y0 Z5', 'G1 Z-5 F100', 'M30']);
  assert.ok(still.found.some((f) => /^turning: .* meets the stock while the table is not turning/.test(f)), still.found.join('\n'));
});
