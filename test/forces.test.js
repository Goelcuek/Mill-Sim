import test from 'node:test';
import assert from 'node:assert/strict';

import { simulateStraight, forceRatios, deflection } from '../src/cutting/forceModel.js';
import { materialById } from '../src/cutting/materials.js';

// Reference values printed by Shop-Ref's own Kotlin model
// (MillingForceModel.simulate, ForceRatios.oblique, Deflection.compute) for
// the same inputs: the port has to give the same answers.
const CASES = [
  { id: 'p_medium_carbon', d: 10, n: 4, helix: 35, rake: 8, lead: 90, ap: 10, ae: 3, fz: 0.05, climb: true,
    peakFxy: 650.0238809463023, meanFxy: 572.0214436888982, peakFz: 222.45582423904807, meanTorque: 2.868111575260347, peakTorque: 3.264158884422269 },
  { id: 'n_al_wrought', d: 12, n: 3, helix: 45, rake: 15, lead: 90, ap: 6, ae: 12, fz: 0.08, climb: true,
    peakFxy: 433.26869377920065, meanFxy: 375.8502280755604, peakFz: 215.7570787867299, meanTorque: 2.8650710648972493, peakTorque: 3.086400097301624 },
  { id: 'm_austenitic', d: 8, n: 4, helix: 30, rake: 10, lead: 90, ap: 12, ae: 0.8, fz: 0.04, climb: false,
    peakFxy: 373.9701833683354, meanFxy: 286.28778390446655, peakFz: 88.61215316304605, meanTorque: 1.1011868833854705, peakTorque: 1.4378578673179248 },
  { id: 'p_alloy_annealed', d: 50, n: 5, helix: 0, rake: 10, lead: 45, ap: 2, ae: 35, fz: 0.15, climb: true,
    peakFxy: 1091.5825923236598, meanFxy: 853.4699087027745, peakFz: 300.8293772189736, meanTorque: 23.215863738790077, peakTorque: 32.73401013818243 },
];

for (const c of CASES) {
  test(`the force model matches Shop-Ref: ${c.id}`, () => {
    const r = simulateStraight({
      material: materialById(c.id), diameter: c.d, flutes: c.n, helixDeg: c.helix, rakeDeg: c.rake,
      leadAngleDeg: c.lead, ap: c.ap, ae: c.ae, fz: c.fz, climb: c.climb,
    });
    for (const k of ['peakFxy', 'meanFxy', 'peakFz', 'meanTorque', 'peakTorque']) {
      const rel = Math.abs(r[k] - c[k]) / c[k];
      assert.ok(rel < 1e-9, `${k}: ${r[k]} against Shop-Ref's ${c[k]}`);
    }
  });
}

test('force ratios and deflection match Shop-Ref', () => {
  const r = forceRatios(30, 10, 30);
  assert.ok(Math.abs(r.radial - 0.2972363889085477) < 1e-12);
  assert.ok(Math.abs(r.axial - 0.2665203870458123) < 1e-12);
  const d = deflection({ diameter: 10, shankDiameter: 10, stickout: 40, fluteLength: 25, youngsModulus: 600000, force: 500, loadFromTip: 2.5 }, 400);
  assert.ok(Math.abs(d.tipDeflection - 0.04366509748774403) / 0.0437 < 1e-9, `${d.tipDeflection}`);
  assert.ok(Math.abs(d.maxBendingStress - 223.81163872297782) < 1e-9);
});

test('with a linear law the mean tangential force is the closed form (Altintas)', () => {
  // Shop-Ref's own check, carried across: mc = 0 makes Kt constant.
  const linear = { ...materialById('p_medium_carbon'), mc: 0 };
  const d = 10, ae = 3, ap = 5, fz = 0.1, n = 4;
  const r = simulateStraight({ material: linear, diameter: d, flutes: n, helixDeg: 30, rakeDeg: 0, ap, ae, fz, climb: false, steps: 3600, axialSlices: 100 });
  const phiEx = Math.acos(1 - (2 * ae) / d);
  const closed = (n * ap / (2 * Math.PI)) * linear.kc11 * fz * (1 - Math.cos(phiEx));
  // Torque = Ft · r, so the mean tangential force is the mean torque over the radius.
  const meanFt = (r.meanTorque * 1000) / (d / 2);
  assert.ok(Math.abs(meanFt - closed) / closed < 0.005, `${meanFt} vs ${closed}`);
});

// ---- the analyzer reads the engagement off the stock ---------------------

import { CutAnalyzer } from '../src/cutting/analyzer.js';
import { Stock } from '../src/sim/stock.js';
import { buildTool, makeTool } from '../src/tools/toolDefs.js';
import { buildAssembly } from '../src/tools/assembly.js';

function rig({ material = 'p_medium_carbon', flutes = 4, helix = 35, rake = 8 } = {}) {
  const tool = makeTool({ type: 'flat', diameter: 10, fluteLength: 25, fluteCount: flutes, shankDiameter: 10, overallLength: 75, helixAngle: helix, rakeAngle: rake });
  const built = buildAssembly({ stickout: 40 }, tool, null, { spindleDiameter: 90, spindleLength: 80 });
  const analyzer = new CutAnalyzer();
  analyzer.setMaterial(material);
  analyzer.reset(1);
  return { analyzer, slot: { built }, tool: buildTool(tool) };
}

/** A move at 0.05 mm a tooth: 4 flutes at 1000 rpm is 200 mm/min. */
const move = { i: 0, kind: 'feed', feed: 200, rpm: 1000 };

test('a 3 mm side cut, read off the stock, is the cut Shop-Ref computes', () => {
  // Steel standing on the right of a +X pass (the climb side), 3 mm into
  // the cutter's path and 10 mm tall above the tip.
  const stock = new Stock({ origin: [-30, -20, -10], size: [60, 40, 10], resolution: 0.05 });
  for (let j = 0; j < stock.ny; j++) for (let i = 0; i < stock.nx; i++) {
    stock.height[j * stock.nx + i] = stock.cy(j) < -2 ? 0 : -10;
  }
  stock.refreshTiles();
  const { analyzer, slot } = rig();
  analyzer.sample(stock, slot, move, [-5, 0, -10], [0, 0, -10]);
  const force = analyzer.force[0];
  assert.ok(Math.abs(force - 650.02) / 650.02 < 0.06, `peak force ${force.toFixed(1)} N against Shop-Ref's 650.0 N`);
  assert.ok(Math.abs(analyzer.ap[0] - 10) < 0.05, `ap ${analyzer.ap[0]}`);
  // Engagement arc for ae = 3 on Ø10: acos(1 − 0.6) = 66.4°.
  assert.ok(Math.abs(analyzer.arc[0] - 66.4) < 6, `arc ${analyzer.arc[0]}`);
  assert.ok(Math.abs(analyzer.fz[0] - 0.05) < 1e-9);
  assert.ok(analyzer.deflection[0] > 0 && analyzer.power[0] > 0);
});

test('a slot is the whole half, and a shallow floor pass beside a wall is shallow', () => {
  const stock = new Stock({ origin: [-30, -20, -10], size: [60, 40, 10], resolution: 0.05 });
  stock.refreshTiles();
  const { analyzer, slot } = rig();
  // Full slot, 3 mm deep: the top of the block is at 0.
  analyzer.sample(stock, slot, move, [-5, 0, -3], [0, 0, -3]);
  const straight = simulateStraight({ material: materialById('p_medium_carbon'), diameter: 10, flutes: 4, helixDeg: 35, rakeDeg: 8, ap: 3, ae: 10, fz: 0.05 });
  assert.ok(Math.abs(analyzer.force[0] - straight.peakFxy) / straight.peakFxy < 0.06, `${analyzer.force[0]} vs ${straight.peakFxy}`);
  assert.ok(analyzer.arc[0] > 170);

  // A floor 0.2 mm down beside a 10 mm wall the cutter just touches.
  const floor = new Stock({ origin: [-30, -20, -10], size: [60, 40, 10], resolution: 0.05 });
  for (let j = 0; j < floor.ny; j++) for (let i = 0; i < floor.nx; i++) {
    floor.height[j * floor.nx + i] = floor.cy(j) > 5 ? 0 : -9.8;
  }
  floor.refreshTiles();
  const f2 = rig();
  f2.analyzer.sample(floor, f2.slot, move, [-5, 0, -10], [0, 0, -10]);
  assert.ok(f2.analyzer.ap[0] < 0.25, `the floor pass is ${f2.analyzer.ap[0]} deep`);
  const thin = simulateStraight({ material: materialById('p_medium_carbon'), diameter: 10, flutes: 4, helixDeg: 35, rakeDeg: 8, ap: 0.2, ae: 10, fz: 0.05 });
  assert.ok(f2.analyzer.force[0] < thin.peakFxy * 1.3, `${f2.analyzer.force[0]} vs ${thin.peakFxy}`);
});

test('a plunge into air is not a load, and a drill into metal is', () => {
  const stock = new Stock({ origin: [-30, -20, -10], size: [60, 40, 10], resolution: 0.25 });
  // Faced 1 mm off the top, except one tall corner far from the tool.
  for (let j = 0; j < stock.ny; j++) for (let i = 0; i < stock.nx; i++) {
    stock.height[j * stock.nx + i] = stock.cx(i) > 25 && stock.cy(j) > 15 ? 0 : -1;
  }
  stock.refreshTiles();
  const { analyzer, slot } = rig();
  analyzer.sample(stock, slot, move, [0, 0, 5], [0, 0, -0.6]);
  assert.equal(analyzer.force[0], 0, 'plunging to -0.6 over a top at -1 cuts nothing');
  analyzer.sample(stock, slot, move, [0, 0, -0.6], [0, 0, -3]);
  assert.ok(analyzer.force[0] > 0 && analyzer.plunge[0] === 1, 'into the metal it is a plunge with a thrust');
});
