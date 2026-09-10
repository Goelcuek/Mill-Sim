import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSTL, writeSTL, writeOBJ, bounds } from '../src/io/stl.js';
import { heightmapToTriangles, latheToTriangles, boxToTriangles } from '../src/io/mesh.js';
import { Stock } from '../src/sim/stock.js';
import { buildTool, makeTool } from '../src/tools/toolDefs.js';

test('binary STL survives a round trip', () => {
  const box = boxToTriangles([0, 0, 0], [10, 20, 30]);
  const back = parseSTL(writeSTL(box.positions, { name: 'box' }));
  assert.equal(back.format, 'binary');
  assert.equal(back.triangles, 12);
  assert.deepEqual(bounds(back.positions).size, [10, 20, 30]);
  assert.match(back.name, /box/);
});

test('ASCII STL is detected and parsed', () => {
  const text = `solid widget
 facet normal 0 0 1
  outer loop
   vertex 0 0 0
   vertex 1 0 0
   vertex 0 1 0
  endloop
 endfacet
 facet normal 0 0 -1
  outer loop
   vertex 0 0 0
   vertex 0 1 0
   vertex 1 0 0
  endloop
 endfacet
endsolid widget`;
  const stl = parseSTL(new TextEncoder().encode(text).buffer);
  assert.equal(stl.format, 'ascii');
  assert.equal(stl.triangles, 2);
  assert.equal(stl.name, 'widget');
  assert.equal(stl.normals[2], 1);
  assert.equal(stl.normals[11], -1);
});

test('scientific notation in ASCII STL is handled', () => {
  const text = `solid s
facet normal 0 0 1
outer loop
vertex 1.5e-2 -2.5E+1 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid`;
  const stl = parseSTL(new TextEncoder().encode(text).buffer);
  assert.equal(stl.triangles, 1);
  assert.ok(Math.abs(stl.positions[0] - 0.015) < 1e-9);
  assert.equal(stl.positions[1], -25);
});

test('exported STL normals point out of the solid', () => {
  const stock = new Stock({ origin: [-10, -10, -5], size: [20, 20, 5], resolution: 0.5 });
  const mesh = heightmapToTriangles(stock);
  const p = mesh.positions;

  // Sum of (area-weighted) normals over a closed solid is ~0, and the signed
  // volume from the divergence theorem must be positive for outward normals.
  let volume = 0;
  const n = [0, 0, 0];
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    n[0] += nx; n[1] += ny; n[2] += nz;
    volume += (ax * nx + ay * ny + az * nz) / 6;
  }
  assert.ok(Math.abs(n[0]) < 1e-3 && Math.abs(n[1]) < 1e-3 && Math.abs(n[2]) < 1e-3, `not closed: ${n}`);
  assert.ok(Math.abs(volume - 20 * 20 * 5) < 1, `volume ${volume}, expected 2000`);
});

test('a machined heightmap exports the machined shape', () => {
  const stock = new Stock({ origin: [-25, -15, -10], size: [50, 30, 10], resolution: 0.5 });
  const tool = buildTool(makeTool({ type: 'flat', diameter: 8, fluteLength: 20 }));
  for (let x = -15; x <= 15; x += 0.2) stock.carve(tool.cutEnvelope, x, 0, -3);

  const mesh = heightmapToTriangles(stock);
  const b = bounds(mesh.positions);
  assert.deepEqual(b.min, [-25, -15, -10]);
  assert.deepEqual(b.max, [25, 15, 0]);
  assert.ok(mesh.triangles > 1000);

  const decimated = heightmapToTriangles(stock, { decimate: 4 });
  assert.ok(decimated.triangles < mesh.triangles);
  assert.deepEqual(bounds(decimated.positions).size, [50, 30, 10], 'decimation keeps the outer size');
});

test('a lathed tool exports at the right size', () => {
  const tool = buildTool(makeTool({ type: 'ball', diameter: 8, shankDiameter: 8, fluteLength: 20, overallLength: 60 }));
  const mesh = latheToTriangles(tool.silhouette, { segments: 64 });
  const b = bounds(mesh.positions);
  assert.ok(Math.abs(b.size[0] - 8) < 0.02, `diameter ${b.size[0]}`);
  assert.ok(Math.abs(b.size[2] - 60) < 1e-6, `length ${b.size[2]}`);
  assert.ok(mesh.triangles > 100);
});

test('OBJ export lists every vertex and face', () => {
  const box = boxToTriangles([0, 0, 0], [1, 1, 1]);
  const obj = writeOBJ(box.positions, { name: 'cube' });
  assert.equal(obj.split('\n').filter((l) => l.startsWith('v ')).length, 36);
  assert.equal(obj.split('\n').filter((l) => l.startsWith('f ')).length, 12);
});

test('an empty buffer parses to nothing rather than throwing', () => {
  const stl = parseSTL(new ArrayBuffer(0));
  assert.equal(stl.triangles, 0);
});
