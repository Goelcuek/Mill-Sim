import test from 'node:test';
import assert from 'node:assert/strict';

import { Stock } from '../src/sim/stock.js';
import { Simulator } from '../src/sim/simulator.js';
import { silhouetteSpheres, checkFixtures, checkTable, checkLimits } from '../src/sim/collision.js';
import { buildTool, makeTool, defaultTools } from '../src/tools/toolDefs.js';
import { defaultHolders } from '../src/tools/holderDefs.js';
import { buildAssembly } from '../src/tools/assembly.js';
import { interpret } from '../src/gcode/interpreter.js';

const tools = defaultTools();
const holders = defaultHolders();

function slot(toolIndex, holderIndex, stickout, index = 0) {
  const built = buildAssembly({ stickout }, tools[toolIndex], holderIndex === null ? null : holders[holderIndex], { spindleDiameter: 90, spindleLength: 80 });
  return { built, index, spheres: silhouetteSpheres([...built.toolPoints, ...built.holderPoints, ...built.spindlePoints]) };
}

/** A box fixture at a position, as collisionBoxes() would describe it. */
function boxFixture(centre, size) {
  return {
    id: 'fx', name: 'clamp',
    inverse: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    centre,
    half: size.map((v) => v / 2),
    scale: 1,
  };
}

function simulate(lines, { stock, slots, machine = null, fixtures = [] }) {
  const program = interpret(Array.isArray(lines) ? lines.join('\n') : lines);
  const sim = new Simulator();
  sim.load({ program, stock, slots, fallbackSlot: slots.values().next().value, machine, fixtures });
  sim.runAll();
  return sim;
}

test('facing removes exactly the swept volume', () => {
  const stock = new Stock({ origin: [-50, -25, -20], size: [100, 50, 20], resolution: 0.25 });
  const tool = buildTool(makeTool({ type: 'flat', diameter: 10, fluteLength: 30 }));
  let removed = 0;
  for (let y = -30; y <= 30; y += 4) {
    for (let x = -56; x <= 56; x += 0.1) removed += stock.carve(tool.cutEnvelope, x, y, -2);
  }
  assert.ok(Math.abs(removed - 100 * 50 * 2) < 5, `removed ${removed}`);
  assert.ok(Math.abs(stock.heightAt(0, 0) - -2) < 1e-4);
});

test('a ball nose leaves the analytic spherical form', () => {
  const stock = new Stock({ origin: [-20, -20, -20], size: [40, 40, 20], resolution: 0.1 });
  const tool = buildTool(makeTool({ type: 'ball', diameter: 6, fluteLength: 20 }));
  stock.carve(tool.cutEnvelope, 0, 0, -5);

  // Compare each column against the sphere evaluated at that column's own
  // centre, so the check is about the cutting maths and not about where the
  // grid happens to fall.
  const columnError = (x, y) => {
    const i = Math.floor((x - stock.origin[0]) / stock.dx);
    const j = Math.floor((y - stock.origin[1]) / stock.dy);
    const rr = Math.hypot(stock.cx(i), stock.cy(j));
    const expected = -5 + 3 - Math.sqrt(Math.max(9 - rr * rr, 0));
    return Math.abs(stock.height[j * stock.nx + i] - expected);
  };
  assert.ok(columnError(0.05, 0.05) < 0.01, 'the tip point');
  for (const r of [1, 2, 2.5, 2.9]) {
    assert.ok(columnError(r, 0) < 0.01, `r=${r}: error ${columnError(r, 0)}`);
  }
});

test('air moves are rejected without touching the grid', () => {
  const stock = new Stock({ origin: [-50, -25, -20], size: [100, 50, 20], resolution: 0.25 });
  const tool = buildTool(makeTool({ type: 'flat', diameter: 10 }));
  const before = stock.version;
  let removed = 0;
  for (let k = 0; k < 50000; k++) removed += stock.carve(tool.cutEnvelope, (k % 100) - 50, 0, 5);
  assert.equal(removed, 0);
  assert.equal(stock.version, before, 'no version bump means nothing was written');
});

test('probeBody finds the deepest interference', () => {
  const stock = new Stock({ origin: [-30, -30, -20], size: [60, 60, 20], resolution: 0.5 });
  const built = buildAssembly({ stickout: 40 }, tools[1], holders[0]);
  assert.equal(stock.probeBody(built.holderEnvelope, 0, 0, 10), null, 'clear above the stock');
  const hit = stock.probeBody(built.holderEnvelope, 0, 0, -45);
  assert.ok(hit, 'holder should be buried');
  assert.ok(Math.abs(hit.depth - 5) < 0.6, `depth ${hit.depth}`);
});

test('a pocket cuts to size and reports no collisions', () => {
  const stock = new Stock({ origin: [-35, -20, -20], size: [70, 40, 20], resolution: 0.25 });
  const lines = ['G21 G90 G54', 'T2 M06', 'S6000 M03', 'G0 X-20 Y-10 Z25'];
  for (let z = -1; z >= -5.0001; z -= 1) {
    lines.push('G0 X-20 Y-10 Z2', `G1 Z${z.toFixed(2)} F250`);
    let left = true;
    for (let y = -10; y <= 10.0001; y += 4) {
      lines.push(`G1 Y${y} F900`, `G1 X${left ? 20 : -20}`);
      left = !left;
    }
    lines.push('G0 Z10');
  }
  lines.push('M30');

  const sim = simulate(lines, { stock, slots: new Map([[2, slot(1, 0, 40)]]) });
  assert.equal(sim.collisions.length, 0, JSON.stringify(sim.collisions.map((c) => c.message)));
  assert.ok(Math.abs(stock.heightAt(0, 0) - -5) < 1e-3, 'pocket floor');
  assert.ok(Math.abs(stock.heightAt(0, 17) - 0) < 1e-3, 'untouched wall');
  // 50 x 30 pocket plus the cutter radius sweep, 5 deep.
  assert.ok(sim.removedVolume > 7000 && sim.removedVolume < 7600, `removed ${sim.removedVolume}`);
});

test('a rapid through material is reported as a crash, not a cut', () => {
  const stock = new Stock({ origin: [-30, -20, -20], size: [60, 40, 20], resolution: 0.4 });
  const sim = simulate(['G21 G90 G54', 'T2 M06', 'S6000 M03', 'G0 X-40 Y0 Z-5', 'G0 X40', 'M30'], {
    stock, slots: new Map([[2, slot(1, 0, 40)]]),
  });
  const rapid = sim.collisions.find((c) => c.type === 'rapid');
  assert.ok(rapid, 'expected a rapid collision');
  assert.equal(rapid.severity, 'error');
});

test('cutting deeper than the flutes is reported even with a full-diameter shank', () => {
  const stock = new Stock({ origin: [-30, -20, -30], size: [60, 40, 30], resolution: 0.4 });
  const sim = simulate(['G21 G90 G54', 'T3 M06', 'S9000 M03', 'G0 X-25 Y0 Z5', 'G1 Z-26 F150', 'G1 X25 F400', 'M30'], {
    stock, slots: new Map([[3, slot(2, 0, 32)]]),
  });
  const deep = sim.collisions.find((c) => c.type === 'deep');
  assert.ok(deep, JSON.stringify(sim.collisions.map((c) => c.type)));
  assert.ok(Math.abs(deep.depth - 8) < 0.5, `depth ${deep.depth} (26mm deep, 18mm flutes)`);
});

test('a buried holder is reported separately from the shank', () => {
  const stock = new Stock({ origin: [-25, -25, -50], size: [50, 50, 50], resolution: 0.4 });
  const sim = simulate(['G21 G90 G54', 'T2 M06', 'S6000 M03', 'G0 X0 Y0 Z5', 'G1 Z-45 F150', 'M30'], {
    stock, slots: new Map([[2, slot(1, 0, 32)]]),
  });
  const holder = sim.collisions.find((c) => c.type === 'holder');
  assert.ok(holder, JSON.stringify(sim.collisions.map((c) => c.type)));
  assert.ok(holder.depth > 10, `depth ${holder.depth}`);
  assert.match(holder.message, /ER32|holder/i);
});

test('cutting with the spindle stopped is a warning', () => {
  const stock = new Stock({ origin: [-30, -20, -20], size: [60, 40, 20], resolution: 0.5 });
  const sim = simulate(['G21 G90 G54', 'T2 M06', 'G0 X-25 Y0 Z-2', 'G1 X25 F400', 'M30'], {
    stock, slots: new Map([[2, slot(1, 0, 40)]]),
  });
  assert.ok(sim.collisions.some((c) => c.type === 'spindle'));
});

test('fixtures are hit through the whole assembly, not just the cutter', () => {
  const stock = new Stock({ origin: [-25, -25, -20], size: [50, 50, 20], resolution: 0.5 });
  const clamp = {
    id: 'c', name: 'Toe clamp', scale: 1,
    inverse: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -55, 0, -5, 1],
    half: [12, 20, 15], centre: [0, 0, 0],
  };
  const sim = simulate(['G21 G90 G54', 'T2 M06', 'S6000 M03', 'G0 X0 Y0 Z10', 'G1 X60 F1000', 'M30'], {
    stock, slots: new Map([[2, slot(1, 0, 40)]]), fixtures: [clamp],
  });
  const hit = sim.collisions.find((c) => c.type === 'fixture');
  assert.ok(hit);
  assert.match(hit.message, /Toe clamp/);
});

test('the table surface and travel limits are checked', () => {
  const spheres = silhouetteSpheres([{ r: 0, z: 0 }, { r: 5, z: 0 }, { r: 5, z: 40 }]);
  const table = { enabled: true, z: -10, xMin: -100, xMax: 100, yMin: -100, yMax: 100 };
  assert.equal(checkTable(spheres, [0, 0, 5], table), null);
  const hit = checkTable(spheres, [0, 0, -12], table);
  assert.ok(hit && hit.depth > 0);
  assert.equal(checkTable(spheres, [500, 0, -50], table), null, 'outside the table footprint');

  const limits = { enabled: true, min: [-100, -100, -50], max: [100, 100, 200] };
  assert.equal(checkLimits([0, 0, 0], limits), null);
  assert.equal(checkLimits([0, 0, -60], limits).axis, 'Z');
  assert.equal(checkLimits([120, 0, 0], limits).axis, 'X');
});

test('a sphere chain encloses the silhouette it came from', () => {
  const spheres = silhouetteSpheres([{ r: 0, z: 0 }, { r: 10, z: 0 }, { r: 10, z: 60 }]);
  assert.ok(spheres.length >= 4);
  let maxR = 0;
  for (let i = 1; i < spheres.length; i += 2) maxR = Math.max(maxR, spheres[i]);
  assert.equal(maxR, 10);
});

test('scrubbing backwards replays deterministically', () => {
  const lines = ['G21 G90 G54', 'T2 M06', 'S6000 M03', 'G0 X-25 Y0 Z2', 'G1 Z-3 F300', 'G1 X25 F800', 'G0 Z20', 'M30'];
  const program = interpret(lines.join('\n'));
  const stock = new Stock({ origin: [-30, -20, -20], size: [60, 40, 20], resolution: 0.4 });
  const slots = new Map([[2, slot(1, 0, 40)]]);
  const sim = new Simulator();
  sim.load({ program, stock, slots, fallbackSlot: slots.get(2) });

  sim.runAll();
  const full = sim.removedVolume;

  sim.seek(program.stats.cycleTime * 0.5, 1e6);
  const half = sim.removedVolume;
  assert.ok(half < full, 'seeking back should undo material');

  // Seeking forward again must land on the same result.
  //
  // Not bit-exact: the carver sweeps whole chunks, and a scrub splits the
  // move at a different point. Columns whose centre is *exactly* tangent to
  // the cutting radius sit on a knife edge — the interval where the tool
  // covers them collapses to a single instant, so which chunk claims them
  // depends on where the split fell. That set has measure zero and only
  // appears at all because this path is axis-aligned on the grid, so the
  // agreement is asserted in relative terms.
  while (!sim.finished) sim.run(Infinity, 50);
  const drift = Math.abs(sim.removedVolume - full) / full;
  assert.ok(drift < 1e-3, `replay drifted ${(drift * 100).toFixed(4)}%: ${sim.removedVolume} vs ${full}`);
});

test('the swept carver agrees with stamping the tool along the move', () => {
  // The sweep is the accuracy-critical path, so it is checked against the
  // brute-force method it replaced rather than against itself.
  const opts = { origin: [-30, -20, -12], size: [60, 40, 12], resolution: 0.15 };
  for (const def of [
    makeTool({ type: 'flat', diameter: 10, fluteLength: 30 }),
    makeTool({ type: 'ball', diameter: 6, fluteLength: 20 }),
    makeTool({ type: 'bull', diameter: 8, cornerRadius: 1, fluteLength: 20 }),
    makeTool({ type: 'chamfer', diameter: 12, tipDiameter: 1, tipAngle: 90, fluteLength: 10 }),
  ]) {
    const tool = buildTool(def);
    const A = [-15, -8, 0];
    const B = [15, 9, -4];                       // ramping and diagonal at once

    const stamped = new Stock(opts);
    const steps = 3000;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      stamped.carve(tool.cutEnvelope, A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
    }

    const swept = new Stock(opts);
    swept.carveSweep(tool.cutEnvelope, A, B);

    let maxErr = 0;
    for (let k = 0; k < stamped.height.length; k++) {
      const e = Math.abs(stamped.height[k] - swept.height[k]);
      if (e > maxErr) maxErr = e;
    }
    assert.ok(maxErr < 0.005, `${def.type}: swept surface differs by ${maxErr.toFixed(6)} mm`);
  }
});

test('sweeping a move in pieces gives the same surface as sweeping it whole', () => {
  const opts = { origin: [-30, -20, -12], size: [60, 40, 12], resolution: 0.15 };
  const tool = buildTool(makeTool({ type: 'ball', diameter: 6, fluteLength: 20 }));
  const A = [-12.3, -7.1, -1.4];
  const B = [11.7, 8.3, -5.2];

  const whole = new Stock(opts);
  whole.carveSweep(tool.cutEnvelope, A, B);

  const pieces = new Stock(opts);
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const at = (t) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    pieces.carveSweep(tool.cutEnvelope, at(t0), at(t1));
  }

  let maxErr = 0;
  for (let k = 0; k < whole.height.length; k++) {
    const e = Math.abs(whole.height[k] - pieces.height[k]);
    if (e > maxErr) maxErr = e;
  }
  assert.ok(maxErr < 0.005, `chunking changed the surface by ${maxErr.toFixed(6)} mm`);
});

test('the tool table maps T numbers to assemblies', () => {
  const stock = new Stock({ origin: [-30, -20, -20], size: [60, 40, 20], resolution: 0.5 });
  const slots = new Map([[2, slot(1, 0, 40, 1)], [4, slot(3, 1, 32, 2)]]);
  const sim = simulate([
    'G21 G90 G54', 'T2 M06', 'S6000 M03', 'G0 X-25 Y-5 Z-1', 'G1 X25 F800',
    'T4 M06', 'G0 X-25 Y5 Z-1', 'G1 X25 F800', 'M30',
  ], { stock, slots });
  assert.equal(sim.currentTool, 4);
  // Each tool stamps its own index into the cut flags.
  const flags = new Set(Array.from(stock.cutBy).filter(Boolean));
  assert.deepEqual([...flags].sort(), [2, 3]);
});

test('an unknown T number falls back and says so', () => {
  const stock = new Stock({ origin: [-30, -20, -20], size: [60, 40, 20], resolution: 0.5 });
  const sim = simulate(['G21 G90 G54', 'T9 M06', 'S6000 M03', 'G0 X-25 Y0 Z-1', 'G1 X25 F800', 'M30'], {
    stock, slots: new Map([[2, slot(1, 0, 40)]]),
  });
  assert.ok(sim.collisions.some((c) => c.type === 'notool'));
});

test('a near miss is a near miss, not a crash and not silence', () => {
  // A clamp whose top edge sits just under the holder's nose corner — Ø36
  // at 30.5 up the tool, the clamp's inner edge 21 out and its top at 30 —
  // so about 3 mm away: nothing touches it, but nobody wants to find that
  // out with a hand on the feed hold.
  const holder = slot(1, 0, 30);
  const clamp = boxFixture([26, 0, -10], [10, 20, 80]);

  const bare = checkFixtures(holder.spheres, [0, 0, 0], [clamp], 0, 0);
  assert.equal(bare, null, 'nothing is touching, so nothing is reported');

  const asked = checkFixtures(holder.spheres, [0, 0, 0], [clamp], 0, 12);
  assert.ok(asked, 'asked for room, and it says how much there is');
  // Nearest is the holder's taper (Ø36 at 30.5 opening to Ø50 at 62.5),
  // square to which the clamp's top edge stands (3·32 + 0.5·7)/|7, 32| off.
  assert.ok(Math.abs(asked.gap - 99.5 / Math.hypot(7, 32)) < 1e-4, `gap ${asked.gap}`);
  assert.equal(asked.depth, 0, 'nothing is buried in anything');

  // Push the tool into it and the same call reports a real collision.
  const hit = checkFixtures(holder.spheres, [24, 0, 0], [clamp], 0, 12);
  assert.ok(hit.gap < 0);
  assert.ok(hit.depth > 0);
});

test('a fixture can carry its own rule', () => {
  const holder = slot(1, 0, 30);
  const clamp = boxFixture([26, 0, -10], [10, 20, 80]);

  // Ignored: it is not in the crash model at all, however close anything is.
  assert.equal(checkFixtures(holder.spheres, [24, 0, 0], [{ ...clamp, ignore: true }], 0, 5), null);

  // Or it asks for more room than the setting, and gets it.
  const fussy = { ...clamp, clearance: 30 };
  const near = checkFixtures(holder.spheres, [0, 0, 0], [fussy], 0, 0);
  assert.ok(near && near.gap > 0, 'reported even though the setting asked for nothing');
  assert.equal(near.clearance, 30);
});

test('the table reports the gap above it as well as the dent in it', () => {
  const holder = slot(1, 0, 30);
  const table = { enabled: true, z: -50, xMin: -200, xMax: 200, yMin: -200, yMax: 200 };

  assert.equal(checkTable(holder.spheres, [0, 0, 0], table, 0), null, 'well clear');
  const near = checkTable(holder.spheres, [0, 0, 0], table, 60);
  assert.ok(near && near.gap > 0 && near.gap <= 60);
  const hit = checkTable(holder.spheres, [0, 0, -55], table, 0);
  assert.ok(hit && hit.gap < 0 && hit.depth > 0);
});

// ---- the envelope is the machine's, measured from its home ---------------
//
// A control counts from machine zero: at home the axes read 0, 0, 0 and the
// travels are how far they go from there. Storing the envelope that way is
// what lets the machine be moved about the scene without the walls staying
// behind — and what lets the limit that stopped a move be reported as the
// number that would be on the control.

test('travel limits are held from home and reported as machine coordinates', async () => {
  const { homeOf, limitsInScene, normaliseLimits, DEFAULT_MACHINE } = await import('../src/machine/config.js');

  const machine = {
    home: [0, 0, 250],
    limits: { enabled: true, frame: 'home', min: [-380, -215, -370], max: [380, 215, 80] },
  };
  assert.deepEqual(homeOf(machine), [0, 0, 250]);

  // The walls stand where home puts them.
  const scene = limitsInScene(machine);
  assert.deepEqual(scene.min, [-380, -215, -120]);
  assert.deepEqual(scene.max, [380, 215, 330]);

  // Inside is inside; outside is reported the way the control would say it.
  assert.equal(checkLimits([0, 0, 0], scene, machine.home), null);
  const low = checkLimits([0, 0, -200], scene, machine.home);
  assert.equal(low.axis, 'Z');
  assert.equal(low.value, -450, 'machine Z, not scene Z');
  assert.equal(low.limit, -370);

  // Moving home carries the envelope with it rather than leaving it behind.
  const lifted = limitsInScene({ ...machine, home: [0, 0, 400] });
  assert.deepEqual(lifted.max, [380, 215, 480], 'home 150 higher, ceiling 150 higher');
  assert.deepEqual(lifted.min, [-380, -215, 30]);

  // A machine saved before the envelope was relative wrote scene numbers
  // and said nothing about a frame, so it is converted against its own home.
  const old = normaliseLimits({ enabled: true, min: [-380, -215, -120], max: [380, 215, 330] }, [0, 0, 250]);
  assert.equal(old.frame, 'home');
  assert.deepEqual(old.min, [-380, -215, -370]);
  assert.deepEqual(old.max, [380, 215, 80]);
  // And one written since is left alone.
  assert.deepEqual(normaliseLimits(machine.limits, machine.home).min, machine.limits.min);

  // The machine every session starts from says the same thing both ways.
  assert.deepEqual(limitsInScene(DEFAULT_MACHINE).min, [-380, -215, -120]);
});

test('machine coordinates are read at the gauge line, not at the tool tip', () => {
  // G53 Z0 stands the spindle nose on machine zero. What the tip does
  // then depends on what is in the spindle: a long tool hangs lower, which
  // is exactly the thing that catches people out on the machine.
  const at = (gaugeLength) => {
    const p = interpret(['G21 G90 G54', 'G0 X0 Y0 Z10', 'G53 G0 Z0', 'M30'].join('\n'),
      { gaugeLength, machineZero: [0, 0, 250] });
    return p.moves[p.moves.length - 1].to[2];
  };
  assert.ok(Math.abs(at(0) - 250) < 1e-9, 'with nothing in the spindle the tip is the gauge line');
  assert.ok(Math.abs(at(160) - 90) < 1e-9, 'a 160 mm assembly hangs 160 below it');

  // And the machine starts where the same rule says it does, so G53 Z0 at
  // the top of a program is the nothing-happens move it is on the machine.
  const p = interpret(['G21 G90 G54', 'G53 G0 Z0', 'M30'].join('\n'),
    { gaugeLength: 160, machineZero: [0, 0, 250] });
  assert.ok(Math.abs(p.moves[0].from[2] - 90) < 1e-9, `starts at ${p.moves[0].from[2]}`);
  assert.ok(Math.abs(p.moves[0].to[2] - 90) < 1e-9, 'G53 Z0 moved a machine that was already home');
});

test('reference return goes to the same place', () => {
  // G28 is a machine-coordinate move like any other.
  const p = interpret(['G21 G90 G54', 'G0 X0 Y0 Z10', 'G91 G28 Z0', 'M30'].join('\n'),
    { gaugeLength: 140, machineZero: [0, 0, 250] });
  assert.ok(Math.abs(p.moves[p.moves.length - 1].to[2] - 110) < 1e-9,
    `G28 left the tip at ${p.moves[p.moves.length - 1].to[2]}`);
});

test('the travel envelope is measured at the gauge line', () => {
  // A limit is how far the axis goes. Check it at the tip and the whole
  // envelope moves with every tool change: a long tool cannot reach the
  // bottom of its own travel and a short one runs past the top of it.
  const limits = { enabled: true, min: [-100, -100, -100], max: [100, 100, 100] };
  const home = [0, 0, 0];

  // The tip 150 below the floor of the envelope, with a 200 mm assembly:
  // the gauge line is at +50, which is inside, and so is the machine.
  assert.equal(checkLimits([0, 0, 50], limits, home), null);
  // The same tip with nothing in the spindle is over-travel.
  const over = checkLimits([0, 0, -150], limits, home);
  assert.ok(over && over.axis === 'Z', 'a gauge line below the envelope is not over-travel');
  assert.ok(Math.abs(over.value - -150) < 1e-9, `reported machine Z${over.value}`);
});

test('the envelope floor is the axis floor, not the tip', () => {
  // The floor is 50 below home. A tip at -40 is past it and still fine,
  // because what stops is the axis and the axis is a whole assembly
  // higher. Checking the tip would report over-travel here for every tool
  // in the rack.
  const machine = {
    limits: { enabled: true, frame: 'home', min: [-200, -200, -50], max: [200, 200, 400] },
    home: [0, 0, 0],
  };
  const run = (stickout, depth) => {
    const built = buildAssembly({ stickout }, tools[2], holders[0], { spindleDiameter: 90, spindleLength: 80 });
    const slot = { built, index: 0, spheres: silhouetteSpheres(built.toolPoints) };
    const program = interpret(['G21 G90 G54', 'G0 X0 Y0 Z10', `G1 Z${depth} F300`, 'M30'].join('\n'),
      { machineZero: [0, 0, 0], gaugeLength: built.gaugeLength });
    const sim = new Simulator();
    sim.load({ program, stock: null, slots: new Map([[1, slot]]), fallbackSlot: slot, machine });
    sim.runAll();
    return { limits: sim.collisions.filter((c) => c.type === 'limit'), gauge: built.gaugeLength };
  };

  const deep = run(45, -40);
  assert.equal(deep.limits.length, 0, `a tip at -40 with a ${deep.gauge} mm assembly was stopped`);

  // Far enough down that the gauge line itself is through the floor, and
  // it stops — reported as the machine coordinate, which is the number the
  // control would be showing.
  const tooDeep = run(45, -(deep.gauge + 80));
  assert.equal(tooDeep.limits.length > 0, true, 'the axis went through its own floor unreported');
  assert.match(tooDeep.limits[0].message, /Z travel limit/);
});

test('a flat end is as low as it goes: no phantom radius below the tip', () => {
  // A Ø10 end mill 2 mm over a clamp and over the table is clear of both.
  // Read as spheres, the one at the tip hung 5 mm below it and both said
  // "3 mm in".
  const spheres = silhouetteSpheres([{ r: 0, z: 0 }, { r: 5, z: 0 }, { r: 5, z: 40 }]);
  const clamp = boxFixture([0, 0, -10], [40, 40, 20]);
  assert.equal(checkFixtures(spheres, [0, 0, 2], [clamp]), null);
  assert.ok(Math.abs(checkFixtures(spheres, [0, 0, 2], [clamp], 0, 5).gap - 2) < 1e-9);
  const sunk = checkFixtures(spheres, [0, 0, -1.5], [clamp]);
  assert.ok(Math.abs(sunk.depth - 1.5) < 1e-9);

  const table = { enabled: true, z: 0, xMin: -500, xMax: 500, yMin: -500, yMax: 500 };
  assert.equal(checkTable(spheres, [0, 0, 2], table), null);
  assert.ok(Math.abs(checkTable(spheres, [0, 0, -1], table).depth - 1) < 1e-9);
  // Laid flat, the side of the cutter is a radius below its axis.
  const flat = checkTable(spheres, [0, 0, 4], table, 0, [1, 0, 0]);
  assert.ok(flat && Math.abs(flat.depth - 1) < 1e-6, JSON.stringify(flat));
  // Leaned 30°, the low rim is r·sin30 below the tip, on the downhill side.
  const s30 = Math.sin(Math.PI / 6), c30 = Math.cos(Math.PI / 6);
  const leaned = checkTable(spheres, [0, 0, 2], table, 0, [s30, 0, c30]);
  assert.ok(leaned && Math.abs(leaned.depth - (5 * s30 - 2)) < 1e-6, JSON.stringify(leaned));
  assert.ok(leaned.x > 0, 'the top leans to +X, so the end face dips on +X');
});

test('the side of the tool is found between samples, against a thin plate', () => {
  // A 0.5 mm plate whose edge the cutter's side just touches, between two
  // of the samples 3 mm apart up the tool.
  const spheres = silhouetteSpheres([{ r: 0, z: 0 }, { r: 5, z: 0 }, { r: 5, z: 40 }]);
  const plate = boxFixture([5 + 20 - 0.1, 0, 4.5], [40, 40, 0.5]);
  const hit = checkFixtures(spheres, [0, 0, 0], [plate]);
  assert.ok(hit && Math.abs(hit.depth - 0.1) < 1e-9, JSON.stringify(hit && hit.depth));
});

test('a tilted box is still asked about, with the sphere chain', () => {
  const spheres = silhouetteSpheres([{ r: 0, z: 0 }, { r: 5, z: 0 }, { r: 5, z: 40 }]);
  const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
  // Turned 45° about X: the tool is no longer square to it.
  const box = { ...boxFixture([0, 0, 0], [20, 20, 20]), inverse: [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1] };
  assert.ok(checkFixtures(spheres, [0, 0, 5], [box]), 'buried in it, at any angle');
  assert.equal(checkFixtures(spheres, [0, 0, 40], [box]), null, 'well clear above it');
});

test('block search goes to a move without cutting or checking on the way', () => {
  const stock = new Stock({ origin: [-50, -25, -20], size: [100, 50, 20], resolution: 0.5 });
  const slots = new Map([[1, slot(0, null, 40)], [2, slot(0, null, 40, 1)]]);
  // A rapid through the stock on the way: a crash, if it were made.
  const lines = ['G90 G0 X-60 Y0 Z5', 'T1 M6', 'S3000 M3', 'G0 Z-5', 'G0 X60', 'G0 Z5', 'T2 M6', 'G1 X0 Y0 Z-2 F600', 'G1 X-40', 'M30'];
  const program = interpret(lines.join('\n'));
  const sim = new Simulator();
  sim.load({ program, stock, slots, fallbackSlot: slots.get(1) });
  const k = program.moves.findIndex((mv) => mv.line === 8);
  const { reset } = sim.searchTo(k);
  assert.equal(reset, false);
  assert.equal(sim.moveIndex, k);
  assert.equal(sim.currentTool, 2);
  assert.equal(sim.activeSlot, slots.get(2));
  assert.deepEqual(sim.pos, program.moves[k].from);
  let start = 0;
  for (let i = 0; i < k; i++) start += program.moves[i].time;
  assert.ok(Math.abs(sim.time - start) < 1e-9);
  assert.equal(sim.removedVolume, 0);
  assert.equal(sim.collisions.length, 0);
  // From there it plays as usual: the cut on line 8 and 9 is made.
  sim.runAll();
  assert.ok(sim.removedVolume > 0);
  assert.ok(!sim.collisions.some((c) => c.type === 'rapid'), 'the skipped rapid is not reported');
  // Searching back starts from the raw stock.
  const back = sim.searchTo(2);
  assert.equal(back.reset, true);
  assert.equal(sim.removedVolume, 0);
  assert.equal(sim.moveIndex, 2);
  assert.ok(!sim.finished);
  // Past the end: finished, at the end of the program.
  sim.searchTo(program.moves.length);
  assert.ok(sim.finished);
  assert.ok(Math.abs(sim.time - sim.totalTime) < 1e-9);
});

test('a checkpoint takes a step back exactly: stock, findings and position', async () => {
  const { TriDexelStock } = await import('../src/sim/triDexel.js');
  const slots = new Map([[1, slot(0, null, 40)]]);
  const lines = ['G90 G0 X-30 Y0 Z5', 'T1 M6', 'S3000 M3', 'G1 Z-2 F600', 'G1 X30', 'G0 Y8 Z-3', 'G0 X-30', 'G1 Y10 Z-4', 'G2 X30 Y10 R40', 'M30'];
  const program = interpret(lines.join('\n'));
  const fresh = () => {
    const stock = new TriDexelStock({ origin: [-40, -20, -10], size: [80, 40, 10], resolution: 0.5 });
    const sim = new Simulator();
    sim.load({ program, stock, slots, fallbackSlot: slots.get(1) });
    return sim;
  };
  const starts = [0];
  for (const mv of program.moves) starts.push(starts[starts.length - 1] + mv.time);
  const lineDump = (st) => st.fam.map((F) => {
    const out = [];
    for (let r = 0; r < F.rays; r++) {
      const o = F.off[r];
      out.push(F.cnt[r], ...F.pool.subarray(o, o + 2 * F.cnt[r]), ...F.who.subarray(o, o + 2 * F.cnt[r]));
    }
    return out.join(',');
  });
  const state = (sim) => ({
    t: sim.time, k: sim.moveIndex, pos: sim.pos.join(','), vol: sim.removedVolume.toFixed(6),
    stockVol: sim.stock.removedVolume.toFixed(6), found: sim.collisions.map((c) => `${c.type}:${c.line}:${c.count}`).join(' '),
    stats: Array.from(sim.moveStats).join(','), lines: lineDump(sim.stock), tops: Array.from(sim.stock.height).join(','),
  });

  const sim = fresh();
  const cps = [];
  const marks = [];
  for (let k = 1; k <= program.moves.length; k++) {
    marks.push(state(sim));
    const cp = sim.checkpoint();
    while (!sim.finished && sim.time < starts[k] - 1e-9) sim.run(starts[k] - sim.time, 1e9);
    assert.ok(sim.closeCheckpoint(cp));
    cps.push(cp);
  }
  assert.ok(sim.collisions.some((c) => c.type === 'rapid'), 'the rapid at Z-3 is a crash to take back');
  for (let k = cps.length - 1; k >= 0; k--) {
    assert.ok(sim.restoreCheckpoint(cps[k], cps[k - 1] || null), `step ${k} restores`);
    assert.deepEqual(state(sim), marks[k], `back to before step ${k}`);
  }
  // Played on from the start again, it cuts what it cut the first time.
  while (!sim.finished) sim.run(Infinity, 1e9);
  const again = fresh();
  while (!again.finished) again.run(Infinity, 1e9);
  assert.equal(sim.removedVolume.toFixed(6), again.removedVolume.toFixed(6));
  assert.deepEqual(lineDump(sim.stock), lineDump(again.stock));
  // A checkpoint is good only from where its step ended.
  const cp = sim.checkpoint();
  sim.closeCheckpoint(cp);
  sim.searchTo(2);
  assert.equal(sim.restoreCheckpoint(cp), false);
});
