// Turning tools: an insert on a bar, held still in the milling spindle
// while the table turns the part.
//
// A milling cutter is a shape turned round its own axis, so a profile up
// that axis says everything about it. A turning tool is not: it is a flat
// insert, standing in the plane through the part's axis, on the end of a
// bar. So it is described in that plane, in two coordinates:
//
//   u  across, into the tool body: outward from the part's axis for an
//      outside (OD) tool, inward for an inside (ID) one
//   w  up the tool axis, from the tip towards the spindle
//
// The programmed point is the origin — the imaginary tip, where the two
// tangents to the nose square to u and w meet, which is the point a
// control moves when no nose-radius compensation is on. The part's axis
// runs along w, the way it does on a mill-turn table with the tool upright
// above it, so a point (u, w) of the tool is at radius r_tip ± u and
// height z_tip + w.

/** Included angle of each ISO insert shape, degrees. */
export const INSERT_SHAPES = {
  C: { label: 'C — 80° rhombic', angle: 80 },
  D: { label: 'D — 55° rhombic', angle: 55 },
  V: { label: 'V — 35° rhombic', angle: 35 },
  W: { label: 'W — 80° trigon', angle: 80 },
  T: { label: 'T — 60° triangle', angle: 60, triangle: true },
  S: { label: 'S — 90° square', angle: 90 },
  R: { label: 'R — round', round: true },
};

const rad = (d) => (d * Math.PI) / 180;
const dir = (deg) => [Math.cos(rad(deg)), Math.sin(rad(deg))];
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * A corner rounded to radius `rn`: the arc that replaces corner `c`
 * between the edges running from it towards `a` and towards `b`.
 */
function roundCorner(c, a, b, rn, steps = 8) {
  const ua = norm([a[0] - c[0], a[1] - c[1]]);
  const ub = norm([b[0] - c[0], b[1] - c[1]]);
  const half = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1]))) / 2;
  if (!(rn > 0) || half < 1e-6) return Object.assign([c], { centre: c.slice() });
  const tangent = rn / Math.tan(half);
  const bis = norm([ua[0] + ub[0], ua[1] + ub[1]]);
  const centre = [c[0] + bis[0] * (rn / Math.sin(half)), c[1] + bis[1] * (rn / Math.sin(half))];
  const p0 = [c[0] + ua[0] * tangent, c[1] + ua[1] * tangent];
  const p1 = [c[0] + ub[0] * tangent, c[1] + ub[1] * tangent];
  const a0 = Math.atan2(p0[1] - centre[1], p0[0] - centre[0]);
  let a1 = Math.atan2(p1[1] - centre[1], p1[0] - centre[0]);
  // The short way round, which is the way the corner goes.
  while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
  while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
  // Evenly round, and through every point square to u or w the arc
  // passes — the points the tangents that set a tool are taken at.
  const angles = [];
  for (let k = 0; k <= steps; k++) angles.push(a0 + ((a1 - a0) * k) / steps);
  const lo = Math.min(a0, a1);
  const hi = Math.max(a0, a1);
  for (let q = Math.ceil(lo / (Math.PI / 2)); q * (Math.PI / 2) <= hi; q++) {
    const t = q * (Math.PI / 2);
    if (t > lo + 1e-9 && t < hi - 1e-9) angles.push(t);
  }
  angles.sort((x, y) => (a1 >= a0 ? x - y : y - x));
  const out = angles.map((t) => [centre[0] + rn * Math.cos(t), centre[1] + rn * Math.sin(t)]);
  out.centre = centre;
  return out;
}

function norm(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Shift an outline so `p` is the origin. */
const moveTo = (poly, p) => poly.map(([u, w]) => [u - p[0], w - p[1]]);

/**
 * The tool's outline in its own plane.
 *
 * @param {object} t a tool definition of type turn, groove or thread
 * @returns {{insert:number[][], bar:{u0:number,u1:number,w0:number,w1:number,thick:number},
 *   axisU:number, side:'OD'|'ID', kind:string, warnings:string[]}}
 */
export function turningOutline(t) {
  const warnings = [];
  const side = t.side === 'ID' ? 'ID' : 'OD';
  const length = Math.max(num(t.overallLength, 100), 10);
  const bar = Math.max(num(t.shankWidth, 20), 2);
  let insert;
  // The centre of the nose's radius, in the same frame: the other point a
  // tool can be measured to.
  let centre = [0, 0];

  if (t.type === 'groove') {
    // A blade plunging in along −u: its cutting edge is the end at u = 0,
    // as wide as the groove, the two corners rounded.
    const width = Math.max(num(t.grooveWidth, 3), 0.1);
    const depth = Math.max(num(t.grooveDepth, 10), 0.5);
    const rc = Math.min(Math.max(num(t.cornerRadius, 0.2), 0), width / 2 - 1e-3);
    const box = [[0, 0], [depth, 0], [depth, width], [0, width]];
    // The reference corner is the one at the origin, and its radius's centre.
    centre = [rc, rc];
    insert = [
      ...roundCorner(box[0], box[3], box[1], rc, 4),
      box[1], box[2],
      ...roundCorner(box[3], box[2], box[0], rc, 4),
    ];
  } else if (t.type === 'thread') {
    // A point of the thread's flank angle, square to the part: the tip is
    // the programmed point, the flanks either side of it.
    const angle = Math.min(Math.max(num(t.threadAngle, 60), 10), 120);
    const h = Math.max(num(t.insertSize, 8) / 2, 1);
    const spread = h * Math.tan(rad(angle / 2));
    const rn = Math.max(num(t.noseRadius, 0.1), 0);
    const tip = [0, 0];
    const a = [h, -spread];
    const b = [h, spread];
    const arc = roundCorner(tip, b, a, Math.min(rn, h * 0.2), 4);
    insert = [...arc, a, b];
    // The point of the tip, rounded or not, is the reference.
    const lowest = insert.reduce((m, p) => (p[0] < m[0] ? p : m), insert[0]);
    insert = moveTo(insert, [lowest[0], 0]);
    centre = [arc.centre[0] - lowest[0], 0];
  } else {
    const shape = INSERT_SHAPES[t.insertShape] || INSERT_SHAPES.C;
    const L = Math.max(num(t.insertSize, 12), 1);
    const rn = Math.max(num(t.noseRadius, 0.8), 0);
    if (shape.round) {
      // A round insert: a circle, the imaginary tip its lowest, innermost corner.
      const r = L / 2;
      centre = [r, r];
      insert = [];
      for (let k = 0; k < 32; k++) {
        const th = (2 * Math.PI * k) / 32;
        insert.push([r + r * Math.cos(th), r + r * Math.sin(th)]);
      }
    } else {
      // The two edges leave the nose at the lead angle's complement and
      // the included angle further round: κr 95° on an 80° rhombus is one
      // edge rising 5° from square to the axis and the other 5° off it.
      const lead = Math.min(Math.max(num(t.leadAngle, 95), 30), 120);
      const e1 = lead - 90;
      const e2 = e1 + shape.angle;
      if (e2 >= 180) warnings.push(`A ${lead}° lead with a ${shape.angle}° insert puts the trailing edge past square; check the angles.`);
      const d1 = dir(e1);
      const d2 = dir(e2);
      const nose = [0, 0];
      const a = [d1[0] * L, d1[1] * L];
      const c = [d2[0] * L, d2[1] * L];
      const corners = shape.triangle ? [nose, a, c] : [nose, a, [a[0] + c[0], a[1] + c[1]], c];
      const noseArc = roundCorner(nose, corners[corners.length - 1], a, rn, 8);
      insert = [...noseArc, ...corners.slice(1)];
      // The imaginary tip: the tangents to the nose square to u and to w.
      let uMin = Infinity, wMin = Infinity;
      for (const [u, w] of noseArc) {
        if (u < uMin) uMin = u;
        if (w < wMin) wMin = w;
      }
      insert = moveTo(insert, [uMin, wMin]);
      centre = [noseArc.centre[0] - uMin, noseArc.centre[1] - wMin];
    }
  }

  let uMax = 0, wMax = 0, wMin = 0;
  for (const [u, w] of insert) {
    if (u > uMax) uMax = u;
    if (w > wMax) wMax = w;
    if (w < wMin) wMin = w;
  }
  // The bar stands on the insert, set back from the tip so the insert
  // reaches past it: a third of the way in, and up from its lowest point.
  // A grooving blade reaches out past the bar by all of its depth, or the
  // bar would be in the groove.
  const u0 = t.type === 'groove' ? uMax : Math.max(uMax * 0.35, 1);
  const w0 = t.type === 'thread' ? wMax : t.type === 'groove' ? wMin : Math.max(wMax * 0.5, wMin + 1);
  if (length <= w0 + 5) warnings.push('The tool is shorter than its insert; lengthened.');
  // What the tool was zeroed to, and so the point the program moves: the
  // imaginary tip, or the centre of the nose radius — the whole tool
  // moved so that is the origin.
  const at = t.trackingPoint === 'centre' ? centre : [0, 0];
  return {
    kind: t.type,
    side,
    insert: moveTo(insert, at),
    bar: { u0: u0 - at[0], u1: u0 + bar - at[0], w0: w0 - at[1], w1: Math.max(length, w0 + 5) - at[1], thick: bar },
    // The spindle's own axis runs up the middle of the bar.
    axisU: u0 + bar / 2 - at[0],
    tracking: at[0] || at[1] ? 'centre' : 'tip',
    // Where the other point is, from this one.
    noseCentre: [centre[0] - at[0], centre[1] - at[1]],
    warnings,
  };
}

/**
 * The insert placed at a tip: its outline as [r, z] about the part's axis,
 * for a tip at radius `r` and height `z`. An inside tool's body is towards
 * the axis, so its u counts inward.
 */
export function outlineAt(outline, r, z) {
  const s = outline.side === 'ID' ? -1 : 1;
  return outline.insert.map(([u, w]) => [r + s * u, z + w]);
}

/**
 * The convex hull of points in the plane: the insert swept along a straight
 * move is the hull of where it starts and where it ends.
 */
export function hull2(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let k = p.length - 1; k >= 0; k--) {
    const q = p[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
