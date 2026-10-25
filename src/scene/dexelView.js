// Drawing a tri-dexel stock: the closed surface of what is left.
//
// The mesh comes from the stretches a block at a time (see
// sim/dexelMesh.js), and a cut remakes only the blocks it went through.
// It is shaded as the heightmap's surface is — the same steel, the same
// tool colours — and because it is closed, a section through it shows
// the inside of the part: the faces seen from behind are drawn as the cut
// face, flat and level, in their own colour.

import * as THREE from 'three';
import { DexelMesher } from '../sim/dexelMesh.js';

const MAX_TOOL_COLORS = 8;
/**
 * Triangles the whole view may hold before the lattice is thinned for
 * display. A phone has a quarter of a desktop's room for them.
 */
const TRI_BUDGET = coarsePointer() ? 600000 : 2400000;
/**
 * Milliseconds a frame may spend remaking blocks while the run plays. The
 * rest wait for the next frame: the picture trails the cut by a frame or
 * two instead of the run stuttering to keep it exact.
 */
const FRAME_BUDGET = 4;
/** What a full redraw may take at once; the rest follow on idle frames. */
const FORCE_BUDGET = 150;

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
      uSectionZ: { value: 1e9 },
      uCapColor: { value: colors.capColor || new THREE.Color('#c4705a') },
    };
    this.material = this.buildMaterial();
    this.blocks = new Array(this.mesher.blockCount).fill(null);
    this.dirty = new Uint8Array(this.mesher.blockCount).fill(1);
    this.pending = true;
    stock.takeDirty3();
    this.sync(false, FORCE_BUDGET);
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
          flat varying float vWho;
          varying float vWorkZ;
          varying vec3 vCapNormal;
        `)
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          vWho = aWho;
          vWorkZ = position.z;
          // Straight up in the stock's own frame: the section's cut face.
          vCapNormal = normalize( normalMatrix * vec3( 0.0, 0.0, 1.0 ) );
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `
          #include <common>
          uniform vec3 uStockColor;
          uniform vec3 uCutColor;
          uniform vec3 uToolColors[ ${MAX_TOOL_COLORS} ];
          uniform float uShowTools;
          uniform float uSectionZ;
          uniform vec3 uCapColor;
          flat varying float vWho;
          varying float vWorkZ;
          varying vec3 vCapNormal;
        `)
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          if ( vWorkZ > uSectionZ ) discard;
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
   * Remake the blocks the cutter changed since the last look, for no more
   * than `budget` milliseconds; whatever is left is still waiting, and
   * `pending` says so.
   */
  sync(force = false, budget) {
    if (!(budget >= 0)) budget = force ? FORCE_BUDGET : FRAME_BUDGET;
    const m = this.mesher;
    if (force) {
      this.dirty.fill(1);
      this.stock.takeDirty3();
    } else {
      const box = this.stock.takeDirty3();
      if (box) {
        const [bx0, by0, bz0, bx1, by1, bz1] = m.blocksFor(box);
        for (let bz = bz0; bz <= bz1; bz++) {
          for (let by = by0; by <= by1; by++) {
            for (let bx = bx0; bx <= bx1; bx++) this.dirty[m.blockIndex(bx, by, bz)] = 1;
          }
        }
      }
    }
    const t0 = performance.now();
    let changed = false;
    let left = false;
    for (let k = 0; k < this.dirty.length; k++) {
      if (!this.dirty[k]) continue;
      if (changed && performance.now() - t0 > budget) { left = true; break; }
      this.dirty[k] = 0;
      this.buildBlock(k);
      changed = true;
    }
    this.pending = left;
    return changed;
  }

  buildBlock(k) {
    const out = this.mesher.buildBlock(k);
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
    for (const [a, n] of [[pos, 3 * V], [nrm, 3 * V], [who, V], [idx, I]]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n);
      a.needsUpdate = true;
    }
    g.setDrawRange(0, I);
  }

  /** Triangles drawn right now, for the readout and the tests. */
  triangleCount() {
    let n = 0;
    for (const m of this.blocks) if (m) n += m.geometry.drawRange.count === Infinity ? 0 : m.geometry.drawRange.count / 3;
    return n;
  }

  /**
   * Clip everything above `z`. A closed surface cut open shows its own
   * inside, which is drawn as the cut face — so both sides are drawn while
   * there is a section, and only the outside when there is not.
   */
  setSection(z) {
    this.uniforms.uSectionZ.value = z === null ? 1e9 : z;
    const side = z === null ? THREE.FrontSide : THREE.DoubleSide;
    if (this.material.side !== side) {
      this.material.side = side;
      this.material.needsUpdate = true;
    }
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    for (const mesh of this.blocks) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.blocks = [];
    this.material.dispose();
  }
}
