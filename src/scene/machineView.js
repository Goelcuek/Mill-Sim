// The machine in the viewport.
//
// The rig is the kinematic chain: one scene group per axis node, parented
// the way the nodes are, so posing the machine is nothing more than
// writing each joint's local matrix. That is what lets a trunnion and a
// gantry share this file — the tree differs, the code does not.
//
// Two display modes:
//
//   part     – the part stays put and the tool flies around it, which is
//              what you want while inspecting a cut.
//   machine  – every casting moves the way the real machine does, which is
//              what you want for travel and clearance problems.
//
// Each node draws a plain proxy until the user assigns an STL to it. The
// proxies are deliberately simple: they say where an axis is and which way
// it moves, and nothing more.

import * as THREE from 'three';
import * as m4 from '../core/mat4.js';
import { Kinematics } from '../machine/kinematics.js';
import { buildPreset } from '../machine/presets.js';

export const DEFAULT_MACHINE = {
  name: '3-axis VMC',
  preset: 'vmc3',
  travel: [760, 430, 510],
  tableSize: [900, 460],
  /** Scene Z of the table top; the stock normally sits on fixtures above it. */
  tableZ: -80,
  spindleDiameter: 110,
  spindleLength: 130,
  /** Tool-tip travel limits in scene coordinates. */
  limits: { enabled: true, min: [-380, -215, -120], max: [380, 215, 330] },
  table: { enabled: true, z: -80, xMin: -450, xMax: 450, yMin: -230, yMax: 230 },
  rapidRate: 15000,
  maxFeed: 10000,
  mode: 'part',
  visible: true,
};

// Darker than the part and the stock on purpose: the machine is scenery,
// and at full-machine zoom a white casting against a white background
// tells you nothing about where one part ends and the next begins.
const CAST = { color: 0xb4bbc6, metalness: 0.15, roughness: 0.85 };
const STEEL = { color: 0x99a1ae, metalness: 0.55, roughness: 0.5 };
const TABLE = { color: 0xaab1bd, metalness: 0.7, roughness: 0.3 };
const ROTARY = { color: 0x8d95a3, metalness: 0.6, roughness: 0.4 };

/** Column-major m4 into a three.js matrix, which uses the same layout. */
function toThree(out, m) {
  out.set(
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  );
  return out;
}

/** A box whose local origin is the centre of its base. */
function box(w, d, h, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), material);
  mesh.position.set(x, y, z + h / 2);
  return mesh;
}

/** A cylinder lying along an arbitrary unit axis, centred on the origin. */
function cylinderAlong(radius, length, axis, material) {
  const g = new THREE.CylinderGeometry(radius, radius, length, 32, 1);
  const mesh = new THREE.Mesh(g, material);
  const from = new THREE.Vector3(0, 1, 0);
  const to = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
  mesh.quaternion.setFromUnitVectors(from, to);
  return mesh;
}

export class MachineView {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'machine';

    /** Everything expressed in work coordinates hangs off this. */
    this.workGroup = new THREE.Group();
    this.workGroup.name = 'work';
    /** The spindle end of the chain; the tool assembly rides here. */
    this.toolGroup = new THREE.Group();
    this.toolGroup.name = 'spindle';

    this.materials = {
      cast: new THREE.MeshStandardMaterial(CAST),
      steel: new THREE.MeshStandardMaterial(STEEL),
      table: new THREE.MeshStandardMaterial(TABLE),
      rotary: new THREE.MeshStandardMaterial(ROTARY),
      slot: new THREE.LineBasicMaterial({ color: 0x8d94a2 }),
    };

    /** nodeId -> THREE.Group for that joint. */
    this.nodeGroups = new Map();
    /** nodeId -> the proxy meshes drawn for it. */
    this.proxies = new Map();
    /** nodeId -> a user-supplied Object3D standing in for the proxy. */
    this.models = new Map();

    this.config = { ...DEFAULT_MACHINE };
    this.limitBox = null;
    this.assemblyLength = 200;
    this.lastPose = { values: {}, tip: [0, 0, 0], dir: [0, 0, 1] };

    this.kinematics = buildPreset(this.config.preset);
    this.rebuild();
  }

  // ---- configuration -----------------------------------------------------

  setConfig(cfg) {
    const changedPreset = cfg && cfg.preset && cfg.preset !== this.config.preset;
    this.config = {
      ...DEFAULT_MACHINE,
      ...cfg,
      limits: { ...DEFAULT_MACHINE.limits, ...(cfg && cfg.limits) },
      table: { ...DEFAULT_MACHINE.table, ...(cfg && cfg.table) },
    };
    if (changedPreset) this.kinematics = buildPreset(this.config.preset);
    this.rebuild();
  }

  /** Swap in a chain the user has edited, keeping the display settings. */
  setKinematics(kin) {
    this.kinematics = kin instanceof Kinematics ? kin : new Kinematics(kin);
    this.rebuild();
  }

  /**
   * Attach imported meshes to axes, replacing those axes' proxies.
   * The whole set is passed at once because each change re-rigs the tree,
   * and doing that once per casting on a machine with a dozen of them is
   * wasted work.
   * @param {Map<string, THREE.Object3D>|Iterable<[string, THREE.Object3D]>} map
   */
  setNodeModels(map) {
    for (const obj of this.models.values()) if (obj.parent) obj.parent.remove(obj);
    this.models = new Map(map || []);
    this.rebuild();
  }

  /** Attach one mesh, leaving the others where they are. */
  setNodeModel(nodeId, object) {
    const next = new Map(this.models);
    if (object) next.set(nodeId, object);
    else next.delete(nodeId);
    this.setNodeModels(next);
  }

  clearNodeModels() {
    this.setNodeModels(new Map());
  }

  // ---- the rig -----------------------------------------------------------

  rebuild() {
    this.disposeProxies();
    for (const g of this.nodeGroups.values()) {
      if (g.parent) g.parent.remove(g);
    }
    this.nodeGroups.clear();

    const kin = this.kinematics;
    for (const node of kin.order) {
      const g = new THREE.Group();
      g.name = node.name || node.id;
      g.matrixAutoUpdate = false;
      this.nodeGroups.set(node.id, g);
    }
    for (const node of kin.order) {
      const g = this.nodeGroups.get(node.id);
      const parent = node.parent && this.nodeGroups.get(node.parent);
      (parent || this.group).add(g);
    }

    // The two ends of the chain carry the scene's own contents.
    const work = this.nodeGroups.get(kin.workNode) || this.group;
    work.add(this.workGroup);
    const tool = this.nodeGroups.get(kin.toolNode) || this.group;
    tool.add(this.toolGroup);
    this.workGroup.position.set(...kin.tableOffset);
    this.toolGroup.position.set(...kin.spindleOffset);

    for (const node of kin.order) this.buildNodeParts(node);

    this.buildLimitBox();
    this.setMode(this.config.mode);
    this.group.visible = this.config.visible;
    this.update(this.lastPose);
  }

  /** Proxy geometry for one axis, or the user's model in its place. */
  buildNodeParts(node) {
    const g = this.nodeGroups.get(node.id);
    const kin = this.kinematics;
    const model = this.models.get(node.id);
    if (model) {
      g.add(model);
      return;
    }

    const parts = [];
    const add = (mesh) => { g.add(mesh); parts.push(mesh); return mesh; };
    const [tw, td] = this.config.tableSize;

    if (node.id === kin.workNode) {
      // The fixture face: a plate with its top at the node's own origin.
      const plate = add(box(tw, td, 70, this.materials.table, 0, 0, -70));
      plate.name = 'table';
      add(this.tSlots(tw, td));
    } else if (node.id === kin.toolNode) {
      // The head hangs above the gauge line; how far is set by the
      // assembly currently loaded, so the castings never swallow the tool.
      // Centred on the spindle axis so the head reads as a head however it
      // is tilted, with a short nose bridging down to the gauge line.
      this.headCasting = add(box(210, 210, 300, this.materials.cast, 0, 0, 0));
      this.headSlide = add(box(150, 150, 60, this.materials.steel, 0, 0, 0));
      this.applyAssemblyLength();
    } else if (node.kind === 'rotary') {
      // A disc about the axis, with a cradle so which way it turns is
      // legible even before the user hangs a real casting on it.
      const r = Math.max(Math.min(tw, td) * 0.22, 50);
      const face = add(cylinderAlong(r, r * 0.4, node.axis, this.materials.rotary));
      face.name = `${node.letter || ''} rotary`;
      const arm = add(cylinderAlong(r * 1.15, r * 0.16, node.axis, this.materials.cast));
      arm.position.set(-node.axis[0] * r * 0.34, -node.axis[1] * r * 0.34, -node.axis[2] * r * 0.34);
    } else if (node.kind === 'linear') {
      // A pair of ways along the direction of travel: long, thin and
      // clearly pointing the way the axis moves.
      const len = Math.max(node.limits.max - node.limits.min, 120) * 0.9;
      const gap = Math.max(Math.min(tw, td) * 0.34, 90);
      const a = node.axis;
      const along = Math.abs(a[0]) > 0.5 ? 0 : Math.abs(a[1]) > 0.5 ? 1 : 2;
      // Rails run along the axis and are spaced across the flattest of the
      // other two directions, which is what a real slideway looks like.
      const across = along === 2 ? 0 : 1;
      for (const sign of [-1, 1]) {
        const dim = [40, 40, 40];
        dim[along] = len;
        const rail = add(box(dim[0], dim[1], dim[2], this.materials.steel));
        rail.position.set(0, 0, -20);
        rail.position.setComponent(across, (sign * gap) / 2);
        rail.name = `${node.letter || ''} way`;
      }
    } else {
      // A plain carrier: the base, or a bracket the user will replace.
      add(box(tw * 0.8, td * 1.1, 180, this.materials.cast, 0, 0, -430));
    }
    this.proxies.set(node.id, parts);
  }

  tSlots(tw, td) {
    const slots = 5;
    const pts = [];
    for (let i = 0; i < slots; i++) {
      const y = -td / 2 + (td * (i + 0.5)) / slots;
      pts.push(new THREE.Vector3(-tw / 2, y, 0.4), new THREE.Vector3(tw / 2, y, 0.4));
    }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), this.materials.slot);
    lines.name = 't-slots';
    return lines;
  }

  disposeProxies() {
    for (const parts of this.proxies.values()) {
      for (const p of parts) {
        if (p.geometry) p.geometry.dispose();
        if (p.parent) p.parent.remove(p);
      }
    }
    this.proxies.clear();
    this.headCasting = null;
    this.headSlide = null;
  }

  buildLimitBox() {
    if (this.limitBox) {
      this.limitBox.geometry.dispose();
      if (this.limitBox.parent) this.limitBox.parent.remove(this.limitBox);
      this.limitBox = null;
    }
    const l = this.config.limits;
    if (!l || !l.enabled) return;
    const b = new THREE.Box3(new THREE.Vector3(...l.min), new THREE.Vector3(...l.max));
    this.limitBox = new THREE.Box3Helper(b, 0x0a84ff);
    this.limitBox.material.transparent = true;
    this.limitBox.material.opacity = 0.35;
    this.limitBox.visible = false;
    this.group.add(this.limitBox);
  }

  setLimitsVisible(v) { if (this.limitBox) this.limitBox.visible = v; }

  /**
   * Tell the head how far the tool tip sits below the spindle gauge line,
   * so the castings never swallow the tool or float above the holder.
   */
  setAssemblyLength(length) {
    this.assemblyLength = Math.max(length || 0, 40);
    this.applyAssemblyLength();
  }

  applyAssemblyLength() {
    // Both sit above the gauge line, which is `assemblyLength` above the
    // tool tip the rig was posed for.
    if (this.headSlide) this.headSlide.position.z = this.assemblyLength + 30;
    if (this.headCasting) this.headCasting.position.z = this.assemblyLength + 210;
  }

  // ---- posing ------------------------------------------------------------

  /**
   * Pose the rig.
   *
   * @param {{values:object, tip:number[], dir:number[]}} pose
   *   `values` are the axis positions, `tip` and `dir` the tool in part
   *   coordinates — which is all part mode needs.
   * @returns {{tip:number[], dir:number[]}} the tool in scene coordinates
   */
  update(pose) {
    const p = Array.isArray(pose)
      ? { values: { X: pose[0], Y: pose[1], Z: pose[2] }, tip: pose, dir: [0, 0, 1], rot: {} }
      : pose;
    this.lastPose = p;
    const kin = this.kinematics;

    if (this.config.mode !== 'machine') {
      // Part mode: the chain collapses. The work frame is the scene, and
      // the tool is placed straight at the point it reached on the part.
      for (const g of this.nodeGroups.values()) {
        g.matrix.identity();
        g.matrixWorldNeedsUpdate = true;
      }
      this.workGroup.position.set(0, 0, 0);
      this.toolGroup.position.set(0, 0, 0);
      return { tip: p.tip.slice(), dir: p.dir.slice() };
    }

    // Where the part's zero sits on the table for the tool now loaded. It
    // is the tool tip at machine home, which is the point the programmed
    // numbers are measured from, so it moves with the gauge length — hold
    // the Z axis still and fit a longer tool and the tip goes lower, so the
    // zero those numbers refer to is lower too.
    const ref = kin.partOrigin(this.assemblyLength);
    const off = kin.tableOffset;
    this.workGroup.position.set(off[0] + ref[0], off[1] + ref[1], off[2] + ref[2]);
    this.toolGroup.position.set(...kin.spindleOffset);

    // Drive the rig from the tool tip, not from the programmed word. Once
    // a work offset and a tool length exist those are different numbers —
    // the programmed Z is where the tip should be on the part, while the
    // Z axis has to stand a whole gauge length higher. Solving for the
    // axis positions is what keeps the castings around the tool instead of
    // through it, and it is exact.
    const wanted = [p.tip[0] + ref[0], p.tip[1] + ref[1], p.tip[2] + ref[2]];
    const rot = p.rot || {};
    const lin = kin.linearsForTip(wanted, rot, this.assemblyLength);
    kin.solve(lin ? { ...rot, ...lin } : (p.values || {}));
    const tmp = new THREE.Matrix4();
    for (const node of kin.order) {
      const g = this.nodeGroups.get(node.id);
      if (!g) continue;
      toThree(tmp, kin.localOf(node.id));
      g.matrix.copy(tmp);
      g.matrixWorldNeedsUpdate = true;
    }
    this.group.updateMatrixWorld(true);

    // The tool is drawn where the part says it is, so it lands on the cut
    // even if the machine could not quite reach the pose.
    const world = this.workGroup.matrixWorld;
    const tip = new THREE.Vector3(p.tip[0], p.tip[1], p.tip[2]).applyMatrix4(world);
    const dir = new THREE.Vector3(p.dir[0], p.dir[1], p.dir[2]).transformDirection(world).normalize();
    return { tip: [tip.x, tip.y, tip.z], dir: [dir.x, dir.y, dir.z] };
  }

  /** 'part' or 'machine'. */
  setMode(mode) {
    this.config.mode = mode === 'machine' ? 'machine' : 'part';
    const show = this.config.mode === 'machine' && this.config.visible;
    for (const [id, parts] of this.proxies) {
      for (const p of parts) p.visible = show;
    }
    for (const obj of this.models.values()) obj.visible = show;
    this.update(this.lastPose);
  }

  setVisible(v) {
    this.config.visible = v;
    this.setMode(this.config.mode);
  }

  /** Scene-space bounding box of the whole machine. */
  boundingBox() {
    const b = new THREE.Box3();
    let any = false;
    for (const parts of this.proxies.values()) {
      for (const p of parts) {
        if (!p.visible) continue;
        b.expandByObject(p);
        any = true;
      }
    }
    for (const obj of this.models.values()) {
      if (!obj.visible) continue;
      b.expandByObject(obj);
      any = true;
    }
    return any ? b : new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  }

  dispose() {
    this.disposeProxies();
    for (const g of this.nodeGroups.values()) if (g.parent) g.parent.remove(g);
    this.nodeGroups.clear();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
