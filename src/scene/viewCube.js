// The view cube: a small cube in the corner of the viewport that turns
// with the camera and, clicked, turns the camera to look from wherever was
// clicked.
//
// Its faces are the six machine views — TOP is +Z, FRONT is −Y, RIGHT is
// +X, as the named views have them — and its edges and corners are the
// views between: clicking near an edge looks along the diagonal between
// its two faces, near a corner from all three. Twenty-six ways to look,
// each one click.
//
// It is its own little canvas, so a click on it is a click on it and never
// the start of an orbit of the scene behind.

import * as THREE from 'three';

/** Cube CSS size, px. */
const SIZE = 104;
/** How far in from a face's edge counts as the edge rather than the face, of a half-side of 1. */
const EDGE = 0.62;

const FACES = [
  // BoxGeometry's material order: +X, −X, +Y, −Y, +Z, −Z. Its faces are
  // laid out for Y up; turned so each label reads upright with Z up.
  { label: 'RIGHT', turn: Math.PI / 2 },
  { label: 'LEFT', turn: -Math.PI / 2 },
  { label: 'BACK', turn: Math.PI },
  { label: 'FRONT', turn: 0 },
  { label: 'TOP', turn: 0 },
  { label: 'BOTTOM', turn: 0 },
];

function faceTexture(label, turn = 0) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#eef1f6';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#9aa3b2';
  g.lineWidth = 10;
  g.strokeRect(5, 5, 246, 246);
  g.fillStyle = '#3a4252';
  g.font = '600 50px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 128, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.center.set(0.5, 0.5);
  t.rotation = turn;
  return t;
}

export class ViewCube {
  /**
   * @param {import('./viewer.js').Viewer} viewer
   * @param {HTMLElement} host where the cube's canvas goes (the viewport)
   */
  constructor(viewer, host) {
    this.viewer = viewer;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(SIZE, SIZE);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = this.renderer.domElement;
    canvas.className = 'view-cube';
    canvas.title = 'Click a face, an edge or a corner to look from there';
    host.appendChild(canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);

    this.materials = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTexture(f.label, f.turn) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.materials);
    this.scene.add(this.cube);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x6b7586 }),
    );
    this.scene.add(edges);

    // What the pointer is over: a block sitting on the face, edge or corner.
    this.hot = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.45, depthTest: false }),
    );
    this.hot.renderOrder = 10;
    this.hot.visible = false;
    this.scene.add(this.hot);

    // The three machine axes off the near bottom corner, so which way is
    // +X is never a question.
    const axis = (dir, color) => {
      const a = new THREE.ArrowHelper(new THREE.Vector3(...dir), new THREE.Vector3(-1.25, -1.25, -1.25), 1.15, color, 0.3, 0.16);
      this.scene.add(a);
    };
    axis([1, 0, 0], 0xe5484d);
    axis([0, 1, 0], 0x30a46c);
    axis([0, 0, 1], 0x0a84ff);

    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hover = null;
    this.lastKey = '';

    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    canvas.addEventListener('pointerdown', (e) => e.stopPropagation());
    canvas.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = this.pick(e);
      if (d) this.viewer.lookFrom(d, { animate: true });
    });

    // It follows the main camera: redrawn whenever that has turned.
    viewer.onFrame(() => this.follow());
    this.follow(true);
  }

  /** The way to look from for the point under the pointer, or null. */
  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hit = this.ray.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    // Near a side of the face is that side's edge, near two its corner.
    const p = hit.point;
    const d = [p.x, p.y, p.z].map((v) => (Math.abs(v) > 0.999 ? Math.sign(v) : Math.abs(v) > EDGE ? Math.sign(v) : 0));
    return d.some(Boolean) ? d : null;
  }

  onMove(e) {
    this.setHover(this.pick(e));
  }

  setHover(d) {
    const key = d ? d.join(',') : '';
    if (key === (this.hover ? this.hover.join(',') : '')) return;
    this.hover = d;
    this.renderer.domElement.style.cursor = d ? 'pointer' : '';
    if (d) {
      // The region: the outer band of each side the direction leans to,
      // the middle of each it does not.
      const size = d.map((v) => (v ? 1 - EDGE + 0.04 : 2 * EDGE));
      const at = d.map((v) => (v ? v * (EDGE + (1 - EDGE) / 2 + 0.02) : 0));
      this.hot.scale.set(...size);
      this.hot.position.set(...at);
      this.hot.visible = true;
    } else {
      this.hot.visible = false;
    }
    this.render();
  }

  /** Turn with the main camera; drawn only when it has turned. */
  follow(force = false) {
    const cam = this.viewer.camera;
    const target = this.viewer.controls.target;
    const off = cam.position.clone().sub(target);
    if (off.lengthSq() < 1e-12) return;
    off.normalize();
    const key = `${off.x.toFixed(4)},${off.y.toFixed(4)},${off.z.toFixed(4)},${cam.up.x.toFixed(3)},${cam.up.y.toFixed(3)},${cam.up.z.toFixed(3)}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.camera.position.copy(off).multiplyScalar(6);
    this.camera.up.copy(cam.up);
    this.camera.lookAt(0, 0, 0);
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const m of this.materials) { if (m.map) m.map.dispose(); m.dispose(); }
    this.cube.geometry.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
