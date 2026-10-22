// Cutting loads along a program, measured from the material actually cut.
//
// The simulator calls `sample` for every chunk of a feed move with the
// tool upright, before it carves the chunk. That is the moment the stock
// still holds the metal the chunk is about to take, so the engagement read
// off it is the engagement the cutter meets: for each slice up the flutes,
// which angles on the leading half of the cutter have metal in them. The
// force model (forceModel.js, Shop-Ref's physics) turns that into forces,
// torque and power, and the deflection model into how far the tool bends.
// Every move keeps the worst of what its chunks met.
//
// Nothing here changes the program. It answers "how hard is this cut", so
// the answer can be looked at before anything is allowed to act on it.

import { simulateEngaged, deflection, youngsModulus, powerKw, forceRatios, rakeFactor } from './forceModel.js';
import { materialById, defaultRake } from './materials.js';

/** Immersion bins over the leading half of the cutter, 5° each. */
const BINS = 36;
/** Most slices a sample cuts the flutes into; fewer when the cut is shallow. */
const MAX_SLICES = 24;
/** Rotation steps per revolution for the analysis: 10°, plenty for peaks. */
const STEPS = 36;

/** Per-move results, one value per move. */
const FIELDS = ['force', 'torque', 'power', 'deflection', 'chip', 'ap', 'arc', 'fz'];

/** The cutter types whose definitions carry a helix angle. */
const HELICAL = new Set(['flat', 'ball', 'bull', 'taper']);

/** A tool's default helix when its definition gives none, deg. */
function defaultHelix(type) {
  switch (type) {
    case 'face': case 'chamfer': return 0;
    case 'drill': return 30;
    default: return 35;
  }
}

/**
 * The cutting flank of a tool as a function of height: radius and lead
 * angle at each height above the tip, read off its profile.
 */
function flankOf(built) {
  if (built._flank) return built._flank;
  const pts = built.tool.cuttingPoints || [];
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b.z - a.z > 1e-9) segs.push(a, b);
  }
  const radiusAt = (z) => {
    let r = 0, kappa = Math.PI / 2;
    for (let i = 0; i < segs.length; i += 2) {
      const a = segs[i], b = segs[i + 1];
      if (z < a.z || z > b.z) continue;
      const t = (z - a.z) / (b.z - a.z);
      const rr = a.r + (b.r - a.r) * t;
      if (rr >= r) {
        r = rr;
        // The lead angle is the flank's angle from the axis's normal: 90°
        // on a straight flute, smaller down a ball or a chamfer.
        kappa = Math.atan2(b.z - a.z, Math.abs(b.r - a.r));
      }
    }
    return { r, kappa };
  };
  const tipKappa = (() => {
    // What the end edges meet in a plunge: half the point angle of a drill,
    // flat across an end mill.
    const a = pts[0], b = pts[1];
    if (!a || !b) return Math.PI / 2;
    const k = Math.atan2(Math.abs(b.r - a.r), Math.max(b.z - a.z, 0));
    return Math.min(Math.PI / 2, Math.max(0.2, k));
  })();
  built._flank = { radiusAt, tipKappa, top: built.tool.fluteLength || built.fluteLength || 0 };
  return built._flank;
}

/**
 * The chip a catalogue would start this cutter at, mm (Shop-Ref chipTarget,
 * standard level): insert cutters by the material's ISO group, solid
 * cutters as a fraction of their diameter, HSS three-quarters of carbide.
 * Null for a drill, whose feed is per revolution and judged differently.
 */
export function chipTarget(type, material, diameter, toolMaterial) {
  if (type === 'drill') return null;
  if (type === 'face') return { P: 0.15, M: 0.12, K: 0.18, N: 0.15, S: 0.10, H: 0.08 }[material.group] || 0.12;
  const hss = /hss|high.?speed|cobalt|m42/i.test(String(toolMaterial || ''));
  return material.fzPerD * diameter * (hss ? 0.75 : 1);
}

export class CutAnalyzer {
  constructor() {
    this.material = materialById();
    /** Spindle limits to judge power and torque against; 0 is unknown. */
    this.spindleKw = 0;
    this.spindleNm = 0;
    this.enabled = true;
    this.reset(0);
  }

  setMaterial(id) {
    const next = materialById(id);
    if (next !== this.material) this.invalidate();
    this.material = next;
  }

  /**
   * Start measuring a run.
   *
   * The last run measured to the end is kept apart from the one in
   * progress: going back to look at a move restarts the run from the top,
   * and that must not throw away what the whole program was found to do.
   * It stands until something that would change it changes — see
   * invalidate.
   */
  reset(moveCount) {
    if (this.final && this.final.count !== moveCount) this.final = null;
    this.count = moveCount;
    for (const f of FIELDS) this[f] = new Float32Array(moveCount);
    /** Which moves were plunges, read as drilling rather than side cutting. */
    this.plunge = new Uint8Array(moveCount);
    this.cache = new Map();
    this.samples = 0;
  }

  /** The tool's cutting data, worked out once per assembly. */
  toolOf(slot) {
    const built = slot.built;
    if (built._cutting && built._cutting.material === this.material) return built._cutting;
    const def = built.tool.def;
    const m = this.material;
    const t = {
      material: m,
      type: def.type,
      diameter: 2 * built.cutRadius,
      flutes: Math.max(1, Math.round(def.fluteCount || 2)),
      // Only the cutters whose editor asks for a helix carry one of their
      // own; a face mill's inserts and a chamfer's edges sit straight.
      helix: HELICAL.has(def.type) && Number.isFinite(def.helixAngle) ? def.helixAngle : defaultHelix(def.type),
      rake: Number.isFinite(def.rakeAngle) ? def.rakeAngle : defaultRake(m),
      modulus: youngsModulus(def.material),
      shank: def.shankDiameter || 2 * built.cutRadius,
      stickout: built.stickout || built.tool.length,
      fluteLength: built.fluteLength,
      flank: flankOf(built),
    };
    built._cutting = t;
    return t;
  }

  /**
   * Measure the loads over one chunk of a move.
   *
   * @param {import('../sim/stock.js').Stock} stock  before the chunk is carved
   * @param {object} slot  the assembly in the spindle
   * @param {object} mv    the move
   * @param {number[]} from tip at the start of the chunk, stock frame
   * @param {number[]} to   tip at the end
   */
  sample(stock, slot, mv, from, to) {
    if (!this.enabled || !stock || !slot || mv.kind === 'rapid' || !(mv.rpm > 0)) return;
    const i = mv.i;
    if (!(i >= 0 && i < this.count)) return;
    const tool = this.toolOf(slot);
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const lenXY = Math.hypot(dx, dy);
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return;
    const fz = mv.feed / (mv.rpm * tool.flutes);
    if (!(fz > 0)) return;

    // Straight down, or nearly: the end edges cut, as a drill's lips do.
    if (lenXY < 1e-6 || (dz < 0 && lenXY < -dz * 0.05)) {
      this.plungeAt(stock, tool, mv, to, fz * (-dz / len));
      return;
    }

    const f = [dx / lenXY, dy / lenXY];
    const nL = [-f[1], f[0]];
    const fzXY = fz * (lenXY / len);
    const R = tool.diameter / 2;
    // Along the chunk at a spacing that keeps up with a corner, the far end
    // always included. Points on the leading half are never inside the
    // cutter's own earlier positions on this chunk, so what the stock says
    // there is what is still to be cut.
    const spacing = Math.max(stock.cell * 2, Math.min(R * 0.5, 2));
    const n = Math.max(1, Math.min(16, Math.ceil(lenXY / spacing)));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      this.sideAt(stock, tool, mv, [from[0] + dx * t, from[1] + dy * t, from[2] + dz * t], f, nL, fzXY);
    }
  }

  /** How high the metal stands, above the tip, where a front point lands. */
  heightAbove(stock, tip, f, nL, r, phi) {
    const s = Math.sin(phi), c = Math.cos(phi);
    const qx = tip[0] + r * (s * f[0] + c * nL[0]);
    const qy = tip[1] + r * (s * f[1] + c * nL[1]);
    const ci = Math.floor((qx - stock.origin[0]) / stock.dx);
    const cj = Math.floor((qy - stock.origin[1]) / stock.dy);
    if (ci < 0 || cj < 0 || ci >= stock.nx || cj >= stock.ny) return -Infinity;
    return stock.height[cj * stock.nx + ci] - tip[2];
  }

  /** Side cutting at one point: slice the flutes, read the arc, sum the forces. */
  sideAt(stock, tool, mv, tip, f, nL, fz) {
    const R = tool.diameter / 2;
    const flank = tool.flank;
    // Where the metal the front of the cutter meets stops, at the full and
    // the half radius: the slices are cut at exactly those heights, so a
    // shallow floor pass beside a tall wall is not sliced as thick as the
    // wall is tall.
    const levels = [];
    for (const rr of [R, R * 0.5]) {
      for (let b = 0; b < BINS; b++) {
        const hz = this.heightAbove(stock, tip, f, nL, rr, ((b + 0.5) * Math.PI) / BINS);
        if (hz > 1e-4) levels.push(Math.min(hz, flank.top));
      }
    }
    if (!levels.length) return;
    levels.sort((a, b) => a - b);
    const reach = levels[levels.length - 1];
    // Boundaries: every distinct height the metal stops at, and an even
    // grid besides, so a ball's changing radius is followed up the flank.
    const marks = [0];
    for (const v of levels) if (v - marks[marks.length - 1] > 0.02) marks.push(v);
    const grid = Math.max(reach / 12, 0.05);
    for (let z = grid; z < reach; z += grid) marks.push(z);
    marks.sort((a, b) => a - b);
    const bounds = [0];
    for (const v of marks) if (v - bounds[bounds.length - 1] > 0.01) bounds.push(v);
    if (reach - bounds[bounds.length - 1] > 1e-6) bounds.push(reach);
    while (bounds.length > MAX_SLICES + 1) {
      // Merge the thinnest slice into its neighbour until few enough.
      let best = 1, gap = Infinity;
      for (let i = 1; i < bounds.length - 1; i++) {
        const g = bounds[i + 1] - bounds[i - 1];
        if (g < gap) { gap = g; best = i; }
      }
      bounds.splice(best, 1);
    }

    const slices = [];
    let hash = 2166136261;
    let lo = Infinity, hi = -Infinity, arc = 0;
    for (let k = 0; k + 1 < bounds.length; k++) {
      const z0 = bounds[k], z1 = bounds[k + 1];
      const z = (z0 + z1) / 2;
      const { r, kappa } = flank.radiusAt(z);
      if (!(r > 0)) continue;
      const mask = new Uint8Array(BINS);
      let any = 0;
      for (let b = 0; b < BINS; b++) {
        if (this.heightAbove(stock, tip, f, nL, r, ((b + 0.5) * Math.PI) / BINS) > z) {
          mask[b] = 1;
          any++;
          hash = Math.imul(hash ^ (k * BINS + b + 1), 16777619);
        }
      }
      if (!any) continue;
      hash = Math.imul(hash ^ Math.round(z1 * 1000), 16777619);
      if (z0 < lo) lo = z0;
      if (z1 > hi) hi = z1;
      if (any > arc) arc = any;
      slices.push({ z, dz: z1 - z0, radius: r, kappa, engaged: (phi) => mask[Math.min(BINS - 1, Math.floor((phi / Math.PI) * BINS))] === 1 });
    }
    if (!slices.length) return;

    // The same engagement at the same chip load is the same answer: a slot
    // or a steady wall pass asks it hundreds of times.
    const key = `${hash}:${slices.length}:${fz.toFixed(5)}:${tool.diameter}`;
    let res = this.cache.get(key);
    if (!res) {
      res = simulateEngaged({
        material: tool.material, diameter: tool.diameter, flutes: tool.flutes,
        helixDeg: tool.helix, rakeDeg: tool.rake, fz, slices, steps: STEPS,
      });
      if (this.cache.size > 4000) this.cache.clear();
      this.cache.set(key, res);
    }
    this.samples++;
    const ap = hi - lo;
    const bend = deflection({
      diameter: tool.diameter, shankDiameter: tool.shank, stickout: tool.stickout,
      fluteLength: Math.min(tool.fluteLength, tool.stickout), youngsModulus: tool.modulus,
      force: res.peakFxy, loadFromTip: (lo + hi) / 2,
    }, 60);
    this.keep(mv.i, {
      force: res.peakFxy,
      torque: res.peakTorque,
      power: powerKw(res.meanTorque, mv.rpm),
      deflection: bend.tipDeflection,
      chip: res.maxChip,
      ap,
      arc: (arc / BINS) * 180,
      fz,
    });
  }

  /**
   * A plunge, read as drilling with the end edges: each lip cuts a chip of
   * the axial feed per tooth across the radius, at the point's half angle.
   * An approximation, and said to be one; the side-cutting model is the
   * one this was built for.
   */
  plungeAt(stock, tool, mv, tip, fzAxial) {
    const R = tool.diameter / 2;
    // The real columns under the cutter, not the tile maxima: a tile holds
    // the highest column anywhere in it, and a plunge into a faced-off top
    // read as cutting the metal that used to be there.
    const top = this.highestUnder(stock, tip, R);
    if (!(top > tip[2] + 1e-4)) return;
    const m = tool.material;
    const kappa = tool.flank.tipKappa;
    const hChip = fzAxial * Math.sin(kappa);
    if (!(hChip > 0)) return;
    const b = R / Math.max(Math.sin(kappa), 1e-3);
    const ft = m.kc11 * rakeFactor(tool.rake) * b * hChip ** (1 - m.mc);
    const ratios = forceRatios(m.frictionAngle, tool.rake, tool.helix);
    const torque = (tool.flutes * ft * (R / 2)) / 1000;
    const thrust = tool.flutes * ft * ratios.radial * Math.sin(kappa);
    this.samples++;
    this.plunge[mv.i] = 1;
    this.keep(mv.i, {
      force: thrust, torque, power: powerKw(torque, mv.rpm), deflection: 0,
      chip: hChip, ap: Math.min(top - tip[2], tool.flank.top), arc: 180, fz: fzAxial,
    });
  }

  /** The highest metal within a radius of a point, read column by column. */
  highestUnder(stock, tip, R) {
    const i0 = Math.max(0, Math.floor((tip[0] - R - stock.origin[0]) / stock.dx));
    const i1 = Math.min(stock.nx - 1, Math.floor((tip[0] + R - stock.origin[0]) / stock.dx));
    const j0 = Math.max(0, Math.floor((tip[1] - R - stock.origin[1]) / stock.dy));
    const j1 = Math.min(stock.ny - 1, Math.floor((tip[1] + R - stock.origin[1]) / stock.dy));
    // A face mill covers tens of thousands of columns; a few thousand say
    // whether there is metal under it just as well.
    const stride = Math.max(1, Math.ceil(Math.sqrt(((i1 - i0 + 1) * (j1 - j0 + 1)) / 4000)));
    const R2 = R * R;
    let top = -Infinity;
    for (let j = j0; j <= j1; j += stride) {
      const y = stock.cy(j) - tip[1];
      for (let i = i0; i <= i1; i += stride) {
        const x = stock.cx(i) - tip[0];
        if (x * x + y * y > R2) continue;
        const h = stock.height[j * stock.nx + i];
        if (h > top) top = h;
      }
    }
    return top;
  }

  /** The run reached the end: what it measured is the program's answer. */
  finish() {
    const snap = { count: this.count, plunge: this.plunge.slice() };
    for (const k of FIELDS) snap[k] = this[k].slice();
    this.final = snap;
  }

  /** The program, the tools, the stock or the material changed. */
  invalidate() { this.final = null; }

  /** The measurements to show: the last whole run, or the one going on. */
  get view() { return this.final || this; }

  keep(i, v) {
    for (const k of FIELDS) if (v[k] > this[k][i]) this[k][i] = v[k];
  }

  /** The worst of everything, and where, for the results page. */
  summary(program) {
    const src = this.view;
    const moves = program ? program.moves : [];
    const byTool = new Map();
    for (let i = 0; i < src.count && i < moves.length; i++) {
      if (!(src.force[i] > 0)) continue;
      const tool = moves[i].tool || 0;
      let t = byTool.get(tool);
      if (!t) { t = { tool, moves: 0 }; for (const k of FIELDS) t[k] = { value: 0, line: 0, move: -1 }; byTool.set(tool, t); }
      t.moves++;
      for (const k of FIELDS) {
        if (src[k][i] > t[k].value) t[k] = { value: src[k][i], line: moves[i].line, move: i, plunge: !!src.plunge[i] };
      }
    }
    return [...byTool.values()].sort((a, b) => a.tool - b.tool);
  }
}

export { FIELDS as LOAD_FIELDS };
