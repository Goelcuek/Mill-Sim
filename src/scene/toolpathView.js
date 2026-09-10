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
    this.group = new THREE.Group();
    this.group.name = 'toolpath';
    this.lines = null;
    this.uniforms = {
      uRapidColor: { value: new THREE.Color('#e8913c') },
      uFeedColor: { value: new THREE.Color('#4fd1c5') },
      uArcColor: { value: new THREE.Color('#7aa2f7') },
      uDoneColor: { value: new THREE.Color('#3a4356') },
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
    const m = new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true, opacity: 0.9 });
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

    const pos = [];
    const kind = [];
    const tval = [];
    const tool = [];
    const total = program.stats.cycleTime || program.moves.length;
    let acc = 0;

    for (const mv of program.moves) {
      const k = mv.kind === 'rapid' ? 0 : mv.kind === 'arc' ? 2 : 1;
      const p = mv.path;
      const segCount = p.length / 3 - 1;
      if (segCount < 1) { acc += mv.time; continue; }
      const step = mv.kind === 'arc' ? stride : 1;
      for (let i = 0; i < segCount; i += step) {
        const j = Math.min(i + step, segCount);
        const t = (acc + mv.time * (j / segCount)) / (total || 1);
        pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
        kind.push(k, k);
        tval.push(t, t);
        tool.push(mv.tool, mv.tool);
      }
      acc += mv.time;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
    geometry.setAttribute('aT', new THREE.Float32BufferAttribute(tval, 1));
    geometry.setAttribute('aTool', new THREE.Float32BufferAttribute(tool, 1));
    geometry.computeBoundingSphere();

    this.lines = new THREE.LineSegments(geometry, this.material);
    this.lines.name = 'backplot';
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    this.segments = pos.length / 6;
  }

  setProgress(p) { this.uniforms.uProgress.value = p; }
  setMode(mode) { this.uniforms.uMode.value = mode === 'remaining' ? 1 : mode === 'done' ? 2 : 0; }
  setShowRapids(v) { this.uniforms.uShowRapids.value = v ? 1 : 0; }
  setToolFilter(n) { this.uniforms.uToolFilter.value = n === null || n === undefined ? -1 : n; }
  setOpacity(v) { this.uniforms.uOpacity.value = v; }
  setVisible(v) { if (this.lines) this.lines.visible = v; }

  setMarker(x, y, z, radius) {
    this.marker.visible = true;
    this.marker.position.set(x, y, z);
    const s = Math.max(radius || 1, 0.6);
    this.marker.scale.setScalar(s);
  }

  hideMarker() { this.marker.visible = false; }

  boundingBox() {
    if (!this.lines) return new THREE.Box3();
    this.lines.geometry.computeBoundingBox();
    return this.lines.geometry.boundingBox.clone();
  }

  clear() {
    if (this.lines) {
      this.lines.geometry.dispose();
      this.group.remove(this.lines);
      this.lines = null;
    }
  }

  dispose() {
    this.clear();
    this.material.dispose();
    this.marker.geometry.dispose();
    this.marker.material.dispose();
  }
}
