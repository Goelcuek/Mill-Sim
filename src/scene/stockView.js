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
    // Machined faces read as freshly cut metal; the hue only shifts enough
    // to tell one tool's work from another's.
    this.toolColors = [
      new THREE.Color('#b8c4d4'), new THREE.Color('#a9c6c0'), new THREE.Color('#c8bda4'),
      new THREE.Color('#b6aecb'), new THREE.Color('#a6bcd6'), new THREE.Color('#d2b3ad'),
      new THREE.Color('#aecaa6'), new THREE.Color('#cfc6a6'),
    ];
    this.uniforms = null;
    this.renderStep = 1;
  }

  /** Attach to a Stock, rebuilding all GPU resources. */
  setStock(stock, opts = {}) {
    this.dispose();
    this.stock = stock;
    if (!stock) return;

    // Keep the display mesh within a sane vertex budget even when the
    // simulation grid is very fine.
    const budget = opts.vertexBudget || 1_400_000;
    this.renderStep = Math.max(1, Math.ceil(Math.sqrt((stock.nx * stock.ny) / budget)));

    this.data = new Float32Array(stock.nx * stock.ny * 2);
    this.texture = new THREE.DataTexture(this.data, stock.nx, stock.ny, THREE.RGFormat, THREE.FloatType);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    const geometry = this.buildGeometry(stock, this.renderStep);
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
    const uvX = xs.map((i) => (i + 0.5) / nx);
    const uvY = ys.map((j) => (j + 0.5) / ny);

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
      roughness: 0.42,
      metalness: 0.62,
      side: THREE.FrontSide,
    });

    const uniforms = {
      uHeight: { value: this.texture },
      uTexel: { value: new THREE.Vector2(1 / stock.nx, 1 / stock.ny) },
      uStep: { value: new THREE.Vector2(stock.dx, stock.dy) },
      uBase: { value: stock.base },
      uStockColor: { value: new THREE.Color('#6b7688') },
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
          attribute float aMode;
          varying float vCut;
          varying float vWorldZ;
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
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3( tangent.xyz );
          #endif
        `)
        .replace('#include <begin_vertex>', `
          vec2 hs = texture2D( uHeight, uv ).rg;
          vCut = hs.g;
          vec3 transformed = vec3( position );
          if ( aMode > 0.5 ) transformed.z = hs.r - uBase;
          vWorldZ = transformed.z + uBase;
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `
          #include <common>
          uniform vec3 uStockColor;
          uniform vec3 uToolColors[ ${MAX_TOOL_COLORS} ];
          uniform float uShowTools;
          uniform float uSectionZ;
          varying float vCut;
          varying float vWorldZ;
        `)
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          if ( vWorldZ > uSectionZ ) discard;
          vec3 surface = uStockColor;
          if ( vCut > 0.5 ) {
            int ti = int( clamp( vCut - 1.0, 0.0, ${MAX_TOOL_COLORS - 1}.0 ) );
            vec3 machined = uToolColors[ 0 ];
            for ( int k = 0; k < ${MAX_TOOL_COLORS}; k ++ ) {
              if ( k == ti ) machined = uToolColors[ k ];
            }
            surface = mix( uToolColors[ 0 ], machined, uShowTools );
          }
          diffuseColor.rgb *= surface;
        `);

      this.shader = shader;
    };
    material.customProgramCacheKey = () => 'millsim-stock';
    return material;
  }

  /** Copy the heightmap into the texture. */
  sync(force = false) {
    const stock = this.stock;
    if (!stock || !this.data) return false;
    if (!force && stock.version === this.lastVersion) return false;
    this.lastVersion = stock.version;

    const h = stock.height;
    const c = stock.cutBy;
    const d = this.data;
    for (let k = 0, o = 0; k < h.length; k++, o += 2) {
      d[o] = h[k];
      d[o + 1] = c[k];
    }
    this.texture.needsUpdate = true;
    stock.clearDirty();
    return true;
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
    this.data = null;
    this.lastVersion = -1;
    this.shader = null;
    this.uniforms = null;
  }
}
