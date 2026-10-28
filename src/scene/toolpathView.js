// Backplot: the programmed path drawn as coloured line segments.
//
// The whole program becomes one geometry with a per-vertex "position in
// the program" attribute, so showing progress, dimming what is still to
// come or isolating one tool is a uniform change rather than a rebuild.

import * as THREE from 'three';

const VERT = `
  attribute float aKind;
  attribute float aT;
  attribute float aTool;
  varying float vKind;
  varying float vT;
  varying float vTool;
  void main() {
    vKind = aKind;
    vT = aT;
    vTool = aTool;
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = `
  uniform vec3 uRapidColor;
  uniform vec3 uFeedColor;
  uniform vec3 uArcColor;
  uniform vec3 uDoneColor;
  uniform float uProgress;
  uniform float uMode;        // 0 all, 1 remaining only, 2 done only
  uniform float uShowRapids;
  uniform float uToolFilter;  // <0 = all
  uniform float uOpacity;
  varying float vKind;
  varying float vT;
  varying float vTool;
  void main() {
    if ( vKind < 0.5 && uShowRapids < 0.5 ) discard;
    if ( uToolFilter >= 0.0 && abs( vTool - uToolFilter ) > 0.5 ) discard;
    bool done = vT <= uProgress;
    if ( uMode > 1.5 && !done ) discard;
    if ( uMode > 0.5 && uMode < 1.5 && done ) discard;
    vec3 c = vKind < 0.5 ? uRapidColor : ( vKind > 1.5 ? uArcColor : uFeedColor );
    float a = uOpacity;
    if ( done && uMode < 0.5 ) { c = mix( c, uDoneColor, 0.75 ); a *= 0.55; }
    gl_FragColor = vec4( c, a );
    #include <colorspace_fragment>
  }
`;

export class ToolpathView {
  constructor() {
    /**
     * Moves made without TCP: their X Y Z are the slides, so they hang in
     * the frame the slides place and stay put while a rotary turns the part.
     */
    this.group = new THREE.Group();
    this.group.name = 'toolpath';
    /** Moves under TRAORI or a swivelled plane: points on the part, riding it. */
    this.followGroup = new THREE.Group();
    this.followGroup.name = 'toolpath-on-part';
    this.lines = null;
    this.followLines = null;
    this.uniforms = {
      uRapidColor: { value: new THREE.Color('#e8890b') },
      uFeedColor: { value: new THREE.Color('#0a84ff') },
      uArcColor: { value: new THREE.Color('#5e5ce6') },
      uDoneColor: { value: new THREE.Color('#b3b8c2') },
      uProgress: { value: 0 },
      uMode: { value: 0 },
      uShowRapids: { value: 1 },
      uToolFilter: { value: -1 },
      uOpacity: { value: 0.95 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.marker = null;
    this.buildMarker();
  }

  buildMarker() {
    const g = new THREE.SphereGeometry(1, 16, 12);
    const m = new THREE.MeshBasicMaterial({ color: 0xff9f0a, depthTest: false, transparent: true, opacity: 0.95 });
    this.marker = new THREE.Mesh(g, m);
    this.marker.renderOrder = 950;
    this.marker.visible = false;
    this.group.add(this.marker);
  }

  /**
   * @param {ReturnType<import('../gcode/interpreter.js').interpret>} program
   * @param {{maxVertices?:number}} [opts]
   */
  setProgram(program, opts = {}) {
    this.clear();
    if (!program || !program.moves.length) return;

    const maxVertices = opts.maxVertices || 4_000_000;
    let vertexCount = 0;
    for (const mv of program.moves) vertexCount += Math.max(0, (mv.path.length / 3 - 1) * 2);
    // Very long programs get their arcs decimated rather than dropped.
    const stride = Math.max(1, Math.ceil(vertexCount / maxVertices));

    // One set of segments for each frame; see the two groups.
    const sets = [0, 1].map(() => ({ pos: [], kind: [], tval: [], tool: [] }));
    const total = program.stats.cycleTime || program.moves.length;
    let acc = 0;

    // The backplot is where the tool was sent, in the coordinates it was
    // sent in — it hangs in the work frame, which stays still when the
    // part indexes underneath it.
    for (const mv of program.moves) {
      const k = mv.kind === 'rapid' ? 0 : mv.kind === 'arc' ? 2 : 1;
      const p = mv.path;
      const segCount = p.length / 3 - 1;
      if (segCount < 1) { acc += mv.time; continue; }
      const step = mv.kind === 'arc' ? stride : 1;
      const set = sets[mv.tcp ? 1 : 0];
      // A tool by name draws as a number; the filter compares numbers.
      const toolNo = typeof mv.tool === 'number' ? mv.tool : 0;
      for (let i = 0; i < segCount; i += step) {
        const j = Math.min(i + step, segCount);
        const t = (acc + mv.time * (j / segCount)) / (total || 1);
        set.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
        set.kind.push(k, k);
        set.tval.push(t, t);
        set.tool.push(toolNo, toolNo);
      }
      acc += mv.time;
    }

    const make = (set, name) => {
      if (!set.pos.length) return null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(set.pos, 3));
      geometry.setAttribute('aKind', new THREE.Float32BufferAttribute(set.kind, 1));
      geometry.setAttribute('aT', new THREE.Float32BufferAttribute(set.tval, 1));
      geometry.setAttribute('aTool', new THREE.Float32BufferAttribute(set.tool, 1));
      geometry.computeBoundingSphere();
      const lines = new THREE.LineSegments(geometry, this.material);
      lines.name = name;
      lines.frustumCulled = false;
      lines.visible = this.visible !== false;
      return lines;
    };
    this.lines = make(sets[0], 'backplot');
    this.followLines = make(sets[1], 'backplot-on-part');
    if (this.lines) this.group.add(this.lines);
    if (this.followLines) this.followGroup.add(this.followLines);
    this.segments = (sets[0].pos.length + sets[1].pos.length) / 6;
  }

  setProgress(p) { this.uniforms.uProgress.value = p; }
  setMode(mode) { this.uniforms.uMode.value = mode === 'remaining' ? 1 : mode === 'done' ? 2 : 0; }
  setShowRapids(v) { this.uniforms.uShowRapids.value = v ? 1 : 0; }
  setToolFilter(n) { this.uniforms.uToolFilter.value = n === null || n === undefined ? -1 : n; }
  setOpacity(v) { this.uniforms.uOpacity.value = v; }
  setVisible(v) {
    this.visible = v;
    if (this.lines) this.lines.visible = v;
    if (this.followLines) this.followLines.visible = v;
  }

  /** @param {boolean} [onPart] the move under it was made with TCP */
  setMarker(x, y, z, radius, onPart = false) {
    const home = onPart ? this.followGroup : this.group;
    if (this.marker.parent !== home) home.add(this.marker);
    this.marker.visible = true;
    this.marker.position.set(x, y, z);
    const s = Math.max(radius || 1, 0.6);
    this.marker.scale.setScalar(s);
  }

  hideMarker() { this.marker.visible = false; }

  boundingBox() {
    const box = new THREE.Box3();
    for (const l of [this.lines, this.followLines]) {
      if (!l) continue;
      l.geometry.computeBoundingBox();
      box.union(l.geometry.boundingBox);
    }
    return box;
  }

  clear() {
    for (const [l, g] of [[this.lines, this.group], [this.followLines, this.followGroup]]) {
      if (!l) continue;
      l.geometry.dispose();
      g.remove(l);
    }
    this.lines = null;
    this.followLines = null;
  }

  dispose() {
    this.clear();
    this.material.dispose();
    this.marker.geometry.dispose();
    this.marker.material.dispose();
  }
}
