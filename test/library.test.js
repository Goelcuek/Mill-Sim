import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolLibrary } from '../src/tools/library.js';
import { fromFusion, isFusionLibrary } from '../src/tools/fusionLibrary.js';
import { buildTool } from '../src/tools/toolDefs.js';

const MM = 25.4;

/** The shape Fusion 360 actually exports, trimmed to what is read. */
const fusion = {
  version: 37,
  data: [
    {
      BMC: 'carbide',
      description: '',
      geometry: { DC: 0.4724, LB: 1.574, LCF: 1.181, NOF: 4, OAL: 3, RE: 0.04, SFDM: 0.4724 },
      'post-process': { number: 1 },
      'start-values': { presets: [{ n: 5000, v_f: 40, v_f_plunge: 13.333333333333334 }] },
      type: 'bull nose end mill',
      unit: 'inches',
    },
    {
      BMC: 'hss',
      geometry: { DC: 6, LB: 100, LCF: 80, NOF: 2, OAL: 130, SIG: 118, SFDM: 6 },
      'post-process': { number: 2 },
      type: 'drill',
      unit: 'millimeters',
      description: '6mm stub drill',
    },
    {
      geometry: { DC: 0.5, LB: 1.5, LCF: 0.75, NOF: 2, OAL: 3, TA: 45, 'tip-diameter': 0 },
      'post-process': { number: 3 },
      type: 'chamfer mill',
      unit: 'inches',
    },
  ],
};

test('a Fusion library is recognised and converted', () => {
  assert.ok(isFusionLibrary(fusion));
  assert.equal(isFusionLibrary({ tools: [], holders: [] }), false);

  const { tools, assemblies } = fromFusion(fusion);
  assert.equal(tools.length, 3);
  assert.equal(assemblies.length, 3);

  // Inches become millimetres, and the ISO short names land on the right
  // parameters: DC diameter, RE corner radius, LCF flutes, OAL overall.
  const [bull, drill, cham] = tools;
  assert.equal(bull.type, 'bull');
  assert.ok(Math.abs(bull.diameter - 0.4724 * MM) < 1e-6);
  assert.ok(Math.abs(bull.cornerRadius - 0.04 * MM) < 1e-6);
  assert.ok(Math.abs(bull.fluteLength - 1.181 * MM) < 1e-6);
  assert.ok(Math.abs(bull.overallLength - 3 * MM) < 1e-6);
  assert.equal(bull.fluteCount, 4);
  assert.equal(bull.material, 'carbide');
  assert.equal(bull.cutting.rpm, 5000);
  assert.equal(bull.cutting.feed, Math.round(40 * MM));

  // A millimetre entry is not scaled twice.
  assert.equal(drill.type, 'drill');
  assert.equal(drill.diameter, 6);
  assert.equal(drill.tipAngle, 118);
  assert.equal(drill.name, '6mm stub drill');
  assert.equal(drill.material, 'hss');

  // Fusion gives one flank of a chamfer; the tool model wants the whole
  // included angle.
  assert.equal(cham.type, 'chamfer');
  assert.equal(cham.tipAngle, 90);

  // The body length is the stickout, and the T number comes across.
  assert.ok(Math.abs(assemblies[0].stickout - 1.574 * MM) < 1e-6);
  assert.deepEqual(assemblies.map((a) => a.number), [1, 2, 3]);

  // And every one of them builds.
  for (const t of tools) assert.ok(buildTool(t).radius > 0, `${t.name} builds`);
});

test('importing a foreign library goes through the normal door', () => {
  const lib = new ToolLibrary().loadDefaults();
  const before = lib.tools.length;
  const stats = lib.fromJSON(fusion, { merge: true });
  assert.deepEqual(stats, { tools: 3, holders: 0, assemblies: 3 });
  assert.equal(lib.tools.length, before + 3);

  // The built-ins already own T1-T8, so the incoming table moves up rather
  // than shadowing them, and every assembly still points at its own cutter.
  const numbers = lib.assemblies.map((a) => a.number);
  assert.equal(new Set(numbers).size, numbers.length);
  for (const a of lib.assemblies) assert.ok(lib.tool(a.toolId), `${a.name} kept its cutter`);
  assert.deepEqual(lib.audit({}), []);
});

test('a library replaced by a foreign one keeps that library numbering', () => {
  const lib = new ToolLibrary().loadDefaults();
  assert.ok(lib.fromJSON(fusion));
  assert.equal(lib.tools.length, 3);
  assert.deepEqual(lib.assemblies.map((a) => a.number), [1, 2, 3]);
});

test('a stored library missing a whole category is refilled, not lost', () => {
  const lib = new ToolLibrary().loadDefaults();
  const keep = lib.assemblies.slice(0, 3);
  // What a half-written save looks like: the tool table, no cutters.
  assert.ok(lib.fromJSON({ tools: [], holders: [], assemblies: keep }));
  assert.equal(lib.tools.length, 0);

  assert.deepEqual(lib.repair(), ['cutters', 'holders']);
  assert.equal(lib.assemblies.length, 3, 'what was stored is kept');
  for (const a of lib.assemblies) assert.ok(lib.tool(a.toolId), `${a.name} found its cutter again`);
});

test('the built-ins can be put back without touching anything else', () => {
  const lib = new ToolLibrary().loadDefaults();
  const mine = lib.addTool({ name: 'my own 3mm' });
  lib.tools = lib.tools.filter((t) => t.id !== 'tool_flat10' && t.id !== 'tool_ball6');

  assert.equal(lib.mergeDefaults(), 2);
  assert.ok(lib.tool('tool_flat10'));
  assert.ok(lib.tool(mine.id), 'the tool I added is still mine');
  assert.equal(lib.mergeDefaults(), 0, 'nothing to do the second time');
});

test('a pile of cutters goes in one go, and the tool table is patched once', () => {
  const lib = new ToolLibrary().loadDefaults();
  const before = lib.tools.length;
  const doomed = lib.tools.slice(0, 3).map((t) => t.id);
  const users = lib.assemblies.filter((a) => doomed.includes(a.toolId)).length;
  assert.ok(users > 0, 'the tools being removed are in use, or this proves nothing');

  let changes = 0;
  lib.onChange(() => { changes++; });

  assert.equal(lib.removeMany('tools', doomed), 3);
  assert.equal(lib.tools.length, before - 3);
  assert.equal(changes, 1, 'removing three raised one change, not three');
  // Every assembly that used one is left without a cutter rather than
  // pointing at something that is no longer there.
  for (const a of lib.assemblies) assert.ok(!a.toolId || lib.tool(a.toolId), `${a.name} points at a cutter that exists`);
  assert.equal(lib.assemblies.filter((a) => !a.toolId).length, users);

  // An id that is not there is not an error, and an empty list is a no-op.
  assert.equal(lib.removeMany('tools', [doomed[0], 'nothing_like_it']), 0);
  assert.equal(lib.removeMany('tools', []), 0);
  assert.equal(changes, 1, 'a no-op raised a change');
});

test('holders and assemblies go the same way', () => {
  const lib = new ToolLibrary().loadDefaults();
  const held = lib.assemblies.find((a) => a.holderId);
  assert.ok(held, 'no assembly uses a holder, so this proves nothing');
  assert.equal(lib.removeMany('holders', [held.holderId]), 1);
  assert.equal(lib.assembly(held.id).holderId, '', 'the assembly kept a holder that is gone');

  const ids = lib.assemblies.slice(0, 2).map((a) => a.id);
  assert.equal(lib.removeMany('assemblies', ids), 2);
  for (const id of ids) assert.equal(lib.assembly(id), null);
});
