// Imported models: fixtures, clamps, reference parts and anything else the
// user drops in.
//
// Every model is a mesh in its own group so the transform gizmo can move,
// rotate and scale it without touching the geometry. Models flagged as
// fixtures are handed to the simulator as oriented boxes, which is what
// makes "will the holder hit the clamp" answerable.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { parseSTL, bounds } from '../io/stl.js';
import { uid } from '../core/util.js';

export const MODEL_ROLES = {
  fixture: { label: 'Fixture (collision)', color: 0xd98b4a, collide: true },
  clamp: { label: 'Clamp (collision)', color: 0xd06a62, collide: true },
  // Not a box like the fixtures: the holder, shank and spindle are checked
  // against its real shape, and the cutter against it as a gouge.
  reference: { label: 'Reference part (collision, gouge)', color: 0x5fb3a1, collide: false },
  decor: { label: 'Decoration only', color: 0xa8aeba, collide: false },
};

/**
 * The order a model's three angles are applied in: X, then Y, then Z, each
 * about the machine's own axis. Three.js names an order by its matrix,
 * which reads the other way round. Applied Z first, as three.js does by
 * default, the X angle tipped the part over an axis the Z angle had already
 * swung, and no angle meant what it said once two were set.
 */
export const MODEL_ROTATION_ORDER = 'ZYX';

/** An angle in degrees, brought into (−180, 180]. */
function wrapDeg(d) {
  let a = ((d + 180) % 360 + 360) % 360 - 180;
  if (a === -180) a = 180;
  return Math.round(a * 1e6) / 1e6;
}

export class ModelsView {
  /** @param {import('./viewer.js').Viewer} viewer */
  constructor(viewer) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    this.group.name = 'models';
    /** Roles drawn out of the picture for now; see hideRole. */
    this.hiddenRoles = new Set();
    this.models = [];
    this.selected = null;
    this.onChange = () => {};

    this.gizmo = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.gizmo.setSpace('world');
    this.gizmo.addEventListener('dragging-changed', (e) => {
      viewer.controls.enabled = !e.value;
      if (!e.value) this.onChange('transform', this.selected);
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.selected) this.selected.dirty = true;
      viewer.invalidate();
    });
    const helper = this.gizmo.getHelper ? this.gizmo.getHelper() : this.gizmo;
    this.gizmoHelper = helper;
    viewer.scene.add(helper);
    helper.visible = false;
  }

  /**
   * @param {{name:string, positions:Float32Array, role?:string,
   *          units?:'mm'|'in', recentre?:boolean}} spec
   */
  add(spec) {
    const role = MODEL_ROLES[spec.role] ? spec.role : 'fixture';
    const positions = spec.positions;
    if (!positions || positions.length < 9) throw new Error('Model has no triangles.');

    const scale = spec.units === 'in' ? 25.4 : 1;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
    if (scale !== 1) geometry.scale(scale, scale, scale);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    if (spec.recentre) {
      const c = geometry.boundingBox.getCenter(new THREE.Vector3());
      geometry.translate(-c.x, -c.y, -geometry.boundingBox.min.z);
      geometry.computeBoundingBox();
    }

    const material = new THREE.MeshStandardMaterial({
      color: MODEL_ROLES[role].color,
      metalness: 0.2,
      roughness: 0.65,
      transparent: false,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = spec.name || 'model';
    mesh.visible = !this.hiddenRoles.has(role);

    const holder = new THREE.Group();
    holder.rotation.order = MODEL_ROTATION_ORDER;
    holder.name = `model:${mesh.name}`;
    holder.add(mesh);
    this.group.add(holder);

    const model = {
      id: uid('model'),
      name: spec.name || 'Model',
      role,
      object: holder,
      mesh,
      material,
      visible: true,
      /** Skip this one in the crash model, whatever its role says. */
      ignore: false,
      /** Room this one wants for itself, in mm; null follows the setting. */
      clearance: null,
      triangles: geometry.attributes.position.count / 3,
      dirty: true,
    };
    this.models.push(model);
    this.onChange('add', model);
    this.viewer.invalidate();
    return model;
  }

  /** Read an STL file into the scene. */
  async addFromFile(file, opts = {}) {
    const buffer = await file.arrayBuffer();
    const stl = parseSTL(buffer);
    if (!stl.triangles) throw new Error(`${file.name}: no triangles found.`);
    const b = bounds(stl.positions);
    const model = this.add({
      name: file.name.replace(/\.stl$/i, ''),
      positions: stl.positions,
      role: opts.role || 'fixture',
      units: opts.units || 'mm',
      recentre: opts.recentre !== false,
    });
    model.source = { file: file.name, format: stl.format, size: b.size };
    return model;
  }

  select(model) {
    this.selected = model || null;
    if (model) {
      this.gizmo.attach(model.object);
      this.gizmoHelper.visible = true;
    } else {
      this.gizmo.detach();
      this.gizmoHelper.visible = false;
    }
    this.viewer.invalidate();
    this.onChange('select', model);
  }

  setGizmoMode(mode) {
    this.gizmo.setMode(mode);
    this.viewer.invalidate();
  }

  setGizmoEnabled(on) {
    this.gizmo.enabled = on;
    this.gizmoHelper.visible = on && !!this.selected;
    this.viewer.invalidate();
  }

  /**
   * Turn a model by a step about one of the machine's axes: the step goes
   * on that angle, and the model turns about its own origin — the point
   * its X, Y and Z say — so where it stands does not change.
   *
   * @param {0|1|2} axis
   * @param {number} degrees
   */
  turnAbout(model, axis, degrees) {
    if (!degrees) return;
    const r = model.object.rotation;
    const k = ['x', 'y', 'z'][axis];
    const deg = wrapDeg((r[k] * 180) / Math.PI + degrees);
    r[k] = (deg * Math.PI) / 180;
    model.dirty = true;
    this.viewer.invalidate();
    this.onChange('transform', model);
  }

  /**
   * @param {{position?:number[], rotation?:number[], rotationOrder?:string,
   *          scale?:number[]}} t rotation in radians, in rotationOrder —
   *   this one's when not said; a project saved before the order changed
   *   says XYZ, and its angles are turned into this order's.
   */
  setTransform(model, { position, rotation, rotationOrder, scale }) {
    if (position) model.object.position.set(position[0], position[1], position[2]);
    if (rotation) {
      const from = rotationOrder || MODEL_ROTATION_ORDER;
      const e = new THREE.Euler(rotation[0], rotation[1], rotation[2], from);
      if (from !== MODEL_ROTATION_ORDER) e.reorder(MODEL_ROTATION_ORDER);
      model.object.rotation.set(e.x, e.y, e.z, MODEL_ROTATION_ORDER);
    }
    if (scale) model.object.scale.set(scale[0], scale[1], scale[2]);
    model.dirty = true;
    this.viewer.invalidate();
    this.onChange('transform', model);
  }

  /**
   * Stand every model of a role aside from the picture, without changing
   * whether it is on. The deviation map does this to the reference part:
   * the map is the comparison with it, and the part drawn over the top
   * hides exactly the faces the map is colouring.
   */
  hideRole(role, hidden) {
    if (hidden) this.hiddenRoles.add(role); else this.hiddenRoles.delete(role);
    for (const m of this.models) m.mesh.visible = !this.hiddenRoles.has(m.role);
    this.viewer.invalidate();
  }

  setRole(model, role) {
    if (!MODEL_ROLES[role]) return;
    model.role = role;
    model.mesh.visible = !this.hiddenRoles.has(role);
    model.material.color.setHex(MODEL_ROLES[role].color);
    model.dirty = true;
    this.viewer.invalidate();
    this.onChange('role', model);
  }

  setVisible(model, visible) {
    model.visible = visible;
    model.object.visible = visible;
    this.viewer.invalidate();
  }

  setOpacity(model, alpha) {
    model.material.transparent = alpha < 0.999;
    model.material.opacity = alpha;
    model.material.depthWrite = alpha > 0.999;
    model.material.needsUpdate = true;
    this.viewer.invalidate();
  }

  remove(model) {
    if (this.selected === model) this.select(null);
    this.group.remove(model.object);
    model.mesh.geometry.dispose();
    model.material.dispose();
    this.models = this.models.filter((m) => m !== model);
    this.onChange('remove', model);
    this.viewer.invalidate();
  }

  clear() {
    for (const m of [...this.models]) this.remove(m);
  }

  /**
   * Oriented boxes for the simulator, one per collidable model.
   * @returns {import('../sim/collision.js').FixtureBox[]}
   */
  collisionBoxes(frame = null) {
    const out = [];
    const toFrame = frame ? new THREE.Matrix4() : null;
    if (frame) {
      frame.updateMatrixWorld(true);
      toFrame.copy(frame.matrixWorld).invert();
    }
    for (const m of this.models) {
      if (!m.visible || !MODEL_ROLES[m.role].collide) continue;
      m.object.updateMatrixWorld(true);
      const bb = m.mesh.geometry.boundingBox;
      if (!bb) continue;
      const centre = bb.getCenter(new THREE.Vector3());
      const half = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      // The tool is given on the part, so the box has to answer in the
      // same frame — see worldPositions.
      const placed = new THREE.Matrix4().copy(m.object.matrixWorld);
      if (toFrame) placed.premultiply(toFrame);
      const inv = new THREE.Matrix4().copy(placed).invert();
      const s = m.object.scale;
      out.push({
        id: m.id,
        name: m.name,
        inverse: inv.elements,
        centre: [centre.x, centre.y, centre.z],
        half: [half.x, half.y, half.z],
        scale: Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) || 1,
        // Rules this one carries itself: a part the tool is meant to touch,
        // or one that wants more room than the rest.
        ignore: !!m.ignore,
        clearance: Number.isFinite(m.clearance) ? m.clearance : null,
      });
      m.dirty = false;
    }
    return out;
  }

  needsCollisionRefresh() {
    return this.models.some((m) => m.dirty);
  }

  /** Serialise transforms and roles (geometry is not stored). */
  serialize() {
    return this.models.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      visible: m.visible,
      position: m.object.position.toArray(),
      rotation: [m.object.rotation.x, m.object.rotation.y, m.object.rotation.z],
      rotationOrder: MODEL_ROTATION_ORDER,
      scale: m.object.scale.toArray(),
      source: m.source || null,
      triangles: m.triangles,
    }));
  }

  boundingBox() {
    const b = new THREE.Box3();
    if (this.models.length) b.setFromObject(this.group);
    return b;
  }

  /** World-space triangles of a model, for export. */
  worldPositions(model, frame = null) {
    model.object.updateMatrixWorld(true);
    // In the frame that was asked for, which is the part's when the caller
    // is the reference-part check: the stock grid is in part coordinates,
    // and in full-machine view the scene's coordinates are a whole
    // kinematic chain away from those. Comparing the two put the reference
    // surface somewhere off the side of the block, where nothing could
    // ever gouge it.
    const m = new THREE.Matrix4().copy(model.object.matrixWorld);
    if (frame) {
      frame.updateMatrixWorld(true);
      m.premultiply(new THREE.Matrix4().copy(frame.matrixWorld).invert());
    }
    const src = model.mesh.geometry.attributes.position.array;
    const out = new Float32Array(src.length);
    const v = new THREE.Vector3();
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m);
      out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
    }
    return out;
  }

  dispose() {
    this.clear();
    this.gizmo.detach();
    this.gizmo.dispose();
    if (this.gizmoHelper.parent) this.gizmoHelper.parent.remove(this.gizmoHelper);
  }
}
