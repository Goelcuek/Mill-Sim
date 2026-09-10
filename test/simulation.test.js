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

  // Seeking forward again must land on exactly the same result.
  while (!sim.finished) sim.run(Infinity, 50);
  assert.ok(Math.abs(sim.removedVolume - full) < 1e-6, `${sim.removedVolume} vs ${full}`);
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
