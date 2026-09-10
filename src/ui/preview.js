// The small turntable viewport in the tool editor.
//
// It runs its own renderer so the parametric editor can show the assembly
// being edited without disturbing the main scene, and it only draws when
// something actually changed.

import * as THREE from 'three';
import { assemblyPreviewMesh } from '../scene/toolView.js';
import { makeStudioEnvironment } from '../scene/viewer.js';

export class PreviewViewer {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Same environment as the main viewport, or the preview shows a black
    // silhouette where the main scene shows steel.
    this.environment = makeStudioEnvironment(this.renderer);
    this.scene.environment = this.environment;
    this.scene.add(new THREE.HemisphereLight(0xd6e2f5, 0x2b3140, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(160, -220, 240);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x93a9cc, 0.9);
    fill.position.set(-180, 140, 60);
    this.scene.add(fill);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 4000);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.angle = Math.PI * 0.15;
    this.elevation = 0.28;
    this.distance = 260;
    this.centre = new THREE.Vector3();
    this.spinning = true;
    this.dragging = false;
    this.dirty = true;

    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop = this.loop.bind(this);
    this.handle = requestAnimationFrame(this.loop);
  }

  bindPointer() {
    const dom = this.renderer.domElement;
    let lastX = 0;
    let lastY = 0;
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.spinning = false;
      lastX = e.clientX;
      lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.angle -= (e.clientX - lastX) * 0.01;
      this.elevation = Math.max(-1.3, Math.min(1.3, this.elevation + (e.clientY - lastY) * 0.008));
      lastX = e.clientX;
      lastY = e.clientY;
      this.dirty = true;
    });
    const stop = (e) => {
      this.dragging = false;
      if (dom.hasPointerCapture && e.pointerId !== undefined && dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    };
    dom.addEventListener('pointerup', stop);
    dom.addEventListener('pointercancel', stop);
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = Math.max(20, Math.min(2000, this.distance * (1 + Math.sign(e.deltaY) * 0.12)));
      this.dirty = true;
    }, { passive: false });
    dom.addEventListener('dblclick', () => {
      this.spinning = !this.spinning;
    });
  }

  /** @param {ReturnType<import('../tools/assembly.js').buildAssembly>} built */
  setAssembly(built) {
    this.clear();
    if (!built) return;
    this.content = assemblyPreviewMesh(built);
    this.pivot.add(this.content);

    const box = new THREE.Box3().setFromObject(this.content);
    if (box.isEmpty()) return;
    box.getCenter(this.centre);
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 3);
    this.distance = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.25;
    this.camera.near = Math.max(0.1, this.distance / 500);
    this.camera.far = this.distance * 12;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  clear() {
    if (!this.content) return;
    this.content.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.pivot.remove(this.content);
    this.content = null;
    this.dirty = true;
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  loop() {
    this.handle = requestAnimationFrame(this.loop);
    if (!this.container.isConnected || this.container.offsetParent === null) return;
    if (this.spinning) {
      this.angle += 0.006;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;

    const ce = Math.cos(this.elevation);
    this.camera.position.set(
      this.centre.x + Math.cos(this.angle) * this.distance * ce,
      this.centre.y + Math.sin(this.angle) * this.distance * ce,
      this.centre.z + Math.sin(this.elevation) * this.distance,
    );
    this.camera.lookAt(this.centre);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.handle);
    if (this.environment) this.environment.dispose();
    this.resizeObserver.disconnect();
    this.clear();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  }
}
