// Drawing a tri-dexel stock: the closed surface of what is left.
//
// The mesh comes from the stretches a block at a time (see
// sim/dexelMesh.js), and a cut remakes only the blocks it went through.
// It is shaded in the stock's steel and the tool colours, and because it
// is closed, a section through it shows the inside of the part: the faces
// seen from behind are drawn as the cut face, flat and level, in their
// own colour.

import * as THREE from 'three';
import { DexelMesher } from '../sim/dexelMesh.js';
import { pointDeviation, DEV_JUDGED } from '../sim/target.js';
import { startMeshWorker } from './meshWorkerClient.js';

const MAX_TOOL_COLORS = 8;
/**
 * Triangles the whole view may hold before the lattice is thinned for
 * display. A phone has a quarter of a desktop's room for them. `?tris=` in
 * the page address sets it outright — the smoke test asks for a small one,
 * because its browser draws on the CPU.
 */
const TRI_BUDGET = askedBudget() || (coarsePointer() ? 600000 : 2400000);
/**
 * Milliseconds a frame may spend remaking blocks while the run plays. The
 * rest wait for the next frame: the picture trails the cut by a frame or
 * two instead of the run stuttering to keep it exact.
 */
const FRAME_BUDGET = 4;
/** What a frame may take when a batch is large, so the picture catches up. */
const CATCH_UP_BUDGET = 16;
/** What a full redraw may take at once; the rest follow on idle frames. */
const FORCE_BUDGET = 150;

function askedBudget() {
  try {
    const n = Number(new URLSearchParams(globalThis.location && globalThis.location.search).get('tris'));
    return n >= 10000 ? n : 0;
  } catch {
    return 0;
  }
}

function coarsePointer() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * Every how many lines the display mesh is made from: enough that a block
 * with its faces cut up somewhat stays inside the budget.
 */
export function displayStep(stock, budget = TRI_BUDGET) {
  const [sx, sy, sz] = stock.size;
  const area = 2 * (sx * sy + sy * sz + sx * sz);
  const cell = Math.cbrt(stock.d3[0] * stock.d3[1] * stock.d3[2]);
  // Two triangles a lattice square, and half as much again for the cutting.
  const tris = (3 * area) / (cell * cell);
  return Math.max(1, Math.ceil(Math.sqrt(tris / budget)));
}

export class DexelSurface {
  /**
   * @param {import('../sim/triDexel.js').TriDexelStock} stock
   * @param {{stockColor:THREE.Color, cutColor:THREE.Color, toolColors:THREE.Color[], capColor?:THREE.Color}} colors
   */
  constructor(stock, colors) {
    this.stock = stock;
    this.group = new THREE.Group();
    this.group.name = 'stock-surface';
    this.step = displayStep(stock);
    this.mesher = new DexelMesher(stock, { step: this.step });
    this.uniforms = {
      uStockColor: { value: colors.stockColor },
      uCutColor: { value: colors.cutColor },
      uToolColors: { value: colors.toolColors.slice(0, MAX_TOOL_COLORS) },
      uShowTools: { value: 1 },
      uSectionN: { value: new THREE.Vector3(0, 0, 1) },
      uSectionD: { value: 1e9 },
      uCapColor: { value: colors.capColor || new THREE.Color('#c4705a') },
      uDevMode: { value: 0 },
      uDevTol: { value: 0.02 },
      uDevRange: { value: 0.5 },
    };
    /** The deviation map: on or off, against what, and how far it looks. */
    this.dev = { mode: false, target: null, tolerance: 0.02, range: 0.5 };
    this.material = this.buildMaterial();
    this.blocks = new Array(this.mesher.blockCount).fill(null);
    /**
     * Blocks are remade a batch at a time: `dirty` is the batch being
     * built, `next` what the cutter has changed since it began. A batch is
     * built out of sight and put up whole — see sync.
     */
    this.dirty = new Uint8Array(this.mesher.blockCount);
    this.next = new Uint8Array(this.mesher.blockCount).fill(1);
    this.batchLeft = 0;
    this.staged = [];
    this.pending = true;
    stock.takeDirty3();
    if (stock.takeDirtyCells) stock.takeDirtyCells();
    this.attachWorker();
    this.sync(false, FORCE_BUDGET);
  }

  /**
   * Mesh on another thread when one can be had: the worker keeps a copy of
   * the stock's lines, is sent the ones that change, and makes the blocks.
   * Without one — or the moment one fails — the blocks are made here.
   */
  attachWorker() {
    const stock = this.stock;
    if (!stock.fam || typeof stock.trackLines !== 'function') return;
    const w = startMeshWorker();
    if (!w) return;
    this.worker = w;
    this.inFlight = null;
    this.ready = null;
    this.requestId = 0;
    stock.trackLines();
    w.onmessage = (e) => this.onWorker(e.data);
    w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); this.dropWorker(); };
    w.postMessage({
      type: 'stock',
      step: this.step,
      geometry: {
        n3: stock.n3.slice(),
        d3: stock.d3.slice(),
        o3: stock.o3.slice(),
        fam: stock.fam.map((F) => ({ a: F.a, b: F.b, c: F.c, nb: F.nb, nc: F.nc, db: F.db, dc: F.dc, rays: F.rays, len: F.len })),
      },
    });
  }

  onWorker(m) {
    if (m.type === 'built' && this.inFlight && m.id === this.inFlight.id) {
      this.ready = m.results;
      this.inFlight = null;
    } else if (m.type === 'failed') {
      if (typeof console !== 'undefined') console.warn('Stock mesh worker failed; meshing on the main thread.', m.message);
      this.dropWorker();
    }
  }

  /** Back to meshing here: whatever the worker was making is made again. */
  dropWorker() {
    if (!this.worker) return;
    try { this.worker.terminate(); } catch { /* gone already */ }
    this.worker = null;
    if (this.inFlight) for (const k of this.inFlight.blocks) this.next[k] = 1;
    this.inFlight = null;
    this.ready = null;
    this.pending = true;
  }

  /** The blocks the cuts since have changed, marked in `next`. */
  collectDirty(force) {
    const m = this.mesher;
    if (force) {
      this.next.fill(1);
      this.stock.takeDirty3();
      if (this.stock.takeDirtyCells) this.stock.takeDirtyCells();
      return;
    }
    // The whole stock when it was reset; otherwise the cells the cuts
    // since really changed — a turned cut goes all the way round, and a
    // box round it would be the whole part to remake for a thin shell.
    const boxes = this.stock.takeDirtyCells ? this.stock.takeDirtyCells() : [];
    const box = this.stock.takeDirty3();
    if (box) boxes.push(box);
    for (const bx3 of boxes) {
      const [bx0, by0, bz0, bx1, by1, bz1] = m.blocksFor(bx3);
      for (let bz = bz0; bz <= bz1; bz++) {
        for (let by = by0; by <= by1; by++) {
          for (let bx = bx0; bx <= bx1; bx++) this.next[m.blockIndex(bx, by, bz)] = 1;
        }
      }
    }
  }

  /**
   * The worker's half of sync: put up a batch that has come back, and send
   * the next — the lines changed since and the blocks to make — once the
   * last is home. One batch at a time, put up whole, as on the main thread.
   */
  syncWorker(force) {
    this.collectDirty(force);
    let changed = false;
    if (this.ready) {
      for (const r of this.ready) this.applyBlock(r.k, r);
      this.ready = null;
      changed = true;
    }
    if (!this.inFlight) {
      const blocks = [];
      for (let k = 0; k < this.next.length; k++) if (this.next[k]) { blocks.push(k); this.next[k] = 0; }
      if (blocks.length) {
        const changes = this.stock.takeLineChanges();
        const transfer = [];
        if (changes) {
          for (const c of changes) {
            if (!c) continue;
            if (c.full) transfer.push(c.off.buffer, c.cnt.buffer, c.cap.buffer, c.pool.buffer, c.who.buffer);
            else transfer.push(c.vals.buffer, c.whos.buffer);
          }
        }
        const id = ++this.requestId;
        this.inFlight = { id, blocks };
        try {
          this.worker.postMessage({ type: 'lines', changes }, transfer);
          this.worker.postMessage({ type: 'build', id, blocks });
        } catch {
          this.dropWorker();
          return this.sync(force);
        }
      }
    }
    let more = !!this.inFlight || !!this.ready;
    if (!more) for (let k = 0; k < this.next.length; k++) if (this.next[k]) { more = true; break; }
    this.pending = more;
    return changed;
  }

  buildMaterial() {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.44,
      metalness: 0.45,
      side: THREE.FrontSide,
    });
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `
          #include <common>
          attribute float aWho;
          attribute float aDev;
          attribute float aDevOn;
          flat varying float vWho;
          varying float vDev;
          flat varying float vDevOn;
          varying vec3 vWorkPos;
          varying vec3 vCapNormal;
          uniform vec3 uSectionN;
        `)
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          vWho = aWho;
          vDev = aDev;
          vDevOn = aDevOn;
          vWorkPos = position;
          // The section's cut face, facing out of what is kept.
          vCapNormal = normalize( normalMatrix * uSectionN );
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `
          #include <common>
          uniform vec3 uStockColor;
          uniform vec3 uCutColor;
          uniform vec3 uToolColors[ ${MAX_TOOL_COLORS} ];
          uniform float uShowTools;
          uniform vec3 uSectionN;
          uniform float uSectionD;
          uniform vec3 uCapColor;
          uniform float uDevMode;
          uniform float uDevTol;
          uniform float uDevRange;
          flat varying float vWho;
          varying float vDev;
          flat varying float vDevOn;
          varying vec3 vWorkPos;
          varying vec3 vCapNormal;

          // Within tolerance green, material left pale
          // to deep blue, a gouge orange to red, full colour at uDevRange.
          vec3 deviationColor( float d ) {
            float a = abs( d );
            if ( a <= uDevTol ) return vec3( 0.25, 0.73, 0.31 );
            float t = clamp( ( a - uDevTol ) / max( uDevRange - uDevTol, 1e-6 ), 0.0, 1.0 );
            if ( d > 0.0 ) return mix( vec3( 0.56, 0.83, 1.0 ), vec3( 0.12, 0.31, 0.75 ), t );
            return mix( vec3( 1.0, 0.70, 0.28 ), vec3( 0.85, 0.18, 0.13 ), t );
          }
        `)
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          if ( dot( vWorkPos, uSectionN ) > uSectionD ) discard;
          vec3 surface = uStockColor;
          float tinted = 0.0;
          if ( !gl_FrontFacing ) {
            // The inside of the part, seen through the section.
            surface = uCapColor;
          } else if ( vWho > 0.5 ) {
            int ti = int( clamp( vWho - 1.0 + 0.5, 0.0, ${MAX_TOOL_COLORS - 1}.0 ) );
            vec3 machined = uToolColors[ 0 ];
            for ( int k = 0; k < ${MAX_TOOL_COLORS}; k ++ ) {
              if ( k == ti ) machined = uToolColors[ k ];
            }
            surface = mix( uCutColor, machined, uShowTools );
            tinted = uShowTools;
          }
          // Every face judged where it is — walls, the inside of a side
          // hole, the roof of an undercut — not only the tops of columns.
          if ( uDevMode > 0.5 && gl_FrontFacing && vDevOn > 0.5 ) {
            surface = deviationColor( vDev );
            tinted = 1.0;
          }
          diffuseColor.rgb *= surface;
        `)
        .replace('#include <normal_fragment_begin>', `
          #include <normal_fragment_begin>
          // Seen from behind is seen through the cut: lit as the flat face
          // the section would leave, not as the inside of a wall.
          if ( !gl_FrontFacing ) normal = normalize( vCapNormal );
        `)
        .replace('#include <metalnessmap_fragment>', `
          #include <metalnessmap_fragment>
          metalnessFactor *= mix( 1.0, 0.55, tinted );
          roughnessFactor = mix( roughnessFactor, 0.55, tinted );
          if ( !gl_FrontFacing ) { metalnessFactor = 0.1; roughnessFactor = 0.8; }
        `);
    };
    material.customProgramCacheKey = () => 'millsim-dexel-surface';
    return material;
  }

  /**
   * Remake the blocks the cutter changed, for no more than `budget`
   * milliseconds a call; whatever is left is still waiting, and `pending`
   * says so.
   *
   * Blocks change together — a turned cut reaches all the way round — and
   * putting each up as soon as it was made showed some blocks cut and their
   * neighbours not, with slits along the seams until the rest caught up.
   * So the blocks changed by then are a batch, built out of sight over as
   * many frames as it takes and put up all at once: the picture may trail
   * the cut, but it is always one moment of it. What changes meanwhile is
   * the next batch.
   */
  sync(force = false, budget) {
    // A batch the main thread had started is finished here; after that,
    // with a worker, the worker makes them.
    // Asked to finish now, with no limit: done here, at once. Whatever the
    // worker has made is put up, and what it is still making is made here.
    if (this.worker && budget === Infinity) {
      if (this.ready) { for (const r of this.ready) this.applyBlock(r.k, r); this.ready = null; }
      if (this.inFlight) { for (const k of this.inFlight.blocks) this.next[k] = 1; this.inFlight = null; }
    } else if (this.worker && this.batchLeft === 0 && !this.staged.length) return this.syncWorker(force);
    if (!(budget >= 0)) budget = force ? FORCE_BUDGET : FRAME_BUDGET;
    this.collectDirty(force);
    // A batch done: the next one starts with everything changed since.
    if (this.batchLeft === 0) {
      let n = 0;
      for (let k = 0; k < this.next.length; k++) if (this.next[k]) n++;
      if (n) {
        const t = this.dirty;
        this.dirty = this.next;
        this.next = t;
        this.next.fill(0);
        this.batchLeft = n;
        this.staged.length = 0;
      }
    }
    // A big batch gets more of each frame, or the picture falls far behind.
    if (!force && this.batchLeft > 24) budget = Math.max(budget, CATCH_UP_BUDGET);
    const t0 = performance.now();
    let built = false;
    for (let k = 0; k < this.dirty.length && this.batchLeft > 0; k++) {
      if (!this.dirty[k]) continue;
      if (built && performance.now() - t0 > budget) break;
      this.dirty[k] = 0;
      this.batchLeft--;
      this.staged.push(this.stageBlock(k));
      built = true;
    }
    let changed = false;
    if (this.batchLeft === 0 && this.staged.length) {
      for (const st of this.staged) this.applyBlock(st.k, st);
      this.staged.length = 0;
      changed = true;
    }
    let more = this.batchLeft > 0;
    if (!more) for (let k = 0; k < this.next.length; k++) if (this.next[k]) { more = true; break; }
    this.pending = more;
    return changed;
  }

  /** One block meshed and copied out of the mesher's own buffers, to put up later. */
  stageBlock(k) {
    const out = this.mesher.buildBlock(k);
    if (!out.indices) return { k, vertices: 0, indices: 0 };
    const V = out.vertices;
    const I = out.indices;
    return {
      k,
      vertices: V,
      indices: I,
      positions: out.positions.slice(0, 3 * V),
      normals: out.normals.slice(0, 3 * V),
      who: out.who.slice(0, V),
      index: out.index.slice(0, I),
    };
  }

  /** Make one block now, as sync would, and put it straight up. */
  buildBlock(k) {
    this.applyBlock(k, this.mesher.buildBlock(k));
  }

  applyBlock(k, out) {
    let mesh = this.blocks[k];
    if (!out.indices) {
      if (mesh) mesh.geometry.setDrawRange(0, 0);
      return;
    }
    const V = out.vertices;
    const I = out.indices;
    // A block keeps its buffers and is refilled in place while it fits;
    // only one that outgrows them gets new ones.
    if (!mesh || mesh.userData.vCap < V || mesh.userData.iCap < I) {
      if (mesh) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
      }
      const vCap = Math.ceil(V * 1.3) + 64;
      const iCap = Math.ceil(I * 1.3) + 192;
      const g = new THREE.BufferGeometry();
      const attr = (array, size, normalized) => {
        const a = new THREE.BufferAttribute(array, size, normalized);
        a.setUsage(THREE.DynamicDrawUsage);
        return a;
      };
      g.setAttribute('position', attr(new Float32Array(3 * vCap), 3, false));
      g.setAttribute('normal', attr(new Int8Array(3 * vCap), 3, true));
      g.setAttribute('aWho', attr(new Uint8Array(vCap), 1, false));
      g.setAttribute('aDev', attr(new Float32Array(vCap), 1, false));
      g.setAttribute('aDevOn', attr(new Uint8Array(vCap), 1, false));
      // A block holds fewer vertices than a 16-bit index can name.
      g.setIndex(attr(vCap < 65536 ? new Uint16Array(iCap) : new Uint32Array(iCap), 1, false));
      const [lo, hi] = this.mesher.blockBox(k);
      g.boundingBox = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      mesh = new THREE.Mesh(g, this.material);
      mesh.name = 'stock-block';
      mesh.frustumCulled = true;
      mesh.userData.vCap = vCap;
      mesh.userData.iCap = iCap;
      mesh.userData.block = k;
      this.blocks[k] = mesh;
      this.group.add(mesh);
    }
    const g = mesh.geometry;
    const pos = g.attributes.position;
    pos.array.set(out.positions.subarray(0, 3 * V));
    const nrm = g.attributes.normal;
    const na = nrm.array;
    const src = out.normals;
    for (let q = 0; q < 3 * V; q++) na[q] = Math.round(src[q] * 127);
    const who = g.attributes.aWho;
    who.array.set(out.who.subarray(0, V));
    const idx = g.index;
    idx.array.set(out.index.subarray(0, I));
    const dev = g.attributes.aDev;
    const devOn = g.attributes.aDevOn;
    this.measureBlock(out.positions, V, dev.array, devOn.array);
    for (const [a, n] of [[pos, 3 * V], [nrm, 3 * V], [who, V], [idx, I], [dev, V], [devOn, V]]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n);
      a.needsUpdate = true;
    }
    g.setDrawRange(0, I);
  }

  /**
   * Each vertex against the reference part, while the map is on: how far
   * and which way, or not judged. Off, nothing is measured — the map is
   * redone in full when it is turned on.
   */
  measureBlock(P, V, dev, on) {
    const d = this.dev;
    if (!d.mode || !d.target) {
      on.fill(0, 0, V);
      return;
    }
    const cap = this.devCap();
    for (let v = 0; v < V; v++) {
      const r = pointDeviation(d.target, P[3 * v], P[3 * v + 1], P[3 * v + 2], cap, d.tolerance);
      on[v] = r.state === DEV_JUDGED ? 1 : 0;
      dev[v] = r.deviation;
    }
  }

  /** How far the map looks for the part: twice the colour range, at least 1 mm. */
  devCap() { return Math.max(1, 2 * (this.dev.range || 0.5)); }

  /**
   * Switch the deviation map, or change what it measures against. What the
   * vertices hold is remade, block by block, whenever it would read
   * differently: turned on, a new reference, a wider range.
   */
  setDeviation({ mode, target, tolerance, range }) {
    const d = this.dev;
    const before = { ...d, cap: this.devCap() };
    d.mode = !!mode;
    d.target = target || null;
    d.tolerance = tolerance;
    d.range = range || 0.5;
    this.uniforms.uDevMode.value = d.mode && d.target ? 1 : 0;
    this.uniforms.uDevTol.value = d.tolerance;
    this.uniforms.uDevRange.value = d.range;
    if (d.mode && d.target && (!before.mode || before.target !== d.target || before.cap !== this.devCap() || before.tolerance !== d.tolerance)) {
      this.next.fill(1);
      this.pending = true;
    }
  }

  /** Triangles drawn right now, for the readout and the tests. */
  triangleCount() {
    let n = 0;
    for (const m of this.blocks) if (m) n += m.geometry.drawRange.count === Infinity ? 0 : m.geometry.drawRange.count / 3;
    return n;
  }

  /**
   * Cut the part open on a plane square to an axis: {axis, value, flip},
   * or null. A closed surface cut open shows its own inside, which is drawn
   * as the cut face — so both sides are drawn while there is a section, and
   * only the outside when there is not.
   */
  setSection(plane) {
    const n = [0, 0, 1];
    let d = 1e9;
    if (plane) {
      const sign = plane.flip ? -1 : 1;
      n[0] = n[1] = n[2] = 0;
      n[plane.axis] = sign;
      d = sign * plane.value;
    }
    this.uniforms.uSectionN.value.set(n[0], n[1], n[2]);
    this.uniforms.uSectionD.value = d;
    const side = plane ? THREE.DoubleSide : THREE.FrontSide;
    if (this.material.side !== side) {
      this.material.side = side;
      this.material.needsUpdate = true;
    }
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* gone already */ }
      this.worker = null;
    }
    for (const mesh of this.blocks) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.blocks = [];
    this.material.dispose();
  }
}
