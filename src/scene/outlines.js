// Edge outlines on solid models.
//
// A shaded casting next to a shaded fixture next to a shaded part is three
// greys meeting in a blur; drawn the way a CAD package draws them — with
// the edges where one face turns into another — each reads as a solid with
// a shape. The edges are the model's own feature edges: where two faces
// meet at more than a set angle, and where a surface simply stops. A
// cylinder's facets are not edges; its end circles are.
//
// three.js has this as EdgesGeometry, but it finds shared corners by
// turning every vertex into a string, and an imported casting of a million
// triangles took ten seconds to outline. This does the same job with
// numbers in typed arrays, once per geometry, and keeps the answer.
//
// The stock is deliberately not outlined. It changes every frame the tool
// cuts, and its machined walls already read by their shading and colour.

import * as THREE from 'three';
import { featureEdgeSegments } from './featureEdges.js';

/**
 * Hangs outlines on the meshes under a set of roots and keeps them current.
 *
 * `sync` is cheap enough to run on every frame that is drawn: it walks the
 * visible meshes, and an outline is only worked out the first time its
 * geometry is seen. Anything marked `userData.noOutline` is left alone,
 * along with everything under it.
 */
export class Outliner {
  constructor() {
    this.enabled = true;
    this.material = new THREE.LineBasicMaterial({ color: 0x20252d });
    /** geometry -> its edges, shared by every mesh that uses it. */
    this.cache = new WeakMap();
  }

  setEnabled(on) { this.enabled = !!on; }

  /** The outline of one geometry, worked out once. */
  edgesFor(geometry) {
    let edges = this.cache.get(geometry);
    if (edges) return edges;
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const segs = pos ? featureEdgeSegments(pos.array, index ? index.array : null) : new Float32Array(0);
    edges = new THREE.BufferGeometry();
    edges.setAttribute('position', new THREE.BufferAttribute(segs, 3));
    this.cache.set(geometry, edges);
    // When the model goes, its outline goes with it.
    geometry.addEventListener('dispose', () => {
      edges.dispose();
      this.cache.delete(geometry);
    });
    return edges;
  }

  /** @param {THREE.Object3D[]} roots */
  sync(roots) {
    const meshes = [];
    const walk = (o) => {
      if (!o.visible || o.userData.noOutline) return;
      if (o.isMesh && o.geometry && !o.userData.isOutline) meshes.push(o);
      for (const c of o.children) walk(c);
    };
    for (const r of roots) if (r) walk(r);

    for (const mesh of meshes) {
      let line = mesh.userData.outline;
      if (!this.enabled) {
        if (line) line.visible = false;
        continue;
      }
      const edges = this.edgesFor(mesh.geometry);
      if (!line) {
        line = new THREE.LineSegments(edges, this.material);
        line.name = 'outline';
        line.userData.isOutline = true;
        line.userData.noOutline = true;
        // A line is never what a click meant.
        line.raycast = () => {};
        mesh.add(line);
        mesh.userData.outline = line;
      } else if (line.geometry !== edges) {
        line.geometry = edges;
      }
      line.visible = true;
      // Push the faces a hair back so the edge lying exactly on them wins
      // the depth test instead of flickering in and out of it.
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (m && !m.polygonOffset) {
          m.polygonOffset = true;
          m.polygonOffsetFactor = 1;
          m.polygonOffsetUnits = 1;
        }
      }
    }
  }

  dispose() { this.material.dispose(); }
}
