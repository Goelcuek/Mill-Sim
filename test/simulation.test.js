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
  // A clamp 4 mm to the side of the tool: nothing touches it, but nobody
  // wants to find that out with a hand on the feed hold.
  const holder = slot(1, 0, 30);
  const clamp = boxFixture([26, 0, -10], [10, 20, 40]);

  const bare = checkFixtures(holder.spheres, [0, 0, 0], [clamp], 0, 0);
  assert.equal(bare, null, 'nothing is touching, so nothing is reported');

  const asked = checkFixtures(holder.spheres, [0, 0, 0], [clamp], 0, 12);
  assert.ok(asked, 'asked for room, and it says how much there is');
  assert.ok(asked.gap > 0, 'a gap, not a depth');
  assert.ok(asked.gap < 12);
  assert.equal(asked.depth, 0, 'nothing is buried in anything');

  // Push the tool into it and the same call reports a real collision.
  const hit = checkFixtures(holder.spheres, [24, 0, 0], [clamp], 0, 12);
  assert.ok(hit.gap < 0);
  assert.ok(hit.depth > 0);
});

test('a fixture can carry its own rule', () => {
  const holder = slot(1, 0, 30);
  const clamp = boxFixture([26, 0, -10], [10, 20, 40]);

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
