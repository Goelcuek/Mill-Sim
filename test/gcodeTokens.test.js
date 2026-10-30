// What the editor colours each piece of a line as.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeLine, highlightLine } from '../src/ui/gcodeTokens.js';

const kinds = (line) => tokenizeLine(line).filter(([, c]) => c).map(([t, c]) => `${c}:${t}`);

test('addresses are told apart by their letter', () => {
  assert.deepEqual(kinds('N10 G1 X-5.5 Y2 F300 S750 M3 T4'), [
    'n:N', 'n:10', 'g:G', 'g:1', 'a:X', 'p:-', 'num:5.5', 'a:Y', 'num:2', 't:F', 'num:300', 't:S', 'num:750', 'm:M', 'm:3', 't:T', 'num:4',
  ]);
});

test('remarks: brackets on their own, and ; to the end', () => {
  assert.deepEqual(kinds('G01 X25.6 (FINISH)'), ['g:G', 'g:01', 'a:X', 'num:25.6', 'c:(FINISH)']);
  assert.deepEqual(kinds('N4350 M0 ;(* ADJUST *)'), ['n:N', 'n:4350', 'm:M', 'm:0', 'c:;(* ADJUST *)']);
});

test('a bracket after a name is a call, not a remark', () => {
  const k = kinds('CYCLE800(1,"HERMLE",0,-90)');
  assert.equal(k[0], 'k:CYCLE800');
  assert.ok(k.includes('s:"HERMLE"'));
  assert.ok(!k.some((x) => x.startsWith('c:')));
  assert.deepEqual(kinds('C=ACN(300)'), ['a:C', 'p:=', 'k:ACN', 'p:(', 'num:300', 'p:)']);
});

test('keywords, variables, labels and program names', () => {
  assert.deepEqual(kinds('N4380 GOTOF N4400'), ['n:N', 'n:4380', 'k:GOTOF', 'a:N', 'num:4400']);
  assert.deepEqual(kinds('R81=$P_TOOLNO'), ['v:R81', 'p:=', 'v:$P_TOOLNO']);
  assert.deepEqual(kinds('#100 = #1'), ['v:#100', 'p:=', 'v:#1']);
  assert.deepEqual(kinds('MARK1: TRAORI'), ['k:MARK1', 'p::', 'k:TRAORI']);
  assert.deepEqual(kinds('%_N_41200_MPF'), ['o:%_N_41200_MPF']);
});

test('the text comes back exactly, and safe to put in a page', () => {
  const line = 'IF R1<5 GOTOF L1 ; a < b & c > d';
  assert.equal(tokenizeLine(line).map(([t]) => t).join(''), line);
  const html = highlightLine(line);
  assert.ok(!/<(?!\/?span)/.test(html), html);
  assert.ok(html.includes('&lt;') && html.includes('&amp;'));
});
