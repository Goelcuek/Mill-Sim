// Parametric tool-holder definitions.
//
// A holder is a stack of truncated-cone stages listed from the nose (the
// face the tool sticks out of) upwards, ending at the gauge line. Holders
// matter for two reasons: they are the part that usually crashes, and
// their nose position is what fixes the usable stickout of the cutter.
//
// The model stops at the gauge line on purpose. The 7:24 taper, the HSK
// shank and the retention knob all sit inside the spindle bore, so they
// can never touch the work, the fixture or the machine. Drawing them only
// adds a phantom column of metal where the spindle should be. The gauge
// line is the mating face: the spindle nose starts exactly there and goes
// up, so there is never a gap between holder and spindle.
//
// The V-flange or HSK collar is kept, because it is below the gauge line
// and is very often the widest thing on the whole assembly — a BT40 flange
// is 63 mm across, which is what actually clips a clamp in a deep pocket.

import { buildEnvelope, dedupe } from './envelope.js';
import { num, uid } from '../core/util.js';

/**
 * Standard spindle interfaces.
 *
 * Only the collar below the gauge line is described, because only that
 * part is ever outside the spindle. `flangeDia` is the V-flange or HSK
 * collar diameter and `flangeLength` how far it hangs below the gauge
 * line. The taper above it is deliberately not modelled.
 */
export const TAPERS = {
  none: { label: 'None (bare body)', flangeDia: 0, flangeLength: 0 },
  BT30: { label: 'BT30', flangeDia: 46, flangeLength: 16 },
  BT40: { label: 'BT40', flangeDia: 63, flangeLength: 18 },
  BT50: { label: 'BT50', flangeDia: 97.5, flangeLength: 24 },
  CAT40: { label: 'CAT40', flangeDia: 63, flangeLength: 18 },
  CAT50: { label: 'CAT50', flangeDia: 97.5, flangeLength: 24 },
  HSK63A: { label: 'HSK63-A', flangeDia: 63, flangeLength: 10 },
  HSK100A: { label: 'HSK100-A', flangeDia: 100, flangeLength: 12 },
  ISO30: { label: 'ISO30 / SK30', flangeDia: 50, flangeLength: 14 },
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

  // The flange or collar, and then stop: z is now the gauge line, the face
  // the spindle nose mates against.
  const taper = TAPERS[h.taper] || TAPERS.none;
  if (taper.flangeDia > 0) {
    const fr = taper.flangeDia / 2;
    pts.push({ r: fr, z });
    pts.push({ r: fr, z: z + taper.flangeLength });
    z += taper.flangeLength;
  }
  pts.push({ r: 0, z });

  const points = dedupe(pts);
  let maxDia = 0;
  for (const p of points) maxDia = Math.max(maxDia, p.r * 2);

  return {
    def: h,
    points,
    envelope: buildEnvelope(points),
    /** Nose to gauge line — the holder's projection from the spindle. */
    length: z,
    noseDia: num(stages[0].dia, 20),
    flangeDia: taper.flangeDia,
    maxDia,
    warnings,
  };
}

export function defaultHolders() {
  // Stage lengths add up, with the flange, to the holder's projection from
  // the gauge line — the number a catalogue quotes and the number that
  // decides whether the holder clears the part.
  return [
    makeHolder({
      id: 'hld_er32', name: 'BT40 ER32 collet chuck · 100', type: 'collet', taper: 'BT40',
      stages: [
        { dia: 36, topDia: 50, length: 32 },   // collet nut
        { dia: 50, topDia: 50, length: 20 },
        { dia: 50, topDia: 58, length: 30 },
      ],
    }),
    makeHolder({
      id: 'hld_shrink', name: 'BT40 shrink fit 12 · 90', type: 'shrink', taper: 'BT40', color: '#7f8a9c',
      stages: [
        { dia: 21, topDia: 24, length: 40 },   // slim shrink nose
        { dia: 24, topDia: 40, length: 20 },
        { dia: 40, topDia: 58, length: 12 },
      ],
    }),
    makeHolder({
      id: 'hld_slim', name: 'BT40 slim extension · 120', type: 'extension', taper: 'BT40', color: '#79839a',
      stages: [
        { dia: 16, topDia: 16, length: 60 },
        { dia: 16, topDia: 32, length: 14 },
        { dia: 32, topDia: 58, length: 28 },
      ],
    }),
    makeHolder({
      id: 'hld_shell', name: 'BT40 shell mill arbor 22 · 60', type: 'shell', taper: 'BT40', color: '#96a0b1',
      stages: [
        { dia: 22, topDia: 22, length: 16 },   // arbor pilot
        { dia: 60, topDia: 60, length: 16 },   // drive face
        { dia: 60, topDia: 58, length: 10 },
      ],
    }),
    makeHolder({
      id: 'hld_hsk', name: 'HSK63A end mill holder 16 · 85', type: 'endmill', taper: 'HSK63A', color: '#8792a5',
      stages: [
        { dia: 32, topDia: 32, length: 51 },
        { dia: 32, topDia: 48, length: 14 },
        { dia: 48, topDia: 63, length: 10 },
      ],
    }),
    makeHolder({
      id: 'hld_drill', name: 'BT40 drill chuck 13 · 110', type: 'drillchuck', taper: 'BT40', color: '#9aa4b4',
      stages: [
        { dia: 12, topDia: 42, length: 40 },   // chuck jaws and body
        { dia: 46, topDia: 46, length: 34 },
        { dia: 46, topDia: 58, length: 18 },
      ],
    }),
  ];
}
