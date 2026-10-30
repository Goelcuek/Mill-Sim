// The stock's display mesh, made on another thread.
//
// Meshing the cut surface is a fifth or so of what a frame does while the
// program plays, and it does not have to be done where the cutting is: it
// only reads the stretches of material along the stock's lines. So this
// worker keeps its own copy of those — the whole of each family when the
// stock is refilled, and afterwards only the lines a cut changed — and
// meshes the blocks it is asked for from that copy, with the same mesher
// the main thread uses. What comes back is the blocks' buffers, handed
// over rather than copied.
//
// Messages in:
//   { type: 'stock', geometry, step }      a new stock: its shape and the display step
//   { type: 'lines', changes }             what changed since, per family (see takeLineChanges)
//   { type: 'build', id, blocks }          mesh these blocks, now
// Messages out:
//   { type: 'built', id, results }         one result per block asked for
//   { type: 'failed', id, message }        something went wrong; the main thread meshes instead

import { DexelMesher } from '../sim/dexelMesh.js';

/** Most stretches a line holds; the stock's own limit. */
const MAX = 255;

let stock = null;
let mesher = null;

/** A family's copy, from the stock's whole family. */
function replaceFamily(F, full) {
  F.off = full.off;
  F.cnt = full.cnt;
  F.cap = full.cap;
  F.pool = full.pool;
  F.who = full.who;
  F.used = full.used;
}

/** Room for `need` more numbers at the end of a family's pool, compacting or growing it. */
function room(F, need) {
  if (F.used + need <= F.pool.length) return;
  let live = 0;
  for (let r = 0; r < F.rays; r++) live += 2 * F.cap[r];
  const size = Math.ceil((live + need) * 2) + 4096;
  const pool = new Float32Array(size);
  const who = new Uint8Array(size);
  let at = 0;
  for (let r = 0; r < F.rays; r++) {
    const o = F.off[r];
    const n2 = 2 * F.cnt[r];
    if (n2) {
      pool.set(F.pool.subarray(o, o + n2), at);
      who.set(F.who.subarray(o, o + n2), at);
    }
    F.off[r] = at;
    at += 2 * F.cap[r];
  }
  F.pool = pool;
  F.who = who;
  F.used = at;
}

/** The lines that changed, written into the copy. */
function applyLines(F, vals, whos) {
  for (let at = 0; at < vals.length;) {
    const r = vals[at];
    const n = vals[at + 1];
    at += 2;
    if (n > F.cap[r]) {
      const cap = Math.min(MAX, Math.max(n, 2 * F.cap[r], 2));
      room(F, 2 * cap);
      F.off[r] = F.used;
      F.cap[r] = cap;
      F.used += 2 * cap;
    }
    const o = F.off[r];
    for (let q = 0; q < 2 * n; q++) {
      F.pool[o + q] = vals[at + q];
      F.who[o + q] = whos[at + q];
    }
    F.cnt[r] = n;
    at += 2 * n;
  }
}

function onStock({ geometry, step }) {
  stock = {
    n3: geometry.n3,
    d3: geometry.d3,
    o3: geometry.o3,
    fam: geometry.fam.map((f) => ({ ...f, off: new Int32Array(f.rays), cnt: new Uint8Array(f.rays), cap: new Uint8Array(f.rays), pool: new Float32Array(0), who: new Uint8Array(0), used: 0 })),
  };
  mesher = new DexelMesher(stock, { step });
}

function onLines({ changes }) {
  if (!stock || !changes) return;
  changes.forEach((c, a) => {
    if (!c) return;
    const F = stock.fam[a];
    if (c.full) replaceFamily(F, c);
    else applyLines(F, c.vals, c.whos);
  });
}

function onBuild({ id, blocks }) {
  const results = [];
  const transfer = [];
  for (const k of blocks) {
    const out = mesher.buildBlock(k);
    if (!out.indices) { results.push({ k, vertices: 0, indices: 0 }); continue; }
    const V = out.vertices;
    const I = out.indices;
    const r = {
      k,
      vertices: V,
      indices: I,
      positions: out.positions.slice(0, 3 * V),
      normals: out.normals.slice(0, 3 * V),
      who: out.who.slice(0, V),
      index: out.index.slice(0, I),
    };
    results.push(r);
    transfer.push(r.positions.buffer, r.normals.buffer, r.who.buffer, r.index.buffer);
  }
  self.postMessage({ type: 'built', id, results }, transfer);
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'stock') onStock(m);
    else if (m.type === 'lines') onLines(m);
    else if (m.type === 'build') onBuild(m);
  } catch (err) {
    self.postMessage({ type: 'failed', id: m.id, message: String(err && err.stack ? err.stack : err) });
  }
};
