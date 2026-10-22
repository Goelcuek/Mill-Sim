import test from 'node:test';
import assert from 'node:assert/strict';

import { featureEdgeSegments } from '../src/scene/featureEdges.js';

/** An axis-aligned box as an STL would hold it: 12 triangles, nothing shared. */
function boxSoup(w, d, h) {
  const v = [];
  for (let i = 0; i < 8; i++) v.push([(i & 1) ? w : 0, (i & 2) ? d : 0, (i & 4) ? h : 0]);
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const out = [];
  for (const [a, b, c, e] of quads) for (const t of [[a, b, c], [a, c, e]]) for (const k of t) out.push(...v[k]);
  return out;
}

/** An n-sided prism standing on Z, indexed, split at the seam as generators do. */
function prism(n, r, h) {
  const pos = [];
  const idx = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos.push(r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(a), r * Math.sin(a), h);
  }
  for (let i = 0; i < n; i++) {
    const b0 = i * 2, t0 = b0 + 1, b1 = b0 + 2, t1 = b0 + 3;
    idx.push(b0, b1, t1, b0, t1, t0);
  }
  // Caps, each with its own centre and its own copies of the rim.
  for (const z of [0, h]) {
    const c = pos.length / 3;
    pos.push(0, 0, z);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pos.push(r * Math.cos(a), r * Math.sin(a), z);
    }
    for (let i = 0; i < n; i++) {
      const p = c + 1 + i, q = c + 1 + ((i + 1) % n);
      if (z === 0) idx.push(c, q, p); else idx.push(c, p, q);
    }
  }
  return { pos, idx };
}

test('a box has twelve edges, however its triangles are stored', () => {
  assert.equal(featureEdgeSegments(boxSoup(10, 20, 30)).length / 6, 12);
});

test('a round body is outlined at its ends, not down its facets', () => {
  const { pos, idx } = prism(48, 5, 20);
  // 7.5° between facets: no edges down the side, a circle at each end.
  assert.equal(featureEdgeSegments(pos, idx).length / 6, 96);
  // Coarse enough that the facets are corners, and they are drawn.
  const hex = prism(6, 5, 20);
  assert.equal(featureEdgeSegments(hex.pos, hex.idx).length / 6, 18);
});

test('where a surface stops is an edge too', () => {
  // One open square, two triangles: four boundary edges, no diagonal.
  const sheet = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
  assert.equal(featureEdgeSegments(sheet).length / 6, 4);
});

test('slivers with no area do not draw edges across a face', () => {
  const soup = boxSoup(10, 10, 10);
  // A zero-area triangle lying along the top face's diagonal.
  soup.push(0, 0, 10, 5, 5, 10, 10, 10, 10);
  assert.equal(featureEdgeSegments(soup).length / 6, 12);
});
