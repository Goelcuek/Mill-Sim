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

// ---- castings ---------------------------------------------------------------
//
// Every stand-in below is laid out in millimetres in the frame of the axis
// that carries it, so a part sits where the real one would and moves with
// what really moves it. Three rules keep them honest: nothing static pokes
// through anything that moves past it; a spindle cartridge is inside its
// head, with only the nose showing; and a rotary's castings are on the
// side of the joint that turns with them.

const block = (min, max, tone, name) => ({ part: 'block', min, max, tone, name });
const drum = (at, radius, length, axis, tone, name) => ({ part: 'drum', at, radius, length, axis, tone, name });
const NONE = [{ part: 'none' }];

/** Shift a set of castings, so one layout can be reused at another height. */
const shifted = (parts, dz) => parts.map((q) => {
  const c = { ...q };
  if (c.min) c.min = [c.min[0], c.min[1], c.min[2] + dz];
  if (c.max) c.max = [c.max[0], c.max[1], c.max[2] + dz];
  if (c.at) c.at = [c.at[0], c.at[1], c.at[2] + dz];
  return c;
});

/**
 * A C-frame mill's base: the bed, the saddle's Y rails along its top, and
 * the column at the back with the head's Z rails down its face.
 *
 * The column stands behind the saddle's whole Y travel — saddle 460 deep,
 * 215 either way — which is why a VMC's head reaches so far forward.
 */
function cFrameBase(bedTop, columnTop) {
  return [
    block([-575, -535, bedTop - 430], [575, 955, bedTop - 410], 'body', 'Bed sill'),
    block([-560, -520, bedTop - 410], [560, 940, bedTop - 330], 'base', 'Bed'),
    block([-500, -480, bedTop - 330], [500, 900, bedTop], 'base', 'Bed'),
    block([-235, -470, bedTop], [-205, 470, bedTop + 18], 'steel', 'Y rail'),
    block([205, -470, bedTop], [235, 470, bedTop + 18], 'steel', 'Y rail'),
    block([-330, 470, bedTop], [330, 890, columnTop], 'body', 'Column'),
    block([-350, 455, columnTop], [350, 905, columnTop + 40], 'body', 'Column cap'),
    block([-165, 452, bedTop + 150], [-135, 470, columnTop - 20], 'steel', 'Z rail'),
    block([135, 452, bedTop + 150], [165, 470, columnTop - 20], 'steel', 'Z rail'),
  ];
}

/** A saddle on the Y rails, with the X rails along its top. */
function saddle(bottom, top) {
  return [
    block([-320, -230, bottom], [320, 230, top - 10], 'slide', 'Saddle'),
    block([-320, -155, top - 10], [320, -125, top], 'steel', 'X rail'),
    block([-320, 125, top - 10], [320, 155, top], 'steel', 'X rail'),
  ];
}

/**
 * A spindle head on the column's Z rails: the casting the spindle lives in,
 * its carriage against the column face, and the motor on top. `bottom` is
 * where the casting starts above the nose, which is what decides how much
 * of the cartridge shows below it.
 */
function cFrameHead(bottom, top, motor = true) {
  const parts = [
    block([-170, -150, bottom], [170, 430, top], 'accent', 'Spindle head'),
    block([-210, 430, bottom - 50], [210, 452, top + 30], 'slide', 'Z carriage'),
  ];
  if (motor) {
    parts.push(drum([0, 0, top + 70], 85, 140, [0, 0, 1], 'body', 'Spindle motor'));
    parts.push(drum([0, 0, top + 145], 70, 10, [0, 0, 1], 'way', 'Motor fan'));
  }
  return parts;
}

/**
 * A gantry: the bed, two walls along Y with rails on top, a bridge riding
 * them in Y, and a carriage riding the bridge in X. The ram goes down
 * through the carriage at the spindle axis; the bridge is behind it, so
 * nothing it carries is ever over the work but the head.
 *
 * The walls start where the bridge's travel does — `wallFront` — and not at
 * the front of the bed, which leaves the work open to the operator and to
 * the camera, as it is on the machines this is drawn from.
 */
function gantryBed(bedTop, wallTop, wallFront) {
  return [
    block([-905, -425, bedTop - 420], [905, 1025, bedTop - 400], 'body', 'Bed sill'),
    block([-890, -410, bedTop - 400], [890, 1010, bedTop], 'base', 'Bed'),
    block([-820, wallFront, bedTop], [-660, 900, wallTop], 'body', 'Left wall'),
    block([660, wallFront, bedTop], [820, 900, wallTop], 'body', 'Right wall'),
    block([-755, wallFront, wallTop], [-725, 900, wallTop + 20], 'steel', 'Y rail'),
    block([725, wallFront, wallTop], [755, 900, wallTop + 20], 'steel', 'Y rail'),
  ];
}
const gantryBridge = (bottom) => [
  block([-840, 200, bottom], [840, 500, bottom + 240], 'accent', 'Bridge'),
  block([-820, 186, bottom + 180], [820, 200, bottom + 205], 'steel', 'X rail'),
  block([-820, 186, bottom + 35], [820, 200, bottom + 60], 'steel', 'X rail'),
];
const gantryCarriage = (bottom, top) => [block([-210, -150, bottom], [210, 186, top], 'slide', 'X carriage')];

/** The 3-axis VMC: table carries the work in X and Y, head moves in Z. */
export function vmc3Axis() {
  // Table face at -80 in the base frame; the nose parks NOSE_AT_HOME above it.
  return {
    name: '3-axis VMC',
    nodes: [
      {
        id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0],
        proxy: cFrameBase(-250, 1250),
      },

      {
        id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'base', origin: [0, 0, -80],
        limits: { min: -215, max: 215 }, invert: true,
        proxy: saddle(-152, -70),
      },
      {
        id: 'x', name: 'X axis (table)', letter: 'X', parent: 'y', origin: [0, 0, 0],
        limits: { min: -380, max: 380 }, invert: true,
        proxy: NONE,
      },
      {
        id: 'table', name: 'Table', kind: 'carrier', parent: 'x', origin: [0, 0, 0],
        proxy: [{ part: 'slotted', min: [-450, -230, -70], max: [450, 230, 0], slots: 5 }],
      },

      {
        id: 'z', name: 'Z axis (head)', letter: 'Z', parent: 'base', origin: [0, 0, NOSE_AT_HOME - 80],
        limits: { min: -120, max: 330 },
        proxy: cFrameHead(100, 580),
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
 * heavy work stays put and the head does the swinging. A bridge rides two
 * walls in Y, a carriage rides the bridge in X, the ram comes down through
 * it, and C swings a fork that tilts the spindle about B.
 */
export function headHead() {
  return {
    name: '5-axis head-head (gantry)',
    nodes: [
      {
        id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0],
        proxy: gantryBed(-200, 760, -120),
      },
      {
        id: 'table', name: 'Table (fixed)', kind: 'carrier', parent: 'base', origin: [0, 0, -80],
        proxy: [{ part: 'slotted', min: [-500, -310, -120], max: [500, 310, 0], slots: 6 }],
      },

      {
        id: 'y', name: 'Y axis (bridge)', letter: 'Y', parent: 'base', origin: [0, 0, 0],
        limits: { min: -300, max: 300 },
        proxy: gantryBridge(780),
      },
      {
        id: 'x', name: 'X axis (carriage)', letter: 'X', parent: 'y', origin: [0, 0, 0],
        limits: { min: -400, max: 400 },
        proxy: gantryCarriage(700, 1060),
      },
      // The nose hangs 290 below the ram at home: C is 120 down, B 110
      // below that, the nose 60 below B — and the table is 80 below the base.
      {
        id: 'z', name: 'Z axis (ram)', letter: 'Z', parent: 'x', origin: [0, 0, NOSE_AT_HOME + 290 - 80],
        limits: { min: -150, max: 350 },
        proxy: [
          block([-115, -115, -90], [115, 115, 680], 'body', 'Ram'),
          drum([0, 0, -105], 150, 30, [0, 0, 1], 'body', 'C flange'),
        ],
      },

      // C swings the whole fork about the ram, then B tilts inside it. The
      // order matters: with B outermost, C would only spin the tool about
      // its own axis and the head could never point off the XZ plane. B
      // turns about Y, so the fork's arms stand in front of and behind the
      // spindle, and the pivot is far enough below C that the spindle clears
      // it lying flat.
      {
        id: 'c', name: 'C axis (head swivel)', letter: 'C', parent: 'z', origin: [0, 0, -120],
        limits: { min: -360, max: 360 },
        proxy: [
          drum([0, 0, -12.5], 130, 25, [0, 0, 1], 'rotary', 'C swivel'),
          block([-75, -160, -190], [75, -120, -25], 'accent', 'Fork arm'),
          block([-75, 120, -190], [75, 160, -25], 'accent', 'Fork arm'),
          drum([0, -170, -110], 45, 20, [0, 1, 0], 'steel', 'B bearing'),
          drum([0, 170, -110], 45, 20, [0, 1, 0], 'steel', 'B bearing'),
        ],
      },
      {
        id: 'b', name: 'B axis (fork tilt)', letter: 'B', parent: 'c', origin: [0, 0, -110],
        limits: { min: -110, max: 110 },
        proxy: [drum([0, 0, 0], 62, 236, [0, 1, 0], 'rotary', 'Tilting housing')],
      },
      {
        id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'b', origin: [0, 0, -60],
        proxy: [{ part: 'spindle', size: [64, 100], at: [0, 0, 0] }],
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
 * The classic 5-axis conversion of a VMC: a rotary table on the X slide,
 * and a fork on the Z head with the spindle tilting between its arms.
 */
export function headTable() {
  return {
    name: '5-axis head-table (B head, C table)',
    nodes: [
      {
        id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0],
        proxy: cFrameBase(-275, 1300),
      },

      {
        id: 'y', name: 'Y axis (saddle)', letter: 'Y', parent: 'base', origin: [0, 0, -80],
        limits: { min: -215, max: 215 }, invert: true,
        proxy: saddle(-177, -95),
      },
      {
        id: 'x', name: 'X axis (table)', letter: 'X', parent: 'y', origin: [0, 0, 0],
        limits: { min: -380, max: 380 }, invert: true,
        proxy: [
          block([-380, -230, -95], [380, 230, -40], 'table', 'X carriage'),
          drum([0, 0, -44], 215, 8, [0, 0, 1], 'body', 'C housing'),
          block([380, -120, -95], [470, -20, -45], 'body', 'C drive'),
        ],
      },
      {
        id: 'c', name: 'C axis (rotary table)', letter: 'C', parent: 'x', origin: [0, 0, 0],
        limits: { min: -360, max: 360 },
        proxy: NONE,
      },
      {
        id: 'table', name: 'Rotary table face', kind: 'carrier', parent: 'c', origin: [0, 0, 0],
        proxy: [{ part: 'rotaryTable', at: [0, 0, 0], radius: 230, thickness: 40, slots: 4 }],
      },

      // The nose hangs 180 below the slide, and the table is 80 below the base.
      {
        id: 'z', name: 'Z axis (head)', letter: 'Z', parent: 'base', origin: [0, 0, NOSE_AT_HOME + 180 - 80],
        limits: { min: -120, max: 330 },
        proxy: [
          ...cFrameHead(-30, 450, false),
          // B turns about Y: the fork's arms stand in front of and behind
          // the spindle, and the housing tilts between them.
          block([-85, -145, -220], [85, -105, -30], 'accent', 'Fork arm'),
          block([-85, 105, -220], [85, 145, -30], 'accent', 'Fork arm'),
          drum([0, -155, -140], 55, 20, [0, 1, 0], 'steel', 'B bearing'),
          drum([0, 155, -140], 55, 20, [0, 1, 0], 'steel', 'B bearing'),
        ],
      },
      {
        id: 'b', name: 'B axis (head tilt)', letter: 'B', parent: 'z', origin: [0, 0, -140],
        limits: { min: -120, max: 120 },
        proxy: [drum([0, 0, 0], 90, 205, [0, 1, 0], 'rotary', 'Tilting housing')],
      },
      {
        id: 'spindle', name: 'Spindle', kind: 'carrier', parent: 'b', origin: [0, 0, -40],
        proxy: [{ part: 'spindle', size: [70, 130], at: [0, 0, 0] }],
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
 * The most common 5-axis layout on smaller machines, and built here the way
 * most of them are: the trunnion stands on the bed and only swings, and X,
 * Y and Z are all in the head — a bridge on two walls, a carriage on the
 * bridge, the ram down through it.
 */
export function tableTable() {
  return {
    name: '5-axis table-table (A/C trunnion)',
    nodes: [
      {
        id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0],
        proxy: [
          ...gantryBed(-310, 760, -20),
          // The trunnion's fixed half: a base plate and two cheeks with the
          // A bearings in them, the drive on the right-hand one.
          block([-470, -170, -310], [470, 170, -290], 'slide', 'Trunnion base'),
          block([-455, -150, -290], [-335, 150, 40], 'body', 'Trunnion cheek'),
          block([335, -150, -290], [455, 150, 40], 'body', 'Trunnion cheek'),
          drum([-395, 0, -50], 110, 120, [1, 0, 0], 'body', 'A bearing'),
          drum([395, 0, -50], 110, 120, [1, 0, 0], 'body', 'A bearing'),
          block([455, -80, -200], [575, 80, 10], 'body', 'A drive'),
        ],
      },

      // The pivot is at the table face, 50 below the base frame: the nose
      // parks NOSE_AT_HOME above it.
      {
        id: 'a', name: 'A axis (trunnion)', letter: 'A', parent: 'base', origin: [0, 0, -50],
        limits: { min: -120, max: 30 },
        proxy: [
          // The cradle that swings: a floor under the table and a side plate
          // up to each hub, and the C drive housed under the platter.
          block([-245, -170, -165], [245, 170, -120], 'slide', 'Cradle'),
          block([-290, -170, -165], [-245, 170, 60], 'slide', 'Cradle side'),
          block([245, -170, -165], [290, 170, 60], 'slide', 'Cradle side'),
          drum([-310, 0, 0], 75, 40, [1, 0, 0], 'rotary', 'A hub'),
          drum([310, 0, 0], 75, 40, [1, 0, 0], 'rotary', 'A hub'),
          drum([0, 0, -82.5], 150, 75, [0, 0, 1], 'body', 'C housing'),
        ],
      },
      {
        id: 'c', name: 'C axis (rotary)', letter: 'C', parent: 'a', origin: [0, 0, 0],
        limits: { min: -360, max: 360 },
        proxy: NONE,
      },
      {
        id: 'table', name: 'Table face', kind: 'carrier', parent: 'c', origin: [0, 0, 0],
        proxy: [{ part: 'rotaryTable', at: [0, 0, 0], radius: 165, thickness: 45, slots: 4 }],
      },

      {
        id: 'y', name: 'Y axis (bridge)', letter: 'Y', parent: 'base', origin: [0, 0, 0],
        limits: { min: -200, max: 200 },
        proxy: gantryBridge(780),
      },
      {
        id: 'x', name: 'X axis (carriage)', letter: 'X', parent: 'y', origin: [0, 0, 0],
        limits: { min: -300, max: 300 },
        proxy: gantryCarriage(600, 1060),
      },
      {
        id: 'z', name: 'Z axis (ram)', letter: 'Z', parent: 'x', origin: [0, 0, NOSE_AT_HOME - 50],
        limits: { min: -150, max: 330 },
        proxy: [
          block([-120, -120, 90], [120, 120, 910], 'body', 'Ram'),
          drum([0, 0, 80], 108, 20, [0, 0, 1], 'body', 'Nose collar'),
        ],
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
