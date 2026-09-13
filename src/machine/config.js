// What a machine is, apart from its shape.
//
// The chain says how the machine moves; this says how big it is, what its
// control powers up believing, and what it does at an M code. It lives
// here rather than in the viewport's own file because saving a machine,
// loading one and simulating one all need it, and only one of those three
// has anything to do with drawing.

import { defaultMacros, DEFAULT_PARAMETERS } from './macros.js';

/**
 * The settings on the Machine tab that are numbers rather than shape: the
 * envelope, the table, the spindle nose and the rates.
 *
 * Named in one place because saving a machine and loading one have to agree
 * about what a machine *is* — a list that only exists inside the exporter
 * is a list the importer will drift away from.
 */
export const MACHINE_SETTINGS = [
  'travel', 'tableSize', 'tableZ', 'spindleDiameter', 'spindleLength',
  'limits', 'table', 'rapidRate', 'maxFeed',
];

export const DEFAULT_MACHINE = {
  name: '3-axis VMC',
  preset: 'vmc3',
  travel: [760, 430, 510],
  tableSize: [900, 460],
  /** Scene Z of the table top; the stock normally sits on fixtures above it. */
  tableZ: -80,
  spindleDiameter: 110,
  spindleLength: 130,
  /** Tool-tip travel limits in scene coordinates. */
  limits: { enabled: true, min: [-380, -215, -120], max: [380, 215, 330] },
  table: { enabled: true, z: -80, xMin: -450, xMax: 450, yMin: -230, yMax: 230 },
  rapidRate: 15000,
  maxFeed: 10000,
  /**
   * The control, not the iron. Which flavour of G-code this machine reads
   * and what modal state it powers up in — see DEFAULT_CONFIG.controller
   * in the interpreter.
   */
  controller: {
    flavour: 'fanuc',
    /**
     * How this control writes a macro — see gcode/dialects.js. The flavour
     * picks the starting table; `syntax` is whatever the shop changed
     * about it, which is how a control nobody has heard of is described.
     */
    dialect: 'fanuc',
    syntax: null,
    plane: 17,
    metric: true,
    absolute: true,
    arcCentreAbsolute: false,
    feedMode: 94,
  },
  /**
   * What this machine does at an M code, and the numbers those macros
   * read. Both belong to the machine, so both travel with it.
   */
  macros: defaultMacros('fanuc'),
  parameters: { ...DEFAULT_PARAMETERS },
  /**
   * Subprograms that live in the control between jobs — probing cycles,
   * pallet routines, the builder's own O9000 programs. Any program loaded
   * on this machine can call them.
   */
  subprograms: [],
  mode: 'part',
  visible: true,
};
