import test from 'node:test';
import assert from 'node:assert/strict';

import { lex, stripComments } from '../src/gcode/lexer.js';
import { interpret, flattenArc } from '../src/gcode/interpreter.js';

const run = (src, cfg) => interpret(Array.isArray(src) ? src.join('\n') : src, cfg);
const feeds = (p) => p.moves.filter((m) => m.kind !== 'rapid' && m.kind !== 'dwell');

test('comments and block delete are stripped, words survive', () => {
  assert.deepEqual(stripComments('G1 X1 (move) Y2 ; rest').code.trim(), 'G1 X1  Y2');
  assert.deepEqual(stripComments('G1 (a) X1 ; b').comments, ['a', 'b']);

  const blocks = lex('%\nO100 (name)\nN10 G0X-12.5Y0.\n/G0 Z50\n');
  assert.equal(blocks[2].words.length, 4);
  assert.deepEqual(blocks[2].words.map((w) => w.letter + w.value), ['N10', 'G0', 'X-12.5', 'Y0']);
  assert.equal(blocks[3].blockDelete, true);
});

test('block delete lines produce no motion', () => {
  const p = run(['G90 G21', 'G0 X0 Y0 Z0', '/G1 X100 F100', 'G1 X10 F100', 'M30']);
  assert.equal(feeds(p).length, 1);
  assert.equal(feeds(p)[0].to[0], 10);
});

test('inches are converted and absolute/incremental both work', () => {
  const p = run(['G20 G90', 'G0 X1 Y0 Z0', 'G1 X2 F10', 'G91', 'G1 X1', 'M30']);
  const f = feeds(p);
  assert.ok(Math.abs(f[0].to[0] - 50.8) < 1e-9);
  assert.ok(Math.abs(f[1].to[0] - 76.2) < 1e-9);
  assert.equal(f[0].feed, 254);           // F10 in/min
});

test('IJK arcs sweep the correct way and length', () => {
  // Quarter circle CCW from (10,0) to (0,10) about the origin.
  const p = run(['G90 G21 G17', 'G0 X10 Y0 Z0', 'G3 X0 Y10 I-10 J0 F600', 'M30']);
  const arc = p.moves.find((m) => m.kind === 'arc');
  assert.ok(Math.abs(arc.length - (Math.PI / 2) * 10) < 0.01, `length ${arc.length}`);
  // Midpoint of the flattened path should sit on the circle.
  const n = arc.path.length / 3;
  const mid = (n - 1) >> 1;
  const r = Math.hypot(arc.path[mid * 3], arc.path[mid * 3 + 1]);
  assert.ok(Math.abs(r - 10) < 0.02);
});

test('a G2 the long way round is 270 degrees, not 90', () => {
  const p = run(['G90 G21 G17', 'G0 X20 Y0 Z0', 'G2 X30 Y10 I0 J10 F600', 'M30']);
  const arc = p.moves.find((m) => m.kind === 'arc');
  assert.ok(Math.abs(arc.length - (3 * Math.PI / 2) * 10) < 0.05, `length ${arc.length}`);
});

test('R-format arcs pick the minor arc for a positive radius', () => {
  const p = run(['G90 G21 G17', 'G0 X10 Y0 Z0', 'G3 X0 Y10 R10 F600', 'M30']);
  const arc = p.moves.find((m) => m.kind === 'arc');
  assert.ok(Math.abs(arc.length - (Math.PI / 2) * 10) < 0.05);
});

test('an impossible R arc is reported rather than drawn', () => {
  const p = run(['G90 G21 G17', 'G0 X0 Y0 Z0', 'G2 X50 Y0 R5 F600', 'M30']);
  assert.ok(p.warnings.some((w) => /smaller than half the chord/.test(w.message)));
});

test('a mismatched arc end point is reported', () => {
  const p = run(['G90 G21 G17', 'G0 X10 Y0 Z0', 'G2 X0 Y12 I-10 J0 F600', 'M30']);
  assert.ok(p.warnings.some((w) => /off the programmed radius/.test(w.message)));
});

test('helical interpolation carries Z through the arc', () => {
  const p = run(['G90 G21 G17', 'G0 X10 Y0 Z0', 'G3 X10 Y0 I-10 J0 Z-5 F600', 'M30']);
  const arc = p.moves.find((m) => m.kind === 'arc');
  assert.equal(arc.to[2], -5);
  assert.ok(arc.length > 2 * Math.PI * 10 - 1, 'a full turn');
});

test('G18 and G19 arcs use the right plane', () => {
  const xz = run(['G90 G21 G18', 'G0 X10 Y0 Z0', 'G2 X0 Y0 Z10 I-10 K0 F600', 'M30']);
  assert.ok(xz.moves.some((m) => m.kind === 'arc' && m.plane === 18));
  const yz = run(['G90 G21 G19', 'G0 X0 Y10 Z0', 'G2 Y0 Z10 J-10 K0 F600', 'M30']);
  assert.ok(yz.moves.some((m) => m.kind === 'arc' && m.plane === 19));
});

test('G81 drills a hole and retracts to the right plane', () => {
  const p = run(['G90 G21', 'G0 X0 Y0 Z50', 'G99 G81 X10 Y0 Z-5 R2 F150', 'G80', 'M30']);
  const cut = feeds(p);
  assert.equal(cut.length, 1);
  assert.deepEqual(cut[0].to, [10, 0, -5]);
  const last = p.moves[p.moves.length - 1];
  assert.equal(last.to[2], 2, 'G99 retracts to the R plane');

  const p98 = run(['G90 G21', 'G0 X0 Y0 Z50', 'G98 G81 X10 Y0 Z-5 R2 F150', 'G80', 'M30']);
  assert.equal(p98.moves[p98.moves.length - 1].to[2], 50, 'G98 retracts to the initial plane');
});

test('G83 pecks in Q increments', () => {
  const p = run(['G90 G21', 'G0 X0 Y0 Z10', 'G98 G83 X0 Y0 Z-10 R1 Q3 F100', 'G80', 'M30']);
  const depths = feeds(p).map((m) => +m.to[2].toFixed(2));
  assert.deepEqual(depths, [-2, -5, -8, -10]);
});

test('G91 canned cycles step by L repeats', () => {
  const p = run(['G21 G90', 'G0 X0 Y0 Z10', 'G91 G81 X10 Y5 Z-5 R2 F100 L3', 'G80', 'M30']);
  const holes = feeds(p).map((m) => [m.to[0], m.to[1]]);
  assert.deepEqual(holes, [[10, 5], [20, 10], [30, 15]]);
});

test('subprograms run and repeat', () => {
  const p = run([
    'G21 G90', 'G0 X0 Y0 Z0',
    'M98 P200 L3',
    'M30',
    'O200',
    'G91 G1 X5 F100',
    'G90',
    'M99',
  ]);
  const f = feeds(p);
  assert.equal(f.length, 3);
  assert.equal(f[2].to[0], 15);
});

test('a missing subprogram is an error, not a crash', () => {
  const p = run(['G21 G90', 'M98 P999', 'M30']);
  assert.ok(p.warnings.some((w) => /O999 not found/.test(w.message)));
});

test('work offsets shift the programmed position', () => {
  const p = run(['G21 G90 G55', 'G0 X0 Y0 Z0', 'G1 X10 F100', 'M30'], {
    wcs: { G55: [100, 50, -10] },
  });
  assert.deepEqual(feeds(p)[0].to, [110, 50, -10]);
});

test('G10 L2 programs a work offset', () => {
  const p = run(['G21 G90', 'G10 L2 P2 X100 Y0 Z0', 'G55', 'G0 X0 Y0 Z0', 'G1 X5 F100', 'M30']);
  assert.equal(feeds(p)[0].to[0], 105);
});

test('G28 returns via an optional intermediate point', () => {
  const p = run(['G21 G90', 'G0 X10 Y10 Z0', 'G91 G28 Z0', 'M30'], { machineZero: [0, 0, 300] });
  const last = p.moves[p.moves.length - 1];
  assert.equal(last.to[2], 300);
  assert.equal(last.to[0], 10, 'X is untouched by a Z-only G28');
});

test('G53 addresses machine coordinates', () => {
  const p = run(['G21 G90 G54', 'G0 X0 Y0 Z0', 'G53 G0 Z-50', 'M30'], { machineZero: [0, 0, 300] });
  assert.equal(p.moves[p.moves.length - 1].to[2], 250);
});

test('G43 with a mismatched H is flagged', () => {
  const p = run(['G21 G90', 'T5 M06', 'G43 H2 Z10', 'M30']);
  assert.ok(p.warnings.some((w) => /does not match the active tool/.test(w.message)));
});

test('dwell honours P milliseconds and X seconds', () => {
  const ms = run(['G21', 'G4 P1500', 'M30']);
  assert.equal(ms.moves.find((m) => m.kind === 'dwell').time, 1.5);
  const sec = run(['G21', 'G4 X2.5', 'M30']);
  assert.equal(sec.moves.find((m) => m.kind === 'dwell').time, 2.5);
});

test('tool changes are recorded in order', () => {
  const p = run(['G21 G90', 'T1 M06', 'G0 X0Y0Z0', 'G1 X1 F100', 'T3 M06', 'G1 X2', 'M30']);
  assert.deepEqual(p.toolChanges.map((t) => t.tool), [1, 3]);
  assert.equal(feeds(p)[0].tool, 1);
  assert.equal(feeds(p)[1].tool, 3);
});

test('cycle time accounts for feed rate and rapids', () => {
  const p = run(['G21 G90', 'G0 X0 Y0 Z0', 'G1 X100 F1000', 'M30'], { rapidRate: 10000 });
  const cut = feeds(p)[0];
  assert.ok(Math.abs(cut.time - 6) < 1e-6, `100mm at 1000mm/min is 6s, got ${cut.time}`);
});

test('a runaway loop is stopped instead of hanging', () => {
  const p = run(['G21 G90', 'O10', 'G91 G1 X0.001 F100', 'M98 P10', 'M99', 'M30'], { maxBlocks: 5000 });
  assert.ok(
    p.warnings.some((w) => /block limit|nesting too deep/.test(w.message)),
    'expected a guard to fire, got: ' + JSON.stringify(p.warnings.map((w) => w.message)),
  );
  assert.ok(p.moves.length < 5000, 'move list stayed bounded');
});

test('flattenArc chords stay inside the tolerance', () => {
  const path = flattenArc([50, 0, 0], [-50, 0, 0], [0, 0, 0], 17, true, 0.005);
  for (let i = 3; i < path.length; i += 3) {
    const mx = (path[i] + path[i - 3]) / 2;
    const my = (path[i + 1] + path[i - 2]) / 2;
    const sagitta = 50 - Math.hypot(mx, my);
    assert.ok(sagitta <= 0.0055, `sagitta ${sagitta}`);
  }
});
