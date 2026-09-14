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
  'home', 'tableSize', 'tableZ', 'spindleDiameter', 'spindleLength',
  'limits', 'table', 'rapidRate', 'maxFeed', 'proxies', 'accent',
];

export const DEFAULT_MACHINE = {
  name: '3-axis VMC',
  preset: 'vmc3',
  /**
   * Where the machine sits when its axes are at their home switches, in
   * scene coordinates.
   *
   * This is machine zero. G53 and G28 measure from it, and so do the travel
   * limits below — which is how a machine is actually described: the
   * envelope is a property of the iron, fixed relative to home, and nothing
   * to do with where today's vice happens to be bolted.
   */
  home: [0, 0, 250],
  tableSize: [900, 460],
  /** Scene Z of the table top; the stock normally sits on fixtures above it. */
  tableZ: -80,
  spindleDiameter: 110,
  spindleLength: 130,
  /**
   * Tool-tip travel limits, in machine coordinates — measured from home,
   * the way a control reads them out and a manual writes them down.
   *
   * `frame` says so. A machine saved before this was relative carries no
   * frame, and its numbers are read as the scene coordinates they were.
   */
  limits: { enabled: true, frame: 'home', min: [-380, -215, -370], max: [380, 215, 80] },
  table: { enabled: true, z: -80, xMin: -450, xMax: 450, yMin: -230, yMax: 230 },
  rapidRate: 15000,
  maxFeed: 10000,
  /**
   * Draw a stand-in casting for an axis that has no body of its own.
   *
   * A preset is described in stand-ins, so they are what a preset machine
   * looks like. A machine being built from real STLs is a different case:
   * once some of the castings are the shop's own, a generic slab beside
   * them is not "the machine we have not modelled yet", it is something in
   * the way — so a machine started from a bare base turns them off.
   */
  proxies: true,
  /**
   * What colour this machine's moving castings are painted.
   *
   * null means the one the preset family comes in. A shop that has two of
   * the same machine and paints them differently, or that just wants its
   * own machine to look like its own machine, sets it.
   */
  accent: null,
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

/** Where this machine's home is, in scene coordinates. */
export function homeOf(machine) {
  const h = machine && machine.home;
  return Array.isArray(h) && h.length === 3 ? [Number(h[0]) || 0, Number(h[1]) || 0, Number(h[2]) || 0] : [0, 0, 0];
}

/**
 * The travel limits as scene coordinates, whichever way they were written.
 *
 * New machines measure their envelope from home; ones saved before that
 * wrote scene coordinates and carry no frame, so they are taken as they
 * stand. Everything that draws or checks the envelope goes through here, so
 * there is one answer to "where is the wall" rather than one per caller.
 */
export function limitsInScene(machine) {
  const l = machine && machine.limits;
  if (!l) return null;
  const home = l.frame === 'home' ? homeOf(machine) : [0, 0, 0];
  return {
    enabled: !!l.enabled,
    min: [0, 1, 2].map((i) => (Number(l.min[i]) || 0) + home[i]),
    max: [0, 1, 2].map((i) => (Number(l.max[i]) || 0) + home[i]),
  };
}

/**
 * Read a machine file's limits, whenever it was written.
 *
 * Before the envelope was measured from home it was written in scene
 * coordinates, and such a file carries no frame. It is converted here
 * rather than left to be misread as a relative one — the difference is the
 * whole height of the machine.
 *
 * @param {object} limits as found in the file
 * @param {number[]} home that file's home position
 */
export function normaliseLimits(limits, home) {
  const l = limits || DEFAULT_MACHINE.limits;
  const shift = l.frame === 'home' ? [0, 0, 0] : [-(home[0] || 0), -(home[1] || 0), -(home[2] || 0)];
  return {
    enabled: l.enabled !== false,
    frame: 'home',
    min: [0, 1, 2].map((i) => Number(((Number(l.min[i]) || 0) + shift[i]).toFixed(4))),
    max: [0, 1, 2].map((i) => Number(((Number(l.max[i]) || 0) + shift[i]).toFixed(4))),
  };
}
