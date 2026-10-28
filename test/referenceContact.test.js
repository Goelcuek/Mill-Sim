// The holder, shank and spindle against the reference part's real shape.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSurfaceIndex } from '../src/sim/surfaceIndex.js';
import { checkReference } from '../src/sim/referenceContact.js';
import { boxToTriangles } from '../src/io/mesh.js';

// A block, X and Y ±20, Z −40 to 0.
const index = buildSurfaceIndex([boxToTriangles([-20, -20, -40], [20, 20, 0])], 2);
// A Ø10 cutter with 20 mm of flute, a Ø30 holder from 25 mm up.
const spheres = [0, 5, 10, 5, 20, 5, 25, 15, 40, 15, 60, 15];
const UP = [0, 0, 1];
const opts = { skipBelow: 20, clearance: 0, closed: true };

test('the cutter in the part is the gouge check\'s, not a crash', () => {
  assert.equal(checkReference(spheres, [0, 0, -1], UP, index, opts), null);
  assert.equal(checkReference(spheres, [0, 0, -15], UP, index, opts), null, 'holder starts at Z10, clear of the top');
});

test('a holder that reaches into the part beside it is a crash, measured', () => {
  // Down the outside of the wall at X20: the cutter clears it by 3 mm, the
  // Ø30 holder from Z−5 reaches 7 mm past the wall — and its deepest point
  // is 5 mm under the top, the shortest way out.
  const hit = checkReference(spheres, [28, 0, -30], UP, index, opts);
  assert.ok(hit && hit.gap < 0, JSON.stringify(hit));
  assert.ok(Math.abs(hit.depth - 5) < 0.01, `depth ${hit.depth}`);
  // Higher, with the holder above the top, it is clear.
  assert.equal(checkReference(spheres, [28, 0, -24], UP, index, opts), null);
});

test('a near miss when room is asked for, and a holder buried all round', () => {
  const near = checkReference(spheres, [28, 0, -24], UP, index, { ...opts, clearance: 2 });
  assert.ok(near && near.gap >= 0 && near.gap < 2, JSON.stringify(near));
  // Deep inside, the disc is in the part all the way round.
  const buried = checkReference(spheres, [0, 0, -60], UP, index, opts);
  assert.ok(buried && buried.gap < 0);
});

test('a tool lying on its side: the holder beside the part', () => {
  // Pointing along −X, tip at X30 Z−10: the holder from X55 out is clear;
  // tipped back toward the part along +X it is not.
  assert.equal(checkReference(spheres, [30, 0, -10], [1, 0, 0], index, opts), null);
  const hit = checkReference(spheres, [-30, 0, 10], [0, 0, -1], index, opts);
  assert.ok(hit && hit.gap < 0, 'a tool pointing up into the part from below');
});

// ---- through the simulator -------------------------------------------------

import { Stock } from '../src/sim/stock.js';
import { buildTargetMap } from '../src/sim/target.js';
import { Simulator } from '../src/sim/simulator.js';
import { silhouetteSpheres } from '../src/sim/collision.js';
import { buildAssembly } from '../src/tools/assembly.js';
import { defaultHolders } from '../src/tools/holderDefs.js';
import { makeTool } from '../src/tools/toolDefs.js';
import { interpret } from '../src/gcode/interpreter.js';

function runWith(lines, checks = {}) {
  const stock = new Stock({ origin: [-40, -40, -60], size: [80, 80, 60], resolution: 0.5 });
  // A boss standing the full depth of the block, X20 to X40.
  const target = buildTargetMap(stock, [boxToTriangles([20, -10, -60], [40, 10, 0])]);
  const built = buildAssembly({ stickout: 32 }, makeTool({ type: 'flat', diameter: 10, fluteLength: 30 }), defaultHolders()[0],
    { spindleDiameter: 90, spindleLength: 80 });
  const slot = { built, index: 0, spheres: silhouetteSpheres([...built.toolPoints, ...built.holderPoints, ...built.spindlePoints]) };
  const sim = new Simulator();
  sim.load({
    program: interpret(lines.join('\n')),
    stock, slots: new Map([[1, slot]]), fallbackSlot: slot, fixtures: [], target, checks: { nearMiss: 0, ...checks },
  });
  sim.runAll();
  return sim;
}

test('the simulator reports a holder in the reference part, and nothing when it is clear', () => {
  const beside = ['G90 G21 G17 G54', 'T1 M6', 'S6000 M3', 'G0 X10 Y0 Z5', 'G1 Z-40 F300', 'G0 Z50', 'M30'];
  const hit = runWith(beside).collisions.filter((c) => c.type === 'part');
  assert.ok(hit.length >= 1, 'the holder beside the boss is in it');
  assert.ok(/reference part/.test(hit[0].message));
  const away = ['G90 G21 G17 G54', 'T1 M6', 'S6000 M3', 'G0 X-20 Y0 Z5', 'G1 Z-40 F300', 'G0 Z50', 'M30'];
  assert.equal(runWith(away).collisions.filter((c) => c.type === 'part').length, 0);
  assert.equal(runWith(beside, { reference: false }).collisions.filter((c) => c.type === 'part').length, 0, 'and it can be turned off');
});

import { latheToTriangles } from '../src/io/mesh.js';

test('a cutter just clear of a bore is not a gouge; one just oversize is, by its oversize', () => {
  // A Ø.336 in cutter plunged in a Ø.342 in bore has .003 in a side to spare.
  const R = (0.342 * 25.4) / 2;
  const ring = latheToTriangles([{ r: R, z: -10 }, { r: 30, z: -10 }, { r: 30, z: 0 }, { r: R, z: 0 }, { r: R, z: -10 }], { segments: 256 });
  const surface = buildSurfaceIndex([{ positions: ring.positions }], 2);
  const gouges = (inches) => {
    const built = buildAssembly({ stickout: 40 }, makeTool({ type: 'flat', diameter: inches * 25.4, fluteLength: 30 }), defaultHolders()[0],
      { spindleDiameter: 90, spindleLength: 80 });
    const slot = { built, index: 0, spheres: silhouetteSpheres([...built.toolPoints, ...built.holderPoints]) };
    const sim = new Simulator();
    sim.load({
      program: interpret('G90 G21\nT1 M6\nS3000 M3\nG0 X0 Y0 Z10\nG1 Z-8 F300\nG0 Z10\nM30'),
      stock: null, slots: new Map([[1, slot]]), fallbackSlot: slot, fixtures: [],
      target: { surface, closed: true, map: null, grid: null },
    });
    sim.gougeTolerance = 0.0008 * 25.4;
    sim.runAll();
    return sim.collisions.filter((c) => c.type === 'gouge');
  };
  assert.deepEqual(gouges(0.336).map((c) => c.message), []);
  const over = gouges(0.346);
  assert.ok(over.length && Math.abs(over[0].depth - 0.002 * 25.4) < 0.005, JSON.stringify(over.map((c) => c.depth)));
});
