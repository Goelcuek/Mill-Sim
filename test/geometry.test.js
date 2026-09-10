import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnvelope, arcPoints, NO_CONTACT } from '../src/tools/envelope.js';
import { buildTool, defaultTools, makeTool } from '../src/tools/toolDefs.js';
import { buildHolder, defaultHolders } from '../src/tools/holderDefs.js';
import { buildAssembly } from '../src/tools/assembly.js';

test('envelope reproduces a ball nose to within a micron', () => {
  const R = 5;
  const points = [{ r: 0, z: 0 }, ...arcPoints(0, R, R, -Math.PI / 2, 0, 64), { r: R, z: 30 }];
  const env = buildEnvelope(points);
  for (const r of [0, 0.5, 1, 2.5, 4, 4.9]) {
    const exact = R - Math.sqrt(R * R - r * r);
    assert.ok(Math.abs(env.at(r * r) - exact) < 1e-3, `r=${r}: ${env.at(r * r)} vs ${exact}`);
  }
  assert.equal(env.at(6 * 6), NO_CONTACT, 'no contact outside the tool');
});

test('envelope of a flat end mill is a plane inside the radius', () => {
  const env = buildEnvelope([{ r: 0, z: 0 }, { r: 4, z: 0 }, { r: 4, z: 20 }]);
  for (const r of [0, 1, 2, 3.9]) assert.equal(env.at(r * r), 0);
  assert.equal(env.at(25), NO_CONTACT);
});

test('bull nose blends a flat centre into a torus corner', () => {
  const built = buildTool(makeTool({ type: 'bull', diameter: 12, cornerRadius: 2, fluteLength: 25 }));
  const env = built.cutEnvelope;
  assert.equal(env.at(0), 0, 'centre is flat');
  assert.equal(env.at(3 * 3), 0, 'flat out to R - rc');
  const r = 5;                                  // inside the corner radius
  const exact = 2 - Math.sqrt(4 - (r - 4) ** 2);
  assert.ok(Math.abs(env.at(r * r) - exact) < 5e-3);
  assert.ok(Math.abs(env.at(6 * 6) - 2) < 5e-3, 'full corner height at the OD');
});

test('every built-in cutter builds without errors', () => {
  for (const def of defaultTools()) {
    const built = buildTool(def);
    assert.ok(built.radius > 0, `${def.name} has no radius`);
    assert.ok(built.fluteLength > 0);
    assert.ok(built.length >= built.fluteLength);
    assert.ok(built.silhouette.length >= 3);
    assert.equal(built.cutEnvelope.at(0), 0, `${def.name} tip is not at z=0`);
  }
});

test('every built-in holder builds and reports its nose', () => {
  for (const def of defaultHolders()) {
    const built = buildHolder(def);
    assert.ok(built.length > 50, `${def.name} is suspiciously short`);
    assert.ok(built.noseDia > 0);
    assert.ok(built.maxDia >= built.noseDia);
  }
});

test('assembly clamps a stickout shorter than the flutes', () => {
  const tools = defaultTools();
  const holders = defaultHolders();
  const built = buildAssembly({ stickout: 3 }, tools[1], holders[0]);
  assert.ok(built.stickout >= built.fluteLength);
  assert.ok(built.warnings.some((w) => /stickout/i.test(w)));
});

test('assembly envelopes separate the flutes, the shank and the holder', () => {
  const tools = defaultTools();
  const holders = defaultHolders();
  const built = buildAssembly({ stickout: 45 }, tools[1], holders[0], { spindleDiameter: 100, spindleLength: 80 });

  // Flutes reach the tip.
  assert.equal(built.cutEnvelope.at(0), 0);
  // The shank envelope starts at the top of the flutes.
  assert.ok(Math.abs(built.shankEnvelope.at(0) - built.fluteLength) < 1e-6);
  // The holder starts at the stickout.
  assert.ok(built.holderEnvelope.zMin >= built.stickout - 1e-6);
  assert.ok(built.bodyRadius > built.cutRadius);
});

test('the engagement disc catches a cut deeper than the flutes', () => {
  const tool = makeTool({ type: 'flat', diameter: 6, shankDiameter: 6, fluteLength: 18, overallLength: 60 });
  const built = buildAssembly({ stickout: 30 }, tool, null);
  // Just outside the cutting radius, the shank envelope must still bite:
  // a plain end mill's shank is exactly its cutting diameter.
  const justOutside = (3.0) ** 2;
  assert.ok(Number.isFinite(built.shankEnvelope.at(justOutside)));
  assert.ok(Math.abs(built.shankEnvelope.at(justOutside) - 18) < 1e-6);
});

test('the holder model stops at the gauge line', () => {
  for (const def of defaultHolders()) {
    const built = buildHolder(def);
    const top = built.points[built.points.length - 1];
    assert.equal(top.r, 0, `${def.name} does not close at the top`);
    assert.equal(top.z, built.length, `${def.name} top is not the gauge line`);

    // Nothing narrows again on the way up: a drawn taper would show as a
    // radius shrinking below the flange near the top of the stack.
    const flangeR = built.flangeDia / 2;
    if (flangeR > 0) {
      const belowTop = built.points.filter((pt) => pt.z < built.length - 1e-9);
      const highest = belowTop[belowTop.length - 1];
      assert.equal(highest.r, flangeR, `${def.name} should end on the flange, got r=${highest.r}`);
    }
  }
});

test('the spindle nose mates flush with the gauge line', () => {
  const tools = defaultTools();
  for (const holderDef of defaultHolders()) {
    const built = buildAssembly({ stickout: 40 }, tools[1], holderDef, { spindleDiameter: 110, spindleLength: 130 });
    const gauge = built.stickout + built.holder.length;

    assert.equal(built.gaugeLength, gauge);
    assert.ok(built.spindlePoints.length > 0, 'spindle nose missing');
    assert.equal(built.spindlePoints[0].z, gauge, `${holderDef.name}: spindle starts off the gauge line`);
    assert.equal(built.totalLength, gauge + 130);

    // No holder geometry above the gauge line.
    const above = built.holderPoints.filter((pt) => pt.z > gauge + 1e-9);
    assert.equal(above.length, 0, `${holderDef.name} has ${above.length} points above the gauge line`);
  }
});

test('a bare cutter still builds without a holder', () => {
  const built = buildAssembly({ stickout: 30 }, defaultTools()[1], null);
  assert.equal(built.holder, null);
  assert.equal(built.holderPoints.length, 0);
  assert.ok(built.cutEnvelope.at(0) === 0);
});
