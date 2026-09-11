// Five-axis behaviour: the tilted carver, the Fanuc tilt/TCP codes, and the
// bridge between them. The 3-axis cases are covered elsewhere; what matters
// here is that nothing changes when the tool happens to stand upright, and
// that the tilted results match closed-form geometry where one exists.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Stock } from '../src/sim/stock.js';
import { buildTool, makeTool } from '../src/tools/toolDefs.js';
import { interpret, tiltedPlaneMatrix } from '../src/gcode/interpreter.js';
import * as m4 from '../src/core/mat4.js';
import { buildPreset } from '../src/machine/presets.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);
const rad = (d) => (d * Math.PI) / 180;

const envOf = (spec) => buildTool(makeTool(spec)).cutEnvelope;
const blank = (res = 0.25) => new Stock({ origin: [-40, -40, -20], size: [80, 80, 20], resolution: res });

const run = (src, cfg) => interpret(Array.isArray(src) ? src.join('\n') : src, cfg);
const errs = (p) => p.warnings.filter((w) => w.severity === 'error');

// ---------------------------------------------------------------- carving

test('an upright tilted carve matches the straight-down carve', () => {
  const env = envOf({ type: 'flat', diameter: 12, fluteLength: 30 });
  const a = blank();
  const b = blank();
  a.carve(env, 3, -4, -5);
  b.carveTilted(env, [3, -4, -5], [0, 0, 1], 30);

  let worst = 0;
  for (let i = 0; i < a.height.length; i++) worst = Math.max(worst, Math.abs(a.height[i] - b.height[i]));
  near(worst, 0, 1e-6, 'surfaces agree');
  near(a.removedVolume, b.removedVolume, 1e-6, 'volume agrees');
});

test('a tilted ball nose bottoms out where the sphere says it should', () => {
  const r = 5;
  const env = envOf({ type: 'ball', diameter: 2 * r, fluteLength: 30 });

  for (const deg of [0, 15, 30, 45, 60]) {
    const dir = [Math.sin(rad(deg)), 0, Math.cos(rad(deg))];
    const s = blank(0.1);
    const tip = [0, 0, -2];
    s.carveTilted(env, tip, dir, 30);

    // The ball's centre is r up the axis, so tilting about the tip drops the
    // centre by r*(1 - cos) and the sphere's lowest point with it. That
    // point sits directly under the centre.
    let low = Infinity, lowI = 0, lowJ = 0;
    for (let j = 0; j < s.ny; j++) {
      for (let i = 0; i < s.nx; i++) {
        const h = s.height[j * s.nx + i];
        if (h < low) { low = h; lowI = i; lowJ = j; }
      }
    }
    near(low, tip[2] + r * (dir[2] - 1), 3e-3, `${deg} deg deepest point`);
    near(s.cx(lowI), tip[0] + dir[0] * r, 0.2, `${deg} deg contact sits under the ball centre`);
    near(s.cy(lowJ), tip[1] + dir[1] * r, 0.2, `${deg} deg contact stays on the tilt plane`);
  }
});

test('a tilted flat end mill leaves the ellipse its diameter implies', () => {
  const d = 10, deg = 30;
  const env = envOf({ type: 'flat', diameter: d, fluteLength: 40 });
  // A thin slab, so what is left is one horizontal section of the tool
  // rather than the union of every section it passed through. The tip is
  // well below the slab, so the section cuts the cylinder, not the end cap,
  // and that section is the full ellipse.
  const s = new Stock({ origin: [-40, -40, -0.1], size: [80, 80, 0.1], resolution: 0.05 });
  s.carveTilted(env, [0, 0, -10], [Math.sin(rad(deg)), 0, Math.cos(rad(deg))], 40);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < s.ny; j++) {
    for (let i = 0; i < s.nx; i++) {
      if (s.height[j * s.nx + i] > -1e-6) continue;
      minX = Math.min(minX, s.cx(i)); maxX = Math.max(maxX, s.cx(i));
      minY = Math.min(minY, s.cy(j)); maxY = Math.max(maxY, s.cy(j));
    }
  }
  near(maxY - minY, d, 0.15, 'minor axis is the diameter');
  near(maxX - minX, d / Math.cos(rad(deg)), 0.15, 'major axis stretches with the tilt');
  // And the ellipse leans up-tilt, starting at the tip rather than straddling it.
  near(minX, 0, 0.15, 'the down-tilt edge touches the tip column');
});

test('a tilted carve never lifts the surface or invents material', () => {
  const env = envOf({ type: 'bull', diameter: 12, cornerRadius: 2, fluteLength: 30 });
  const s = blank(0.2);
  const before = s.height.slice();
  s.carveTilted(env, [0, 0, -6], m4.normalize([0.4, 0.3, 0.87]), 30);
  for (let i = 0; i < s.height.length; i++) {
    assert.ok(s.height[i] <= before[i] + 1e-9, `column ${i} rose`);
  }
  assert.ok(s.removedVolume > 0, 'something was actually cut');
});

test('a tilted cutter clear of the stock removes nothing', () => {
  const env = envOf({ type: 'flat', diameter: 8, fluteLength: 30 });
  const s = blank(0.25);
  const r = s.carveTilted(env, [0, 0, 5], m4.normalize([0.5, 0, 0.866]), 30);
  assert.equal(r.volume, 0);
  assert.equal(s.removedVolume, 0);
});

// ------------------------------------------------------------- the codes

test('G68.2 P1 builds the Euler ZXZ frame Fanuc documents', () => {
  // ZXZ by (0, 90, 0) lays the plane's Z along the machine -Y... in the
  // usual convention the second rotation tips Z toward +Y by 90 degrees.
  const m = tiltedPlaneMatrix([10, 20, 30], 0, 90, 0, 1);
  const origin = m4.transformPoint([0, 0, 0], m, [0, 0, 0]);
  assert.deepEqual([...origin], [10, 20, 30]);
  const zAxis = m4.transformDir([0, 0, 0], m, [0, 0, 1]);
  near(zAxis[0], 0, 1e-12, 'zx');
  near(Math.abs(zAxis[1]), 1, 1e-12, 'the plane normal has tipped into Y');
  near(zAxis[2], 0, 1e-12, 'zz');

  // Zero angles is the identity frame at the origin.
  const flat = tiltedPlaneMatrix([0, 0, 0], 0, 0, 0, 1);
  near(m4.dot(m4.transformDir([0, 0, 0], flat, [0, 0, 1]), [0, 0, 1]), 1, 1e-12, 'untilted');
});

test('G68.2 P2 is roll-pitch-yaw, not the same as P1', () => {
  const rpy = tiltedPlaneMatrix([0, 0, 0], 0, 30, 0, 2);
  const n = m4.transformDir([0, 0, 0], rpy, [0, 0, 1]);
  // A 30 degree pitch tips the normal into +X by sin(30).
  near(n[0], Math.sin(rad(30)), 1e-12, 'pitched into X');
  near(n[2], Math.cos(rad(30)), 1e-12, 'and leans back the right amount');

  const zxz = tiltedPlaneMatrix([0, 0, 0], 0, 30, 0, 1);
  assert.notDeepEqual([...zxz], [...rpy]);
});

test('programming in a tilted plane moves along that plane, not the machine', () => {
  const p = run([
    'G90 G21 G17 G54',
    'G0 X0 Y0 Z50',
    'G68.2 X0 Y0 Z0 I0 J90 K0 P2',   // plane pitched 90 degrees about Y
    'G1 X10 Y0 Z0 F500',
    'G69',
    'M30',
  ]);
  assert.deepEqual(errs(p), []);
  const f = p.moves.filter((m) => m.kind === 'feed');
  assert.equal(f.length, 1);
  // Plane X now runs down the machine's -Z, so ten along it is ten down.
  near(f[0].to[0], 0, 1e-9, 'no machine X');
  near(f[0].to[2], -10, 1e-9, 'ten millimetres down instead');
});

test('G69 puts the machine back in its own frame', () => {
  const p = run([
    'G90 G21 G54', 'G0 X0 Y0 Z0',
    'G68.2 X0 Y0 Z0 I0 J90 K0 P2',
    'G69',
    'G1 X10 F500', 'M30',
  ]);
  assert.deepEqual(errs(p), []);
  const f = p.moves.find((m) => m.kind === 'feed');
  near(f.to[0], 10, 1e-9, 'plain machine X again');
  near(f.to[2], 0, 1e-9, 'and no Z');
  assert.ok(p.events.some((e) => e.text.includes('G69')), 'the cancel is logged');
});

test('G53.1 swings the rotaries normal to the tilted plane', () => {
  const machine = buildPreset('headTable');
  const p = run([
    'G90 G21 G54', 'G0 X0 Y0 Z0',
    'G68.2 X0 Y0 Z0 I0 J30 K0 P2',
    'G53.1',
    'M30',
  ], { kinematics: machine, gaugeLength: 95 });

  assert.deepEqual(errs(p), []);
  const aligned = p.events.find((e) => e.type === 'align');
  assert.ok(aligned, 'the alignment is reported');

  const last = p.moves[p.moves.length - 1];
  const axis = machine.toolInWork({ ...last.rotTo }, 95).axis;
  const want = m4.normalize(m4.transformDir([0, 0, 0], tiltedPlaneMatrix([0, 0, 0], 0, 30, 0, 2), [0, 0, 1]));
  near(1 - m4.dot(axis, want), 0, 1e-7, 'the tool ends up normal to the plane');
});

test('G53.1 without a plane or without a machine is an error, not a crash', () => {
  const noPlane = run(['G90 G21', 'G53.1', 'M30'], { kinematics: buildPreset('headTable') });
  assert.ok(errs(noPlane).some((w) => /G53\.1/.test(w.message)));

  const noMachine = run(['G90 G21', 'G68.2 X0 Y0 Z0 I0 J30 K0 P2', 'G53.1', 'M30']);
  assert.ok(errs(noMachine).some((w) => /rotary|machine/i.test(w.message)));
});

test('rotary words alone still produce a move', () => {
  const p = run(['G90 G21 G54', 'G0 X0 Y0 Z0', 'G1 B30 C45 F500', 'M30']);
  assert.deepEqual(errs(p), []);
  const last = p.moves[p.moves.length - 1];
  assert.equal(last.rotTo.B, 30);
  assert.equal(last.rotTo.C, 45);
  assert.equal(last.rotFrom.B, 0);
  assert.deepEqual(last.to, last.from, 'the tip did not move in work coordinates');
});

test('rotary words ride along with a linear move and are incremental under G91', () => {
  const p = run([
    'G90 G21 G54', 'G0 X0 Y0 Z0',
    'G1 X10 A15 F500',
    'G91', 'G1 X5 A15',
    'M30',
  ]);
  const f = p.moves.filter((m) => m.kind === 'feed');
  assert.equal(f[0].rotTo.A, 15);
  assert.equal(f[1].rotTo.A, 30, 'G91 adds to the rotary as well');
  near(f[1].to[0], 15, 1e-9, 'and the linear axis is still incremental');
});

test('G43.4 and G43.5 record tool centre point control, G49 clears it', () => {
  const p = run([
    'G90 G21 G54', 'G0 X0 Y0 Z0',
    'G43.4 H1', 'G1 X10 F500',
    'G49', 'G1 X20',
    'M30',
  ]);
  const f = p.moves.filter((m) => m.kind === 'feed');
  assert.equal(f[0].tcp, 4, 'TCP is on for the first move');
  assert.equal(f[1].tcp, 0, 'and off after G49');
  assert.ok(p.events.some((e) => e.type === 'tcp'));

  const five = run(['G90 G21', 'G43.5 H1', 'G1 X1 F100', 'M30']);
  assert.equal(five.moves.filter((m) => m.kind === 'feed')[0].tcp, 5);
});

test('a five-axis program runs end to end without warnings', () => {
  const machine = buildPreset('tableTable');
  const p = run([
    'G90 G21 G17 G54',
    'G0 X0 Y0 Z50',
    'G68.2 X0 Y0 Z0 I0 J20 K0 P2',
    'G53.1',
    'G43.4 H1',
    'G1 X0 Y0 Z0 F400',
    'G1 X20',
    'G2 X30 Y10 I0 J10',
    'G69 G49',
    'G0 Z50',
    'M30',
  ], { kinematics: machine, gaugeLength: 90 });

  assert.deepEqual(errs(p), []);
  assert.ok(p.moves.length > 5);
  assert.ok(p.moves.every((m) => m.to.every(Number.isFinite)), 'every point is a real number');
  assert.ok(p.moves.some((m) => m.kind === 'arc'), 'the arc survived the tilt');
});
