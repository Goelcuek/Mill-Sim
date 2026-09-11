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

/**
 * Build a procedural studio environment map.
 *
 * Cutters and holders are metal, and metal with nothing to reflect renders
 * as a black shape with a couple of specular dots. Rather than pull in an
 * HDR file, this builds a small equirectangular gradient — bright sky, mid
 * horizon, dark floor, with a soft overhead band — and pre-filters it,
 * which is enough to make machined surfaces read as machined surfaces.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @returns {THREE.Texture} a PMREM texture to assign to `scene.environment`
 */
export function makeStudioEnvironment(renderer) {
  const W = 64;
  const H = 32;
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);              // 0 at the top of the sphere
    const sky = 1 - v;
    const band = Math.exp(-((v - 0.22) ** 2) / 0.006) * 1.5;
    const base = 0.34 + sky * sky * 0.72 + band;
    const warm = 1 + band * 0.06;
    for (let x = 0; x < W; x++) {
      // A little azimuthal variation stops flat faces looking uniform.
      const sweep = 1 + 0.18 * Math.cos((x / W) * Math.PI * 2);
      const o = (y * W + x) * 4;
      data[o] = base * sweep * warm;
      data[o + 1] = base * sweep;
      data[o + 2] = base * sweep * 1.08;
      data[o + 3] = 1;
    }
  }

  const equirect = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  equirect.colorSpace = THREE.LinearSRGBColorSpace;
  equirect.minFilter = THREE.LinearFilter;
  equirect.magFilter = THREE.LinearFilter;
  equirect.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const texture = pmrem.fromEquirectangular(equirect).texture;
  pmrem.dispose();
  equirect.dispose();
  return texture;
}

export class Viewer {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;

    // alpha:true lets the CSS backdrop behind the canvas show through, so
    // the studio gradient is one line of CSS instead of a skybox mesh.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
    this.renderer.domElement.style.display = 'block';
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.scene.fog = new THREE.Fog(0xdfe3ea, 2200, 5200);

    // A 1 mm near plane against a 8 km far plane spends almost all of the
    // depth buffer on the first few centimetres, which is what makes two
    // touching castings flicker against each other. Nothing is ever this
    // close to the camera anyway — the orbit controls stop at 5.
    this.camera = new THREE.PerspectiveCamera(42, 1, 4, 6000);
    this.camera.position.set(240, -300, 220);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // No damping: the viewport should track the pointer exactly and stop
    // dead when it does. Inertia looks smooth in a demo and gets in the way
    // when you are lining up on a corner.
    this.controls.enableDamping = false;
    this.controls.maxDistance = 4000;
    this.controls.minDistance = 5;
    // Orbiting is the one thing that changes the picture without anything
    // in the app changing, so it asks for the redraw itself.
    this.controls.addEventListener('change', () => this.invalidate());

    this.buildEnvironment();
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

  buildEnvironment() {
    this.environment = makeStudioEnvironment(this.renderer);
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.45;
  }

  buildLights() {
    // The environment map carries most of the ambient, so the lights are
    // here for shape and highlights rather than raw brightness.
    //
    // This is deliberately dimmer than it was. With a bright environment,
    // a strong key and filmic tone mapping, every mid-grey facing the
    // camera clipped to white — a painted machine casting came out the same
    // colour as the background behind it, which is no colour at all. Lit
    // this way a material renders roughly as the colour it was given.
    const hemi = new THREE.HemisphereLight(0xffffff, 0xb9c0cc, 0.55);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(300, -420, 620);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xdfe8f5, 0.45);
    fill.position.set(-420, 260, 240);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xfff0d8, 0.32);
    rim.position.set(120, 520, -180);
    this.scene.add(rim);

    this.lights = { hemi, key, fill, rim };
  }

  buildGround() {
    this.helpers = new THREE.Group();
    this.helpers.name = 'helpers';

    this.scene.add(this.helpers);
    this.gridSpan = 1000;
    this.helpers.add(this.makeGrid(this.gridSpan));
    this.helpers.add(this.makeAxes());
  }

  /**
   * Hang the grid and the origin axes off a frame.
   *
   * They mark the *work* origin, so on a machine whose table moves they
   * belong to the table, not to the floor. Left in the scene they sat at a
   * fixed height and sliced through the castings.
   */
  setHelperFrame(object) {
    (object || this.scene).add(this.helpers);
    this.invalidate();
  }

  /**
   * Size the reference grid to the job.
   *
   * A fixed metre square is either lost under a big fixture or spread far
   * past a small part and over the machine behind it. Sized to the work it
   * reads as what it is — a scale next to the part.
   *
   * @param {number} span the work area's largest dimension, mm
   */
  setGridExtent(span) {
    const size = Math.max(100, Math.min(Math.ceil((span * 1.8) / 50) * 50, 2000));
    if (size === this.gridSpan) return;
    this.gridSpan = size;
    if (this.grid) {
      this.grid.geometry.dispose();
      this.helpers.remove(this.grid);
    }
    this.helpers.add(this.makeGrid(size));
    if (this.background) this.setBackground(this.background);
    this.invalidate();
  }

  makeGrid(span = 1000) {
    const step = span > 900 ? 50 : span > 400 ? 20 : 10;
    const grid = new THREE.GridHelper(span, Math.max(4, Math.round(span / step)), 0xa8b0be, 0xd2d7e0);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.6;
    // A transparent material still writes depth unless told not to, and a
    // grid that writes depth erases whatever is behind it — which is how a
    // reference plane ends up looking like a rendering fault across the
    // middle of the machine.
    grid.material.depthWrite = false;
    grid.renderOrder = -1;
    if (this.gridVisible === false) grid.visible = false;
    this.grid = grid;
    return grid;
  }

  /**
   * Paint the backdrop.
   *
   * The canvas is transparent and the backdrop is CSS, which keeps a
   * gradient to one line instead of a skybox. Two things have to follow it:
   * the distance fog, which otherwise fades the far end of a dark scene
   * into a pale haze, and the grid, which is drawn in dark lines that
   * disappear the moment the ground behind them goes dark.
   *
   * @param {{css:string, haze:number, dark:boolean}} spec
   */
  setBackground(spec) {
    if (!spec) return;
    this.background = spec;
    this.container.style.background = spec.css;
    if (this.scene.fog) this.scene.fog.color.setHex(spec.haze);
    if (this.grid) {
      // Light lines on a dark ground, dark lines on a light one.
      const major = spec.dark ? 0xf2f5fa : 0xa8b0be;
      const minor = spec.dark ? 0x9aa3b2 : 0xd2d7e0;
      const g = this.grid.geometry.getAttribute('color');
      if (g) {
        const a = new THREE.Color(major);
        const bb = new THREE.Color(minor);
        // GridHelper colours the first four vertices with the centre lines.
        for (let i = 0; i < g.count; i++) {
          const c = i < 4 ? a : bb;
          g.setXYZ(i, c.r, c.g, c.b);
        }
        g.needsUpdate = true;
      }
      this.grid.material.opacity = spec.dark ? 0.32 : 0.6;
    }
    this.invalidate();
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
    group.add(mk([1, 0, 0], 0xff453a));
    group.add(mk([0, 1, 0], 0x32d74b));
    group.add(mk([0, 0, 1], 0x0a84ff));
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

  /**
   * The frame loop draws on demand.
   *
   * A machining simulator is static most of the time — the program is not
   * running, nobody is dragging the view, and the picture on screen is the
   * same picture it was a second ago. Redrawing it sixty times a second
   * anyway costs a whole core, which a desktop absorbs and a laptop turns
   * into fan noise and a hot palm rest. So the renderer runs only when
   * something has said it needs to: `invalidate()` from any change, the
   * orbit controls while they are moving, or the simulator while it cuts.
   */
  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(loop);
      const dt = this.clock.getDelta();
      for (const fn of this.callbacks) fn(dt, this.needsRender);
      if (this.controls.enableDamping && this.controls.update()) this.needsRender = true;
      if (!this.needsRender) return;
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
      this.frames = (this.frames || 0) + 1;
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

    // Distance fog has to follow the scene. Fixed at a couple of metres it
    // is invisible on a small part and, on a bridge machine four metres
    // across, fades the whole machine into the backdrop.
    if (this.scene.fog) {
      this.scene.fog.near = Math.max(dist * 1.5, 400);
      this.scene.fog.far = Math.max(dist * 4.5, 2000);
    }

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

  setGridVisible(v) { this.gridVisible = v; if (this.grid) this.grid.visible = v; this.invalidate(); }
  setAxesVisible(v) { if (this.axes) this.axes.visible = v; this.invalidate(); }

  screenshot(type = 'image/png') {
    // The canvas is transparent so the CSS backdrop shows through; paint
    // that backdrop in before exporting or the PNG comes out with a hole.
    const prev = this.scene.background;
    this.scene.background = new THREE.Color((this.background && this.background.haze) || 0xdfe3ea);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL(type);
    this.scene.background = prev;
    this.renderer.render(this.scene, this.camera);
    return url;
  }

  dispose() {
    this.stop();
    if (this.environment) this.environment.dispose();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  }
}
