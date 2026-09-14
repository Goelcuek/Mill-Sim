import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTargetMap, compareToTarget } from '../src/sim/target.js';
import { boxToTriangles, latheToTriangles } from '../src/io/mesh.js';
import { Stock } from '../src/sim/stock.js';
import { buildTool, makeTool } from '../src/tools/toolDefs.js';

const stockOpts = { origin: [-40, -25, -10], size: [80, 50, 10], resolution: 0.1 };
const pad = () => boxToTriangles([-20, -10, -10], [20, 10, -4]);

test('a reference part rasterises onto the stock grid', () => {
  const stock = new Stock(stockOpts);
  const target = buildTargetMap(stock, [pad()]);
  assert.ok(target, 'no target produced');

  // The pad's top face is at z = -4 wherever it covers the stock.
  const mid = Math.floor(stock.ny / 2) * stock.nx + Math.floor(stock.nx / 2);
  assert.ok(Math.abs(target.map[mid] - -4) < 1e-6);

  // Outside its footprint there is nothing to compare against.
  assert.equal(target.map[0], -Infinity);

  const covered = target.map.reduce((n, v) => n + (v > -Infinity ? 1 : 0), 0);
  const expected = Math.round(40 / stock.dx) * Math.round(20 / stock.dy);
  assert.ok(Math.abs(covered - expected) / expected < 0.02, `covered ${covered}, expected about ${expected}`);
});

test('no reference parts means nothing to compare against', () => {
  const stock = new Stock(stockOpts);
  assert.equal(buildTargetMap(stock, []), null);
  assert.equal(buildTargetMap(stock, null), null);
  const empty = compareToTarget(stock, null);
  assert.equal(empty.gougeCells, 0);
  assert.equal(empty.comparedCells, 0);
});

test('cutting to the reference surface is not a gouge', () => {
  const stock = new Stock(stockOpts);
  const target = buildTargetMap(stock, [pad()]);
  const tool = buildTool(makeTool({ type: 'flat', diameter: 8, fluteLength: 30 }));

  const res = stock.carveSweep(tool.cutEnvelope, [-30, 0, -4], [30, 0, -4], 0, { target, tolerance: 0.02 });
  assert.equal(res.gouge, null, 'cutting exactly to the surface reported a gouge');
  assert.equal(compareToTarget(stock, target, 0.02).gougeCells, 0);
});

test('cutting past the reference surface is reported with its depth', () => {
  const stock = new Stock(stockOpts);
  const target = buildTargetMap(stock, [pad()]);
  const tool = buildTool(makeTool({ type: 'flat', diameter: 8, fluteLength: 30 }));

  const res = stock.carveSweep(tool.cutEnvelope, [-30, 0, -4.5], [30, 0, -4.5], 0, { target, tolerance: 0.02 });
  assert.ok(res.gouge, 'a 0.5 mm overcut was not reported');
  assert.ok(Math.abs(res.gouge.depth - 0.5) < 1e-3, `reported ${res.gouge.depth}`);

  const cmp = compareToTarget(stock, target, 0.02);
  assert.ok(Math.abs(cmp.maxGouge - 0.5) < 1e-3);
  assert.ok(cmp.gougeCells > 1000);
  // Material outside the cut still stands proud of the part.
  assert.ok(cmp.maxExcess > 3.9 && cmp.maxExcess < 4.1, `excess ${cmp.maxExcess}`);
});

test('the tolerance decides what counts', () => {
  const stock = new Stock(stockOpts);
  const target = buildTargetMap(stock, [pad()]);
  const tool = buildTool(makeTool({ type: 'flat', diameter: 8, fluteLength: 30 }));
  stock.carveSweep(tool.cutEnvelope, [-30, 0, -4.05], [30, 0, -4.05], 0, { target, tolerance: 0.02 });

  assert.ok(compareToTarget(stock, target, 0.02).gougeCells > 0, '0.05 mm over should trip a 0.02 mm tolerance');
  assert.equal(compareToTarget(stock, target, 0.1).gougeCells, 0, '0.05 mm over should pass a 0.1 mm tolerance');
});

test('a curved reference surface is followed, not just flats', () => {
  // A cone standing on the stock floor: the target height should fall off
  // linearly with radius.
  const cone = latheToTriangles([{ r: 8, z: -10 }, { r: 0, z: -2 }], { segments: 96 });
  const stock = new Stock(stockOpts);
  const target = buildTargetMap(stock, [cone]);
  assert.ok(target);

  const at = (x, y) => {
    const i = Math.floor((x - stock.origin[0]) / stock.dx);
    const j = Math.floor((y - stock.origin[1]) / stock.dy);
    return target.map[j * stock.nx + i];
  };
  // The nearest column centre to the axis is half a cell out in each
  // direction, and this cone has slope 1, so the apex reads a hair low.
  const offAxis = Math.hypot(stock.dx / 2, stock.dy / 2);
  assert.ok(Math.abs(at(0, 0) - (-2 - offAxis)) < 0.02, `apex ${at(0, 0)}`);
  assert.ok(Math.abs(at(4, 0) - -6) < 0.1, `mid ${at(4, 0)}`);
  assert.equal(at(20, 0), -Infinity, 'outside the cone there is no reference');
});

// A plate with a 5 mm hole through it: the annulus top face at z = -4, the
// hole a polygon inscribed in the true bore, so its flats stand a couple of
// hundredths *inside* the 5 mm circle.
const holedPlate = (segments = 64) => latheToTriangles(
  [{ r: 2.5, z: -4 }, { r: 20, z: -4 }], { segments },
);

test('a hole drilled to size is not a gouge', () => {
  const stock = new Stock(stockOpts);
  const target = buildTargetMap(stock, [holedPlate()]);
  assert.ok(target.edgeCells > 0, 'the hole and the rim should both be edges');
  assert.ok(Math.abs(target.lateral - stock.dx) < 1e-9);

  // The sliver between the polygon and the circle is real: some columns the
  // reference calls material fall inside a 5 mm bore.
  const inSliver = (() => {
    let n = 0;
    for (let j = 0; j < stock.ny; j++) {
      for (let i = 0; i < stock.nx; i++) {
        const r = Math.hypot(stock.cx(i), stock.cy(j));
        if (r < 2.5 && target.map[j * stock.nx + i] > -Infinity) n++;
      }
    }
    return n;
  })();
  assert.ok(inSliver > 0, 'no sliver to trip over — the test proves nothing');

  const drill = buildTool(makeTool({ type: 'flat', diameter: 5, fluteLength: 30 }));
  const res = stock.carveSweep(drill.cutEnvelope, [0, 0, 0], [0, 0, -10], 0, { target, tolerance: 0.02 });
  assert.equal(res.gouge, null, 'a 5 mm drill in a 5 mm hole reported a gouge');
  assert.equal(compareToTarget(stock, target, 0.02).gougeCells, 0);
});

test('a hole cut oversize is still a gouge', () => {
  const stock = new Stock(stockOpts);
  const target = buildTargetMap(stock, [holedPlate()]);
  const drill = buildTool(makeTool({ type: 'flat', diameter: 6, fluteLength: 30 }));

  const res = stock.carveSweep(drill.cutEnvelope, [0, 0, 0], [0, 0, -10], 0, { target, tolerance: 0.02 });
  assert.ok(res.gouge, 'a 6 mm drill in a 5 mm hole went unreported');
  assert.ok(Math.abs(res.gouge.depth - 6) < 1e-3, `reported ${res.gouge.depth}`);
  assert.ok(compareToTarget(stock, target, 0.02).gougeCells > 100);
});

test('the walls left out of the comparison are counted, not hidden', () => {
  const stock = new Stock(stockOpts);
  const target = buildTargetMap(stock, [holedPlate()]);
  const cmp = compareToTarget(stock, target, 0.02);

  assert.equal(cmp.comparedCells + cmp.skippedCells, target.map.reduce((n, v) => n + (v > -Infinity ? 1 : 0), 0));
  assert.ok(cmp.skippedCells > 0, 'the hole and the rim are walls and should be skipped');
  // Walls are a rim one column wide, so the flat annulus is most of it.
  assert.ok(cmp.skippedCells / (cmp.comparedCells + cmp.skippedCells) < 0.1);
});
