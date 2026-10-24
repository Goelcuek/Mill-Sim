// What single block steps through: every block the run read, in order.
//
// The moves say where the machine went; the block log says which lines it
// read on the way, including the ones that move nothing. These check that
// the record is the control's reading order — loops pass by pass, calls
// into the called file and back — and that each block owns the moves it
// made, so a step can run exactly one of them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { interpret } from '../src/gcode/interpreter.js';
import { BlockLog, blockAt, moveAfter, blockBeforeMove, blockOfMove } from '../src/gcode/blockLog.js';
import { variableTimeline } from '../src/gcode/variableTimeline.js';

const lines = (p) => {
  const out = [];
  for (let i = 0; i < p.blockLog.count; i++) {
    const b = blockAt(p.blockLog, i);
    out.push(b.source ? `${b.line}@${b.source}` : b.line);
  }
  return out;
};

test('every block that does something is in the record, in the order it ran', () => {
  const p = interpret([
    '%',
    '(ROUGHING)',
    'G90 G21 G54',
    '',
    'S6000 M3',
    '#100 = 0',
    'G0 X0 Y0 Z5',
    'WHILE [#100 LT 2] DO 1',
    '  #100 = #100 + 1',
    '  G1 X[#100 * 10] F600',
    'END 1',
    'M30',
    '%',
  ].join('\n'));
  // No %, no remark, no blank line; the loop twice and its head three times.
  assert.deepEqual(lines(p), [3, 5, 6, 7, 8, 9, 10, 11, 8, 9, 10, 11, 8, 12]);
});

test('each block owns the moves it made, a canned cycle all of them', () => {
  const p = interpret(['G90 G21', 'G0 X0 Y0 Z10', 'G81 X10 Y10 Z-5 R2 F100', 'G80', 'G0 Z50', 'M30'].join('\n'));
  const log = p.blockLog;
  const at = (line) => lines(p).indexOf(line);
  const cycle = at(3);
  const made = p.moves.filter((m) => m.line === 3).length;
  assert.ok(made >= 3, 'a drilling cycle is several moves');
  assert.equal(moveAfter(log, cycle, p.moves.length) - log.move[cycle], made, 'all of them one block');
  assert.equal(moveAfter(log, at(4), p.moves.length) - log.move[at(4)], 0, 'G80 moves nothing');
  // At the start of the move after the cycle, the cycle is what has run.
  assert.equal(blockBeforeMove(log, moveAfter(log, cycle, p.moves.length)), cycle);
  // Part way through the cycle, it is the cycle that is running.
  assert.equal(blockOfMove(log, log.move[cycle] + 1), cycle);
  assert.equal(blockBeforeMove(log, 0), -1, 'nothing has run at the start');
});

test('a call goes into the called file and comes back', () => {
  const p = interpret(['G90 G21', 'G1 X10 F600', 'M98 P2000', 'G1 X0', 'M30'].join('\n'), {
    subprograms: [{ name: 'O2000', text: 'O2000\nG91 G1 X5\nG90\nM99' }],
  });
  assert.deepEqual(lines(p), [1, 2, 3, '2@O2000', '3@O2000', '4@O2000', 4, 5]);
});

test('variables can be read after any block, not only at a move', () => {
  const p = interpret(['G90 G21', 'G0 X0', '#100 = 1', '#100 = 2', '#100 = 3', 'G0 X10', 'M30'].join('\n'));
  const t = variableTimeline(p);
  const row = t.rows.find((r) => r.key === '#100');
  // All three happen before move 1, so by move they are one change...
  assert.equal(t.valueAt(row, 1), 3);
  // ...but stepping, each block has its own.
  const block = (line) => lines(p).indexOf(line);
  assert.equal(t.valueAt(row, { move: 1, block: block(3) }), 1);
  assert.equal(t.valueAt(row, { move: 1, block: block(4) }), 2);
  assert.equal(t.valueAt(row, { move: 1, block: block(2) }), undefined);
  assert.deepEqual([...t.changedAt({ move: 1, block: block(4) })], ['#100']);
});

test('the record stops at its limit rather than running away', () => {
  const log = new BlockLog(3);
  for (let i = 0; i < 5; i++) log.push(i + 1, 0, i % 2 ? 'SUB' : null);
  const done = log.finish();
  assert.equal(done.count, 3);
  assert.equal(done.truncated, true);
  assert.deepEqual(blockAt(done, 1), { line: 2, source: 'SUB' });
});
