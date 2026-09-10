// A parametric 3-axis vertical machining centre.
//
// Two display modes share one kinematic model:
//
//   part     – the workpiece stays put and the spindle flies around it.
//              This is what you want while inspecting a cut.
//   machine  – the table carries the workpiece in X and Y and the head
//              moves in Z, the way the real machine does. Useful for
//              spotting travel and clearance problems.

import * as THREE from 'three';

export const DEFAULT_MACHINE = {
  name: '3-axis VMC',
  travel: [760, 430, 510],
  tableSize: [900, 460],
  /** Scene Z of the table top; the stock normally sits on fixtures above it. */
  tableZ: -80,
  /** Where the spindle centreline sits in scene X/Y when the table is at zero. */
  spindleAt: [0, 0],
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

const STEEL = { color: 0xb9bfca, metalness: 0.55, roughness: 0.5 };
const CAST = { color: 0xd6dae1, metalness: 0.15, roughness: 0.85 };
const TABLE = { color: 0xc9ced8, metalness: 0.7, roughness: 0.3 };

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
    this.tableGroup = new THREE.Group();
    this.headGroup = new THREE.Group();
    this.staticGroup = new THREE.Group();

    this.group.add(this.staticGroup);
    this.group.add(this.tableGroup);
    this.group.add(this.headGroup);
    this.tableGroup.add(this.workGroup);

    this.materials = {
      steel: new THREE.MeshStandardMaterial(STEEL),
      cast: new THREE.MeshStandardMaterial(CAST),
      table: new THREE.MeshStandardMaterial(TABLE),
      slot: new THREE.LineBasicMaterial({ color: 0x8d94a2 }),
      limit: new THREE.LineBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.5 }),
    };
    this.config = { ...DEFAULT_MACHINE };
    this.parts = [];
    this.limitBox = null;
    this.setConfig(this.config);
  }

  setConfig(cfg) {
    this.config = { ...DEFAULT_MACHINE, ...cfg, limits: { ...DEFAULT_MACHINE.limits, ...(cfg.limits || {}) }, table: { ...DEFAULT_MACHINE.table, ...(cfg.table || {}) } };
    this.rebuild();
  }

  rebuild() {
    for (const p of this.parts) {
      p.geometry.dispose();
      p.parent.remove(p);
    }
    this.parts = [];

    const c = this.config;
    const [tw, td] = c.tableSize;
    const tableTop = c.tableZ;
    const tableThickness = 70;
    const baseHeight = 260;

    const track = (mesh, parent) => {
      parent.add(mesh);
      this.parts.push(mesh);
      return mesh;
    };

    // Base casting and plinth (static).
    track(box(tw * 0.95, td * 1.5, baseHeight, this.materials.cast, 0, -20, tableTop - tableThickness - baseHeight), this.staticGroup);
    track(box(tw * 0.6, td * 0.9, 90, this.materials.steel, 0, -20, tableTop - tableThickness - 90), this.staticGroup);

    // Column behind the table, with the top casting overhanging the spindle.
    const colDepth = 220;
    const colY = td * 0.75 + colDepth * 0.5;
    const colHeight = c.travel[2] + 420;
    const colBase = tableTop - tableThickness;
    track(box(tw * 0.58, colDepth, colHeight, this.materials.cast, 0, colY, colBase), this.staticGroup);
    track(box(tw * 0.62, colDepth * 1.4, 100, this.materials.cast, 0, colY - 60, colBase + colHeight), this.staticGroup);
    // Z-axis way cover down the front face of the column.
    track(box(190, 26, colHeight * 0.92, this.materials.steel, c.spindleAt[0], colY - colDepth / 2 - 13, colBase + 40), this.staticGroup);

    // Table (moves in X and Y).
    const table = track(box(tw, td, tableThickness, this.materials.table, 0, 0, tableTop - tableThickness), this.tableGroup);
    table.name = 'table';
    this.addTSlots(tw, td, tableTop);

    // Spindle head (moves in Z). Its local origin is the tool tip, so the
    // castings are offset upwards by the length of whatever assembly is
    // loaded — see setAssemblyLength().
    this.headCasting = track(box(250, 230, 330, this.materials.cast, c.spindleAt[0], c.spindleAt[1] + 40, 0), this.headGroup);
    this.headSlide = track(box(180, 60, 300, this.materials.steel, c.spindleAt[0], c.spindleAt[1] + 175, 20), this.headGroup);
    this.setAssemblyLength(this.assemblyLength || 200);

    this.buildLimitBox();
    this.setMode(c.mode);
    this.group.visible = c.visible;
  }

  addTSlots(tw, td, tableTop) {
    const slots = 5;
    const pts = [];
    for (let i = 0; i < slots; i++) {
      const y = -td / 2 + (td * (i + 0.5)) / slots;
      pts.push(new THREE.Vector3(-tw / 2, y, tableTop + 0.4), new THREE.Vector3(tw / 2, y, tableTop + 0.4));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const lines = new THREE.LineSegments(g, this.materials.slot);
    lines.name = 't-slots';
    this.tableGroup.add(lines);
    this.parts.push(lines);
  }

  buildLimitBox() {
    if (this.limitBox) {
      this.limitBox.geometry.dispose();
      this.group.remove(this.limitBox);
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
    if (this.headCasting) this.headCasting.position.z = this.assemblyLength + 165;
    if (this.headSlide) this.headSlide.position.z = this.assemblyLength + 170;
  }

  /** 'part' or 'machine'. */
  setMode(mode) {
    this.config.mode = mode === 'machine' ? 'machine' : 'part';
    const machine = this.config.mode === 'machine';
    this.staticGroup.visible = machine && this.config.visible;
    this.headGroup.visible = machine && this.config.visible;
    for (const p of this.parts) {
      if (p.parent === this.tableGroup) p.visible = machine && this.config.visible;
    }
    this.update(this.lastPos || [0, 0, 0]);
  }

  setVisible(v) {
    this.config.visible = v;
    this.setMode(this.config.mode);
  }

  /**
   * Move the machine to put the tool tip at a work-coordinate position.
   * @returns {[number,number,number]} where the tool tip sits in the scene
   */
  update(pos) {
    this.lastPos = [pos[0], pos[1], pos[2]];
    const c = this.config;
    if (c.mode === 'machine') {
      this.tableGroup.position.set(c.spindleAt[0] - pos[0], c.spindleAt[1] - pos[1], 0);
      this.headGroup.position.set(0, 0, pos[2]);
      return [c.spindleAt[0], c.spindleAt[1], pos[2]];
    }
    this.tableGroup.position.set(0, 0, 0);
    this.headGroup.position.set(0, 0, pos[2]);
    return [pos[0], pos[1], pos[2]];
  }

  /** Scene-space bounding box of the whole machine. */
  boundingBox() {
    const b = new THREE.Box3();
    b.setFromObject(this.staticGroup);
    return b;
  }

  dispose() {
    for (const p of this.parts) {
      p.geometry.dispose();
      if (p.parent) p.parent.remove(p);
    }
    this.parts = [];
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
