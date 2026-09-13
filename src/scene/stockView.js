// Rendering the stock.
//
// The heightmap lives in a float texture and the mesh is a flat grid that
// the vertex shader lifts to the current surface. That means cutting costs
// one texture upload per frame instead of rebuilding a million-triangle
// mesh, and surface normals come out of the same texture so machined faces
// shade correctly the instant they change.
//
// The mesh is one geometry: the top grid, a skirt down each side, and a
// bottom face. A per-vertex `aMode` attribute says how each vertex should
// behave — 0 fixed, 1 follow the heightmap, 2 follow it and derive the
// normal from its slope.
//
// Display resolution is deliberately decoupled from simulation resolution.
// A 0.025 mm grid is twelve million columns; no screen shows that and no
// GPU wants a 98 MB texture upload per frame. The view keeps a reduced grid
// sized to a vertex budget, each display texel taking the *lowest* column in
// its block so a cut is never hidden, and only the rectangle the cutter
// actually touched is uploaded each frame.

import * as THREE from 'three';

const MAX_TOOL_COLORS = 8;

export class StockView {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'stock';
    this.mesh = null;
    this.texture = null;
    this.data = null;
    this.stock = null;
    this.lastVersion = -1;
    /**
     * One colour per cutter, for the question this answers: which tool left
     * this face?
     *
     * That question is only answered if the colours can be told apart at a
     * glance, on a shaded surface, next to raw stock — so these are eight
     * hues spread right round the wheel at a similar lightness, rather than
     * eight shades of the same steel. Blue against orange, green against
     * purple: pairs that stay distinct for the commonest colour blindness
     * too, and none of them close to the raw stock grey.
     */
    this.toolColors = [
      new THREE.Color('#5b9bd5'), new THREE.Color('#e8933f'), new THREE.Color('#45ab84'),
      new THREE.Color('#a06cc8'), new THREE.Color('#dcbb46'), new THREE.Color('#d96b63'),
      new THREE.Color('#4cb9c9'), new THREE.Color('#93a844'),
    ];
    /** What a machined face looks like when the tool is not being named. */
    this.cutColor = new THREE.Color('#d5dde8');
    this.uniforms = null;
    this.renderStep = 1;
    this.renderer = null;
    this.uploadedOnce = false;
    this.copyBox = new THREE.Box2(new THREE.Vector2(), new THREE.Vector2());
    this.copyPos = new THREE.Vector2();
  }

  /** Attach to a Stock, rebuilding all GPU resources. */
  setStock(stock, opts = {}) {
    this.dispose();
    this.stock = stock;
    this.renderer = opts.renderer || this.renderer;
    if (!stock) return;

    // One reduction factor drives both the mesh and the texture: sampling
    // the heightmap finer than the mesh that displaces it buys nothing.
    const budget = opts.vertexBudget || 1_400_000;
    this.renderStep = Math.max(1, Math.ceil(Math.sqrt((stock.nx * stock.ny) / budget)));

    const geometry = this.buildGeometry(stock, this.renderStep);
    const gw = this.gridSize[0];
    const gh = this.gridSize[1];

    // Two texture objects over one array: the source describes the CPU-side
    // pixels for partial uploads, the destination is what the material samples.
    this.data = new Float32Array(gw * gh * 2);
    this.srcTexture = new THREE.DataTexture(this.data, gw, gh, THREE.RGFormat, THREE.FloatType);
    this.srcTexture.needsUpdate = true;
    this.texture = new THREE.DataTexture(this.data, gw, gh, THREE.RGFormat, THREE.FloatType);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    const material = this.buildMaterial(stock);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'stock-mesh';
    this.mesh.position.set(stock.origin[0], stock.origin[1], stock.base);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    this.sync(true);
  }

  buildGeometry(stock, step) {
    const nx = stock.nx;
    const ny = stock.ny;

    const xs = [];
    for (let i = 0; i < nx; i += step) xs.push(i);
    if (xs[xs.length - 1] !== nx - 1) xs.push(nx - 1);
    const ys = [];
    for (let j = 0; j < ny; j += step) ys.push(j);
    if (ys[ys.length - 1] !== ny - 1) ys.push(ny - 1);

    const gw = xs.length;
    const gh = ys.length;
    const sx = stock.size[0];
    const sy = stock.size[1];

    // Local positions: cell centres, with the outer ring pushed out to the
    // true stock boundary so the block keeps its nominal dimensions.
    const localX = xs.map((i, k) => (k === 0 ? 0 : k === gw - 1 ? sx : (i + 0.5) * stock.dx));
    const localY = ys.map((j, k) => (k === 0 ? 0 : k === gh - 1 ? sy : (j + 0.5) * stock.dy));
    // uv addresses the display grid, one texel per mesh column.
    const uvX = xs.map((_, k) => (k + 0.5) / gw);
    const uvY = ys.map((_, k) => (k + 0.5) / gh);
    this.srcX = xs;
    this.srcY = ys;

    const topCount = gw * gh;
    const skirtCount = (gw * 2 + gh * 2) * 2;
    const bottomCount = 4;
    const total = topCount + skirtCount + bottomCount;

    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const mode = new Float32Array(total);
    const indices = [];

    let v = 0;
    const put = (x, y, z, nrm, u, vv, md) => {
      position[v * 3] = x; position[v * 3 + 1] = y; position[v * 3 + 2] = z;
      normal[v * 3] = nrm[0]; normal[v * 3 + 1] = nrm[1]; normal[v * 3 + 2] = nrm[2];
      uv[v * 2] = u; uv[v * 2 + 1] = vv;
      mode[v] = md;
      return v++;
    };

    // Top surface.
    const up = [0, 0, 1];
    for (let gj = 0; gj < gh; gj++) {
      for (let gi = 0; gi < gw; gi++) put(localX[gi], localY[gj], 0, up, uvX[gi], uvY[gj], 2);
    }
    for (let gj = 0; gj < gh - 1; gj++) {
      for (let gi = 0; gi < gw - 1; gi++) {
        const a = gj * gw + gi;
        const b = a + 1;
        const c = a + gw + 1;
        const d = a + gw;
        indices.push(a, b, c, a, c, d);
      }
    }

    // Skirt: one strip per edge, top vertices follow the heightmap.
    const strip = (list, nrm, flip) => {
      const start = v;
      for (const s of list) {
        put(s.x, s.y, 0, nrm, s.u, s.v, 0);      // bottom
        put(s.x, s.y, 0, nrm, s.u, s.v, 1);      // top, driven by texture
      }
      for (let k = 0; k + 1 < list.length; k++) {
        const a = start + k * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        // Wound so the face normal points out of the block.
        if (flip) indices.push(a, b, d, a, d, c);
        else indices.push(a, c, d, a, d, b);
      }
    };

    strip(xs.map((_, gi) => ({ x: localX[gi], y: 0, u: uvX[gi], v: uvY[0] })), [0, -1, 0], false);
    strip(xs.map((_, gi) => ({ x: localX[gi], y: sy, u: uvX[gi], v: uvY[gh - 1] })), [0, 1, 0], true);
    strip(ys.map((_, gj) => ({ x: 0, y: localY[gj], u: uvX[0], v: uvY[gj] })), [-1, 0, 0], true);
    strip(ys.map((_, gj) => ({ x: sx, y: localY[gj], u: uvX[gw - 1], v: uvY[gj] })), [1, 0, 0], false);

    // Bottom face.
    const down = [0, 0, -1];
    const b0 = put(0, 0, 0, down, uvX[0], uvY[0], 0);
    const b1 = put(0, sy, 0, down, uvX[0], uvY[gh - 1], 0);
    const b2 = put(sx, sy, 0, down, uvX[gw - 1], uvY[gh - 1], 0);
    const b3 = put(sx, 0, 0, down, uvX[gw - 1], uvY[0], 0);
    indices.push(b0, b1, b2, b0, b2, b3);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('aMode', new THREE.BufferAttribute(mode, 1));
    geometry.setIndex(indices);
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(sx / 2, sy / 2, stock.size[2] / 2),
      Math.hypot(sx, sy, stock.size[2]) * 0.6,
    );
    this.gridSize = [gw, gh];
    return geometry;
  }

  buildMaterial(stock) {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.44,
      metalness: 0.45,
      side: THREE.FrontSide,
    });

    const uniforms = {
      uHeight: { value: this.texture },
      uTexel: { value: new THREE.Vector2(1 / this.gridSize[0], 1 / this.gridSize[1]) },
      uStep: { value: new THREE.Vector2(stock.dx * this.renderStep, stock.dy * this.renderStep) },
      uBase: { value: stock.base },
      /** Below this thickness a column is air, not metal. */
      uMinThick: { value: 1e-4 },
      uStockColor: { value: new THREE.Color('#8e97a6') },
      uCutColor: { value: this.cutColor },
      uToolColors: { value: this.toolColors.slice(0, MAX_TOOL_COLORS) },
      uShowTools: { value: 1 },
      uSectionZ: { value: 1e9 },
    };
    this.uniforms = uniforms;

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `
          #include <common>
          uniform sampler2D uHeight;
          uniform vec2 uTexel;
          uniform vec2 uStep;
          uniform float uBase;
          uniform float uMinThick;
          attribute float aMode;
          varying float vWorldZ;
          varying vec2 vGridUv;
          varying float vSolid;
          varying float vTop;
          varying float vSteep;
        `)
        .replace('#include <beginnormal_vertex>', `
          vec3 objectNormal = vec3( normal );
          if ( aMode > 1.5 ) {
            float hl = texture2D( uHeight, uv - vec2( uTexel.x, 0.0 ) ).r;
            float hr = texture2D( uHeight, uv + vec2( uTexel.x, 0.0 ) ).r;
            float hd = texture2D( uHeight, uv - vec2( 0.0, uTexel.y ) ).r;
            float hu = texture2D( uHeight, uv + vec2( 0.0, uTexel.y ) ).r;
            objectNormal = normalize( vec3(
              -( hr - hl ) / ( 2.0 * uStep.x ),
              -( hu - hd ) / ( 2.0 * uStep.y ),
              1.0 ) );
          }
          // How far this face has tipped off flat: 0 on a floor, 1 on a wall.
          vSteep = 1.0 - abs( objectNormal.z );
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3( tangent.xyz );
          #endif
        `)
        .replace('#include <begin_vertex>', `
          vec2 hs = texture2D( uHeight, uv ).rg;
          vGridUv = uv;
          // The machined surface, as opposed to the sides and bottom of the
          // block, which no tool has been near.
          vTop = aMode > 1.5 ? 1.0 : 0.0;
          // Whether this corner has metal under it. Interpolated, it is
          // non-zero anywhere on a triangle that touches material, which is
          // what keeps the wall of a round bar — a single quad stretched
          // from the last full column down to the empty one — solid.
          vSolid = ( hs.r - uBase > uMinThick ) ? 1.0 : 0.0;
          vec3 transformed = vec3( position );
          if ( aMode > 0.5 ) transformed.z = hs.r - uBase;
          vWorldZ = transformed.z + uBase;
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `
          #include <common>
          uniform sampler2D uHeight;
          uniform float uBase;
          uniform float uMinThick;
          uniform vec2 uTexel;
          uniform vec2 uStep;
          uniform vec3 uStockColor;
          uniform vec3 uCutColor;
          uniform vec3 uToolColors[ ${MAX_TOOL_COLORS} ];
          uniform float uShowTools;
          uniform float uSectionZ;
          varying float vWorldZ;
          varying vec2 vGridUv;
          varying float vSolid;
          varying float vTop;
          varying float vSteep;
        `)
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          if ( vWorldZ > uSectionZ ) discard;
          // Which column this pixel stands on, and which tool cut it. Read
          // here rather than at the corners: a cut number interpolated
          // between two columns is a tool that never ran — halfway between
          // the first tool and the third is the second — so the wall of a
          // pocket used to fade through colours nothing had cut.
          vec2 hs = texture2D( uHeight, vGridUv ).rg;
          // Nothing in this column and nothing on this triangle: outside a
          // round bar or a cast shape, or milled clean through. A flat film
          // across a through-pocket is a lie the eye believes, and the flat
          // sheet outside a bar is another.
          if ( hs.r - uBase <= uMinThick && vSolid < 1e-5 ) discard;

          float cutId = hs.g;
          // A wall belongs to the tool that took the metal away beside it,
          // not to whatever last touched the rim above. On a steep face the
          // cut is read from the lower of the neighbouring columns, which is
          // the floor the wall drops to — otherwise every pocket side and
          // every drilled hole reads as untouched stock.
          if ( vTop > 0.5 && vSteep > 0.3 ) {
            // A wall proper: the drop to the neighbour is longer than the
            // cell is wide. A face that merely slopes — the flank of a
            // pocket floor, the side of a dome — is its own tool's work and
            // keeps its own colour.
            float lowest = hs.r - max( uStep.x, uStep.y );
            vec2 n;
            n = texture2D( uHeight, vGridUv + vec2( uTexel.x, 0.0 ) ).rg;
            if ( n.r < lowest ) { lowest = n.r; cutId = n.g; }
            n = texture2D( uHeight, vGridUv - vec2( uTexel.x, 0.0 ) ).rg;
            if ( n.r < lowest ) { lowest = n.r; cutId = n.g; }
            n = texture2D( uHeight, vGridUv + vec2( 0.0, uTexel.y ) ).rg;
            if ( n.r < lowest ) { lowest = n.r; cutId = n.g; }
            n = texture2D( uHeight, vGridUv - vec2( 0.0, uTexel.y ) ).rg;
            if ( n.r < lowest ) { lowest = n.r; cutId = n.g; }
          }

          vec3 surface = uStockColor;
          if ( cutId > 0.5 && vTop > 0.5 ) {
            int ti = int( clamp( cutId - 1.0, 0.0, ${MAX_TOOL_COLORS - 1}.0 ) );
            vec3 machined = uToolColors[ 0 ];
            for ( int k = 0; k < ${MAX_TOOL_COLORS}; k ++ ) {
              if ( k == ti ) machined = uToolColors[ k ];
            }
            surface = mix( uCutColor, machined, uShowTools );
          }
          diffuseColor.rgb *= surface;
          float tinted = ( cutId > 0.5 && vTop > 0.5 ) ? uShowTools : 0.0;
        `)
        // Steel takes a tint badly: at this metalness most of what the eye
        // gets back is the light source rather than the surface, which is
        // right for raw stock and hides the very thing a coloured face is
        // there to say. So a face that is carrying a tool's colour is
        // rendered as a duller, less mirror-like metal.
        .replace('#include <metalnessmap_fragment>', `
          #include <metalnessmap_fragment>
          metalnessFactor *= mix( 1.0, 0.55, tinted );
          roughnessFactor = mix( roughnessFactor, 0.55, tinted );
        `);

      this.shader = shader;
    };
    material.customProgramCacheKey = () => 'millsim-stock';
    return material;
  }

  /**
   * Push whatever the cutter changed into the texture.
   *
   * Only the dirty rectangle is reduced and uploaded, so the per-frame cost
   * tracks the size of the cut rather than the size of the stock.
   */
  sync(force = false) {
    const stock = this.stock;
    if (!stock || !this.data) return false;
    if (!force && stock.version === this.lastVersion) return false;
    this.lastVersion = stock.version;

    const rect = force
      ? { i0: 0, j0: 0, i1: stock.nx - 1, j1: stock.ny - 1 }
      : stock.clearDirty();
    if (!rect) return false;
    if (force) stock.clearDirty();

    const step = this.renderStep;
    const [gw, gh] = this.gridSize;
    const xs = this.srcX;
    const ys = this.srcY;

    // Display cells whose source block overlaps the dirty rectangle.
    const gi0 = Math.max(0, this.gridIndexFor(xs, rect.i0) - 1);
    const gi1 = Math.min(gw - 1, this.gridIndexFor(xs, rect.i1) + 1);
    const gj0 = Math.max(0, this.gridIndexFor(ys, rect.j0) - 1);
    const gj1 = Math.min(gh - 1, this.gridIndexFor(ys, rect.j1) + 1);
    if (gi0 > gi1 || gj0 > gj1) return false;

    const h = stock.height;
    const c = stock.cutBy;
    const d = this.data;
    const nx = stock.nx;
    const ny = stock.ny;

    for (let gj = gj0; gj <= gj1; gj++) {
      const jStart = ys[gj];
      const jEnd = Math.min(gj + 1 < gh ? ys[gj + 1] : jStart + 1, ny);
      for (let gi = gi0; gi <= gi1; gi++) {
        const iStart = xs[gi];
        const iEnd = Math.min(gi + 1 < gw ? xs[gi + 1] : iStart + 1, nx);

        // Lowest column in the block: a cut is never averaged away.
        let lo = Infinity;
        let flag = 0;
        for (let j = jStart; j < jEnd; j++) {
          const row = j * nx;
          for (let i = iStart; i < iEnd; i++) {
            const v = h[row + i];
            if (v < lo) lo = v;
            const f = c[row + i];
            if (f > flag) flag = f;
          }
        }
        if (lo === Infinity) lo = h[Math.min(jStart, ny - 1) * nx + Math.min(iStart, nx - 1)];
        const o = (gj * gw + gi) * 2;
        d[o] = lo;
        d[o + 1] = flag;
      }
    }

    this.upload(gi0, gj0, gi1 - gi0 + 1, gj1 - gj0 + 1, force);
    return true;
  }

  /** Index of the display cell whose block contains source column `i`. */
  gridIndexFor(list, i) {
    const step = this.renderStep;
    const g = Math.floor(i / step);
    return Math.max(0, Math.min(list.length - 1, g));
  }

  /** Upload a sub-rectangle, falling back to a full refresh if unsupported. */
  upload(x, y, w, h, force) {
    if (force || !this.renderer || !this.uploadedOnce) {
      this.texture.needsUpdate = true;
      this.uploadedOnce = true;
      return;
    }
    try {
      this.copyBox.min.set(x, y, 0);
      this.copyBox.max.set(x + w, y + h, 1);
      this.copyPos.set(x, y);
      this.renderer.copyTextureToTexture(this.srcTexture, this.texture, this.copyBox, this.copyPos);
    } catch (err) {
      this.texture.needsUpdate = true;
    }
  }

  /** The shade a machined face takes when the tool is not being named. */
  setCutColor(hex) {
    if (this.uniforms) this.uniforms.uCutColor.value.set(hex);
  }

  setStockColor(hex) {
    if (this.uniforms) this.uniforms.uStockColor.value.set(hex);
  }

  setToolColor(index, hex) {
    if (index >= 0 && index < MAX_TOOL_COLORS) this.toolColors[index].set(hex);
  }

  /** Colour machined faces per tool, or use a single machined colour. */
  setShowToolColors(on) {
    if (this.uniforms) this.uniforms.uShowTools.value = on ? 1 : 0;
  }

  /** Clip everything above `z`, for looking inside a pocket. */
  setSection(z) {
    if (this.uniforms) this.uniforms.uSectionZ.value = z === null ? 1e9 : z;
  }

  setVisible(v) { this.group.visible = v; }

  boundingBox() {
    if (!this.stock) return new THREE.Box3();
    const s = this.stock;
    return new THREE.Box3(
      new THREE.Vector3(s.origin[0], s.origin[1], s.base),
      new THREE.Vector3(s.origin[0] + s.size[0], s.origin[1] + s.size[1], s.top),
    );
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.group.remove(this.mesh);
      this.mesh = null;
    }
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    if (this.srcTexture) {
      this.srcTexture.dispose();
      this.srcTexture = null;
    }
    this.uploadedOnce = false;
    this.data = null;
    this.lastVersion = -1;
    this.shader = null;
    this.uniforms = null;
  }
}
