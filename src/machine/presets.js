// Stock machine configurations.
//
// Each is just a tree, which is the point: the difference between the
// three 5-axis families is where the rotaries sit, not what code runs.
// Users are expected to start from the closest one and edit it — change a
// pivot, flip a sign, attach their own STLs.

import { Kinematics } from './kinematics.js';

/**
 * Spindle nose height above the fixture face with every axis at zero.
 *
 * This is what decides where the part sits on the table, because Mill-Sim
 * ties the part's zero to the tool tip at machine home: with a typical
 * 230 mm assembly the tip parks about 60 mm clear of the table, which is
 * roughly where a part on parallels lives. Set it too low and the part is
 * drawn inside the table.
 */
const NOSE_AT_HOME = 290;

/**
 * How far the part's zero sits above the table face.
 *
 * A job is not clamped flat to the cast iron — it stands on parallels, in a
 * vice, on a fixture plate. This is that stack. Left at zero the stock's top
 * face lands exactly on the table and the block disappears inside the
 * casting, which is what it did.
 */
const FIXTURE_HEIGHT = 80;

/** The 3-axis VMC: table carries the work in X and Y, head moves in Z. */
export function vmc3Axis() {
  return {
    name: '3-axis VMC',
    nodes: [
      {
        id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0],
        proxy: [
          { part: 'plinth', size: [1020, 760, 400], at: [0, -30, -645] },
          { part: 'column', size: [780, 300, 950], at: [0, 400, -245] },
          { part: 'ways', axis: 'y', size: [250, 760, 40], at: [0, 245, -110], steps: 5, tone: 'way' },
        ],
      },

      {
        id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'base', origin: [0, 0, -80],
        limits: { min: -215, max: 215 }, invert: true,
        proxy: [{ part: 'saddle', size: [700, 560, 95], at: [0, 0, -165] }],
      },
      {
        id: 'x', name: 'X axis (table)', letter: 'X', parent: 'y', origin: [0, 0, 0],
        limits: { min: -380, max: 380 }, invert: true,
        proxy: [
          { part: 'ways', axis: 'x', size: [400, 420, 60], at: [-660, 0, -66], steps: 5, from: 'far' },
          { part: 'ways', axis: 'x', size: [400, 420, 60], at: [660, 0, -66], steps: 5 },
        ],
      },
      {
        id: 'table', name: 'Table', kind: 'carrier', parent: 'x', origin: [0, 0, 0],
        proxy: [{ part: 'table', size: [900, 460, 70], at: [0, 0, -70], slots: 5 }],
      },

      // The table face sits 80 below the base, so the nose starts there plus
      // the standing clearance.
      {
        id: 'z', name: 'Z axis (head)', letter: 'Z', parent: 'base', origin: [0, 0, NOSE_AT_HOME - 80],
        limits: { min: -120, max: 330 },
        proxy: [{ part: 'headSlide', size: [320, 270, 470], at: [0, 130, 90] }],
      },
      {
        id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'z', origin: [0, 0, 0],
        proxy: [{ part: 'spindle', size: [82, 250], at: [0, 0, 0] }],
      },
    ],
    toolNode: 'spindle',
    workNode: 'table',
    spindleOffset: [0, 0, 0],
    tableOffset: [0, 0, FIXTURE_HEIGHT],
    accent: 0x1f6fb4,
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
      {
        id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0],
        proxy: [
          { part: 'plinth', size: [1500, 900, 220], at: [0, 0, -420] },
          { part: 'leg', size: [200, 300, 760], at: [-700, 300, -200] },
          { part: 'leg', size: [200, 300, 760], at: [700, 300, -200] },
          { part: 'leg', size: [200, 300, 760], at: [-700, -300, -200] },
          { part: 'leg', size: [200, 300, 760], at: [700, -300, -200] },
        ],
      },
      {
        id: 'table', name: 'Table (fixed)', kind: 'carrier', parent: 'base', origin: [0, 0, -80],
        proxy: [{ part: 'table', size: [1000, 620, 120], at: [0, 0, -120], slots: 6 }],
      },

      {
        id: 'x', name: 'X axis (bridge)', letter: 'X', parent: 'base', origin: [0, 0, 0],
        limits: { min: -400, max: 400 },
        proxy: [{ part: 'bridge', size: [1560, 320, 260], at: [0, 0, 560] }],
      },
      {
        id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'x', origin: [0, 0, 0],
        limits: { min: -300, max: 300 },
        proxy: [{ part: 'saddle', size: [400, 380, 300], at: [0, 0, 540] }],
      },
      // The fork hangs 240 below the ram, and the table is 80 below the base.
      {
        id: 'z', name: 'Z axis (ram)', letter: 'Z', parent: 'y', origin: [0, 0, NOSE_AT_HOME + 240 - 80],
        limits: { min: -150, max: 350 },
        proxy: [{ part: 'ram', size: [230, 230, 560], at: [0, 0, -40] }],
      },

      // C swings the whole fork about the ram, then B tilts inside it. The
      // order matters: with B outermost, C would only spin the tool about
      // its own axis and the head could never point off the XZ plane.
      {
        id: 'c', name: 'C axis (head swivel)', letter: 'C', parent: 'z', origin: [0, 0, -120],
        limits: { min: -360, max: 360 },
        proxy: [{ part: 'rotary', size: [140, 46], at: [0, 0, -46], axis: [0, 0, 1], slots: 0, tone: 'rotary' }],
      },
      {
        id: 'b', name: 'B axis (fork tilt)', letter: 'B', parent: 'c', origin: [0, 0, -60],
        limits: { min: -110, max: 110 },
        proxy: [
          { part: 'fork', size: [150, 210, 210], at: [0, 0, -70], span: 300 },
          { part: 'rotary', size: [70, 40, 0], at: [-150, 0, 0], axis: [1, 0, 0], slots: 0 },
          { part: 'rotary', size: [70, 40, 0], at: [150, 0, 0], axis: [1, 0, 0], slots: 0 },
        ],
      },
      {
        id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'b', origin: [0, 0, -60],
        proxy: [{ part: 'spindle', size: [78, 230], at: [0, 0, 0] }],
      },
    ],
    toolNode: 'spindle',
    workNode: 'table',
    spindleOffset: [0, 0, 0],
    tableOffset: [0, 0, FIXTURE_HEIGHT],
    accent: 0x6b4fbf,
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
      {
        id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0],
        proxy: [
          { part: 'plinth', size: [1020, 760, 400], at: [0, -30, -645] },
          { part: 'column', size: [780, 300, 1050], at: [0, 400, -245] },
          { part: 'ways', axis: 'y', size: [250, 760, 40], at: [0, 245, -110], steps: 5, tone: 'way' },
        ],
      },

      {
        id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'base', origin: [0, 0, -80],
        limits: { min: -215, max: 215 }, invert: true,
        proxy: [{ part: 'saddle', size: [700, 560, 95], at: [0, 0, -165] }],
      },
      {
        id: 'x', name: 'X axis (table)', letter: 'X', parent: 'y', origin: [0, 0, 0],
        limits: { min: -380, max: 380 }, invert: true,
        proxy: [
          { part: 'box', size: [760, 420, 70], at: [0, 0, -70], tone: 'table' },
          { part: 'ways', axis: 'x', size: [360, 400, 58], at: [-600, 0, -66], steps: 5, from: 'far' },
          { part: 'ways', axis: 'x', size: [360, 400, 58], at: [600, 0, -66], steps: 5 },
        ],
      },
      {
        id: 'c', name: 'C axis (rotary table)', letter: 'C', parent: 'x', origin: [0, 0, 0],
        limits: { min: -360, max: 360 },
      },
      {
        id: 'table', name: 'Rotary table face', kind: 'carrier', parent: 'c', origin: [0, 0, 0],
        proxy: [{ part: 'rotary', size: [230, 56], at: [0, 0, -56], axis: [0, 0, 1], slots: 4 }],
      },

      // The nose hangs 180 below the slide, and the table is 80 below the base.
      {
        id: 'z', name: 'Z axis (head)', letter: 'Z', parent: 'base', origin: [0, 0, NOSE_AT_HOME + 180 - 80],
        limits: { min: -120, max: 330 },
        proxy: [{ part: 'headSlide', size: [320, 270, 430], at: [0, 130, 40] }],
      },
      {
        id: 'b', name: 'B axis (head tilt)', letter: 'B', parent: 'z', origin: [0, 0, -140],
        limits: { min: -120, max: 120 },
        proxy: [
          { part: 'fork', size: [130, 200, 190], at: [0, 0, -50], span: 260 },
          { part: 'rotary', size: [64, 36, 0], at: [-130, 0, 0], axis: [1, 0, 0], slots: 0 },
          { part: 'rotary', size: [64, 36, 0], at: [130, 0, 0], axis: [1, 0, 0], slots: 0 },
        ],
      },
      {
        id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'b', origin: [0, 0, -40],
        proxy: [{ part: 'spindle', size: [74, 210], at: [0, 0, 0] }],
      },
    ],
    toolNode: 'spindle',
    workNode: 'table',
    spindleOffset: [0, 0, 0],
    tableOffset: [0, 0, FIXTURE_HEIGHT],
    accent: 0x18867a,
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
      {
        id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0],
        proxy: [
          { part: 'plinth', size: [1040, 820, 430], at: [0, -20, -700] },
          { part: 'column', size: [800, 320, 1000], at: [0, 430, -270] },
          { part: 'ways', axis: 'y', size: [250, 800, 40], at: [0, 272, -150], steps: 5, tone: 'way' },
        ],
      },

      {
        id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'base', origin: [0, 0, -120],
        limits: { min: -200, max: 200 }, invert: true,
        proxy: [{ part: 'saddle', size: [720, 580, 90], at: [0, 0, -150] }],
      },
      {
        id: 'x', name: 'X axis (table)', letter: 'X', parent: 'y', origin: [0, 0, 0],
        limits: { min: -300, max: 300 }, invert: true,
        proxy: [
          { part: 'box', size: [780, 440, 60], at: [0, 0, -60], tone: 'table' },
          { part: 'ways', axis: 'x', size: [340, 410, 54], at: [-600, 0, -56], steps: 4, from: 'far' },
          { part: 'ways', axis: 'x', size: [340, 410, 54], at: [600, 0, -56], steps: 4 },
          // The cheeks stand off the slide and carry the A pivot at +70.
          { part: 'trunnion', size: [200, 360, 190], at: [0, 0, -60], span: 500 },
        ],
      },
      // The trunnion pivot sits above the slide, which is what gives a
      // trunnion machine its characteristic swing.
      {
        id: 'a', name: 'A axis (trunnion)', letter: 'A', parent: 'x', origin: [0, 0, 70],
        limits: { min: -120, max: 30 },
        proxy: [
          { part: 'cradle', size: [420, 330, 70], at: [0, 0, -110] },
          { part: 'rotary', size: [95, 46, 0], at: [-250, 0, 0], axis: [1, 0, 0], slots: 0 },
          { part: 'rotary', size: [95, 46, 0], at: [250, 0, 0], axis: [1, 0, 0], slots: 0 },
        ],
      },
      {
        id: 'c', name: 'C axis (rotary)', letter: 'C', parent: 'a', origin: [0, 0, 0],
        limits: { min: -360, max: 360 },
      },
      {
        id: 'table', name: 'Table face', kind: 'carrier', parent: 'c', origin: [0, 0, 0],
        proxy: [{ part: 'rotary', size: [190, 44], at: [0, 0, -44], axis: [0, 0, 1], slots: 4 }],
      },

      // The trunnion face sits 50 below the base.
      {
        id: 'z', name: 'Z axis (head)', letter: 'Z', parent: 'base', origin: [0, 0, NOSE_AT_HOME - 50],
        limits: { min: -150, max: 330 },
        proxy: [{ part: 'headSlide', size: [320, 280, 470], at: [0, 140, 90] }],
      },
      {
        id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'z', origin: [0, 0, 0],
        proxy: [{ part: 'spindle', size: [80, 240], at: [0, 0, 0] }],
      },
    ],
    toolNode: 'spindle',
    workNode: 'table',
    spindleOffset: [0, 0, 0],
    tableOffset: [0, 0, FIXTURE_HEIGHT],
    accent: 0xc05a26,
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
