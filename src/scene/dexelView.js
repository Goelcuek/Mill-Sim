// Drawing a tri-dexel stock: the surface as the lines see it.
//
// Every place a line goes into the material or comes out of it is a point
// on the surface. Drawn as small shaded discs that overlap their neighbours
// they make the part, holes from the side and all — no mesh has to be
// built, and a cut only redraws the chunks of lines it changed.
//
// Each point's facing comes from its neighbours on the same family: the
// slope across the grid of where they meet the surface. Where a family
// meets the surface nearly edge on — a wall seen down the Z lines — its
// points are left out, because another family crosses that wall squarely
// and draws it properly. Every face is crossed within 54.7° of square by
// one of the three.

import * as THREE from 'three';

const MAX_TOOL_COLORS = 8;
/**
 * Display lines per chunk side; a chunk is one draw call. Small enough that
 * a cut redraws little more than the lines it touched, big enough that the
 * whole stock is a few hundred draws.
 */
const CHUNK = 32;
/**
 * Points the whole view may hold before lines are thinned for display. A
 * phone's GPU fills discs several times slower than a desktop's, so it
 * gets a quarter of them, drawn twice the size.
 */
const POINT_BUDGET = coarsePointer() ? 600000 : 2400000;
/**
 * Milliseconds a frame may spend redrawing chunks while the run plays. The
 * rest wait for the next frame: the picture trails the cut by a frame or
 * two instead of the run stuttering to keep it exact.
 */
const FRAME_BUDGET = 4;

function coarsePointer() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** Scratch for one chunk's points, grown as needed and reused. */
let SP = new Float32Array(3 * 8192);
let SN = new Float32Array(3 * 8192);
let SW = new Float32Array(8192);
function ensure(n) {
  if (SW.length >= n) return;
  const m = Math.max(n, SW.length * 2);
  const grow = (a, k) => { const b = new Float32Array(k * m); b.set(a); return b; };
  SP = grow(SP, 3);
  SN = grow(SN, 3);
  SW = grow(SW, 1);
}
/** A family seeing a face nearer edge-on than this leaves it to the others. */
const GRAZING = 0.3;

export class DexelCloud {
  /**
   * @param {import('../sim/triDexel.js').TriDexelStock} stock
   * @param {{stockColor:THREE.Color, cutColor:THREE.Color, toolColors:THREE.Color[]}} colors
   */
  constructor(stock, colors) {
    this.stock = stock;
    this.group = new THREE.Group();
    this.group.name = 'stock-dexels';
    // Thin the lines for display when there are more than the budget: every
    // step-th line in each direction, drawn bigger to close the gaps.
    const rays = stock.rayCount;
    this.step = Math.max(1, Math.ceil(Math.sqrt((2 * rays) / POINT_BUDGET)));
    const spacing = Math.max(...stock.d3) * this.step;
    this.uniforms = {
      uSize: { value: spacing * 2.0 },
      uScale: { value: 400 },
      uStockColor: { value: colors.stockColor },
      uCutColor: { value: colors.cutColor },
      uToolColors: { value: colors.toolColors.slice(0, MAX_TOOL_COLORS) },
      uShowTools: { value: 1 },
      uSectionZ: { value: 1e9 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        uniform float uSize;
        uniform float uScale;
        attribute vec3 aNormal;
        attribute float aWho;
        varying vec3 vNormal;
        varying float vWho;
        varying float vWorldZ;
        void main() {
          vec4 world = modelMatrix * vec4( position, 1.0 );
          vWorldZ = world.z;
          vec4 mv = viewMatrix * world;
          vNormal = normalize( mat3( viewMatrix ) * mat3( modelMatrix ) * aNormal );
          vWho = aWho;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max( 1.5, uSize * uScale / max( -mv.z, 1e-3 ) );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uStockColor;
        uniform vec3 uCutColor;
        uniform vec3 uToolColors[ ${MAX_TOOL_COLORS} ];
        uniform float uShowTools;
        uniform float uSectionZ;
        varying vec3 vNormal;
        varying float vWho;
        varying float vWorldZ;
        void main() {
          if ( vWorldZ > uSectionZ ) discard;
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          if ( dot( q, q ) > 1.0 ) discard;
          vec3 n = normalize( vNormal );
          // The surface is closed, so a point facing away is hidden behind
          // the front of the part — the underside seen through the gaps
          // between the top's discs, if it were drawn.
          if ( n.z < -0.15 ) discard;
          if ( n.z < 0.0 ) n = -n;
          vec3 base = uStockColor;
          if ( vWho > 0.5 ) {
            if ( uShowTools > 0.5 ) {
              // Rounded before the wrap: a 1 that arrives as 0.9999 would
              // otherwise wrap to the last slot and fall through to grey.
              int k = int( mod( floor( vWho + 0.5 ) - 1.0, ${MAX_TOOL_COLORS}.0 ) + 0.5 );
              for ( int i = 0; i < ${MAX_TOOL_COLORS}; i++ ) if ( i == k ) base = uToolColors[ i ];
            } else base = uCutColor;
          }
          vec3 l1 = normalize( vec3( 0.35, 0.55, 0.75 ) );
          vec3 l2 = normalize( vec3( -0.6, -0.2, 0.5 ) );
          float d = 0.32 + 0.58 * max( dot( n, l1 ), 0.0 ) + 0.22 * max( dot( n, l2 ), 0.0 );
          gl_FragColor = vec4( base * d, 1.0 );
        }
      `,
    });
    /** Per family: its chunks and which of them need drawing again. */
    this.chunks = stock.fam.map((F) => {
      const nb = Math.ceil(F.nb / this.step);
      const nc = Math.ceil(F.nc / this.step);
      const cb = Math.ceil(nb / CHUNK);
      const cc = Math.ceil(nc / CHUNK);
      return { cb, cc, list: new Array(cb * cc).fill(null), dirty: new Uint8Array(cb * cc).fill(1), seen: -1 };
    });
    this.sync(true);
  }

  /**
   * Redraw the chunks the cutter changed since the last look, for no more
   * than `budget` milliseconds; whatever is left is still waiting, and
   * `pending` says so.
   */
  sync(force = false, budget) {
    if (!(budget >= 0)) budget = force ? Infinity : FRAME_BUDGET;
    const stock = this.stock;
    for (let f = 0; f < 3; f++) {
      const F = stock.fam[f];
      const C = this.chunks[f];
      if (force) {
        C.dirty.fill(1);
        F.dirty = null;
      } else if (F.dirty) {
        // A line's points take their facing from its neighbours, so the
        // chunks either side of a change are redrawn with it.
        const span = CHUNK * this.step;
        const [i0, j0, i1, j1] = F.dirty;
        F.dirty = null;
        const ci0 = Math.max(0, Math.floor((i0 - this.step) / span));
        const ci1 = Math.min(C.cb - 1, Math.floor((i1 + this.step) / span));
        const cj0 = Math.max(0, Math.floor((j0 - this.step) / span));
        const cj1 = Math.min(C.cc - 1, Math.floor((j1 + this.step) / span));
        for (let cj = cj0; cj <= cj1; cj++) for (let ci = ci0; ci <= ci1; ci++) C.dirty[cj * C.cb + ci] = 1;
      }
    }
    const t0 = performance.now();
    let changed = false;
    let left = false;
    for (let f = 0; f < 3 && !left; f++) {
      const C = this.chunks[f];
      for (let k = 0; k < C.dirty.length; k++) {
        if (!C.dirty[k]) continue;
        if (changed && performance.now() - t0 > budget) { left = true; break; }
        C.dirty[k] = 0;
        this.buildChunk(f, k % C.cb, Math.floor(k / C.cb));
        changed = true;
      }
    }
    this.pending = left;
    return changed;
  }

  buildChunk(f, ci, cj) {
    const stock = this.stock;
    const F = stock.fam[f];
    const C = this.chunks[f];
    const k = cj * C.cb + ci;
    const step = this.step;
    const { a, b, c, db, dc } = F;
    const o3 = stock.o3;
    const i0 = ci * CHUNK * step;
    const i1 = Math.min(F.nb, i0 + CHUNK * step);
    const j0 = cj * CHUNK * step;
    const j1 = Math.min(F.nc, j0 + CHUNK * step);
    const tol = 4 * Math.max(db, dc) * step;
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    let m = 0;
    for (let j = j0; j < j1; j += step) {
      for (let i = i0; i < i1; i += step) {
        const r = j * F.nb + i;
        const cnt = F.cnt[r];
        if (!cnt) continue;
        const o = F.off[r];
        ensure(m + 2 * cnt);
        p[b] = o3[b] + (i + 0.5) * db;
        p[c] = o3[c] + (j + 0.5) * dc;
        for (let e = 0; e < 2 * cnt; e++) {
          const v = F.pool[o + e];
          const exit = e & 1;
          // The slope of the surface across the grid, from the neighbours.
          const gb = slope(F, i, j, step, 0, v, exit, tol) / (db * step);
          const gc = slope(F, i, j, step, 1, v, exit, tol) / (dc * step);
          const sgn = exit ? 1 : -1;
          n[a] = sgn;
          n[b] = -sgn * gb;
          n[c] = -sgn * gc;
          const len = Math.hypot(n[0], n[1], n[2]);
          if (Math.abs(n[a]) / len < GRAZING) continue;
          p[a] = o3[a] + v;
          SP[3 * m] = p[0]; SP[3 * m + 1] = p[1]; SP[3 * m + 2] = p[2];
          SN[3 * m] = n[0] / len; SN[3 * m + 1] = n[1] / len; SN[3 * m + 2] = n[2] / len;
          SW[m] = F.who[o + e];
          m++;
        }
      }
    }

    let pts = C.list[k];
    if (!m) {
      if (pts) pts.geometry.setDrawRange(0, 0);
      return;
    }
    // A chunk keeps its buffers and is refilled in place while its points
    // fit; only a chunk that outgrows them gets new ones. Reallocating and
    // re-sending every chunk a cut touched was most of a frame.
    if (!pts || pts.userData.capacity < m) {
      if (pts) {
        this.group.remove(pts);
        pts.geometry.dispose();
      }
      const capacity = Math.ceil(m * 1.3) + 256;
      const g = new THREE.BufferGeometry();
      for (const [name, size] of [['position', 3], ['aNormal', 3], ['aWho', 1]]) {
        const attr = new THREE.BufferAttribute(new Float32Array(capacity * size), size);
        attr.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute(name, attr);
      }
      // The chunk's own block of space, which no cut can take it out of.
      const lo = [0, 0, 0];
      const hi = [0, 0, 0];
      lo[a] = o3[a]; hi[a] = o3[a] + F.len;
      lo[b] = o3[b] + i0 * db; hi[b] = o3[b] + i1 * db;
      lo[c] = o3[c] + j0 * dc; hi[c] = o3[c] + j1 * dc;
      g.boundingBox = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      pts = new THREE.Points(g, this.material);
      pts.frustumCulled = true;
      // Discs are sized in millimetres, so the scale follows the camera.
      pts.onBeforeRender = (renderer, scene, camera) => {
        const hgt = renderer.getDrawingBufferSize(SIZE).y;
        this.uniforms.uScale.value = camera.isPerspectiveCamera
          ? hgt / (2 * Math.tan((camera.fov * Math.PI) / 360))
          : hgt / ((camera.top - camera.bottom) / camera.zoom);
      };
      pts.userData.family = f;
      pts.userData.capacity = capacity;
      C.list[k] = pts;
      this.group.add(pts);
    }
    const g = pts.geometry;
    const fill = (name, src, size) => {
      const attr = g.attributes[name];
      attr.array.set(src.subarray(0, m * size));
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, m * size);
      attr.needsUpdate = true;
    };
    fill('position', SP, 3);
    fill('aNormal', SN, 3);
    fill('aWho', SW, 1);
    g.setDrawRange(0, m);
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    for (const C of this.chunks) {
      for (const pts of C.list) {
        if (!pts) continue;
        this.group.remove(pts);
        pts.geometry.dispose();
      }
    }
    this.material.dispose();
  }
}

const SIZE = new THREE.Vector2();

/**
 * How far the surface moves from line (i, j) to its neighbours along one
 * grid direction, at the endpoint `v` of the given kind — central where
 * both neighbours have one nearby, one-sided where only one does.
 */
function slope(F, i, j, step, dir, v, exit, tol) {
  const plus = near(F, dir ? i : i + step, dir ? j + step : j, v, exit, tol);
  const minus = near(F, dir ? i : i - step, dir ? j - step : j, v, exit, tol);
  if (plus !== null && minus !== null) return (plus - minus) / 2;
  if (plus !== null) return plus - v;
  if (minus !== null) return v - minus;
  return 0;
}

/** The endpoint of the same kind on line (i, j) nearest v, or null. */
function near(F, i, j, v, exit, tol) {
  if (i < 0 || j < 0 || i >= F.nb || j >= F.nc) return null;
  const r = j * F.nb + i;
  const cnt = F.cnt[r];
  const o = F.off[r];
  let best = null;
  let bd = tol;
  for (let k = exit; k < 2 * cnt; k += 2) {
    const d = Math.abs(F.pool[o + k] - v);
    if (d <= bd) { bd = d; best = F.pool[o + k]; }
  }
  return best;
}
