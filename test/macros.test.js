// Subprogram files and machine macros: the two things a control reads that
// are not in the part program.

import test from 'node:test';
import assert from 'node:assert/strict';

import { interpret } from '../src/gcode/interpreter.js';
import { makeMacro, normaliseCode, expandMacro, macroReferences, defaultMacros } from '../src/machine/macros.js';

const run = (src, cfg = {}) => interpret(Array.isArray(src) ? src.join('\n') : src, cfg);
const errs = (p) => p.warnings.filter((w) => w.severity === 'error');
const where = (p) => p.moves.map((m) => `${m.source || 'main'} ${m.to.map((v) => Math.round(v)).join(',')}`);

const macro = (code, body, patch = {}) => makeMacro({ code, body, enabled: true, ...patch });

test('an M code is normalised the way a control reads it', () => {
  assert.equal(normaliseCode('M6'), 'M6');
  assert.equal(normaliseCode('M06'), 'M6');
  assert.equal(normaliseCode(' m006 '), 'M6');
  assert.equal(normaliseCode('G84.2'), 'G84.2');
  assert.equal(normaliseCode('hello'), null);
});

test('a macro body reads machine parameters and the calling block', () => {
  const body = 'G53 G0 X#toolChangeX Y#toolChangeY (T#T)';
  assert.deepEqual(macroReferences(body), ['toolChangeX', 'toolChangeY', 'T']);

  const missing = [];
  const out = expandMacro(body, { toolChangeX: -320, toolChangeY: 210 }, (n) => missing.push(n));
  assert.equal(out, 'G53 G0 X-320 Y210 (T0)');
  assert.deepEqual(missing, ['T'], 'and says which name nobody set');
});

test('what the machine does at M06 is what the macro says', () => {
  const src = ['G90 G21 G54', 'G0 X10 Y10 Z5', 'T4 M06', 'G0 Z2', 'M30'];

  // Without a macro the tool change is instantaneous, as it always was.
  const bare = run(src);
  assert.deepEqual(errs(bare), []);
  assert.equal(bare.moves.filter((m) => m.source).length, 0);

  const withMacro = run(src, {
    machineZero: [0, 0, 250],
    parameters: { toolChangeX: -320, toolChangeY: 210 },
    macros: [macro('M6', 'G91 G28 Z0\nG90 G53 G0 X#toolChangeX Y#toolChangeY\n(loaded T#T)')],
  });
  assert.deepEqual(errs(withMacro), []);

  // It runs after the block that called it, and the machine comes back to
  // carry on with the next one.
  assert.deepEqual(where(withMacro), [
    'main 10,10,5',
    'M6 macro 10,10,250',
    'M6 macro -320,210,250',
    'main -320,210,2',
  ]);
  assert.equal(withMacro.toolChanges.length, 1, 'and it is still a tool change');
  assert.equal(withMacro.toolChanges[0].tool, 4);
});

test('the calling block’s T word reaches the macro', () => {
  const p = run(['G90 G21', 'T7 M06', 'M30'], {
    macros: [macro('M6', 'G0 X#T')],
  });
  assert.equal(p.moves[0].to[0], 7);
});

test('an M30 macro parks the machine before the program ends', () => {
  const p = run(['G90 G21', 'G0 X50 Y50', 'M30'], {
    machineZero: [0, 0, 250],
    parameters: { parkX: 0, parkY: 400 },
    macros: [macro('M30', 'G91 G28 Z0\nG90 G53 G0 X#parkX Y#parkY')],
  });
  assert.deepEqual(where(p), ['main 50,50,250', 'M30 macro 50,50,250', 'M30 macro 0,400,250']);
});

test('a macro is inert until the machine is told to run it', () => {
  const p = run(['G90 G21', 'T1 M06', 'M30'], { macros: [macro('M6', 'G0 X99', { enabled: false })] });
  assert.equal(p.moves.length, 0);
  assert.deepEqual(defaultMacros().map((m) => m.enabled), [false, false],
    'and the ones a machine ships with start that way');
});

test('a macro that calls its own code does not call itself forever', () => {
  const p = run(['G90 G21', 'M60', 'M30'], { macros: [macro('M60', 'G0 X5\nM60\nG0 X10')] });
  assert.deepEqual(errs(p), []);
  assert.deepEqual(where(p), ['M60 macro 5,0,250', 'M60 macro 10,0,250']);
});

test('a name nobody set reads as zero, and says so', () => {
  const p = run(['G90 G21', 'M60', 'M30'], { macros: [macro('M60', 'G0 X#palletX')] });
  assert.equal(p.moves[0].to[0], 0);
  assert.match(p.warnings[0].message, /#palletX/);
});

test('M98 finds a subprogram that is a separate file', () => {
  const subs = [{ name: 'O1000 drill', number: 1000, text: 'G1 X10 F500\nG1 Y10' }];
  const p = run(['G90 G21 G54', 'G1 X0 Y0 F500', 'M98 P1000', 'G0 Z20', 'M30'], { subprograms: subs });
  assert.deepEqual(errs(p), []);
  assert.deepEqual(where(p), ['main 0,0,250', 'O1000 drill 10,0,250', 'O1000 drill 10,10,250', 'main 10,10,20']);

  // The end of the file returns, so M99 is optional in a file of its own.
  assert.equal(p.moves[3].source, undefined, 'and the main program carries on');
});

test('a subprogram file can repeat, and can carry its own O number', () => {
  const subs = [{ name: 'step', number: 0, text: 'O2000\nG91 G1 X5 F400\nG90\nM99' }];
  const p = run(['G90 G21', 'G1 X0 F400', 'M98 P2000 L3', 'M30'], { subprograms: subs });
  assert.deepEqual(errs(p), []);
  assert.deepEqual(p.moves.map((m) => Math.round(m.to[0])), [0, 5, 10, 15]);
});

test('a missing subprogram is reported rather than skipped in silence', () => {
  const p = run(['G90 G21', 'M98 P4000', 'M30']);
  assert.equal(errs(p).length, 1);
  assert.match(errs(p)[0].message, /O4000/);
});

test('a warning raised inside a file says which file it came from', () => {
  const subs = [{ name: 'bad', number: 1000, text: 'G1 X10' }];
  const p = run(['G90 G21', 'M98 P1000', 'M30'], { subprograms: subs });
  const noFeed = p.warnings.find((w) => /feed/i.test(w.message));
  assert.ok(noFeed, 'the feedless G1 is still caught');
  assert.equal(noFeed.source, 'bad');
});

test('a subprogram answers to the O number written at the top of it', () => {
  // No number is declared anywhere but in the file itself, which is how a
  // control knows what it is holding.
  const subs = [{ name: 'probe.nc', text: 'O9832\n(probe cycle)\nG1 Z-5 F200\nM99' }];
  const p = run(['G90 G21', 'G1 Z0 F200', 'M98 P9832', 'M30'], { subprograms: subs });
  assert.deepEqual(errs(p), []);
  assert.equal(p.moves[1].source, 'probe.nc');
  assert.equal(Math.round(p.moves[1].to[2]), -5);
});

test('the machine keeps subprograms of its own, and the job can call them', () => {
  // What Machine > Macros holds: files that stay on the control between
  // jobs. The app hands them to the interpreter behind the job's own.
  const jobSubs = [{ name: 'job-O1000.nc', text: 'O1000\nG1 X5 F300\nM99' }];
  const machineSubs = [{ name: 'O9001 pallet.nc', text: 'O9001\nG1 Y40 F900\nM99' }];
  const p = run(['G90 G21', 'G1 X0 Y0 F300', 'M98 P1000', 'M98 P9001', 'M30'],
    { subprograms: [...jobSubs, ...machineSubs] });
  assert.deepEqual(errs(p), []);
  assert.deepEqual(p.moves.map((m) => m.source || 'main'),
    ['main', 'job-O1000.nc', 'O9001 pallet.nc']);
});

test('two files claiming the same number is said out loud', () => {
  const subs = [
    { name: 'mine.nc', text: 'O1000\nG1 X5 F300\nM99' },
    { name: 'the machine’s.nc', text: 'O1000\nG1 X50 F300\nM99' },
  ];
  const p = run(['G90 G21', 'G1 X0 F300', 'M98 P1000', 'M30'], { subprograms: subs });
  const clash = p.warnings.find((w) => /O1000 is in both/.test(w.message));
  assert.ok(clash, 'the clash is reported');
  // And the first one — the job's own — is the one that runs.
  assert.equal(p.moves[1].source, 'mine.nc');
  assert.equal(Math.round(p.moves[1].to[0]), 5);
});
