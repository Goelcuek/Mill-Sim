import test from 'node:test';
import assert from 'node:assert/strict';

import { interpret } from '../src/gcode/interpreter.js';
import { buildPreset } from '../src/machine/presets.js';

const MAZAK = { flavour: 'mazak', dialect: 'fanuc' };
const run = (lines, opts = {}) => interpret(lines.join('\n'), { controller: MAZAK, ...opts });
const near = (a, b, tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < tol);
const ends = (p, line) => p.moves.filter((m) => m.line === line).map((m) => m.to);
const last = (p, line) => { const e = ends(p, line); return e[e.length - 1]; };
const errors = (p) => p.warnings.filter((w) => w.severity === 'error');

test('T01 T02 M06 puts T01 in the spindle and T02 next', () => {
  const p = run(['G90 G54', 'T01 T02 M06', 'G43 H01 Z50.', 'G0 X10.', 'M06', 'G43 H02 Z50.', 'G0 X20.', 'M30']);
  assert.equal(p.moves.find((m) => m.line === 4).tool, 1);
  assert.equal(p.moves.find((m) => m.line === 7).tool, 2);
  assert.deepEqual(errors(p), []);
});

test('after G80 the next block still moves, in the motion that was in force', () => {
  const p = run(['G90 G54 G0 X0 Y0 Z100.', 'T1 M6', 'G81 X10. Y0 Z-5. R2. F100', 'G80', 'G43 H1 Z50.', 'X30.', 'M30']);
  assert.ok(near(last(p, 5), [10, 0, 50]));
  assert.ok(near(last(p, 6), [30, 0, 50]));
  assert.equal(p.moves.find((m) => m.line === 6).kind, 'rapid');
  assert.ok(!p.warnings.some((w) => /G80/.test(w.message)));
});

test('G52 moves the program to a local origin, and G52 X0 Y0 takes it away', () => {
  const p = run(['G90 G54 T1 M6', 'G52 X10. Y20.', 'G1 X5. Y5. Z0 F500', 'G52 X0 Y0', 'G1 X5. Y5.', 'M30']);
  assert.ok(near(last(p, 3), [15, 25, 0]));
  assert.ok(near(last(p, 5), [5, 5, 0]));
});

test('G68 turns the program about its centre, holes included; G69 ends it', () => {
  const p = run(['G90 G54 T1 M6', 'G0 Z10.', 'G68 X10. Y0 R90.', 'G1 X20. Y0 F500', 'G81 X20. Y0 Z-5. R2. F100', 'G80', 'G69', 'G1 X20. Y0', 'M30']);
  assert.ok(near(last(p, 4), [10, 10, 10]));
  const hole = p.moves.filter((m) => m.line === 5);
  assert.ok(hole.some((m) => near(m.to, [10, 10, -5])), 'drilled at the turned point');
  assert.ok(near(last(p, 8), [20, 0, 10]));
});

test('G51.1 mirrors the path, arcs and all, and G50.1 puts it back', () => {
  const p = run(['G90 G54 T1 M6', 'G0 X0 Y0 Z0', 'G51.1 X0', 'G1 X10. F500', 'G2 X20. Y0 R5.', 'G50.1 X0', 'G1 X10.', 'M30']);
  assert.ok(near(last(p, 4), [-10, 0, 0]));
  const arc = p.moves.find((m) => m.line === 5);
  assert.ok(near(arc.to, [-20, 0, 0], 1e-6));
  // Clockwise in the program, so anticlockwise on the machine: the arc
  // bows the same side (+Y) as the unmirrored clockwise one would.
  const ys = [];
  for (let i = 1; i < arc.path.length; i += 3) ys.push(arc.path[i]);
  assert.ok(Math.max(...ys) > 4.9, `arc bows up to +Y, got ${Math.max(...ys)}`);
  assert.ok(near(last(p, 7), [10, 0, 0]));
});

test('G51 scales about a point; G50 cancels', () => {
  const p = run(['G90 G54 T1 M6', 'G0 X0 Y0 Z0', 'G51 X0 Y0 P2.', 'G1 X10. Y5. F500', 'G50', 'G1 X10. Y5.', 'M30']);
  assert.ok(near(last(p, 4), [20, 10, 0]));
  assert.ok(near(last(p, 6), [10, 5, 0]));
});

test('G16 polar: a bolt circle by radius and angle, the angle stepped in G91', () => {
  const p = run(['G90 G54 T1 M6', 'G0 Z10.', 'G16', 'G81 X50. Y30. Z-5. R2. F100', 'G91 Y120.', 'Y120.', 'G90 G80', 'G15', 'M30']);
  const bottoms = p.moves.filter((m) => m.kind === 'feed').map((m) => m.to);
  const want = [30, 150, 270].map((a) => [50 * Math.cos(a * Math.PI / 180), 50 * Math.sin(a * Math.PI / 180), -5]);
  assert.equal(bottoms.length, 3);
  bottoms.forEach((b, i) => assert.ok(near(b, want[i], 1e-6), `hole ${i}: ${b} vs ${want[i]}`));
});

test('G54.1 P1 and G10 L20 use the extra work offsets', () => {
  const p = run(['G90 T1 M6', 'G54.1 P1', 'G0 X0 Y0 Z0', 'G10 L20 P2 X-50. Y10. Z0', 'G54.1 P2', 'G0 X0 Y0', 'M30'], { wcs: { 'G54.1 P1': [100, 0, 0] } });
  assert.ok(near(last(p, 3), [100, 0, 0]));
  assert.ok(near(last(p, 6), [-50, 10, 0]));
  assert.equal(p.moves.find((m) => m.line === 3).wcs, 'G54.1 P1');
});

test('M98 H calls an N block of the same program and comes back', () => {
  const p = run(['G90 G54 T1 M6', 'G0 X0 Y0 Z0', 'M98 H500 L2', 'G0 X100.', 'M30', 'N500 G91 G1 X1. F100', 'G90', 'M99']);
  const xs = p.moves.map((m) => +m.to[0].toFixed(6));
  assert.deepEqual(xs.slice(-3), [1, 2, 100]);
  assert.deepEqual(errors(p), []);
});

test('G66 calls its macro after every move until G67', () => {
  const p = run(['G90 G54 T1 M6', 'G0 X0 Y0 Z10.', 'G66 P9000 Z-3.', 'X10.', 'X20.', 'G67', 'X30.', 'M30', 'O9000', 'G91 G1 Z#26 F100', 'G0 Z-#26', 'G90', 'M99']);
  const dips = p.moves.filter((m) => m.kind === 'feed').map((m) => m.to);
  assert.equal(dips.length, 2);
  assert.ok(near(dips[0], [10, 0, 7]));
  assert.ok(near(dips[1], [20, 0, 7]));
});

test('G12 cuts a whole circle of radius I less the tool radius, and comes back to the centre', () => {
  const p = run(['G90 G54 T1 M6', 'G0 X50. Y50. Z-2.', 'G12 I20. D1 F300', 'M30'], { tools: { 1: { length: 100, diameter: 10 } } });
  const pts = [];
  for (const m of p.moves.filter((mv) => mv.line === 3)) for (let i = 0; i < m.path.length; i += 3) pts.push([m.path[i], m.path[i + 1]]);
  const reach = Math.max(...pts.map(([x, y]) => Math.hypot(x - 50, y - 50)));
  assert.ok(Math.abs(reach - 15) < 0.02, `reached ${reach}`);
  assert.ok(near(last(p, 3), [50, 50, -2], 1e-6));
});

test('synchronous tapping G84.2 taps; smoothing modes pass quietly', () => {
  const p = run(['G90 G54 T1 M6 S500 M3', 'G05.1 Q1', 'G05 P10000', 'G08 P1', 'G61.1', 'G0 X0 Y0 Z10.', 'G84.2 X0 Y0 Z-10. R2. F500', 'G80', 'M30']);
  assert.ok(p.moves.some((m) => m.line === 7 && near(m.to, [0, 0, -10])));
  assert.ok(!p.warnings.some((w) => /Unsupported/.test(w.message)), p.warnings.map((w) => w.message).join('; '));
});

test('a drilling cycle in a G68.2 plane drills down the plane, not the machine', () => {
  const kinematics = buildPreset('tableTable');
  const p = interpret(['G90 G54 G17', 'T1 M6', 'G68.2 X0 Y0 Z0 I0 J90 K0', 'G53.1', 'G0 X10. Y10. Z50.', 'G81 X10. Y10. Z-5. R2. F100', 'G80', 'G69', 'M30'].join('\n'), { controller: MAZAK, kinematics });
  const feed = p.moves.filter((m) => m.line === 6 && m.kind === 'feed');
  assert.equal(feed.length, 1);
  // The plane is turned 90° about X: its Z is the part's −Y, its Y the part's Z.
  assert.ok(near(feed[0].from, [10, -2, 10], 1e-6), `from ${feed[0].from}`);
  assert.ok(near(feed[0].to, [10, 5, 10], 1e-6), `to ${feed[0].to}`);
});

test('cutter compensation has to start and end on a straight move', () => {
  const bad = run(['G90 G54 T1 M6', 'G0 X0 Y0 Z0', 'G41 D1 G2 X10. Y0 R5. F500', 'G1 X20.', 'G40 G3 X30. Y0 R5.', 'M30']);
  const said = errors(bad).map((w) => w.line);
  assert.deepEqual(said, [3, 5]);
  // Switched on alone, the first move in the plane after it counts.
  const late = run(['G90 G54 T1 M6', 'G0 X0 Y0 Z10.', 'G42 D1', 'G1 Z0 F500', 'G2 X10. Y0 R5.', 'G40', 'G1 X0', 'M30']);
  assert.deepEqual(errors(late).map((w) => w.line), [5]);
  const good = run(['G90 G54 T1 M6', 'G0 X0 Y0 Z0', 'G41 D1 G1 X10. F500', 'G2 X20. Y0 R5.', 'G40 G1 X30.', 'M30']);
  assert.deepEqual(errors(good), []);
  const siemens = interpret(['G90 G54 T1 M6', 'G0 X0 Y0 Z0', 'G41 G2 X10 Y0 CR=5 F500', 'G40 G1 X20', 'M30'].join('\n'), { controller: { flavour: 'siemens', dialect: 'siemens' } });
  assert.deepEqual(errors(siemens).map((w) => w.line), [3]);
});
