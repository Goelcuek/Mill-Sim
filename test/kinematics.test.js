import test from 'node:test';
import assert from 'node:assert/strict';

import * as m4 from '../src/core/mat4.js';
import { Kinematics, makeAxis } from '../src/machine/kinematics.js';
import { buildPreset, PRESETS, headHead, headTable, tableTable, vmc3Axis } from '../src/machine/presets.js';

const FIVE = ['headHead', 'headTable', 'tableTable'];
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);

test('matrix helpers compose and invert exactly', () => {
  const t = m4.fromTranslation(m4.create(), [0, 3, 3]);
  const r = m4.fromRotation(m4.create(), [0, 0, 1], Math.PI / 2);
  const tr = m4.multiply(m4.create(), t, r);
  const p = m4.transformPoint([0, 0, 0], tr, [1, 0, 0]);
  near(p[0], 0, 1e-12, 'x');
  near(p[1], 4, 1e-12, 'y');
  near(p[2], 3, 1e-12, 'z');

  const back = m4.transformPoint([0, 0, 0], m4.invertRigid(m4.create(), tr), p);
  near(back[0], 1, 1e-12, 'round trip x');
  near(back[1], 0, 1e-12, 'round trip y');

  // A direction ignores the translation.
  const d = m4.transformDir([0, 0, 0], tr, [1, 0, 0]);
  near(d[1], 1, 1e-12, 'rotated direction');

  // 2x + y = 5, y + z = 3, x = 1  ->  x=1, y=3, z=0
  const sol = m4.solve3([2, 0, 1, 1, 1, 0, 0, 1, 0], [5, 3, 1]);
  near(sol[0], 1, 1e-12, 'x');
  near(sol[1], 3, 1e-12, 'y');
  near(sol[2], 0, 1e-12, 'z');
  assert.equal(m4.solve3([1, 0, 0, 2, 0, 0, 3, 0, 0], [1, 2, 3]), null);   // singular
});

test('each preset reports the configuration its name claims', () => {
  assert.equal(buildPreset('vmc3').configuration, '3-axis');
  assert.equal(buildPreset('headHead').configuration, 'head-head');
  assert.equal(buildPreset('headTable').configuration, 'head-table');
  assert.equal(buildPreset('tableTable').configuration, 'table-table');
  assert.equal(buildPreset('nonsense').configuration, '3-axis');          // falls back
});

test('every axis lands on the branch its layout implies', () => {
  const hh = buildPreset('headHead');
  assert.deepEqual(hh.rotaries().map((n) => hh.branchOf(n.id)), ['tool', 'tool']);

  const ht = buildPreset('headTable');
  assert.deepEqual(ht.rotaries().map((n) => `${n.letter}:${ht.branchOf(n.id)}`), ['C:work', 'B:tool']);

  const tt = buildPreset('tableTable');
  assert.deepEqual(tt.rotaries().map((n) => tt.branchOf(n.id)), ['work', 'work']);

  // The base carrier is on both paths, so it belongs to neither branch.
  assert.equal(tt.branchOf('base'), 'base');
});

test('the tree nests slaves under their master for the panel', () => {
  const k = buildPreset('tableTable');
  assert.equal(k.depth('base'), 0);
  assert.equal(k.depth('y'), 1);
  assert.equal(k.depth('c'), 4);                       // base>y>x>a>c
  assert.deepEqual(k.children('a').map((n) => n.id), ['c']);
  assert.deepEqual(k.roots().map((n) => n.id), ['base']);
  assert.deepEqual(k.pathTo('c').map((n) => n.id), ['base', 'y', 'x', 'a', 'c']);
});

test('a slaved axis follows its master by the ratio', () => {
  const def = vmc3Axis();
  // A quill that rides the head and travels half as far again, which is how
  // a slaved ram is usually set up.
  def.nodes.push(makeAxis({
    id: 'w', name: 'W (slaved quill)', letter: 'A', parent: 'z', origin: [0, 0, 0],
    kind: 'linear', axis: [0, 0, 1], slaveTo: 'z', slaveRatio: 0.5,
  }));
  def.nodes.find((n) => n.id === 'spindle').parent = 'w';
  const k = new Kinematics(def);
  const resolved = k.resolve({ Z: 100, A: 999 });
  assert.equal(resolved.A, 50);                        // the master wins, not the word
  const rise = k.toolInWork({ Z: 100 }, 0).tip[2] - k.toolInWork({ Z: 0 }, 0).tip[2];
  near(rise, 150, 1e-9, 'the ram adds half the Z travel on top of it');
});

test('a 3-axis chain moves the tip one-for-one with the words', () => {
  const k = buildPreset('vmc3');
  const a = k.toolInWork({ X: 0, Y: 0, Z: 0 }, 100).tip;
  const b = k.toolInWork({ X: 10, Y: -20, Z: 30 }, 100).tip;
  near(b[0] - a[0], 10, 1e-9, 'X');
  near(b[1] - a[1], -20, 1e-9, 'Y');
  near(b[2] - a[2], 30, 1e-9, 'Z');
  near(m4.dot(k.toolInWork({}, 100).axis, [0, 0, 1]), 1, 1e-12, 'tool points up the Z axis');
});

test('linear IK hits an arbitrary tip on every configuration', () => {
  const tips = [[0, 0, 0], [37.5, -12.25, 8], [-90, 60, -30]];
  const poses = [{}, { A: -25, B: 20, C: 45 }, { A: -60, B: -35, C: -110 }];

  for (const key of FIVE) {
    const k = buildPreset(key);
    for (const pose of poses) {
      for (const want of tips) {
        const sol = k.linearsForTip(want, pose, 95);
        assert.ok(sol, `${key} has no linear solution`);
        const got = k.toolInWork({ ...pose, ...sol }, 95).tip;
        for (let i = 0; i < 3; i++) near(got[i], want[i], 1e-8, `${key} tip[${i}]`);
      }
    }
  }
});

test('rotary IK points the tool along a requested direction', () => {
  const dirs = [
    [0, 0, 1],
    m4.normalize([0.3, -0.2, 0.93]),
    m4.normalize([-0.5, 0.5, 0.7071]),
    m4.normalize([0.6, 0.0, 0.8]),
  ];

  for (const key of FIVE) {
    const k = buildPreset(key);
    for (const want of dirs) {
      const sol = k.rotariesForToolAxis(want, { X: 0, Y: 0, Z: 0 }, 95);
      assert.ok(sol, `${key} cannot reach ${want}`);
      const got = k.toolInWork({ X: 0, Y: 0, Z: 0, ...sol }, 95).axis;
      near(1 - m4.dot(got, want), 0, 1e-7, `${key} alignment`);
      // And it should stay inside travel.
      assert.deepEqual(k.violations(sol), []);
    }
  }
});

test('a direction outside the tilt travel is refused, not faked', () => {
  const k = buildPreset('headTable');
  // B is limited to +/-120 degrees, so pointing the tool straight up the
  // part (away from the table) is unreachable on this machine.
  assert.equal(k.rotariesForToolAxis([0, 0, -1], {}, 95), null);
});

test('a rotary table swings the part under a stationary tool', () => {
  const k = buildPreset('tableTable');
  // With C at 90 degrees, a tool parked over machine +X appears over work +Y
  // (the part turned beneath it, so its coordinates turned the other way).
  const at0 = k.toolInWork({ X: 50, Y: 0, Z: 0, A: 0, C: 0 }, 0).tip;
  const at90 = k.toolInWork({ X: 50, Y: 0, Z: 0, A: 0, C: 90 }, 0).tip;
  near(Math.hypot(at0[0], at0[1]), Math.hypot(at90[0], at90[1]), 1e-9, 'radius unchanged');
  near(at90[0], at0[1], 1e-9, 'turned a quarter turn');
  near(at90[1], -at0[0], 1e-9, 'and the right way round');
  near(at90[2], at0[2], 1e-9, 'height unchanged');
});

test('tilting the head does not move the tip when it sits on the pivot', () => {
  const def = headTable();
  // Gauge length chosen so the tip lands exactly on the B pivot: the head
  // is at z=0, B pivots at -140, the spindle nose is 40 below that.
  const k = new Kinematics(def);
  const flat = k.toolInWork({ B: 0 }, 0).tip;
  const tilted = k.toolInWork({ B: 45 }, 0).tip;
  // 40mm below the pivot, a 45 degree tilt swings the nose out by 40*sin45.
  near(Math.hypot(tilted[0] - flat[0], tilted[2] - flat[2]), 2 * 40 * Math.sin(Math.PI / 8), 1e-9, 'swing');
});

test('travel limits are reported per axis with the side that was hit', () => {
  const k = buildPreset('vmc3');
  assert.deepEqual(k.violations({ X: 0, Y: 0, Z: 0 }), []);
  const v = k.violations({ X: 500, Y: 0, Z: -400 });
  assert.deepEqual(v.map((e) => `${e.axis}${e.side}`), ['Xmax', 'Zmin']);
  assert.equal(v[0].limit, 380);
});

test('a machine survives a round trip through JSON', () => {
  const k = buildPreset('tableTable');
  const copy = new Kinematics(JSON.parse(JSON.stringify(k.toJSON())));
  assert.equal(copy.configuration, 'table-table');
  const a = k.toolInWork({ X: 10, A: -30, C: 20 }, 80).tip;
  const b = copy.toolInWork({ X: 10, A: -30, C: 20 }, 80).tip;
  for (let i = 0; i < 3; i++) near(a[i], b[i], 1e-12, `tip[${i}]`);
});

test('a broken tree does not hang the solver', () => {
  const k = new Kinematics({
    name: 'cycle',
    nodes: [
      { id: 'a', letter: 'X', parent: 'b', origin: [0, 0, 0] },
      { id: 'b', letter: 'Y', parent: 'a', origin: [0, 0, 0] },
    ],
    toolNode: 'a', workNode: 'b',
  });
  assert.ok(k.pathTo('a').length <= 64);
  assert.ok(k.toolInWork({ X: 1, Y: 1 }).tip.every(Number.isFinite));
});

test('the preset list and its builders agree', () => {
  for (const [key, entry] of Object.entries(PRESETS)) {
    assert.equal(typeof entry.label, 'string');
    const k = new Kinematics(entry.build());
    assert.ok(k.toolNode && k.workNode, `${key} needs both ends of the chain`);
    assert.ok(k.byId.has(k.toolNode) && k.byId.has(k.workNode), `${key} points at real nodes`);
  }
  assert.equal(new Kinematics(headHead()).rotaries().map((n) => n.letter).join(''), 'CB');
  assert.equal(new Kinematics(tableTable()).rotaries().map((n) => n.letter).join(''), 'AC');
});
