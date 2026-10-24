// A program's own variables, and the record of what they held.
//
// Siemens lets a program name what it keeps — DEF REAL DEPTH=5 — where a
// Fanuc only has numbers. These check that the names behave the way the
// control's do: typed, scoped to the subprogram that declared them, with
// the machine's own data readable by name, and every change written down
// against the line and the move it happened before.

import test from 'node:test';
import assert from 'node:assert/strict';

import { interpret } from '../src/gcode/interpreter.js';
import { coerce } from '../src/gcode/macro.js';

const SIEMENS = { controller: { flavour: 'siemens' } };
const run = (lines, extra = {}) => interpret(lines.join('\n'), { ...SIEMENS, ...extra });
const errs = (p) => p.warnings.filter((w) => w.severity === 'error').map((w) => w.message);
const at = (p) => p.moves.map((m) => m.to.slice(0, 3).map((v) => Number(v.toFixed(4))));
/** The last value the trace has for a key. */
const last = (p, key) => {
  const hits = p.variableTrace.filter((t) => t.key === key);
  return hits.length ? hits[hits.length - 1].value : undefined;
};

test('DEF declares a variable a move can use', () => {
  const p = run([
    'DEF REAL DEPTH=5, STEP',
    'DEF INT COUNT=0',
    'R1=10',
    'STEP=2.5',
    'G0 X0 Y0 Z10',
    'G1 Z=-DEPTH F200',
    'COUNT=COUNT+1',
    'G1 X=R1+STEP',
    'M30',
  ]);
  assert.deepEqual(errs(p), []);
  assert.deepEqual(at(p), [[0, 0, 10], [0, 0, -5], [12.5, 0, -5]]);
  assert.equal(last(p, 'COUNT'), 1);
  assert.equal(last(p, 'STEP'), 2.5);
  assert.deepEqual(p.namedVariables.map((v) => `${v.type} ${v.name}`), ['REAL DEPTH', 'REAL STEP', 'INT COUNT']);
});

test('an INT rounds half away from zero, a BOOL is 1 or 0, a REAL will not hold text', () => {
  assert.equal(coerce('INT', 7.5), 8);
  assert.equal(coerce('INT', -2.5), -3);
  assert.equal(coerce('INT', 2.4), 2);
  assert.equal(coerce('BOOL', 5), 1);
  assert.equal(coerce('BOOL', 0), 0);
  assert.equal(coerce('STRING', 3), '3');
  assert.throws(() => coerce('REAL', 'ROUGH', 'DEPTH'), /text cannot go in the REAL DEPTH/);
});

test('arrays fill from SET, count from zero, and refuse an index outside them', () => {
  const p = run([
    'G90 G21',
    'DEF REAL POS[3]=SET(10, 20, 30)',
    'DEF INT NN',
    'FOR NN=0 TO 2',
    '  G1 X=POS[NN] F500',
    'ENDFOR',
    'POS[1]=7',
    'G1 Y=POS[1]',
    'G1 Y=POS[3]',
    'M30',
  ]);
  assert.deepEqual(at(p).map((m) => m[0]), [10, 20, 30, 30]);
  assert.equal(at(p)[3][1], 7);
  assert.equal(last(p, 'POS[1]'), 7);
  assert.equal(last(p, 'NN'), 3, 'the counter goes one past, as it does on the control');
  assert.equal(errs(p).length, 1);
  assert.match(errs(p)[0], /POS\[3\] is outside POS\[3\]/);
});

test('two-dimensional arrays and their element names', () => {
  const p = run([
    'G90 G21',
    'DEF REAL GRID[2, 3]',
    'GRID[1, 2]=42',
    'G1 X=GRID[1, 2] F500',
    'M30',
  ]);
  assert.deepEqual(errs(p), []);
  assert.equal(at(p)[0][0], 42);
  assert.equal(last(p, 'GRID[1, 2]'), 42);
  assert.equal(last(p, 'GRID[0, 0]'), 0, 'every element is there from the declaration');
});

test('text compares as text and can steer a jump', () => {
  const p = run([
    'G90 G21',
    'DEF STRING[16] OP="ROUGH"',
    'IF OP=="ROUGH" GOTOF CUT',
    'G1 Y99 F500',
    'CUT:',
    'G1 X5 F500',
    'M30',
  ]);
  assert.deepEqual(errs(p), []);
  assert.deepEqual(at(p), [[5, 0, at(p)[0][2]]]);
  assert.equal(last(p, 'OP'), 'ROUGH');
});

test('TRUE and FALSE read as 1 and 0', () => {
  const p = run([
    'G90 G21',
    'DEF BOOL DONE=FALSE',
    'IF DONE GOTOF END',
    'G1 X1 F500',
    'DONE=TRUE',
    'IF DONE GOTOF END',
    'G1 X2',
    'END:',
    'M30',
  ]);
  assert.deepEqual(errs(p), []);
  assert.deepEqual(at(p).map((m) => m[0]), [1]);
  assert.deepEqual(p.variableTrace.filter((t) => t.key === 'DONE').map((t) => t.value), [0, 1]);
});

test("a subprogram's DEF is its own and goes when it returns", () => {
  const p = run([
    'G90 G21',
    'DEF REAL HH=2.5',
    'CALL "SUB1"',
    'G1 Z=HH F500',
    'M30',
  ], { subprograms: [{ name: 'SUB1', text: ['DEF REAL HH=9', 'G1 Z=HH F500', 'M17'].join('\n') }] });
  assert.deepEqual(errs(p), []);
  assert.deepEqual(at(p).map((m) => m[2]), [9, 2.5]);
  const sub = p.namedVariables.find((v) => v.scope === 'SUB1');
  assert.equal(sub.key, 'HH · SUB1');
  const change = p.variableTrace.find((t) => t.key === 'HH · SUB1');
  assert.equal(change.src, 'SUB1');
});

test('a name nothing declared is the machine\'s own data, or an error that says so', () => {
  const p = run(['G90 G21', 'G1 X=CLEARANCE F500', 'G1 Y=MISSING', 'M30'], { parameters: { CLEARANCE: 50 } });
  assert.equal(at(p)[0][0], 50);
  const machine = p.namedVariables.find((v) => v.name === 'CLEARANCE');
  assert.equal(machine.scope, 'machine');
  assert.equal(errs(p).length, 1);
  assert.match(errs(p)[0], /MISSING is not defined: declare it with DEF, or give the machine a parameter/);
});

test('a single letter is an address, not a name', () => {
  const p = run(['DEF REAL H=2', 'M30']);
  assert.match(errs(p)[0], /H is an address; a variable's name starts with two letters/);
});

test('every lasting change is written down with its line and the move it came before', () => {
  const p = interpret([
    'G90 G21',
    '#1 = 4',
    '#100 = 1',
    'G1 X1 F500',
    '#100 = #100 + #1',
    'G1 X2',
    'M30',
  ].join('\n'));
  const changes = p.variableTrace.map((t) => [t.key, t.value, t.line, t.move]);
  // #1 belongs to the call that is running and is not followed; #100 is.
  assert.deepEqual(changes, [['#100', 1, 3, 0], ['#100', 5, 5, 1]]);
});

test('the trace can be turned off, and stops at its limit rather than running away', () => {
  const off = interpret(['#100 = 1', 'M30'].join('\n'), { traceVariables: false });
  assert.deepEqual(off.variableTrace, []);

  const loop = interpret([
    '#100 = 0',
    'WHILE [#100 LT 300000] DO 1',
    '#100 = #100 + 1',
    'END 1',
    'M30',
  ].join('\n'), { maxBlocks: 2000000 });
  assert.equal(loop.variableTraceTruncated, true);
  assert.equal(loop.variableTrace.length, 200000);
});
