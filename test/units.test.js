// The display unit.
//
// The rule this has to keep is simple and worth testing on its own: the
// program holds millimetres and only the reading changes. Anything that
// converts twice, or converts something that is not a length, is a bug you
// find on a machine rather than on a screen.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as u from '../src/core/units.js';
import { MM_PER_INCH } from '../src/core/util.js';

test.afterEach(() => u.setUnits('mm'));

test('millimetres are the default and pass through untouched', () => {
  assert.equal(u.units(), 'mm');
  assert.equal(u.toDisplay(25.4), 25.4);
  assert.equal(u.fromDisplay(25.4), 25.4);
  assert.equal(u.lengthLabel(), 'mm');
  assert.equal(u.lenU(12.5), '12.5 mm');
});

test('inches convert both ways and come back to the same millimetre', () => {
  assert.equal(u.setUnits('in'), true);
  assert.equal(u.setUnits('in'), false, 'setting what it already is is not a change');
  assert.equal(u.toDisplay(25.4), 1);
  assert.equal(u.fromDisplay(1), 25.4);
  assert.equal(u.lenU(25.4), '1 in');
  for (const mm of [0.025, 1, 12.7, 380, 1234.5678]) {
    assert.ok(Math.abs(u.fromDisplay(u.toDisplay(mm)) - mm) < 1e-9, `${mm} did not survive the round trip`);
  }
});

test('an inch gets a decimal more than a millimetre, because it is worth 25 of them', () => {
  assert.equal(u.places(3), 3);
  u.setUnits('in');
  assert.equal(u.places(3), 4);
  // A tenth of a millimetre is four thousandths of an inch, and saying so
  // to three places would round it to nothing.
  assert.equal(u.len(0.1, 3), '0.0039');
});

test('volumes are quoted in what a shop quotes them in', () => {
  assert.equal(u.volumeU(1000), '1 cm³');
  u.setUnits('in');
  assert.equal(u.volumeU(MM_PER_INCH ** 3), '1 in³');
  assert.equal(u.volumeLabel(), 'in³');
});

test('a long path is metres, or feet', () => {
  assert.equal(u.distanceU(1000), '1 m');
  u.setUnits('in');
  assert.equal(u.distanceU(MM_PER_INCH * 12), '1 ft');
});

test('a feed rate carries the unit it is per minute of', () => {
  assert.equal(u.feedLabel(), 'mm/min');
  assert.equal(u.feed(900), '900');
  u.setUnits('in');
  assert.equal(u.feedLabel(), 'in/min');
  assert.equal(u.feed(MM_PER_INCH * 10), '10');
  // An inch a minute wants a decimal a millimetre a minute does not: 900
  // mm/min is 35.4 in/min, and rounding it to 35 loses a real distinction.
  assert.equal(u.feed(900), '35.4');
});

test('a spin box steps by a round number in either unit', () => {
  assert.equal(u.toStep(1), 1);
  assert.equal(u.toStep(0.1), 0.1);
  u.setUnits('in');
  // Nobody nudges by 0.03937".
  assert.equal(u.toStep(1), 0.05);
  assert.equal(u.toStep(0.1), 0.005);
  assert.equal(u.toStep(10), 0.5);
});

test('a triple is three lengths in the current unit', () => {
  assert.equal(u.triple([1, 2, 3], 1), '1, 2, 3');
  u.setUnits('in');
  assert.equal(u.triple([25.4, 50.8, 0], 1, ' × '), '1 × 2 × 0');
});

test('what is not a number says so rather than saying zero', () => {
  for (const bad of [NaN, Infinity, null, undefined]) {
    assert.equal(u.len(bad), '–');
    assert.equal(u.volume(bad), '–');
    assert.equal(u.feed(bad), '–');
    assert.equal(u.distance(bad), '–');
  }
});

test('listeners are told, and can stop being told', () => {
  const seen = [];
  const off = u.onUnitsChange((m) => seen.push(m));
  u.setUnits('in');
  u.setUnits('mm');
  assert.deepEqual(seen, ['in', 'mm']);
  off();
  u.setUnits('in');
  assert.deepEqual(seen, ['in', 'mm'], 'still being told after unsubscribing');
});
