// Parametric tool-holder definitions.
//
// A holder is a stack of truncated-cone stages listed from the nose (the
// face the tool sticks out of) upwards, optionally topped with a standard
// spindle taper. Holders matter for two reasons: they are the part that
// usually crashes, and their nose position is what fixes the usable
// stickout of the cutter.

import { buildEnvelope, dedupe } from './envelope.js';
import { num, uid } from '../core/util.js';

/**
 * Standard spindle interfaces, drawn above the holder body.
 * `flangeDia`/`flangeLength` describe the V-flange or HSK collar,
 * `gaugeDia`/`taperLength` the taper itself and `retention` the stud/knob.
 */
export const TAPERS = {
  none: { label: 'None (bare body)', flangeDia: 0, flangeLength: 0, gaugeDia: 0, taperLength: 0, retention: 0 },
  BT30: { label: 'BT30', flangeDia: 46, flangeLength: 16, gaugeDia: 31.75, taperLength: 48.4, retention: 22 },
  BT40: { label: 'BT40', flangeDia: 63, flangeLength: 18, gaugeDia: 44.45, taperLength: 65.4, retention: 26 },
  BT50: { label: 'BT50', flangeDia: 97.5, flangeLength: 24, gaugeDia: 69.85, taperLength: 101.8, retention: 34 },
  CAT40: { label: 'CAT40', flangeDia: 63, flangeLength: 18, gaugeDia: 44.45, taperLength: 68.6, retention: 26 },
  CAT50: { label: 'CAT50', flangeDia: 97.5, flangeLength: 24, gaugeDia: 69.85, taperLength: 101.6, retention: 34 },
  HSK63A: { label: 'HSK63-A', flangeDia: 63, flangeLength: 10, gaugeDia: 63, taperLength: 50, retention: 0 },
  HSK100A: { label: 'HSK100-A', flangeDia: 100, flangeLength: 12, gaugeDia: 100, taperLength: 75, retention: 0 },
  ISO30: { label: 'ISO30 / SK30', flangeDia: 50, flangeLength: 14, gaugeDia: 31.75, taperLength: 48, retention: 0 },
};

export const HOLDER_TYPES = {
  collet: 'ER collet chuck',
  shrink: 'Shrink fit',
  endmill: 'End mill / Weldon holder',
  shell: 'Shell mill arbor',
  drillchuck: 'Drill chuck',
  extension: 'Slim extension',
  custom: 'Custom stack',
};

export const DEFAULT_HOLDER = {
  id: '',
  name: 'New holder',
  type: 'collet',
  taper: 'BT40',
  color: '#8d97a8',
  // Stages from the nose upwards: bottom diameter, top diameter, length.
  stages: [
    { dia: 22, topDia: 34, length: 26 },
    { dia: 34, topDia: 44, length: 24 },
    { dia: 44, topDia: 48, length: 22 },
  ],
  notes: '',
};

export function makeHolder(patch = {}) {
  return {
    ...DEFAULT_HOLDER,
    ...patch,
    id: patch.id || uid('hld'),
    stages: (patch.stages || DEFAULT_HOLDER.stages).map((s) => ({ dia: num(s.dia, 20), topDia: num(s.topDia, num(s.dia, 20)), length: num(s.length, 10) })),
  };
}

/**
 * Build the holder silhouette.
 *
 * @param {object} def
 * @returns {{def:object, points:Array, envelope:import('./envelope.js').Envelope,
 *            length:number, noseDia:number, maxDia:number, warnings:string[]}}
 */
export function buildHolder(def) {
  const h = { ...DEFAULT_HOLDER, ...def };
  const warnings = [];
  const pts = [];
  let z = 0;

  const stages = (h.stages || []).filter((s) => num(s.length, 0) > 0 && num(s.dia, 0) > 0);
  if (!stages.length) {
    warnings.push('Holder has no stages; a 30 mm stub is used instead.');
    stages.push({ dia: 30, topDia: 30, length: 30 });
  }

  pts.push({ r: 0, z: 0 });
  for (const s of stages) {
    const r0 = num(s.dia, 20) / 2;
    const r1 = num(s.topDia, s.dia) / 2 || r0;
    const len = num(s.length, 10);
    pts.push({ r: r0, z });
    pts.push({ r: r1, z: z + len });
    z += len;
  }

  const taper = TAPERS[h.taper] || TAPERS.none;
  if (taper.flangeDia > 0) {
    const fr = taper.flangeDia / 2;
    pts.push({ r: fr, z });
    pts.push({ r: fr, z: z + taper.flangeLength });
    z += taper.flangeLength;
    // The 7:24 taper narrows going up towards the drawbar.
    const gr = taper.gaugeDia / 2;
    const topR = Math.max(gr - taper.taperLength * (7 / 24) / 2, gr * 0.55);
    pts.push({ r: gr, z });
    pts.push({ r: topR, z: z + taper.taperLength });
    z += taper.taperLength;
    if (taper.retention > 0) {
      pts.push({ r: taper.retention / 2 * 0.55, z });
      pts.push({ r: taper.retention / 2 * 0.55, z: z + taper.retention });
      z += taper.retention;
    }
  }
  pts.push({ r: 0, z });

  const points = dedupe(pts);
  let maxDia = 0;
  for (const p of points) maxDia = Math.max(maxDia, p.r * 2);

  return {
    def: h,
    points,
    envelope: buildEnvelope(points),
    length: z,
    noseDia: num(stages[0].dia, 20),
    maxDia,
    warnings,
  };
}

export function defaultHolders() {
  return [
    makeHolder({
      id: 'hld_er32', name: 'BT40 ER32 collet chuck', type: 'collet', taper: 'BT40',
      stages: [
        { dia: 22, topDia: 34, length: 24 },
        { dia: 40, topDia: 40, length: 18 },
        { dia: 48, topDia: 50, length: 28 },
      ],
    }),
    makeHolder({
      id: 'hld_shrink', name: 'BT40 shrink fit 12mm', type: 'shrink', taper: 'BT40', color: '#7f8a9c',
      stages: [
        { dia: 18, topDia: 21, length: 40 },
        { dia: 21, topDia: 34, length: 26 },
        { dia: 40, topDia: 48, length: 24 },
      ],
    }),
    makeHolder({
      id: 'hld_slim', name: 'BT40 slim extension', type: 'extension', taper: 'BT40', color: '#79839a',
      stages: [
        { dia: 14, topDia: 14, length: 55 },
        { dia: 24, topDia: 32, length: 22 },
        { dia: 42, topDia: 48, length: 22 },
      ],
    }),
    makeHolder({
      id: 'hld_shell', name: 'BT40 shell mill arbor 22', type: 'shell', taper: 'BT40', color: '#96a0b1',
      stages: [
        { dia: 22, topDia: 22, length: 18 },
        { dia: 50, topDia: 58, length: 24 },
        { dia: 58, topDia: 58, length: 18 },
      ],
    }),
    makeHolder({
      id: 'hld_hsk', name: 'HSK63A end mill holder 16', type: 'endmill', taper: 'HSK63A', color: '#8792a5',
      stages: [
        { dia: 32, topDia: 32, length: 45 },
        { dia: 44, topDia: 50, length: 25 },
      ],
    }),
    makeHolder({
      id: 'hld_drill', name: 'BT40 drill chuck 13mm', type: 'drillchuck', taper: 'BT40', color: '#9aa4b4',
      stages: [
        { dia: 12, topDia: 40, length: 34 },
        { dia: 44, topDia: 44, length: 30 },
        { dia: 44, topDia: 48, length: 16 },
      ],
    }),
  ];
}
