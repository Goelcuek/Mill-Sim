// Machine kinematics.
//
// A machine is a tree of joints rooted at the base. Two paths lead away
// from it: one ends at the spindle, the other at the table. Every axis
// belongs to one of them, and which path a rotary sits on is the whole
// difference between a head-head, a head-table and a table-table machine —
// there is no separate code for the three, only different trees.
//
//   head-head    both rotaries on the spindle path
//   head-table   one on each
//   table-table  both on the table path (a trunnion)
//
// Cutting happens in workpiece coordinates, so what the simulator asks for
// is the tool expressed in the work frame:
//
//     M = inverse(workChain) * toolChain
//
// That gives the tool tip and the direction the tool points, which is all
// the material-removal and collision code needs; it never has to know how
// many axes produced them or which ones moved.

import * as m4 from '../core/mat4.js';
import { uid, deg2rad } from '../core/util.js';

/**
 * Letters the interpreter can command, and what they mean by default.
 *
 * X, Y and Z place the tool tip; A, B and C turn about them. U, V and W are
 * the conventional names for a second slide running parallel to X, Y and Z
 * — a quill, a ram, a pallet shuttle, the W of a boring mill — which is how
 * a machine gets a sixth axis without a third rotary.
 */
export const AXIS_LETTERS = {
  X: { kind: 'linear', axis: [1, 0, 0] },
  Y: { kind: 'linear', axis: [0, 1, 0] },
  Z: { kind: 'linear', axis: [0, 0, 1] },
  A: { kind: 'rotary', axis: [1, 0, 0] },
  B: { kind: 'rotary', axis: [0, 1, 0] },
  C: { kind: 'rotary', axis: [0, 0, 1] },
  U: { kind: 'linear', axis: [1, 0, 0] },
  V: { kind: 'linear', axis: [0, 1, 0] },
  W: { kind: 'linear', axis: [0, 0, 1] },
};

/** The three whose values are solved for from a tool-tip position. */
export const TIP_LETTERS = ['X', 'Y', 'Z'];

/**
 * @typedef {object} AxisNode
 * @property {string} id
 * @property {string} name
 * @property {string|null} letter      X Y Z A B C, or null for a plain carrier
 * @property {'linear'|'rotary'|'carrier'} kind
 * @property {number[]} axis           direction of travel or rotation, parent frame
 * @property {number[]} origin         joint position in the parent frame
 * @property {string|null} parent
 * @property {{min:number, max:number}} limits
 * @property {boolean} invert          flip the commanded sign
 * @property {string[]} modelIds       STL models rigidly attached to this node
 * @property {object[]|null} proxy      castings to draw, as plain data
 * @property {string|null} slaveTo      follows another axis's value
 * @property {number} slaveRatio
 */

export function makeAxis(patch = {}) {
  const letter = patch.letter || null;
  const spec = letter ? AXIS_LETTERS[letter] : null;
  return {
    id: patch.id || uid('ax'),
    name: patch.name || (letter ? `${letter} axis` : 'Carrier'),
    letter,
    kind: patch.kind || (spec ? spec.kind : 'carrier'),
    // Any direction, not only along X, Y or Z: a vector in the frame of
    // whatever carries the axis, unit or not. One of zero length has no
    // direction at all and takes the letter's own.
    axis: patch.axis && Math.hypot(...patch.axis) > 1e-12 ? patch.axis.map(Number) : (spec ? spec.axis.slice() : [0, 0, 1]),
    origin: patch.origin || [0, 0, 0],
    parent: patch.parent ?? null,
    limits: patch.limits || { min: -1e6, max: 1e6 },
    invert: !!patch.invert,
    /** A rotary that counts round to 360 and starts again: no limits, the short way round. */
    modulo: !!patch.modulo,
    modelIds: patch.modelIds ? [...patch.modelIds] : [],
    slaveTo: patch.slaveTo || null,
    slaveRatio: patch.slaveRatio ?? 1,
    /**
     * Castings to draw for this joint, as plain data so the presets can
     * describe their own shape without this file knowing about three.js.
     * An axis the user adds has none and gets a generic shape instead.
     */
    proxy: patch.proxy ? patch.proxy.map((s) => ({ ...s })) : null,
    notes: patch.notes || '',
  };
}

export class Kinematics {
  /**
   * @param {{name:string, nodes:AxisNode[], toolNode:string, workNode:string,
   *          spindleOffset?:number[], tableOffset?:number[]}} def
   */
  constructor(def) {
    this.load(def);
  }

  load(def) {
    this.name = def.name || 'Machine';
    this.nodes = (def.nodes || []).map((n) => makeAxis(n));
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.toolNode = def.toolNode || null;
    this.workNode = def.workNode || null;
    /** Spindle gauge line in the tool node's frame. */
    this.spindleOffset = def.spindleOffset || [0, 0, 0];
    /** Fixture face in the work node's frame; the stock sits on it. */
    this.tableOffset = def.tableOffset || [0, 0, 0];
    /** The colour this machine's moving castings are painted. */
    this.accent = def.accent ?? null;
    this.scratch = { a: m4.create(), b: m4.create() };
    this._refGauge = null;
    this._refTip = [0, 0, 0];
    this.rebuild();
  }

  /** Recompute cached orderings after the tree changes. */
  rebuild() {
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.order = this.topoOrder();
    this.matrices = new Map(this.order.map((n) => [n.id, m4.create()]));
    /** Each joint relative to its parent, which is what a scene graph wants. */
    this.locals = new Map(this.order.map((n) => [n.id, m4.create()]));
    this.toolPath = this.pathTo(this.toolNode);
    this.workPath = this.pathTo(this.workNode);
    // Cached against a chain that has just changed shape.
    this._indexZero = null;
    this._indexZeroId = null;
    this._refGauge = null;
    this._bases = new Map();
    this.toolSet = new Set(this.toolPath.map((n) => n.id));
    this.workSet = new Set(this.workPath.map((n) => n.id));
  }

  /** Parents before children, so one pass computes every frame. */
  topoOrder() {
    const out = [];
    const seen = new Set();
    const visit = (node, depth) => {
      if (!node || seen.has(node.id) || depth > 64) return;
      if (node.parent && this.byId.has(node.parent) && !seen.has(node.parent)) {
        visit(this.byId.get(node.parent), depth + 1);
      }
      if (seen.has(node.id)) return;
      seen.add(node.id);
      out.push(node);
    };
    for (const n of this.nodes) visit(n, 0);
    return out;
  }

  children(id) {
    return this.nodes.filter((n) => n.parent === id);
  }

  /**
   * Move a joint's pivot without moving what hangs on it.
   *
   * The pivot is where the joint sits in its parent, and for a rotary it is
   * the centre of rotation — so correcting one on a machine that is already
   * assembled is ordinary work. It used to be impossible: everything inside
   * the joint is expressed in the joint's own frame, so moving that frame
   * dragged the casting, its children and their castings along with it, and
   * the machine you had just got right came apart every time you tried to
   * say where it turns.
   *
   * Moving the frame by d and taking d back off everything inside it leaves
   * the machine looking exactly as it did and turning about somewhere else,
   * which is what setting a pivot means. Child joints are compensated here;
   * the bodies belong to MachineParts, so what they need is returned rather
   * than applied.
   *
   * @param {string} id
   * @param {number[]} origin the new pivot, in the parent's frame
   * @returns {number[]} what to add to the position of each body on this node
   */
  movePivot(id, origin) {
    const node = this.byId.get(id);
    if (!node) return [0, 0, 0];
    const d = [
      origin[0] - node.origin[0],
      origin[1] - node.origin[1],
      origin[2] - node.origin[2],
    ];
    // d is measured in the parent's frame. Inside the joint it is turned by
    // however far the joint is turned — the identity at home, and not while
    // the rig is posed, which is why this reads the pose rather than
    // assuming one.
    const inv = m4.create();
    m4.invertRigid(inv, this.localOf(id));
    const inner = m4.transformDir([0, 0, 0], inv, d);

    node.origin = [origin[0], origin[1], origin[2]];
    for (const child of this.children(id)) {
      child.origin = [
        child.origin[0] - inner[0],
        child.origin[1] - inner[1],
        child.origin[2] - inner[2],
      ];
    }
    this.rebuild();
    return [-inner[0], -inner[1], -inner[2]];
  }

  roots() {
    return this.nodes.filter((n) => !n.parent || !this.byId.has(n.parent));
  }

  /** Chain from the root down to `id`, base first. */
  pathTo(id) {
    const out = [];
    let node = this.byId.get(id);
    let guard = 0;
    while (node && guard++ < 64) {
      out.unshift(node);
      node = node.parent ? this.byId.get(node.parent) : null;
    }
    return out;
  }

  /** Depth of a node, for indenting the tree in the UI. */
  depth(id) {
    return Math.max(0, this.pathTo(id).length - 1);
  }

  /** Which branch a node is on: 'tool', 'work' or 'base'. */
  branchOf(id) {
    if (this.toolSet.has(id) && this.workSet.has(id)) return 'base';
    if (this.toolSet.has(id)) return 'tool';
    if (this.workSet.has(id)) return 'work';
    return 'other';
  }

  /** Every commandable axis, in tree order. */
  axes() {
    return this.order.filter((n) => n.kind !== 'carrier' && n.letter);
  }

  /** Rotary axes, which is what decides the machine's configuration. */
  rotaries() {
    return this.axes().filter((n) => n.kind === 'rotary');
  }

  /**
   * Every axis whose position a tool-tip coordinate does not already say:
   * the rotaries, and any extra linear slide such as U, V or W.
   *
   * These are the axes a program has to command by name, and the ones a
   * move has to carry alongside its tip positions.
   */
  extras() {
    return this.axes().filter((n) => !TIP_LETTERS.includes(n.letter));
  }

  /** Extra linear slides only — U, V, W and anything like them. */
  auxLinears() {
    return this.extras().filter((n) => n.kind === 'linear');
  }

  /** head-head, head-table, table-table, or 3-axis. */
  get configuration() {
    const rot = this.rotaries();
    // An extra slide is named rather than counted into the "5-axis" label,
    // because a W quill does not make a 3-axis mill into a 4-axis one.
    const aux = this.auxLinears();
    const suffix = aux.length ? ` + ${aux.map((n) => n.letter).join('')}` : '';
    if (!rot.length) return `3-axis${suffix}`;
    const onTool = rot.filter((n) => this.toolSet.has(n.id)).length;
    const onWork = rot.filter((n) => this.workSet.has(n.id)).length;
    if (onTool >= 2 && onWork === 0) return `head-head${suffix}`;
    if (onTool >= 1 && onWork >= 1) return `head-table${suffix}`;
    if (onWork >= 2) return `table-table${suffix}`;
    return `${onTool ? '4-axis head' : '4-axis table'}${suffix}`;
  }

  /** Resolve slaved axes, so a follower always mirrors its master. */
  resolve(values) {
    const out = { ...values };
    for (const n of this.order) {
      if (!n.slaveTo || !n.letter) continue;
      const master = this.byId.get(n.slaveTo);
      if (!master || !master.letter) continue;
      out[n.letter] = (out[master.letter] || 0) * (n.slaveRatio ?? 1);
    }
    return out;
  }

  /** Joint value for a node, after slaving, inversion and clamping. */
  valueOf(node, values) {
    if (node.kind === 'carrier' || !node.letter) return 0;
    let v = values[node.letter] || 0;
    if (node.invert) v = -v;
    return v;
  }

  /**
   * Forward kinematics: every node's frame in machine space.
   * @param {Record<string, number>} rawValues axis letter -> value (mm or degrees)
   */
  solve(rawValues) {
    /** What the chain was last posed with, as given; see MachineView.update. */
    this.lastValues = rawValues || {};
    const values = this.resolve(rawValues || {});
    const t = this.scratch.a;
    const j = this.scratch.b;

    for (const node of this.order) {
      const mat = this.matrices.get(node.id);
      const local = this.locals.get(node.id);
      m4.fromTranslation(t, node.origin);

      if (node.kind === 'linear') {
        // The direction is kept as it was typed — 1, 0, 1 for 45° — so a
        // millimetre on the axis is a millimetre along its unit vector.
        const v = this.valueOf(node, values) / (Math.hypot(node.axis[0], node.axis[1], node.axis[2]) || 1);
        m4.fromTranslation(j, [node.axis[0] * v, node.axis[1] * v, node.axis[2] * v]);
        m4.multiply(local, t, j);
      } else if (node.kind === 'rotary') {
        const v = deg2rad(this.valueOf(node, values));
        m4.fromRotation(j, node.axis, v);
        m4.multiply(local, t, j);
      } else {
        m4.copy(local, t);
      }

      const parent = node.parent ? this.matrices.get(node.parent) : null;
      if (parent) m4.multiply(mat, parent, local);
      else m4.copy(mat, local);
    }
    return this.matrices;
  }

  matrixOf(id) {
    return this.matrices.get(id) || m4.create();
  }

  localOf(id) {
    return this.locals.get(id) || m4.create();
  }

  /**
   * The tool expressed in workpiece coordinates: measured from the fixture
   * face the part sits on, in the frame that turns with it — so a rotary
   * turns the part about the axis it really turns about, and linearsForTip
   * is its exact inverse.
   *
   * @param {Record<string, number>} values
   * @param {number} [gaugeLength] tip distance below the spindle gauge line
   * @returns {{tip:number[], axis:number[], matrix:Float64Array}}
   *   `axis` points from the tip back up the tool.
   */
  toolInWork(values, gaugeLength = 0) {
    this.solve(values);
    const toolM = this.matrixOf(this.toolNode);
    const workM = this.matrixOf(this.workNode);

    const invWork = m4.invertRigid(m4.create(), workM);
    const rel = m4.multiply(m4.create(), invWork, toolM);

    // Spindle gauge line, then down the tool to the tip.
    const nose = m4.fromTranslation(m4.create(), this.spindleOffset);
    const down = m4.fromTranslation(m4.create(), [0, 0, -gaugeLength]);
    const frame = m4.multiply(m4.create(), m4.multiply(m4.create(), rel, nose), down);

    // The table offset is where the fixture face sits in the work frame;
    // work coordinates are measured from there.
    const tip = m4.transformPoint([0, 0, 0], frame, [0, 0, 0]);
    const axis = m4.normalize(m4.transformDir([0, 0, 0], frame, [0, 0, 1]));
    return {
      tip: [tip[0] - this.tableOffset[0], tip[1] - this.tableOffset[1], tip[2] - this.tableOffset[2]],
      axis,
      matrix: frame,
    };
  }

  /**
   * The node the coordinate system hangs off, given the indexer's letter.
   *
   * An indexer turns the work without turning the frame the work is
   * measured in: the offset is a place on the table and it stays there
   * whatever angle the part is sitting at. So the coordinate frame is
   * everything the work node carries *except* that rotary, which means
   * the node above it. A machine with no such axis — or one where that
   * letter is a real slide — keeps the work node itself.
   *
   * @param {string|null} letter
   */
  coordNode(letter) {
    if (!letter) return this.workNode;
    let id = this.workNode;
    let guard = 0;
    while (id && guard++ < 64) {
      const node = this.byId.get(id);
      if (!node) break;
      if (node.letter === letter && node.kind === 'rotary') return node.parent || this.workNode;
      id = node.parent;
    }
    return this.workNode;
  }

  /**
   * The transform that carries a point from the coordinate frame onto the
   * part, for the angles given.
   *
   * At the index's zero the two frames are the same point-for-point, which
   * is what makes this the identity there and a rotation about the
   * indexer's own axis, through the indexer's own pivot, everywhere else.
   * It is read off the chain rather than assumed to be a spin about Z: an
   * indexer bolted on at an angle, or turning about -Z as a Fidia's table
   * does, is still just whatever its joint says it is.
   *
   * @param {string} coordId
   * @param {Record<string, number>} values
   * @returns {Float64Array} a 4x4, column major
   */
  indexTransform(coordId, values) {
    const between = (id) => m4.multiply(
      m4.create(), m4.invertRigid(m4.create(), this.matrixOf(id)), this.matrixOf(this.workNode),
    );
    if (!this._indexZero || this._indexZeroId !== coordId) {
      this.solve({});
      this._indexZero = between(coordId);
      this._indexZeroId = coordId;
    }
    this.solve(values);
    return m4.multiply(m4.create(), m4.invertRigid(m4.create(), between(coordId)), this._indexZero);
  }

  /**
   * The tool in part coordinates, measured from where the part zero sits.
   *
   * `toolInWork` answers in the work node's own frame, which is a machine
   * fact: on a VMC with an X/Y table it moves when X moves. What the stock
   * grid needs is the frame the part is set up in, and the tie between the
   * two is the machine at home — with every axis at zero, the programmed
   * point and the tool tip are the same point by definition. Subtracting
   * that reference makes this exact for a 3-axis machine (it collapses to
   * the programmed point) and correct for a rotary: the same X/Y/Z with the
   * table turned puts the tool somewhere else on the part, which is the
   * whole reason non-TCP 5-axis programs look the way they do.
   */
  toolInPart(values, gaugeLength = 0) {
    const ref = this.partOrigin(gaugeLength);
    const r = this.toolInWork(values, gaugeLength);
    return {
      tip: [r.tip[0] - ref[0], r.tip[1] - ref[1], r.tip[2] - ref[2]],
      axis: r.axis,
      matrix: r.matrix,
    };
  }

  /**
   * The table the part sits on, as the machine draws it, in part
   * coordinates: a platter's circle or a slab's rectangle, from the casting
   * on the work node. Null when the work node draws no table — a machine
   * built from the shop's own bodies — and the table setting is what there
   * is to go on.
   *
   * @returns {null | {round?:{cx:number, cy:number, r:number},
   *   xMin?:number, xMax?:number, yMin?:number, yMax?:number}}
   */
  tableFootprint() {
    const i = this.tableSpecIndex();
    if (i < 0) return null;
    const q = this.byId.get(this.workNode).proxy[i];
    const z = this.tableOffset;
    if (q.part === 'rotaryTable') {
      const at = q.at || [0, 0, 0];
      return { round: { cx: at[0] - z[0], cy: at[1] - z[1], r: q.radius } };
    }
    return { xMin: q.min[0] - z[0], xMax: q.max[0] - z[0], yMin: q.min[1] - z[1], yMax: q.max[1] - z[1] };
  }

  /**
   * Which of the work node's castings is the table — the platter or slab
   * the table check stands for — or −1. The castings check leaves it to
   * that one rather than reporting the same plunge twice.
   */
  tableSpecIndex() {
    const node = this.workNode && this.byId.get(this.workNode);
    const list = (node && node.proxy) || [];
    return list.findIndex((q) => (q.part === 'rotaryTable' && q.radius > 0)
      || ((q.part === 'slotted' || q.part === 'block') && q.min && q.max));
  }

  /**
   * Where the part's zero sits in the work frame, for a given tool.
   *
   * This is the tool tip at machine home, which is the point `toolInPart`
   * measures from. It moves with the gauge length, and so it should: hold
   * the Z axis still and fit a longer tool and the tip goes lower, so the
   * part zero the programmed numbers refer to is lower too.
   */
  partOrigin(gaugeLength = 0) {
    if (this._refGauge !== gaugeLength) {
      this._refGauge = gaugeLength;
      this._refTip = this.toolInWork({}, gaugeLength).tip;
    }
    return this._refTip;
  }

  /**
   * The axis a part turns about when the table spins as a lathe spindle:
   * the rotary nearest the table on its side of the chain — C on a
   * trunnion. Given in the frame a move's points are in (the work frame
   * at every rotary zero, from the fixture face), where it stands still
   * whatever any rotary does: it rides on everything above it, and the
   * part rides on it.
   *
   * @returns {null | {letter:string, point:number[], dir:number[]}}
   */
  turningAxis() {
    const path = this.pathTo(this.workNode);
    const node = [...path].reverse().find((n) => n.kind === 'rotary');
    if (!node) return null;
    this.solve({});
    const inv = m4.invertRigid(m4.create(), this.matrixOf(this.workNode));
    const rel = m4.multiply(m4.create(), inv, this.matrixOf(node.id));
    const p = m4.transformPoint([0, 0, 0], rel, [0, 0, 0]);
    const dir = m4.normalize(m4.transformDir([0, 0, 0], rel, node.axis));
    const o = this.tableOffset;
    return { letter: node.letter, point: [p[0] - o[0], p[1] - o[1], p[2] - o[2]], dir };
  }

  /** The tool's direction in part coordinates; only the rotaries matter. */
  toolAxis(values, gaugeLength = 0) {
    return this.toolInWork(values, gaugeLength).axis;
  }

  /**
   * Inverse kinematics for the linear axes.
   *
   * With the rotaries fixed, the tool tip depends on X/Y/Z through a pure
   * translation chain, so the map is affine. Sampling it at the origin and
   * three unit steps recovers that map exactly, and the solve is then one
   * 3x3 system — no iteration, no convergence to worry about. This is what
   * makes TCP mode (G43.4) possible for any chain the user builds rather
   * than only for the configurations someone hard-coded.
   *
   * @returns {null | {X:number, Y:number, Z:number}}
   */
  linearsForTip(targetTip, values, gaugeLength = 0, basis = this.linearBasis(values, gaugeLength)) {
    if (!basis) return null;
    const { p0, mat } = basis;
    const rhs = [targetTip[0] - p0[0], targetTip[1] - p0[1], targetTip[2] - p0[2]];
    const sol = m4.solve3(mat, rhs);
    if (!sol) return null;
    return { X: sol[0], Y: sol[1], Z: sol[2] };
  }

  /**
   * With the rotaries where `values` puts them, the tip is an affine map of
   * X, Y and Z: where it is with all three at zero, and how far a
   * millimetre of each moves it. That is all linearsForTip needs, and a
   * caller asking for many tips at one set of rotaries can keep it.
   *
   * @returns {null | {p0:number[], mat:number[]}} mat column-major, for solve3
   */
  linearBasis(values, gaugeLength = 0) {
    // One set of rotaries and one tool give one basis, and a run asks for
    // the same few thousands of times a second — the travel check, the
    // castings, the readout. Kept until the chain changes shape.
    let key = String(gaugeLength);
    for (const L in values) if (L !== 'X' && L !== 'Y' && L !== 'Z') key += `|${L}${values[L]}`;
    if (!this._bases) this._bases = new Map();
    const kept = this._bases.get(key);
    if (kept !== undefined) return kept;
    const made = this.makeLinearBasis(values, gaugeLength);
    if (this._bases.size > 512) this._bases.clear();
    this._bases.set(key, made);
    return made;
  }

  makeLinearBasis(values, gaugeLength = 0) {
    const letters = ['X', 'Y', 'Z'].filter((L) => this.axes().some((n) => n.letter === L));
    if (letters.length < 3) return null;

    const base = { ...values, X: 0, Y: 0, Z: 0 };
    const p0 = this.toolInWork(base, gaugeLength).tip;

    const cols = [];
    for (const L of letters) {
      const probe = { ...base, [L]: 1 };
      const p = this.toolInWork(probe, gaugeLength).tip;
      cols.push([p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]]);
    }

    // Column-major 3x3 for solve3.
    const mat = [
      cols[0][0], cols[0][1], cols[0][2],
      cols[1][0], cols[1][1], cols[1][2],
      cols[2][0], cols[2][1], cols[2][2],
    ];
    return { p0, mat };
  }

  /**
   * Rotary values that point the tool along a given direction in work space.
   *
   * Two rotaries give two degrees of freedom, which is exactly what a
   * direction needs, but the relationship is trigonometric rather than
   * affine and every machine winds it differently. Rather than special-case
   * each configuration, this searches.
   *
   * Nearly every direction can be reached two ways — A+30 C0 or A−30 C180 —
   * and a control takes the one nearest where the axes already stand, so
   * that is what is asked first: start from here and walk downhill. Only
   * when that fails is the whole travel swept for every basin, and the
   * nearest of what it finds kept. Taking the best of a coarse grid instead
   * flipped the table half a turn between neighbouring points of a vector
   * toolpath, and paid for a 5,000-pose sweep on every block to do it.
   *
   * @param {{all?:boolean}} [opts] `all` returns every pose found instead
   *   of the nearest, for a caller with its own way to choose
   * @returns {null | Record<string, number> | Record<string, number>[]}
   *   values for the rotary letters
   */
  rotariesForToolAxis(direction, values, gaugeLength = 0, { all = false } = {}) {
    const rot = this.rotaries();
    if (rot.length < 1) return null;
    const target = m4.normalize(direction);
    const span = rot.slice(0, 2).map((n) => ({
      L: n.letter,
      lo: Math.max(n.limits.min, -360),
      hi: Math.min(n.limits.max, 360),
    }));
    const now = (L) => Number((values || {})[L]) || 0;

    const error = (guess) => {
      const axis = this.toolInWork({ ...values, ...guess }, gaugeLength).axis;
      return 1 - m4.dot(axis, target);       // 0 when aligned
    };

    // Pattern search on a shrinking step. Moving the axes together as well
    // as singly matters: the error surface has diagonal valleys where
    // one-axis-at-a-time descent stalls well short.
    const offsets = span.length === 2
      ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
      : [[1], [-1]];
    const refine = (seed, start) => {
      let guess = { ...seed };
      let e = error(guess);
      for (let h = start; h > 1e-7 && e > 1e-16; h *= 0.5) {
        let improved = true;
        let guard = 0;
        while (improved && guard++ < 200) {
          improved = false;
          for (const off of offsets) {
            const trial = { ...guess };
            let inTravel = true;
            for (let i = 0; i < span.length; i++) {
              const v = guess[span[i].L] + off[i] * h;
              // The search has to stay inside the travel. Without this it
              // happily walks past a limit to a pose the machine cannot
              // make, and reports success.
              if (v < span[i].lo || v > span[i].hi) { inTravel = false; break; }
              trial[span[i].L] = v;
            }
            if (!inTravel) continue;
            const te = error(trial);
            if (te < e - 1e-18) {
              guess = trial;
              e = te;
              improved = true;
            }
          }
        }
      }
      return { guess, e };
    };

    // The same angle a turn either way, whichever is nearest where the axis
    // stands and still in travel: C−190 rather than C170 when coming from
    // C−180 on a table that turns that far.
    const settle = (guess) => {
      const out = { ...guess };
      for (const { L, lo, hi } of span) {
        let v = out[L];
        const c = now(L);
        while (v - 360 >= lo && Math.abs(v - 360 - c) < Math.abs(v - c)) v -= 360;
        while (v + 360 <= hi && Math.abs(v + 360 - c) < Math.abs(v - c)) v += 360;
        out[L] = v;
      }
      return out;
    };
    const distance = (guess) => span.reduce((sum, { L }) => sum + Math.abs(guess[L] - now(L)), 0);
    const ok = (r) => r.e < 1e-10 && !this.violations({ ...values, ...r.guess }).length;

    const here = {};
    for (const { L, lo, hi } of span) here[L] = Math.min(hi, Math.max(lo, now(L)));
    const local = refine(here, 5);
    if (ok(local) && !all) return settle(local.guess);

    // Nowhere downhill from here: sweep the travel on a 10° grid, keep the
    // best few poses that are not just neighbours of each other, finish
    // each, and take the nearest that arrives.
    const step = 10;
    const grid = [];
    const sweep = (idx, guess) => {
      if (idx >= span.length) { grid.push({ guess: { ...guess }, e: error(guess) }); return; }
      const { L, lo, hi } = span[idx];
      for (let v = lo; v <= hi; v += step) sweep(idx + 1, { ...guess, [L]: v });
    };
    sweep(0, {});
    grid.sort((a, b) => a.e - b.e);
    const seeds = [];
    for (const g of grid) {
      if (seeds.length >= 8) break;
      if (seeds.some((s) => span.every(({ L }) => Math.abs(s.guess[L] - g.guess[L]) <= 2 * step))) continue;
      seeds.push(g);
    }
    const found = ok(local) ? [settle(local.guess)] : [];
    for (const seed of seeds) {
      const r = refine(seed.guess, step / 2);
      if (ok(r)) found.push(settle(r.guess));
    }
    if (all) return found;
    let best = null;
    for (const g of found) if (!best || distance(g) < distance(best)) best = g;
    return best;
  }

  /**
   * Rotary values that put the tool's whole frame where a swivelled plane
   * has it, the way a control swings for CYCLE800, rather than only its
   * direction.
   *
   * The tool axis pins the rotaries everywhere but one place: when a rotary
   * turns about the tool itself, as a C table does under a vertical tool,
   * the direction says nothing about it, and the search leaves it wherever
   * it stopped. The control reads the plane's X there, and so does this:
   * that rotary goes to whatever lines the tool's X up with the plane's,
   * which is C0 for a plane with nothing turned.
   *
   * Of the poses left (A−30 C0 or A+30 C180), `dir` chooses by the `ref`
   * axis as _DIR does: −1 the lower value, +1 the higher. With no `dir`,
   * or both poses at the same value, the nearest wins.
   *
   * @param {Float64Array} frame the plane in work coordinates; its
   *   translation is ignored
   * @param {{ref?:string|null, dir?:number}} [opts]
   * @returns {null | Record<string, number>}
   */
  rotariesForFrame(frame, values, gaugeLength = 0, { ref = null, dir = 0 } = {}) {
    const zT = m4.normalize(m4.transformDir([0, 0, 0], frame, [0, 0, 1]));
    const xT = m4.transformDir([0, 0, 0], frame, [1, 0, 0]);
    const found = this.rotariesForToolAxis(zT, values, gaugeLength, { all: true });
    if (!found || !found.length) return null;
    const now = (L) => Number((values || {})[L]) || 0;
    const rot = this.rotaries().slice(0, 2);
    const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
    const pose = (guess) => this.toolInWork({ ...values, ...guess }, gaugeLength);
    // The turn about the tool, in degrees, from the tool's X to the plane's.
    const residual = (guess) => {
      const m = pose(guess).matrix;
      const x = m4.transformDir([0, 0, 0], m, [1, 0, 0]);
      return Math.atan2(m4.dot(m4.cross(x, xT), zT), m4.dot(x, xT)) * 180 / Math.PI;
    };

    const poses = [];
    for (const g of found) {
      const p = { ...g };
      for (const n of rot) {
        const L = n.letter;
        const turned = { ...p, [L]: p[L] + 10 };
        // Free only if turning it leaves the tool pointing where it was.
        if (1 - m4.dot(pose(turned).axis, zT) > 1e-9) continue;
        const r0 = residual(p);
        const slope = wrap(residual(turned) - r0) / 10;
        if (Math.abs(slope) < 0.5) continue;
        let v = p[L] - r0 / slope;
        const lo = n.modulo ? -Infinity : Math.max(n.limits.min, -360);
        const hi = n.modulo ? Infinity : Math.min(n.limits.max, 360);
        const c = now(L);
        while (v - 360 >= lo && Math.abs(v - 360 - c) < Math.abs(v - c)) v -= 360;
        while (v + 360 <= hi && Math.abs(v + 360 - c) < Math.abs(v - c)) v += 360;
        while (v < lo && v + 360 <= hi) v += 360;
        while (v > hi && v - 360 >= lo) v -= 360;
        // Out of travel either way: the tool still points right, which
        // is the part that matters, so the pose stands as it was found.
        if (v >= lo && v <= hi) p[L] = Math.round(v * 1e9) / 1e9;
      }
      if (this.violations({ ...values, ...p }).length) continue;
      if (!poses.some((q) => rot.every(({ letter }) => Math.abs(q[letter] - p[letter]) < 1e-6))) poses.push(p);
    }
    if (!poses.length) return null;

    const distance = (p) => rot.reduce((sum, { letter }) => sum + Math.abs(p[letter] - now(letter)), 0);
    poses.sort((a, b) => {
      if (ref && dir && Math.abs(a[ref] - b[ref]) > 1e-6) return dir < 0 ? a[ref] - b[ref] : b[ref] - a[ref];
      return distance(a) - distance(b);
    });
    return poses[0];
  }

  /** Anything outside its travel, for the limit check. */
  violations(values) {
    const resolved = this.resolve(values || {});
    const out = [];
    for (const n of this.axes()) {
      const v = resolved[n.letter] || 0;
      if (n.modulo && n.kind === 'rotary') continue;
      if (v < n.limits.min - 1e-6) out.push({ axis: n.letter, value: v, limit: n.limits.min, side: 'min' });
      else if (v > n.limits.max + 1e-6) out.push({ axis: n.letter, value: v, limit: n.limits.max, side: 'max' });
    }
    return out;
  }

  toJSON() {
    return {
      name: this.name,
      nodes: this.nodes,
      toolNode: this.toolNode,
      workNode: this.workNode,
      spindleOffset: this.spindleOffset,
      tableOffset: this.tableOffset,
      accent: this.accent,
    };
  }
}
