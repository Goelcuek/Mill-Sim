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
import { buildPreset, PRESETS } from '../machine/presets.js';
import { TONES, buildCasting } from './castings.js';

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
  /**
   * The control, not the iron. Which flavour of G-code this machine reads
   * and what modal state it powers up in — see DEFAULT_CONFIG.controller
   * in the interpreter.
   */
  controller: {
    flavour: 'fanuc',
    plane: 17,
    metric: true,
    absolute: true,
    arcCentreAbsolute: false,
    feedMode: 94,
  },
  mode: 'part',
  visible: true,
};

// Darker than the part and the stock on purpose: the machine is scenery,
// and at full-machine zoom a white casting against a white background
// tells you nothing about where one part ends and the next begins.

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

    // One material per tone, shared by every casting that uses it.
    this.materials = {};
    for (const [name, spec] of Object.entries(TONES)) {
      this.materials[name] = new THREE.MeshStandardMaterial(spec);
    }
    this.materials.slot = new THREE.LineBasicMaterial({ color: 0x8d94a2 });
    this.tone = (name) => this.materials[name] || this.materials.body;

    /** nodeId -> THREE.Group for that joint. */
    this.nodeGroups = new Map();
    /** nodeId -> the proxy meshes drawn for it. */
    this.proxies = new Map();
    /** nodeId -> the user's bodies hung on that axis, replacing the proxy. */
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
    // Only a name that is actually a preset rebuilds the chain. A machine
    // loaded from a file carries a name that is not in the list, and
    // buildPreset falls back to the 3-axis VMC for anything it does not
    // recognise — so this used to throw the imported machine away the next
    // time any unrelated setting changed.
    const named = cfg && cfg.preset;
    const changedPreset = !!named && PRESETS[named] && named !== this.config.preset;
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
   * Attach the user's bodies to the axes that carry them.
   *
   * An axis can carry several — a saddle is a casting, two way covers and a
   * motor — so the value is a list. The whole set is passed at once because
   * each change re-rigs the tree, and doing that once per body on a machine
   * with a dozen of them is wasted work.
   *
   * @param {Map<string, THREE.Object3D[]>|Iterable<[string, THREE.Object3D[]]>} map
   */
  setNodeModels(map) {
    for (const list of this.models.values()) {
      for (const obj of list) if (obj.parent) obj.parent.remove(obj);
    }
    this.models = new Map();
    for (const [id, value] of map || []) {
      this.models.set(id, Array.isArray(value) ? value : [value]);
    }
    this.rebuild();
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
    // Each machine paints its moving castings its own colour, so a glance
    // at the viewport says which family you are looking at.
    this.materials.accent.color.setHex(kin.accent ?? TONES.accent.color);
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
  /**
   * Draw one axis: the castings the preset describes, or a generic shape
   * for an axis the user added themselves.
   */
  buildNodeParts(node) {
    const g = this.nodeGroups.get(node.id);
    const kin = this.kinematics;
    // A body on an axis replaces that axis's proxy: once you have modelled
    // the real saddle, a stand-in slab next to it is just clutter.
    const bodies = this.models.get(node.id);
    if (bodies && bodies.length) {
      for (const obj of bodies) g.add(obj);
      return;
    }

    const parts = [];
    // Named after the joint they belong to, so a click on one says "Table"
    // rather than "model".
    const add = (mesh) => {
      mesh.name = mesh.name || node.name || node.id;
      g.add(mesh);
      parts.push(mesh);
      return mesh;
    };

    if (Array.isArray(node.proxy) && node.proxy.length) {
      for (const spec of node.proxy) {
        for (const mesh of buildCasting(spec, this.tone)) add(mesh);
      }
      this.proxies.set(node.id, parts);
      return;
    }

    // No description: fall back to something that at least says where the
    // joint is and which way it moves.
    const [tw, td] = this.config.tableSize;
    if (node.id === kin.workNode) {
      for (const mesh of buildCasting({ part: 'table', size: [tw, td, 70], at: [0, 0, -70], slots: 5 }, this.tone)) add(mesh);
    } else if (node.id === kin.toolNode) {
      // The spindle node's own origin is the gauge line, so the cartridge
      // is drawn upwards from there. It used to be pushed up by the length
      // of the tool as well, which left the head floating a whole assembly
      // above the tool it was supposed to be holding.
      for (const mesh of buildCasting({ part: 'spindle', size: [80, 240], at: [0, 0, 0] }, this.tone)) add(mesh);
    } else if (node.kind === 'rotary') {
      const r = Math.max(Math.min(tw, td) * 0.22, 50);
      for (const mesh of buildCasting({ part: 'rotary', size: [r, r * 0.32], axis: node.axis, slots: 0 }, this.tone)) add(mesh);
    } else if (node.kind === 'linear') {
      // A pair of ways along the direction of travel: long, thin and
      // clearly pointing the way the axis moves.
      const len = Math.max(node.limits.max - node.limits.min, 120) * 0.9;
      const gap = Math.max(Math.min(tw, td) * 0.34, 90);
      const a = node.axis;
      const along = Math.abs(a[0]) > 0.5 ? 0 : Math.abs(a[1]) > 0.5 ? 1 : 2;
      const across = along === 2 ? 0 : 1;
      for (const sign of [-1, 1]) {
        const dim = [40, 40, 40];
        dim[along] = len;
        const rail = add(box(dim[0], dim[1], dim[2], this.tone('slide')));
        rail.position.set(0, 0, -20);
        rail.position.setComponent(across, (sign * gap) / 2);
        rail.name = `${node.letter || ''} way`;
      }
    } else {
      for (const mesh of buildCasting({ part: 'box', size: [tw * 0.7, td * 0.9, 160], at: [0, 0, -420], tone: 'base' }, this.tone)) add(mesh);
    }

    this.proxies.set(node.id, parts);
  }

  disposeProxies() {
    for (const parts of this.proxies.values()) {
      for (const p of parts) {
        if (p.geometry) p.geometry.dispose();
        if (p.parent) p.parent.remove(p);
      }
    }
    this.proxies.clear();
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
   * How far the tool tip sits below the spindle gauge line.
   *
   * The castings do not move with it — the spindle node's frame *is* the
   * gauge line, so they are drawn upwards from zero and stay put. What this
   * changes is the inverse-kinematics target: a longer tool means the Z
   * axis has to stand higher to put the tip in the same place. The head
   * used to be shifted up by this as well, which left it floating a whole
   * assembly above the tool it was meant to be holding.
   */
  setAssemblyLength(length) {
    const next = Math.max(length || 0, 40);
    if (next === this.assemblyLength) return;
    this.assemblyLength = next;
    this.update(this.lastPose);
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

    // The part is clamped to the table at a fixed place and stays there.
    //
    // It used to be offset by the tool tip's position at machine home,
    // which moves with the gauge length — so changing tools slid the part
    // up and down the table, and a long enough tool sank it into the
    // casting. Where the programmed numbers are measured from is a question
    // about the *program*, answered by Kinematics.toolInPart; it has no
    // business moving the workpiece.
    this.workGroup.position.set(...kin.tableOffset);
    this.toolGroup.position.set(...kin.spindleOffset);

    // Drive the rig from the tool tip, not from the programmed word. Once
    // a work offset and a tool length exist those are different numbers —
    // the programmed Z is where the tip should be on the part, while the
    // Z axis has to stand a whole gauge length higher. Solving for the
    // axis positions is what keeps the castings around the tool instead of
    // through it, and it is exact.
    const rot = p.rot || {};
    const lin = kin.linearsForTip(p.tip, rot, this.assemblyLength);
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
    for (const list of this.models.values()) for (const obj of list) obj.visible = show;
    this.update(this.lastPose);
  }

  setVisible(v) {
    this.config.visible = v;
    this.setMode(this.config.mode);
  }

  /** Every user body currently in the rig, for picking against. */
  bodyMeshes() {
    const out = [];
    for (const list of this.models.values()) for (const obj of list) if (obj.visible) out.push(obj);
    return out;
  }

  /**
   * Everything of the machine a ray may hit: the user's bodies and the
   * proxy castings alike.
   *
   * Both are machine, and which one an axis happens to be drawn with is not
   * something a click should care about — putting the stock on the table of
   * a preset machine has to work before anybody has imported an STL.
   * Invisible parts are left out, which is what keeps part-only view from
   * quietly catching clicks on a machine nobody can see.
   */
  pickMeshes() {
    const out = this.bodyMeshes();
    for (const parts of this.proxies.values()) {
      for (const p of parts) if (p.visible && p.isMesh) out.push(p);
    }
    return out;
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
    for (const list of this.models.values()) {
      for (const obj of list) {
        if (!obj.visible) continue;
        b.expandByObject(obj);
        any = true;
      }
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
