// The same arithmetic, spelled four ways.
//
// What a control's macro language *does* is the same everywhere; what
// differs is how it is written. These check that the reader is driven by
// the table rather than by what Fanuc happens to do.

import test from 'node:test';
import assert from 'node:assert/strict';

import { interpret } from '../src/gcode/interpreter.js';
import { DIALECTS, resolveDialect, describeDialect, sampleFor, FLAVOUR_DIALECT } from '../src/gcode/dialects.js';
import { parseMacroBlock, hasMacroSyntax } from '../src/gcode/macro.js';
import { lex, stripComments } from '../src/gcode/lexer.js';

const errs = (p) => p.warnings.filter((w) => w.severity === 'error').map((w) => w.message);
const xs = (p) => p.moves.map((m) => Number(m.to[0].toFixed(4)));

test('a control is named by its flavour and read by its table', () => {
  assert.equal(FLAVOUR_DIALECT.haas, 'fanuc', 'Haas reads as Fanuc does');
  assert.equal(FLAVOUR_DIALECT.siemens, 'siemens');
  assert.match(describeDialect(DIALECTS.fanuc), /#100/);
  assert.match(describeDialect(DIALECTS.siemens), /R100/);
  assert.match(sampleFor(DIALECTS.siemens), /ENDWHILE/);
});

test('the same bolt circle, in Fanuc and in Siemens, cuts the same holes', () => {
  const fanuc = interpret([
    'G90 G21 G54',
    '#1 = 0',
    'WHILE [#1 LT 6] DO 1',
    '  G0 X[25 * COS[60 * #1]] Y[25 * SIN[60 * #1]]',
    '  #1 = #1 + 1',
    'END 1',
    'M30',
  ].join('\n'));

  const siemens = interpret([
    'G90 G21 G54',
    'R1 = 0',
    'WHILE R1 < 6',
    '  G0 X=25 * COS(60 * R1) Y=25 * SIN(60 * R1)',
    '  R1 = R1 + 1',
    'ENDWHILE',
    'M30',
  ].join('\n'), { controller: { flavour: 'siemens' } });

  assert.deepEqual(errs(fanuc), []);
  assert.deepEqual(errs(siemens), []);
  assert.equal(fanuc.moves.length, 6);
  assert.deepEqual(
    siemens.moves.map((m) => m.to.map((v) => Number(v.toFixed(6)))),
    fanuc.moves.map((m) => m.to.map((v) => Number(v.toFixed(6)))),
    'the same six holes, however the program spells them',
  );
});

test('Siemens jumps to a name, forwards and backwards', () => {
  const cfg = { controller: { flavour: 'siemens' } };
  const forward = interpret(['G90 G21', 'R4 = 1', 'IF R4 == 1 GOTOF SKIP', 'G0 X999', 'SKIP:', 'G0 X5', 'M30'].join('\n'), cfg);
  assert.deepEqual(errs(forward), []);
  assert.deepEqual(xs(forward), [5], 'the block between the jump and the label did not run');

  const back = interpret(['G90 G21', 'R1 = 0', 'TOP:', 'R1 = R1 + 1', 'G0 X=R1', 'IF R1 < 3 GOTOB TOP', 'M30'].join('\n'), cfg);
  assert.deepEqual(errs(back), []);
  assert.deepEqual(xs(back), [1, 2, 3]);

  const missing = interpret(['G90 G21', 'GOTOF NOWHERE', 'M30'].join('\n'), cfg);
  assert.match(errs(missing)[0], /no label called NOWHERE/);
});

test('FOR and REPEAT, which Fanuc does not have at all', () => {
  const cfg = { controller: { flavour: 'siemens' } };
  const counted = interpret(['G90 G21', 'FOR R2 = 1 TO 4', '  G0 X=R2', 'ENDFOR', 'M30'].join('\n'), cfg);
  assert.deepEqual(errs(counted), []);
  assert.deepEqual(xs(counted), [1, 2, 3, 4]);

  const repeated = interpret(['G90 G21', 'R3 = 0', 'REPEAT', '  R3 = R3 + 1', '  G0 X=R3 * 2', 'UNTIL R3 >= 3', 'M30'].join('\n'), cfg);
  assert.deepEqual(errs(repeated), []);
  assert.deepEqual(xs(repeated), [2, 4, 6], 'the body runs once before the test');
});

test('round brackets are arithmetic on a control that computes with them', () => {
  // The same characters mean opposite things on two controls, and reading
  // them the wrong way turns a move into a remark.
  const asFanuc = stripComments('G1 X=SIN(30) F300', DIALECTS.fanuc);
  assert.deepEqual(asFanuc.comments, ['30'], 'Fanuc reads the bracket as a remark');

  const asSiemens = stripComments('G1 X=SIN(30) F300 ; thirty degrees', DIALECTS.siemens);
  assert.deepEqual(asSiemens.comments, ['thirty degrees']);
  assert.match(asSiemens.code, /SIN\(30\)/);

  const p = interpret(['G90 G21', 'G1 X=SIN(30)*10 F300', 'M30'].join('\n'), { controller: { flavour: 'siemens' } });
  assert.deepEqual(errs(p), []);
  assert.deepEqual(xs(p), [5]);
});

test('a control nobody shipped can be described', () => {
  // Everything about the spelling is a setting, so a house dialect — a
  // sigil of its own, symbols for the comparisons, BEGIN and ENDLOOP — is
  // described rather than waited for.
  const house = {
    dialect: 'fanuc',
    syntax: {
      sigil: '@',
      group: ['(', ')'],
      parenComments: false,
      compare: { lt: '<', gt: '>', eq: '==', ne: '!=', ge: '>=', le: '<=' },
      keywords: { while: 'LOOP', do: null, end: null, endWhile: 'ENDLOOP', if: 'IF', then: 'THEN', goto: 'JUMP' },
    },
  };
  const p = interpret([
    'G90 G21',
    '@1 = 0',
    'LOOP (@1 < 3)',
    '  G0 X(@1 * 5)',
    '  @1 = @1 + 1',
    'ENDLOOP',
    'M30',
  ].join('\n'), { controller: house });

  assert.deepEqual(errs(p), []);
  assert.deepEqual(xs(p), [0, 5, 10]);
});

test('a program with no macros in it reads the same in every dialect', () => {
  const plain = ['G90 G21 G54', 'G0 X0 Y0 Z5', 'G1 Z-1 F200', 'G1 X50 F600', 'G2 X60 Y10 I0 J10', 'G0 Z20', 'M30'].join('\n');
  const base = interpret(plain);
  for (const id of Object.keys(DIALECTS)) {
    const other = interpret(plain, { controller: { dialect: id } });
    assert.deepEqual(errs(other), [], `${id} read it without complaint`);
    assert.deepEqual(other.moves.map((m) => m.to), base.moves.map((m) => m.to), `${id} read it the same`);
  }
});

test('overrides change one thing without restating the rest', () => {
  const d = resolveDialect('fanuc', { compare: { ne: '<>' } });
  assert.equal(d.compare.ne, '<>');
  assert.equal(d.compare.eq, 'EQ', 'the rest of Fanuc is still Fanuc');
  assert.equal(d.sigil, '#');

  const b = parseMacroBlock('IF [#1 <> 2] GOTO 10', d);
  assert.equal(b.error, undefined);
  assert.equal(b.control.kind, 'if-goto');
  // And the standard spelling is no longer understood, which is the point.
  assert.ok(parseMacroBlock('IF [#1 NE 2] GOTO 10', d).error);
});

test('only the blocks that need the reader get it, per dialect', () => {
  assert.equal(hasMacroSyntax('G1 X10 Y20 F300', DIALECTS.fanuc), false);
  assert.equal(hasMacroSyntax('G1 X10 Y20 F300', DIALECTS.siemens), false);
  assert.equal(hasMacroSyntax('R1 = 5', DIALECTS.siemens), true);
  assert.equal(hasMacroSyntax('R1 = 5', DIALECTS.fanuc), true, 'an = is worth a second look in any dialect');
  assert.equal(hasMacroSyntax('MARK1:', DIALECTS.siemens), true);

  const [plain] = lex('G1 X10.5 Y-3 F300', DIALECTS.siemens);
  assert.equal(plain.macro, undefined, 'and an ordinary block still takes the ordinary path');
});
