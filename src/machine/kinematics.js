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
    axis: patch.axis || (spec ? spec.axis.slice() : [0, 0, 1]),
    origin: patch.origin || [0, 0, 0],
    parent: patch.parent ?? null,
    limits: patch.limits || { min: -1e6, max: 1e6 },
    invert: !!patch.invert,
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
    const values = this.resolve(rawValues || {});
    const t = this.scratch.a;
    const j = this.scratch.b;

    for (const node of this.order) {
      const mat = this.matrices.get(node.id);
      const local = this.locals.get(node.id);
      m4.fromTranslation(t, node.origin);

      if (node.kind === 'linear') {
        const v = this.valueOf(node, values);
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
   * The tool expressed in workpiece coordinates.
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
  linearsForTip(targetTip, values, gaugeLength = 0) {
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
    const rhs = [targetTip[0] - p0[0], targetTip[1] - p0[1], targetTip[2] - p0[2]];
    const sol = m4.solve3(mat, rhs);
    if (!sol) return null;
    return { X: sol[0], Y: sol[1], Z: sol[2] };
  }

  /**
   * Rotary values that point the tool along a given direction in work space.
   *
   * Two rotaries give two degrees of freedom, which is exactly what a
   * direction needs, but the relationship is trigonometric rather than
   * affine and every machine winds it differently. Rather than special-case
   * each configuration, this searches: a coarse sweep to find the basin,
   * then Gauss-Newton to land on it. It runs once per G53.1 block, so the
   * cost is irrelevant and the generality is worth having.
   *
   * @returns {null | Record<string, number>} values for the rotary letters
   */
  rotariesForToolAxis(direction, values, gaugeLength = 0) {
    const rot = this.rotaries();
    if (rot.length < 1) return null;
    const target = m4.normalize(direction);
    const letters = rot.slice(0, 2).map((n) => n.letter);

    const error = (guess) => {
      const axis = this.toolInWork({ ...values, ...guess }, gaugeLength).axis;
      return 1 - m4.dot(axis, target);       // 0 when aligned
    };

    // Coarse sweep. 10-degree steps over both letters is 1296 evaluations of
    // a handful of matrix multiplies — cheap, and it removes any dependence
    // on a good starting guess.
    let best = null;
    const span = letters.map((L) => {
      const node = rot.find((n) => n.letter === L);
      const lo = Math.max(node.limits.min, -360);
      const hi = Math.min(node.limits.max, 360);
      return { L, lo, hi };
    });

    const step = 10;
    const sweep = (idx, guess) => {
      if (idx >= span.length) {
        const e = error(guess);
        if (!best || e < best.e) best = { e, guess: { ...guess } };
        return;
      }
      const { L, lo, hi } = span[idx];
      for (let v = lo; v <= hi; v += step) sweep(idx + 1, { ...guess, [L]: v });
    };
    sweep(0, {});
    if (!best) return null;

    // Refine with a pattern search on a shrinking step. Moving the axes
    // together as well as singly matters: the error surface has diagonal
    // valleys where one-axis-at-a-time descent stalls well short.
    let guess = { ...best.guess };
    let e = best.e;
    const offsets = span.length === 2
      ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
      : [[1], [-1]];

    for (let h = step / 2; h > 1e-7; h *= 0.5) {
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
            // happily walks past a limit to a pose the machine cannot make,
            // and reports success.
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

    if (e >= 1e-10) return null;

    // Prefer the equivalent angle closest to zero that is still in travel.
    for (const { L, lo, hi } of span) {
      let v = guess[L];
      while (v - 360 >= lo && Math.abs(v - 360) < Math.abs(v)) v -= 360;
      while (v + 360 <= hi && Math.abs(v + 360) < Math.abs(v)) v += 360;
      guess[L] = v;
    }
    if (this.violations(guess).length) return null;
    return guess;
  }

  /** Anything outside its travel, for the limit check. */
  violations(values) {
    const resolved = this.resolve(values || {});
    const out = [];
    for (const n of this.axes()) {
      const v = resolved[n.letter] || 0;
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
