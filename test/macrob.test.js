// Macro B: variables, arithmetic, and the control flow that makes a family
// of parts one program instead of twenty.

import test from 'node:test';
import assert from 'node:assert/strict';

import { interpret } from '../src/gcode/interpreter.js';
import { parseMacroBlock, evaluate, hasMacroSyntax, Vars } from '../src/gcode/macro.js';
import { lex } from '../src/gcode/lexer.js';

const run = (src, cfg = {}) => interpret(Array.isArray(src) ? src.join('\n') : src, cfg);
const errs = (p) => p.warnings.filter((w) => w.severity === 'error').map((w) => w.message);
const at = (p) => p.moves.map((m) => m.to.map((v) => Number(v.toFixed(3))));
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);

test('only the blocks that need the macro reader get it', () => {
  assert.equal(hasMacroSyntax('G1 X10 Y20 F300'), false);
  assert.equal(hasMacroSyntax('#100 = 5'), true);
  assert.equal(hasMacroSyntax('G1 X[10+5]'), true);
  assert.equal(hasMacroSyntax('IF [#1 GT 2] GOTO 50'), true);

  // An ordinary block still comes out of the lexer the way it always did.
  const [plain] = lex('G1 X10.5 Y-3 F300');
  assert.equal(plain.macro, undefined);
  assert.deepEqual(plain.words.map((w) => [w.letter, w.value]), [['G', 1], ['X', 10.5], ['Y', -3], ['F', 300]]);
});

test('arithmetic follows the usual precedence, and brackets beat it', () => {
  const vars = new Vars();
  vars.set(1, 10);
  vars.set(2, 4);
  const value = (code) => {
    const b = parseMacroBlock(`#100 = ${code}`);
    assert.equal(b.error, undefined, `${code}: ${b.error}`);
    return evaluate(b.assigns[0].value, vars);
  };

  assert.equal(value('2 + 3 * 4'), 14);
  assert.equal(value('[2 + 3] * 4'), 20);
  assert.equal(value('#1 - #2'), 6);
  assert.equal(value('#1 / #2'), 2.5);
  assert.equal(value('7 MOD 4'), 3);
  assert.equal(value('-#2'), -4);
  near(value('SQRT[#1 * #1 + #2 * #2]'), Math.hypot(10, 4), 1e-9, 'SQRT');
  near(value('SIN[30]'), 0.5, 1e-9, 'trig is in degrees, like the control');
  near(value('COS[60]'), 0.5, 1e-9, 'COS');
  assert.equal(value('ROUND[-2.5]'), -3, 'Fanuc rounds away from zero');
  assert.equal(value('FIX[3.9]'), 3);
  assert.equal(value('FUP[3.1]'), 4);
  assert.equal(value('[#1 GT #2]'), 1, 'a comparison is a value');
  assert.equal(value('[#1 LT #2]'), 0);
  assert.equal(value('[[#1 GT 5] AND [#2 LT 5]]'), 1);
});

test('a variable can be read anywhere a number can', () => {
  const p = run(['G90 G21 G54', '#100 = 5', '#101 = [#100 + 3] * 2', 'G0 X#100 Y#101 Z[#100 / 2]', 'M30']);
  assert.deepEqual(errs(p), []);
  assert.deepEqual(at(p), [[5, 16, 2.5]]);
  assert.deepEqual(p.variables, [{ n: 100, value: 5 }, { n: 101, value: 16 }]);
});

test('a bolt circle is a WHILE loop, and lands where trigonometry says', () => {
  const p = run([
    'G90 G21 G54',
    '#1 = 0', '#2 = 6', '#3 = 25',
    'WHILE [#1 LT #2] DO 1',
    '  #10 = #3 * COS[360 * #1 / #2]',
    '  #11 = #3 * SIN[360 * #1 / #2]',
    '  G0 X#10 Y#11',
    '  G1 Z-2 F200',
    '  G0 Z2',
    '  #1 = #1 + 1',
    'END 1',
    'M30',
  ]);
  assert.deepEqual(errs(p), []);
  const holes = p.moves.filter((m) => m.kind === 'feed').map((m) => [m.to[0], m.to[1]]);
  assert.equal(holes.length, 6, 'six holes, because the loop ran six times');
  for (let i = 0; i < 6; i++) {
    const a = (i * 60 * Math.PI) / 180;
    near(holes[i][0], 25 * Math.cos(a), 1e-6, `hole ${i} x`);
    near(holes[i][1], 25 * Math.sin(a), 1e-6, `hole ${i} y`);
  }
});

test('nested loops close against the right END', () => {
  const p = run([
    'G90 G21', '#1 = 0',
    'WHILE [#1 LT 2] DO 1',
    '  #2 = 0',
    '  WHILE [#2 LT 3] DO 2',
    '    G0 X#1 Y#2',
    '    #2 = #2 + 1',
    '  END 2',
    '  #1 = #1 + 1',
    'END 1', 'M30',
  ]);
  assert.deepEqual(errs(p), []);
  assert.deepEqual(at(p).map((q) => [q[0], q[1]]),
    [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
});

test('IF jumps, and IF THEN assigns', () => {
  const jump = run(['G90 G21', '#100 = 3', 'N10 G0 X#100', '#100 = #100 - 1', 'IF [#100 GT 0] GOTO 10', 'M30']);
  assert.deepEqual(errs(jump), []);
  assert.deepEqual(at(jump).map((q) => q[0]), [3, 2, 1]);

  const then = run(['G90 G21', '#100 = 1', 'IF [#100 EQ 1] THEN #101 = 42', 'IF [#100 EQ 9] THEN #102 = 7', 'G0 X#101 Y#102', 'M30']);
  assert.deepEqual(errs(then), []);
  assert.deepEqual(at(then)[0].slice(0, 2), [42, 0], 'the second condition was false, so #102 is still nothing');
});

test('G65 passes its letters in as #1, #2, #3', () => {
  const sub = [{ name: 'O9010', text: 'O9010\n#1 = #1 * 2\nG0 X#1 Y#2 Z#3\nM99' }];
  const p = run(['G90 G21', 'G65 P9010 A10. B20. C3.', 'G0 Z50', 'M30'], { subprograms: sub });
  assert.deepEqual(errs(p), []);
  assert.deepEqual(at(p), [[20, 20, 3], [20, 20, 50]]);

  // The call's own #1 is local: back outside, it is untouched.
  const outer = run(['G90 G21', '#1 = 7', 'G65 P9010 A1.', 'G0 X#1', 'M30'],
    { subprograms: [{ name: 'O9010', text: 'O9010\n#1 = 99\nM99' }] });
  assert.deepEqual(errs(outer), []);
  assert.equal(at(outer)[0][0], 7, 'the macro kept its own #1');
});

test('what cannot be worked out is reported, not guessed at', () => {
  assert.match(errs(run(['G90 G21', '#100 = 1 / 0', 'M30']))[0], /division by zero/);
  assert.match(errs(run(['G90 G21', 'GOTO 500', 'M30']))[0], /no such line/);
  assert.match(errs(run(['G90 G21', 'WHILE [1 EQ 1] DO 1', 'G0 X1', 'M30']))[0], /no END 1/);
  assert.match(errs(run(['G90 G21', 'G1 X[10 + ] F100', 'M30']))[0], /not a number/);

  // And a loop with no way out stops at the block limit rather than hanging.
  const runaway = run(['G90 G21', 'WHILE [1 EQ 1] DO 1', 'G0 X1', 'END 1', 'M30'], { maxBlocks: 400 });
  assert.match(errs(runaway)[0], /block limit/);
});

test('a program with no macros in it is read exactly as before', () => {
  const plain = ['G90 G21 G54', 'G0 X0 Y0 Z5', 'G1 Z-1 F200', 'G1 X50 F600', 'G2 X60 Y10 I0 J10', 'G0 Z20', 'M30'];
  const p = run(plain);
  assert.deepEqual(errs(p), []);
  assert.deepEqual(p.variables, [], 'and it set no variables');
  assert.ok(p.moves.some((m) => m.kind === 'arc'));
});
