// Parametric cutting-tool definitions.
//
// A tool is plain JSON so it can be stored, exported and diffed. Everything
// the renderer and the simulator need is derived from it by `buildTool()`,
// which turns the parameters into two silhouettes (cutting region and
// non-cutting body) plus the lower-envelope tables used by the hot loops.

import { arcPoints, buildEnvelope, dedupe } from './envelope.js';
import { deg2rad, num, uid } from '../core/util.js';
import { MM_PER_INCH } from '../core/util.js';

/** Cutter families the parametric editor understands. */
export const TOOL_TYPES = {
  flat: {
    label: 'Flat end mill',
    fields: ['diameter', 'fluteLength', 'fluteCount', 'shankDiameter', 'overallLength', 'neckDiameter', 'neckLength'],
  },
  ball: {
    label: 'Ball nose',
    fields: ['diameter', 'fluteLength', 'fluteCount', 'shankDiameter', 'overallLength', 'neckDiameter', 'neckLength'],
  },
  bull: {
    label: 'Bull nose / corner radius',
    fields: ['diameter', 'cornerRadius', 'fluteLength', 'fluteCount', 'shankDiameter', 'overallLength', 'neckDiameter', 'neckLength'],
  },
  chamfer: {
    label: 'Chamfer / V-bit',
    fields: ['diameter', 'tipDiameter', 'tipAngle', 'fluteCount', 'shankDiameter', 'overallLength'],
  },
  taper: {
    label: 'Tapered end mill',
    fields: ['tipDiameter', 'taperAngle', 'cornerRadius', 'fluteLength', 'fluteCount', 'shankDiameter', 'overallLength'],
  },
  drill: {
    label: 'Twist drill',
    fields: ['diameter', 'tipAngle', 'fluteLength', 'fluteCount', 'shankDiameter', 'overallLength'],
  },
  face: {
    label: 'Face mill / shell',
    fields: ['diameter', 'cornerRadius', 'fluteLength', 'fluteCount', 'shankDiameter', 'overallLength'],
  },
  lollipop: {
    label: 'Lollipop / undercut',
    fields: ['diameter', 'neckDiameter', 'neckLength', 'fluteCount', 'shankDiameter', 'overallLength'],
  },
};

/** Every parameter the editor can show, with metadata for the UI. */
export const TOOL_FIELDS = {
  diameter: { label: 'Cutting diameter', unit: 'mm', min: 0.05, step: 0.1 },
  tipDiameter: { label: 'Tip diameter', unit: 'mm', min: 0, step: 0.1 },
  cornerRadius: { label: 'Corner radius', unit: 'mm', min: 0, step: 0.1 },
  tipAngle: { label: 'Included tip angle', unit: '°', min: 1, max: 179, step: 1 },
  taperAngle: { label: 'Taper per side', unit: '°', min: 0, max: 60, step: 0.5 },
  fluteLength: { label: 'Flute length (LOC)', unit: 'mm', min: 0.1, step: 1 },
  fluteCount: { label: 'Flutes', unit: '', min: 1, max: 20, step: 1, integer: true },
  shankDiameter: { label: 'Shank diameter', unit: 'mm', min: 0.5, step: 0.5 },
  neckDiameter: { label: 'Neck diameter', unit: 'mm', min: 0, step: 0.1 },
  neckLength: { label: 'Neck length', unit: 'mm', min: 0, step: 1 },
  overallLength: { label: 'Overall length (OAL)', unit: 'mm', min: 1, step: 1 },
};

export const DEFAULT_TOOL = {
  id: '',
  name: 'New tool',
  type: 'flat',
  number: 1,
  diameter: 10,
  tipDiameter: 0,
  cornerRadius: 0,
  tipAngle: 90,
  taperAngle: 5,
  fluteLength: 25,
  fluteCount: 4,
  shankDiameter: 10,
  neckDiameter: 0,
  neckLength: 0,
  overallLength: 75,
  material: 'carbide',
  coating: 'AlTiN',
  color: '#c8ccd4',
  notes: '',
  cutting: { rpm: 6000, feed: 900, plunge: 300, doc: 2, woc: 4 },
};

/** Convert a tool authored in inches into the internal millimetre model. */
export function toolFromInches(def) {
  const scaled = { ...def };
  for (const key of ['diameter', 'tipDiameter', 'cornerRadius', 'fluteLength', 'shankDiameter', 'neckDiameter', 'neckLength', 'overallLength']) {
    if (Number.isFinite(scaled[key])) scaled[key] *= MM_PER_INCH;
  }
  return scaled;
}

export function makeTool(patch = {}) {
  return { ...DEFAULT_TOOL, ...patch, id: patch.id || uid('tool'), cutting: { ...DEFAULT_TOOL.cutting, ...(patch.cutting || {}) } };
}

const ARC_STEPS = 48;

/**
 * Turn a tool definition into geometry.
 *
 * @returns {{
 *   def: object, cuttingPoints: Array, bodyPoints: Array, silhouette: Array,
 *   cutEnvelope: import('./envelope.js').Envelope,
 *   bodyEnvelope: import('./envelope.js').Envelope,
 *   radius: number, fluteLength: number, length: number, warnings: string[]
 * }}
 */
export function buildTool(def) {
  const t = { ...DEFAULT_TOOL, ...def };
  const warnings = [];

  const D = Math.max(num(t.diameter, 6), 0.01);
  const R = D / 2;
  const shankR = Math.max(num(t.shankDiameter, D) / 2, 0.05);
  let flute = Math.max(num(t.fluteLength, D * 2), 0.05);
  let oal = Math.max(num(t.overallLength, flute * 3), flute + 1);

  /** Silhouette of the cutting region, from the tip upwards. */
  let cut = [];

  switch (t.type) {
    case 'ball': {
      const r = R;
      cut.push({ r: 0, z: 0 });
      cut.push(...arcPoints(0, r, r, -Math.PI / 2, 0, ARC_STEPS));
      if (flute < r) {
        warnings.push('Flute length is shorter than the ball radius; clamped.');
        flute = r;
      }
      cut.push({ r: R, z: flute });
      break;
    }
    case 'bull': {
      let rc = Math.min(Math.max(num(t.cornerRadius, 0), 0), R);
      if (rc <= 0) warnings.push('Corner radius of 0 behaves as a flat end mill.');
      const flatR = R - rc;
      cut.push({ r: 0, z: 0 });
      if (flatR > 0) cut.push({ r: flatR, z: 0 });
      if (rc > 0) cut.push(...arcPoints(flatR, rc, rc, -Math.PI / 2, 0, ARC_STEPS));
      if (flute < rc) flute = rc;
      cut.push({ r: R, z: flute });
      break;
    }
    case 'chamfer': {
      const tipR = Math.min(Math.max(num(t.tipDiameter, 0) / 2, 0), R - 1e-4);
      const half = deg2rad(Math.min(Math.max(num(t.tipAngle, 90), 1), 179) / 2);
      const rise = (R - tipR) / Math.tan(half);
      cut.push({ r: 0, z: 0 });
      if (tipR > 0) cut.push({ r: tipR, z: 0 });
      cut.push({ r: R, z: rise });
      flute = Math.max(flute, rise);
      cut.push({ r: R, z: flute });
      break;
    }
    case 'drill': {
      const half = deg2rad(Math.min(Math.max(num(t.tipAngle, 118), 30), 179) / 2);
      const rise = R / Math.tan(half);
      cut.push({ r: 0, z: 0 });
      cut.push({ r: R, z: rise });
      flute = Math.max(flute, rise + 0.1);
      cut.push({ r: R, z: flute });
      break;
    }
    case 'taper': {
      const tipR = Math.max(num(t.tipDiameter, 1) / 2, 0);
      const rc = Math.min(Math.max(num(t.cornerRadius, 0), 0), tipR);
      const ang = deg2rad(Math.min(Math.max(num(t.taperAngle, 5), 0), 60));
      const flatR = tipR - rc;
      cut.push({ r: 0, z: 0 });
      if (flatR > 0) cut.push({ r: flatR, z: 0 });
      if (rc > 0) cut.push(...arcPoints(flatR, rc, rc, -Math.PI / 2, ang, ARC_STEPS));
      const startZ = rc > 0 ? rc + rc * Math.sin(ang) - rc : 0;
      const startR = rc > 0 ? flatR + rc * Math.cos(ang) : tipR;
      const topR = startR + (flute - startZ) * Math.tan(ang);
      cut.push({ r: topR, z: flute });
      break;
    }
    case 'face': {
      const rc = Math.min(Math.max(num(t.cornerRadius, 0.8), 0), R * 0.5);
      const flatR = R - rc;
      cut.push({ r: 0, z: 0 });
      if (flatR > 0) cut.push({ r: flatR, z: 0 });
      if (rc > 0) cut.push(...arcPoints(flatR, rc, rc, -Math.PI / 2, 0, 16));
      cut.push({ r: R, z: Math.max(flute, rc) });
      flute = Math.max(flute, rc);
      break;
    }
    case 'lollipop': {
      const r = R;
      cut.push({ r: 0, z: 0 });
      cut.push(...arcPoints(0, r, r, -Math.PI / 2, Math.PI / 2, ARC_STEPS * 2));
      flute = 2 * r;
      warnings.push('Undercut geometry is drawn and collision-checked, but the heightmap cutting model cannot remove material beneath an overhang.');
      break;
    }
    case 'flat':
    default: {
      cut.push({ r: 0, z: 0 });
      cut.push({ r: R, z: 0 });
      cut.push({ r: R, z: flute });
      break;
    }
  }

  cut = dedupe(cut);
  const cutTopR = cut[cut.length - 1].r;
  const cutTopZ = cut[cut.length - 1].z;

  // Non-cutting body: optional reduced neck, then the shank up to the OAL.
  const body = [];
  const neckD = num(t.neckDiameter, 0);
  const neckL = num(t.neckLength, 0);
  let z = cutTopZ;
  let r = cutTopR;
  body.push({ r, z });

  if (t.type === 'lollipop') {
    const nr = Math.max(neckD / 2, 0.2);
    const nl = Math.max(neckL, 1);
    body.push({ r: nr, z });
    body.push({ r: nr, z: z + nl });
    z += nl;
    r = nr;
  } else if (neckD > 0 && neckL > 0) {
    const nr = neckD / 2;
    body.push({ r: nr, z });
    body.push({ r: nr, z: z + neckL });
    z += neckL;
    r = nr;
  }

  if (oal <= z + 0.5) {
    oal = z + 5;
    warnings.push('Overall length is shorter than the cutting geometry; extended automatically.');
  }
  // Blend up to the shank over a short cone so tapered necks look right.
  const blend = Math.min(Math.max(Math.abs(shankR - r) * 2, 0.001), Math.max(oal - z - 0.5, 0.001));
  body.push({ r, z });
  body.push({ r: shankR, z: z + blend });
  body.push({ r: shankR, z: oal });

  const cuttingPoints = cut;
  const bodyPoints = dedupe(body);
  const silhouette = dedupe([...cut, ...bodyPoints]);

  let radius = 0;
  for (const p of cut) radius = Math.max(radius, p.r);

  return {
    def: { ...t, fluteLength: flute, overallLength: oal },
    cuttingPoints,
    bodyPoints,
    silhouette,
    cutEnvelope: buildEnvelope(cuttingPoints),
    bodyEnvelope: buildEnvelope(bodyPoints),
    radius,
    fluteLength: flute,
    length: oal,
    warnings,
  };
}

/** A small starter library so the app is useful on first load. */
export function defaultTools() {
  return [
    makeTool({ id: 'tool_face50', name: '50mm face mill', type: 'face', number: 1, diameter: 50, cornerRadius: 1.2, fluteLength: 8, fluteCount: 5, shankDiameter: 22, overallLength: 50, color: '#b7c4d6', cutting: { rpm: 2400, feed: 1800, plunge: 400, doc: 1.5, woc: 35 } }),
    makeTool({ id: 'tool_flat10', name: '10mm 4F flat', type: 'flat', number: 2, diameter: 10, fluteLength: 30, fluteCount: 4, shankDiameter: 10, overallLength: 75, cutting: { rpm: 6000, feed: 1200, plunge: 350, doc: 3, woc: 4 } }),
    makeTool({ id: 'tool_flat6', name: '6mm 3F flat', type: 'flat', number: 3, diameter: 6, fluteLength: 18, fluteCount: 3, shankDiameter: 6, overallLength: 57, cutting: { rpm: 9000, feed: 900, plunge: 250, doc: 2, woc: 2.4 } }),
    makeTool({ id: 'tool_ball6', name: '6mm ball nose', type: 'ball', number: 4, diameter: 6, fluteLength: 18, fluteCount: 2, shankDiameter: 6, overallLength: 57, color: '#cfd8e6', cutting: { rpm: 10000, feed: 1500, plunge: 300, doc: 0.3, woc: 0.3 } }),
    makeTool({ id: 'tool_bull8', name: '8mm bull R1', type: 'bull', number: 5, diameter: 8, cornerRadius: 1, fluteLength: 22, fluteCount: 4, shankDiameter: 8, overallLength: 63, cutting: { rpm: 7500, feed: 1100, plunge: 300, doc: 2.5, woc: 3 } }),
    makeTool({ id: 'tool_cham', name: '90° chamfer', type: 'chamfer', number: 6, diameter: 12, tipDiameter: 2, tipAngle: 90, fluteCount: 4, shankDiameter: 12, overallLength: 65, fluteLength: 10, color: '#d8c9a8', cutting: { rpm: 8000, feed: 700, plunge: 200, doc: 0.6, woc: 0.6 } }),
    makeTool({ id: 'tool_drill5', name: '5mm drill', type: 'drill', number: 7, diameter: 5, tipAngle: 140, fluteLength: 35, fluteCount: 2, shankDiameter: 5, overallLength: 70, color: '#bfae8e', cutting: { rpm: 4500, feed: 250, plunge: 250, doc: 5, woc: 5 } }),
    makeTool({ id: 'tool_taper', name: '3° taper ball 1mm', type: 'taper', number: 8, tipDiameter: 1, taperAngle: 3, cornerRadius: 0.5, fluteLength: 20, fluteCount: 4, shankDiameter: 6, overallLength: 60, diameter: 3.1, color: '#c9d6c2', cutting: { rpm: 12000, feed: 800, plunge: 200, doc: 0.2, woc: 0.15 } }),
  ];
}
