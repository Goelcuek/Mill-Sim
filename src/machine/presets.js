// Stock machine configurations.
//
// Each is just a tree, which is the point: the difference between the
// three 5-axis families is where the rotaries sit, not what code runs.
// Users are expected to start from the closest one and edit it — change a
// pivot, flip a sign, attach their own STLs.

import { Kinematics } from './kinematics.js';

/** The 3-axis VMC: table carries the work in X and Y, head moves in Z. */
export function vmc3Axis() {
  return {
    name: '3-axis VMC',
    nodes: [
      { id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0] },

      { id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'base', origin: [0, 0, -80], limits: { min: -215, max: 215 }, invert: true },
      { id: 'x', name: 'X axis (table)', letter: 'X', parent: 'y', origin: [0, 0, 0], limits: { min: -380, max: 380 }, invert: true },
      { id: 'table', name: 'Table', kind: 'carrier', parent: 'x', origin: [0, 0, 0] },

      { id: 'z', name: 'Z axis (head)', letter: 'Z', parent: 'base', origin: [0, 0, 0], limits: { min: -120, max: 330 } },
      { id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'z', origin: [0, 0, 0] },
    ],
    toolNode: 'spindle',
    workNode: 'table',
    spindleOffset: [0, 0, 0],
    tableOffset: [0, 0, 0],
  };
}

/**
 * Head-head: both rotaries in the spindle head, table fixed.
 * Common on gantry machines and big mould mills — the part never moves, so
 * heavy work stays put and the head does the swinging.
 */
export function headHead() {
  return {
    name: '5-axis head-head (gantry)',
    nodes: [
      { id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0] },
      { id: 'table', name: 'Table (fixed)', kind: 'carrier', parent: 'base', origin: [0, 0, -80] },

      { id: 'x', name: 'X axis (bridge)', letter: 'X', parent: 'base', origin: [0, 0, 0], limits: { min: -400, max: 400 } },
      { id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'x', origin: [0, 0, 0], limits: { min: -300, max: 300 } },
      { id: 'z', name: 'Z axis (ram)', letter: 'Z', parent: 'y', origin: [0, 0, 0], limits: { min: -150, max: 350 } },

      // C swings the whole fork about the ram, then B tilts inside it. The
      // order matters: with B outermost, C would only spin the tool about
      // its own axis and the head could never point off the XZ plane.
      { id: 'c', name: 'C axis (head swivel)', letter: 'C', parent: 'z', origin: [0, 0, -120], limits: { min: -360, max: 360 } },
      { id: 'b', name: 'B axis (fork tilt)', letter: 'B', parent: 'c', origin: [0, 0, -60], limits: { min: -110, max: 110 } },
      { id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'b', origin: [0, 0, -60] },
    ],
    toolNode: 'spindle',
    workNode: 'table',
    spindleOffset: [0, 0, 0],
    tableOffset: [0, 0, 0],
  };
}

/**
 * Head-table: the head tilts about B, the table turns about C.
 * The classic 5-axis conversion of a VMC.
 */
export function headTable() {
  return {
    name: '5-axis head-table (B head, C table)',
    nodes: [
      { id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0] },

      { id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'base', origin: [0, 0, -80], limits: { min: -215, max: 215 }, invert: true },
      { id: 'x', name: 'X axis (table)', letter: 'X', parent: 'y', origin: [0, 0, 0], limits: { min: -380, max: 380 }, invert: true },
      { id: 'c', name: 'C axis (rotary table)', letter: 'C', parent: 'x', origin: [0, 0, 0], limits: { min: -360, max: 360 } },
      { id: 'table', name: 'Rotary table face', kind: 'carrier', parent: 'c', origin: [0, 0, 0] },

      { id: 'z', name: 'Z axis (head)', letter: 'Z', parent: 'base', origin: [0, 0, 0], limits: { min: -120, max: 330 } },
      { id: 'b', name: 'B axis (head tilt)', letter: 'B', parent: 'z', origin: [0, 0, -140], limits: { min: -120, max: 120 } },
      { id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'b', origin: [0, 0, -40] },
    ],
    toolNode: 'spindle',
    workNode: 'table',
    spindleOffset: [0, 0, 0],
    tableOffset: [0, 0, 0],
  };
}

/**
 * Table-table: a trunnion. A cradles the table about X, C turns inside it.
 * The most common 5-axis layout on smaller machines.
 */
export function tableTable() {
  return {
    name: '5-axis table-table (A/C trunnion)',
    nodes: [
      { id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0] },

      { id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'base', origin: [0, 0, -120], limits: { min: -200, max: 200 }, invert: true },
      { id: 'x', name: 'X axis (table)', letter: 'X', parent: 'y', origin: [0, 0, 0], limits: { min: -300, max: 300 }, invert: true },
      // The trunnion pivot sits above the slide, which is what gives a
      // trunnion machine its characteristic swing.
      { id: 'a', name: 'A axis (trunnion)', letter: 'A', parent: 'x', origin: [0, 0, 70], limits: { min: -120, max: 30 } },
      { id: 'c', name: 'C axis (rotary)', letter: 'C', parent: 'a', origin: [0, 0, 0], limits: { min: -360, max: 360 } },
      { id: 'table', name: 'Table face', kind: 'carrier', parent: 'c', origin: [0, 0, 0] },

      { id: 'z', name: 'Z axis (head)', letter: 'Z', parent: 'base', origin: [0, 0, 0], limits: { min: -150, max: 330 } },
      { id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'z', origin: [0, 0, 0] },
    ],
    toolNode: 'spindle',
    workNode: 'table',
    spindleOffset: [0, 0, 0],
    tableOffset: [0, 0, 0],
  };
}

export const PRESETS = {
  vmc3: { label: '3-axis VMC', build: vmc3Axis },
  headHead: { label: '5-axis head-head (gantry)', build: headHead },
  headTable: { label: '5-axis head-table (B head, C table)', build: headTable },
  tableTable: { label: '5-axis table-table (A/C trunnion)', build: tableTable },
};

export function buildPreset(key) {
  const p = PRESETS[key] || PRESETS.vmc3;
  return new Kinematics(p.build());
}
