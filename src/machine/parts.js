// Imported machine castings.
//
// Machine parts are kept apart from the job's fixtures on purpose: a vice
// belongs to the setup and gets cleared when the job changes, whereas the
// machine's own castings belong to the machine and outlive every job. They
// are display geometry — the collision model is still the tool assembly
// against the stock and the fixtures — so all that is stored is the mesh
// and enough about where it came from to show it in a list.

import * as THREE from 'three';
import { parseSTL, bounds } from '../io/stl.js';
import { uid } from '../core/util.js';

const MATERIAL = { color: 0xcfd4dc, metalness: 0.35, roughness: 0.6 };

export class MachineParts {
  constructor() {
    /** @type {Array<{id:string, name:string, object:THREE.Object3D, triangles:number, size:number[], nodeId:string|null}>} */
    this.parts = [];
    this.material = new THREE.MeshStandardMaterial(MATERIAL);
  }

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

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = spec.name || 'part';
    const size = geometry.boundingBox.getSize(new THREE.Vector3());

    const part = {
      id: uid('part'),
      name: spec.name || 'Machine part',
      object: mesh,
      triangles: geometry.attributes.position.count / 3,
      size: [size.x, size.y, size.z],
      nodeId: null,
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

  /** Parts assigned to an axis, in import order. */
  forNode(nodeId) {
    return this.parts.filter((p) => p.nodeId === nodeId);
  }

  /** An axis takes at most one part, and a part hangs on at most one axis. */
  assign(part, nodeId) {
    if (!part) return;
    if (nodeId) for (const other of this.parts) if (other !== part && other.nodeId === nodeId) other.nodeId = null;
    part.nodeId = nodeId || null;
  }

  remove(part) {
    const i = this.parts.indexOf(part);
    if (i < 0) return;
    this.parts.splice(i, 1);
    if (part.object.parent) part.object.parent.remove(part.object);
    part.object.geometry.dispose();
  }

  clear() {
    for (const p of [...this.parts]) this.remove(p);
  }

  dispose() {
    this.clear();
    this.material.dispose();
  }
}
