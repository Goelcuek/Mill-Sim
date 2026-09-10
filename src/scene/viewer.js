// Viewport: renderer, camera, lighting and the standard view controls.
//
// The whole app works in machine convention — millimetres, Z up — so the
// three.js default up vector is changed once here and everything else can
// use machine coordinates directly.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export const VIEWS = {
  iso: [1, -1, 0.8],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

export class Viewer {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
    this.renderer.domElement.style.display = 'block';
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x151821);
    this.scene.fog = new THREE.Fog(0x151821, 1800, 4200);

    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 8000);
    this.camera.position.set(240, -300, 220);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 4000;
    this.controls.minDistance = 5;

    this.buildLights();
    this.buildGround();

    this.clock = new THREE.Clock();
    this.callbacks = [];
    this.running = false;
    this.needsRender = true;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  buildLights() {
    const hemi = new THREE.HemisphereLight(0xcfd9ea, 0x2a2f3a, 1.5);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(300, -420, 620);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9fb6d8, 0.85);
    fill.position.set(-420, 260, 240);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffd9a0, 0.5);
    rim.position.set(120, 520, -180);
    this.scene.add(rim);

    this.lights = { hemi, key, fill, rim };
  }

  buildGround() {
    this.helpers = new THREE.Group();
    this.helpers.name = 'helpers';

    this.scene.add(this.helpers);
    this.helpers.add(this.makeGrid());
    this.helpers.add(this.makeAxes());
  }

  makeGrid() {
    const grid = new THREE.GridHelper(1000, 50, 0x39445a, 0x232833);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    this.grid = grid;
    return grid;
  }

  makeAxes() {
    const group = new THREE.Group();
    const len = 60;
    const mk = (dir, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(dir[0] * len, dir[1] * len, dir[2] * len),
      ]);
      const m = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
      const line = new THREE.Line(g, m);
      line.renderOrder = 900;
      return line;
    };
    group.add(mk([1, 0, 0], 0xf2545b));
    group.add(mk([0, 1, 0], 0x7ad17a));
    group.add(mk([0, 0, 1], 0x5aa9f5));
    this.axes = group;
    return group;
  }

  add(object) { this.scene.add(object); this.invalidate(); }
  remove(object) { this.scene.remove(object); this.invalidate(); }

  invalidate() { this.needsRender = true; }

  onFrame(fn) { this.callbacks.push(fn); return () => { this.callbacks = this.callbacks.filter((f) => f !== fn); }; }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // The canvas is absolutely sized, so its CSS size has to track the
    // container or the layout below the viewport gets pushed off screen.
    this.renderer.setSize(w, h);
    this.invalidate();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(loop);
      const dt = this.clock.getDelta();
      for (const fn of this.callbacks) fn(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
  }

  /** Frame a bounding box. */
  fit(box, factor = 1.6) {
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 5);
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * factor * 0.5;

    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, -1, 0.8);
    dir.normalize().multiplyScalar(Math.max(dist, 20));

    this.controls.target.copy(centre);
    this.camera.position.copy(centre).add(dir);
    this.camera.near = Math.max(0.1, dist / 400);
    this.camera.far = dist * 20 + 2000;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  /** Snap to a named view, keeping the current target and distance. */
  setView(name) {
    const dir = VIEWS[name] || VIEWS.iso;
    const dist = this.camera.position.distanceTo(this.controls.target) || 300;
    const v = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize().multiplyScalar(dist);
    this.camera.position.copy(this.controls.target).add(v);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  setGridVisible(v) { if (this.grid) this.grid.visible = v; this.invalidate(); }
  setAxesVisible(v) { if (this.axes) this.axes.visible = v; this.invalidate(); }

  screenshot(type = 'image/png') {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL(type);
  }

  dispose() {
    this.stop();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  }
}
