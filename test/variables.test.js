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
import { variableTimeline, formatVariable } from '../src/gcode/variableTimeline.js';

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

test('machine data is listed once the program reads it, and not before', () => {
  const p = run(['G90 G21', 'G1 X=CLEARANCE F500', 'M30'], { parameters: { CLEARANCE: 50, PARKX: -300 } });
  assert.deepEqual(p.namedVariables.map((v) => v.name), ['CLEARANCE']);
  assert.deepEqual(p.variableTrace.map((t) => [t.key, t.value, t.line, t.move]), [['CLEARANCE', 50, 0, 0]]);
});

test('an assignment by name runs on every pass of a loop', () => {
  const p = run([
    'DEF REAL DEPTH=6, STEP=1.5, ZZ',
    'G90 G21',
    'ZZ=0',
    'LOOP:',
    'ZZ=ZZ-STEP',
    'G1 Z=ZZ F300',
    'IF ZZ>-DEPTH GOTOB LOOP',
    'M30',
  ]);
  assert.deepEqual(errs(p), []);
  assert.deepEqual(at(p).map((m) => m[2]), [-1.5, -3, -4.5, -6]);
  assert.deepEqual(p.variableTrace.filter((t) => t.key === 'ZZ' && t.line === 5).map((t) => t.move), [0, 1, 2, 3]);
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
  assert.deepEqual(changes, [['#1', 4, 2, 0], ['#100', 1, 3, 0], ['#100', 5, 5, 1]]);
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

test('the timeline answers what a variable held on any move', () => {
  const p = run([
    'DEF REAL DEPTH=6, STEP=1.5, ZZ',
    'DEF INT PASS=0',
    'G90 G21',
    'ZZ=0',
    'LOOP:',
    'ZZ=ZZ-STEP',
    'PASS=PASS+1',
    'G1 Z=ZZ F300',
    'R1=PASS*10',
    'IF ZZ>-DEPTH GOTOB LOOP',
    'G0 Z=SAFEZ',
    'M30',
  ], { parameters: { SAFEZ: 50, 7: 2 } });
  assert.deepEqual(errs(p), []);
  const t = variableTimeline(p);
  const row = (key) => t.rows.find((r) => r.key === key);

  // The program's own first, then the registers, then the machine's.
  assert.deepEqual(t.rows.map((r) => `${r.kind}:${r.key}`),
    ['declared:DEPTH', 'declared:STEP', 'declared:ZZ', 'declared:PASS', 'register:R1', 'register:R7', 'machine:SAFEZ']);
  assert.equal(row('R7').preset, true);
  assert.equal(row('R1').preset, false);

  // Before move k means in force while move k runs.
  assert.equal(t.valueAt(row('ZZ'), 0), -1.5);
  assert.equal(t.valueAt(row('ZZ'), 2), -4.5);
  assert.equal(t.valueAt(row('PASS'), 3), 4);
  assert.equal(t.valueAt(row('R1'), 0), undefined, 'R1 is set after the first move');
  assert.equal(t.valueAt(row('R1'), 1), 10);
  assert.equal(t.valueAt(row('R1'), Infinity), 40);
  assert.equal(t.changeAt(row('R1'), 2).line, 9);

  // What the blocks before move 2 touched.
  assert.deepEqual([...t.changedAt(2)].sort(), ['PASS', 'R1', 'ZZ']);
});

test('values read the way the control shows them', () => {
  assert.equal(formatVariable(undefined, 'REAL'), '–');
  assert.equal(formatVariable(1, 'BOOL'), 'TRUE');
  assert.equal(formatVariable(0, 'BOOL'), 'FALSE');
  assert.equal(formatVariable('ROUGH', 'STRING'), '"ROUGH"');
  assert.equal(formatVariable(0.1 + 0.2, 'REAL'), '0.3');
  assert.equal(formatVariable(-3, 'INT'), '-3');
});

// ---- each control's own banks ---------------------------------------------

const FIDIA = { controller: { flavour: 'fidia' } };
const fidia = (lines, extra = {}) => interpret(lines.join('\n'), { ...FIDIA, ...extra });

test('a Fidia has RG and PT, a hundred each, and PT 5 is not RG 5', () => {
  const p = fidia([
    'RG 5 2.0',
    'PT 5 7.5',
    'RG 0 1',
    '>G90 G21',
    '>G0 X0 Y0 Z0',
    'F500',
    '$IF (PT 5 == 7.5) $GOTO GOOD',
    'X99',
    'GOOD:',
    'X=RG 5 + PT 5 + RG 0',
    'M30',
  ]);
  assert.deepEqual(errs(p), []);
  assert.equal(at(p).at(-1)[0], 10.5);
  assert.equal(last(p, 'RG5'), 2);
  assert.equal(last(p, 'PT5'), 7.5);
  assert.equal(last(p, 'RG0'), 1, 'RG 0 is a register like any other');
  assert.deepEqual(p.registers.ranges.map((r) => `${r.bank}${r.from}-${r.to}`), ['RG0-99', 'PT0-99']);
});

test('a Fidia register outside 0 to 99 is not one', () => {
  const p = fidia(['RG 100 1', 'PT 120 1', 'M30']);
  const e = errs(p);
  assert.equal(e.length, 2);
  assert.match(e[0], /RG100 is not a variable on this control, which has RG0 to RG99/);
  assert.match(e[1], /PT120 is not a variable on this control, which has PT0 to PT99/);
});

test('starting values on the machine go in the bank they name', () => {
  const p = fidia(['>G90 G21', '>G0 X=RG 50 + PT 3 Y0 Z0', 'M30'], { parameters: { 50: 4, PT3: 0.5, toolChangeX: 0 } });
  assert.deepEqual(errs(p), []);
  assert.equal(at(p)[0][0], 4.5);
  const t = variableTimeline(p);
  assert.deepEqual(t.rows.map((r) => `${r.key}:${r.preset}`), ['RG50:true', 'PT3:true']);
});

test('Fanuc and Mazak: #1 to #33 per call, #100 and #500 shared, #50 an alarm', () => {
  for (const flavour of ['fanuc', 'mazak']) {
    const p = interpret([
      'G90 G21',
      '#1 = 5',
      '#100 = #1 * 2',
      '#500 = #500 + 1',
      '#50 = 1',
      'G65 P9000 A3.',
      'G0 X#1 Y#101',
      'M30',
    ].join('\n'), {
      controller: { flavour },
      parameters: { '#500': 41 },
      subprograms: [{ name: 'O9000', text: 'O9000\n#1 = #1 + 1\n#101 = #1\nM99' }],
    });
    assert.equal(errs(p).length, 1, flavour);
    assert.match(errs(p)[0], /#50 is not a variable on this control, which has #1 to #33, #100 to #199, #200 to #499, #500 to #999, #1000 up/);
    assert.equal(last(p, '#500'), 42, 'a retained count goes on from where the machine had it');
    assert.equal(at(p)[0][0], 5, "the macro's #1 is not the main program's");
    assert.equal(at(p)[0][1], 4);
    // The call's own #1, by the call it belongs to.
    assert.deepEqual(p.variableTrace.filter((t) => t.key === '#1 · O9000').map((t) => t.value), [3, 4]);
    const t = variableTimeline(p);
    const group = (key) => t.rows.find((r) => r.key === key).group.label;
    assert.equal(group('#1'), 'Local');
    assert.equal(group('#1 · O9000'), 'Local');
    assert.equal(group('#100'), 'Common');
    assert.equal(group('#500'), 'Retained');
  }
});

test('#0 is always empty; setting it is an error, reading it is zero', () => {
  const p = interpret(['#100 = #0 + 1', '#0 = 5', 'M30'].join('\n'));
  assert.equal(last(p, '#100'), 1);
  assert.match(errs(p)[0], /#0 is always empty and cannot be set/);
});

test('a Siemens R0 is a parameter like the rest', () => {
  const p = run(['R0=3', 'G90 G21', 'G1 X=R0 F100', 'M30']);
  assert.deepEqual(errs(p), []);
  assert.equal(at(p)[0][0], 3);
});

test('the control\'s own variables are said once, and #3000 stops the run', () => {
  const p = interpret([
    'G90 G21',
    'G0 X[#5021 + 1]',
    'G0 X[#5021 + 2]',
    'IF [#1 EQ 0] THEN #3000 = 1',
    'G0 X50',
    'M30',
  ].join('\n'));
  const notes = p.warnings.map((w) => w.message);
  assert.equal(notes.filter((m) => /#5021 is one of the control's own variables/.test(m)).length, 1);
  assert.ok(notes.some((m) => /raises alarm 3001 here, and the machine stops/.test(m)));
  assert.deepEqual(at(p).map((m) => m[0]), [1, 2], 'nothing after the alarm runs');
});
