// Measurements drawn in the viewport.
//
// A verification tool that cannot answer "how deep is that pocket" is
// asking you to trust it and check somewhere else. The picking machinery
// already finds corners, edges and the machined surface itself, so a
// measurement is two of those points and the arithmetic between them.
//
// The line is drawn in the scene, in the work frame, so it stays with the
// part when the table moves. The number is HTML over the viewport rather
// than a texture in the scene: it stays crisp at any zoom, it never turns
// edge-on, and it costs a projection per frame.

import * as THREE from 'three';
import { el } from '../ui/dom.js';
import { fmt } from '../core/util.js';
import * as units from '../core/units.js';

const LINE_COLOR = 0x0a84ff;
const CIRCLE_COLOR = 0xaf52de;

export class MeasureView {
  /**
   * @param {import('./viewer.js').Viewer} viewer
   * @param {HTMLElement} overlay the element labels are placed in
   */
  constructor(viewer, overlay) {
    this.viewer = viewer;
    this.overlay = overlay;
    this.group = new THREE.Group();
    this.group.name = 'measurements';
    this.items = [];
    this.labels = new Map();
    this.tmp = new THREE.Vector3();
    viewer.scene.add(this.group);
    this.stop = viewer.onFrame(() => this.placeLabels());
  }

  /** Hang the measurements off whatever the work frame is now. */
  attach(parent) {
    const target = parent || this.viewer.scene;
    if (this.group.parent !== target) target.add(this.group);
  }

  /**
   * @param {Array<{id:string, kind:string, points:number[][], value:number,
   *                delta?:number[], centre?:number[]}>} items
   */
  setItems(items) {
    this.items = items || [];
    this.rebuild();
  }

  rebuild() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    for (const label of this.labels.values()) label.remove();
    this.labels.clear();

    for (const item of this.items) {
      const colour = item.kind === 'circle' ? CIRCLE_COLOR : LINE_COLOR;
      const pts = item.kind === 'circle' ? circlePoints(item) : item.points.map((p) => new THREE.Vector3(...p));
      const geometry = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
        color: colour, depthTest: false, transparent: true, opacity: 0.95,
      }));
      line.renderOrder = 995;
      this.group.add(line);

      // The ends, so a measurement is readable without the label.
      for (const p of item.points) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(1, 12, 8),
          new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.95 }),
        );
        dot.position.set(...p);
        dot.renderOrder = 996;
        dot.userData.isDot = true;
        this.group.add(dot);
      }

      const label = el('div.measure-label', {}, item.kind === 'circle'
        ? `Ø${units.lenU(item.value, 3)}`
        : units.lenU(item.value, 3));
      this.overlay.appendChild(label);
      this.labels.set(item.id, label);
    }
    this.placeLabels();
    this.viewer.invalidate();
  }

  /** Keep the dots the same size on screen and the labels over their lines. */
  placeLabels() {
    if (!this.items.length) return;
    this.group.updateWorldMatrix(true, false);
    const cam = this.viewer.camera;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();

    for (const child of this.group.children) {
      if (!child.userData.isDot) continue;
      const d = cam.position.distanceTo(child.getWorldPosition(this.tmp));
      child.scale.setScalar(Math.max(d * 0.004, 0.12));
    }

    for (const item of this.items) {
      const label = this.labels.get(item.id);
      if (!label) continue;
      const at = item.kind === 'circle' ? item.centre : midpoint(item.points);
      this.tmp.set(at[0], at[1], at[2]);
      this.group.localToWorld(this.tmp);
      this.tmp.project(cam);
      if (this.tmp.z > 1) { label.style.display = 'none'; continue; }
      label.style.display = '';
      label.style.left = `${((this.tmp.x + 1) / 2) * rect.width}px`;
      label.style.top = `${((1 - this.tmp.y) / 2) * rect.height}px`;
    }
  }

  dispose() {
    if (this.stop) this.stop();
    for (const label of this.labels.values()) label.remove();
    this.labels.clear();
  }
}

function midpoint(points) {
  const out = [0, 0, 0];
  for (const p of points) { out[0] += p[0]; out[1] += p[1]; out[2] += p[2]; }
  return out.map((v) => v / points.length);
}

/** The circle through three picked points, as a polyline. */
function circlePoints(item) {
  const c = new THREE.Vector3(...item.centre);
  const a = new THREE.Vector3(...item.points[0]).sub(c);
  const b = new THREE.Vector3(...item.points[1]).sub(c);
  const n = new THREE.Vector3().crossVectors(a, b).normalize();
  const u = a.clone().normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  const r = a.length();
  const out = [];
  for (let i = 0; i <= 72; i++) {
    const t = (i / 72) * Math.PI * 2;
    out.push(new THREE.Vector3()
      .copy(c)
      .addScaledVector(u, Math.cos(t) * r)
      .addScaledVector(v, Math.sin(t) * r));
  }
  return out;
}

/**
 * The centre of the circle through three points, in 3D.
 *
 * Three points on the wall of a bore give its diameter, which is the
 * measurement anybody actually wants from a hole — and unlike a diameter
 * typed from the program, it is measured off the surface that was cut.
 *
 * @returns {{centre:number[], radius:number}|null} null when they are in line
 */
export function circleThrough(p1, p2, p3) {
  const a = new THREE.Vector3(...p1);
  const b = new THREE.Vector3(...p2);
  const c = new THREE.Vector3(...p3);
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const n = new THREE.Vector3().crossVectors(ab, ac);
  if (n.lengthSq() < 1e-12) return null;                 // three points in line

  // The centre is where the perpendicular bisectors of two of the chords
  // meet, in the plane the three points share.
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const mid2 = new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5);
  const dir = new THREE.Vector3().crossVectors(n, ab).normalize();
  const dir2 = new THREE.Vector3().crossVectors(n, ac).normalize();
  const t = solve2(dir, dir2, mid2.clone().sub(mid));
  if (t === null) return null;
  const centre = mid.clone().addScaledVector(dir, t);
  return { centre: [centre.x, centre.y, centre.z], radius: centre.distanceTo(a) };
}

/** Where mid + t*dir meets the line mid2 + s*dir2, as t. */
function solve2(dir, dir2, delta) {
  const cross = new THREE.Vector3().crossVectors(dir, dir2);
  const len2 = cross.lengthSq();
  if (len2 < 1e-12) return null;
  return new THREE.Vector3().crossVectors(delta, dir2).dot(cross) / len2;
}
