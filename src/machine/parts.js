// The machine's own bodies, and where each one sits.
//
// These are kept apart from the job's fixtures on purpose: a vice belongs
// to the setup and gets cleared when the job changes, whereas the machine's
// castings belong to the machine and outlive every job.
//
// A body is two things — a mesh, and a *placement*: which axis carries it
// and where it sits within that axis. Assigning it to the base means it
// never moves; assigning it to X means it rides the X slide. The placement
// is what assembling a machine actually is, so it lives here beside the
// mesh rather than being baked into the geometry, and it can be nudged,
// mated to another body, or reset without touching the file it came from.
//
// They are display geometry: the collision model is still the tool assembly
// against the stock and the fixtures.

import * as THREE from 'three';
import { parseSTL, bounds } from '../io/stl.js';
import { uid } from '../core/util.js';

// Imported bodies are painted the same enamel as the proxy castings, so a
// half-assembled machine does not read as two different machines.
const MATERIAL = { color: 0x8d96a4, metalness: 0.12, roughness: 0.68 };

export class MachineParts {
  constructor() {
    /** @type {Array<{id:string, name:string, object:THREE.Object3D, triangles:number, size:number[], nodeId:string|null}>} */
    this.parts = [];
    /** The enamel a body is painted unless it is given one of its own. */
    this.material = new THREE.MeshStandardMaterial(MATERIAL);
  }

  /** The default colour, as the picker writes one. */
  static get defaultColor() { return `#${MATERIAL.color.toString(16).padStart(6, '0')}`; }

  /**
   * @param {{name:string, positions:Float32Array, units?:'mm'|'in',
   *          origin?:'as-is'|'base'}} spec
   */
  add(spec) {
    const positions = spec.positions;
    if (!positions || positions.length < 9) throw new Error('That file has no triangles.');

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
    if (spec.units === 'in') geometry.scale(25.4, 25.4, 25.4);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    // A casting is normally exported about its own joint, so 'as-is' is the
    // default; 'base' is the escape hatch for a part modelled in a corner.
    if (spec.origin === 'base') {
      const b = geometry.boundingBox;
      const c = b.getCenter(new THREE.Vector3());
      geometry.translate(-c.x, -c.y, -b.min.z);
      geometry.computeBoundingBox();
    }

    // Each body gets its own material so it can be painted on its own. A
    // machine assembled from a dozen castings that are all one grey is a
    // silhouette: which part is the saddle and which is the way cover is
    // exactly what somebody assembling it needs to see.
    const material = new THREE.MeshStandardMaterial(MATERIAL);
    if (spec.color) material.color.set(spec.color);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = spec.name || 'part';
    const size = geometry.boundingBox.getSize(new THREE.Vector3());

    const part = {
      id: uid('part'),
      name: spec.name || 'Machine part',
      object: mesh,
      triangles: geometry.attributes.position.count / 3,
      size: [size.x, size.y, size.z],
      /** Which axis carries it; null until it is assembled. */
      nodeId: spec.nodeId || null,
      /** Where it sits inside that axis, in the axis's own frame. */
      position: [0, 0, 0],
      /** Degrees about X, Y and Z, applied in that order. */
      rotation: [0, 0, 0],
      material,
      color: spec.color || MachineParts.defaultColor,
    };
    this.parts.push(part);
    return part;
  }

  async addFromFile(file, opts = {}) {
    const stl = parseSTL(await file.arrayBuffer());
    if (!stl.triangles) throw new Error(`${file.name}: no triangles found.`);
    const part = this.add({
      name: file.name.replace(/\.stl$/i, ''),
      positions: stl.positions,
      units: opts.units || 'mm',
      origin: opts.origin || 'as-is',
    });
    part.source = { file: file.name, format: stl.format, size: bounds(stl.positions).size };
    return part;
  }

  byId(id) {
    return this.parts.find((p) => p.id === id) || null;
  }

  /** Bodies assigned to an axis, in import order. */
  forNode(nodeId) {
    return this.parts.filter((p) => p.nodeId === nodeId);
  }

  /** Everything not yet hung on an axis. */
  unassigned() {
    return this.parts.filter((p) => !p.nodeId);
  }

  /**
   * Hang a body on an axis.
   *
   * An axis can carry any number of bodies — a real saddle is a casting, two
   * way covers and a motor — so this no longer displaces whatever was there.
   */
  assign(part, nodeId) {
    if (!part) return;
    part.nodeId = nodeId || null;
  }

  /** Move a body within the axis that carries it. */
  place(part, patch) {
    if (!part) return;
    if (patch.position) part.position = patch.position.map((v) => (Number.isFinite(v) ? v : 0));
    if (patch.rotation) part.rotation = patch.rotation.map((v) => (Number.isFinite(v) ? v : 0));
    this.applyTransform(part);
  }

  /** Paint one body. */
  paint(part, color) {
    if (!part || !color) return;
    part.color = color;
    part.material.color.set(color);
  }

  /** Nudge a body by a delta expressed in its own axis's frame. */
  nudge(part, delta) {
    if (!part) return;
    this.place(part, { position: part.position.map((v, i) => v + (delta[i] || 0)) });
  }

  applyTransform(part) {
    const o = part.object;
    o.position.set(part.position[0], part.position[1], part.position[2]);
    o.rotation.set(
      (part.rotation[0] * Math.PI) / 180,
      (part.rotation[1] * Math.PI) / 180,
      (part.rotation[2] * Math.PI) / 180,
    );
    o.updateMatrix();
  }

  /** The placement of every body, for saving with the machine. */
  placements() {
    return this.parts.map((p) => ({
      name: p.name,
      file: p.source ? p.source.file : null,
      nodeId: p.nodeId,
      position: [...p.position],
      rotation: [...p.rotation],
      color: p.color,
    }));
  }

  /**
   * Re-apply saved placements to whatever is loaded, matched by file name
   * and then by name. The geometry itself is never written into a machine
   * file — a set of castings is tens of megabytes — so loading a machine
   * restores the arrangement and asks for the STLs again.
   */
  restorePlacements(list) {
    let matched = 0;
    for (const saved of list || []) {
      const part = this.parts.find((p) => (saved.file && p.source && p.source.file === saved.file))
        || this.parts.find((p) => p.name === saved.name);
      if (!part) continue;
      part.nodeId = saved.nodeId || null;
      this.place(part, { position: saved.position, rotation: saved.rotation });
      if (saved.color) this.paint(part, saved.color);
      matched++;
    }
    return matched;
  }

  remove(part) {
    const i = this.parts.indexOf(part);
    if (i < 0) return;
    this.parts.splice(i, 1);
    if (part.object.parent) part.object.parent.remove(part.object);
    part.object.geometry.dispose();
    if (part.material) part.material.dispose();
  }

  clear() {
    for (const p of [...this.parts]) this.remove(p);
  }

  dispose() {
    this.clear();
    this.material.dispose();
  }
}
