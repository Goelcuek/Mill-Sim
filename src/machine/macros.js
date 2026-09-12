// What the machine does when it reads an M code.
//
// A control does not really "do" M06. It jumps to a program the builder
// wrote — on a Fanuc, O9001 — that swings the head to the change position,
// unclamps, indexes the carousel and comes back. Which moves those are is a
// property of the machine and its control, not of the part program, which
// is why two machines reading the same G-code do visibly different things
// at the same M code.
//
// So a macro here is exactly that: a scrap of G-code the interpreter calls
// when it meets its code, with a few values substituted in. It travels with
// the machine, because that is what it describes.
//
//   #toolChangeX   a machine parameter, set on the Macros page
//   #T             a word from the calling block (T, S, P, Q, R, and #M)
//
// Anything else in the body is ordinary G-code and is read by the ordinary
// interpreter, so G28, G53, dwells and canned cycles all work.

import { uid } from '../core/util.js';

/** Codes worth offering, with what they conventionally mean. */
export const MACRO_CATALOGUE = [
  { code: 'M0', name: 'Program stop', hint: 'Feed hold until the operator restarts' },
  { code: 'M1', name: 'Optional stop', hint: 'Stop only when the operator has asked for it' },
  { code: 'M3', name: 'Spindle on, forward', hint: 'Orient, clamp, run up to speed' },
  { code: 'M5', name: 'Spindle stop', hint: 'Brake, and on some machines orient' },
  { code: 'M6', name: 'Tool change', hint: 'Retract, go to the change position, swap the tool' },
  { code: 'M8', name: 'Coolant on', hint: 'Flood, and any through-spindle sequence' },
  { code: 'M9', name: 'Coolant off', hint: 'Off, and the blow-down that usually follows' },
  { code: 'M19', name: 'Spindle orient', hint: 'Stop the spindle at a known angle' },
  { code: 'M30', name: 'Program end and rewind', hint: 'Park the machine at the end of a job' },
  { code: 'M60', name: 'Pallet change', hint: 'Index the pallet or the shuttle' },
];

/**
 * Machine parameters a macro can read.
 *
 * These are the numbers that differ between two machines running the same
 * macro, so they are named rather than typed into the body: the position of
 * the tool-change point, of the pallet, of the parking position.
 */
export const DEFAULT_PARAMETERS = {
  toolChangeX: 0,
  toolChangeY: 0,
  toolChangeZ: 0,
  parkX: 0,
  parkY: 0,
  safeZ: 0,
};

export const PARAMETER_HINTS = {
  toolChangeX: 'Tool-change position, X, in machine coordinates',
  toolChangeY: 'Tool-change position, Y, in machine coordinates',
  toolChangeZ: 'Tool-change position, Z; 0 is the top of Z travel',
  parkX: 'Where the table parks at the end of a program, X',
  parkY: 'Where the table parks at the end of a program, Y',
  safeZ: 'Clearance height in machine coordinates, for moves between jobs',
};

/** `M6`, `M06` and `m6` are the same code. */
export function normaliseCode(code) {
  const m = String(code || '').trim().match(/^([A-Za-z])\s*0*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return `${m[1].toUpperCase()}${Number(m[2])}`;
}

export function makeMacro(patch = {}) {
  const code = normaliseCode(patch.code) || 'M6';
  return {
    id: patch.id || uid('mac'),
    code,
    name: patch.name || (MACRO_CATALOGUE.find((c) => c.code === code) || {}).name || `${code} macro`,
    body: patch.body || '',
    /** Off by default: a macro that runs is a macro that changes the cut. */
    enabled: patch.enabled !== false,
    notes: patch.notes || '',
  };
}

/**
 * The macros a machine starts with.
 *
 * They are written out rather than hidden in code so that the first thing
 * anyone does with them is read them and change them — which is the point.
 * They start disabled: switching one on changes what every program does at
 * that code, and that should be a decision, not a surprise.
 */
export function defaultMacros(flavour = 'fanuc') {
  const orient = flavour === 'haas' ? 'M19 (orient the spindle)\n' : '';
  return [
    makeMacro({
      id: 'mac_m6',
      code: 'M6',
      name: 'Tool change',
      enabled: false,
      body: [
        '(Tool change: retract, go to the change position, swap T#T)',
        'M5',
        orient.trim(),
        'G91 G28 Z0        (Z to the home switch)',
        'G90 G53 G0 X#toolChangeX Y#toolChangeY',
        'G4 P2.0           (carousel time)',
      ].filter(Boolean).join('\n'),
      notes: 'Runs after the control has recorded the new tool, so #T is the tool being loaded.',
    }),
    makeMacro({
      id: 'mac_m30',
      code: 'M30',
      name: 'Program end',
      enabled: false,
      body: [
        '(End of job: retract and park)',
        'M5',
        'M9',
        'G91 G28 Z0',
        'G90 G53 G0 X#parkX Y#parkY',
      ].join('\n'),
    }),
  ];
}

/** Every `#name` in a macro body, in the order they appear. */
export function macroReferences(body) {
  const out = [];
  for (const m of String(body || '').matchAll(/#([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Substitute a macro body's `#name` references.
 *
 * @param {string} body
 * @param {Record<string, number>} vars
 * @param {(name:string) => void} [onMissing] told about names nobody defined
 * @returns {string} plain G-code
 */
export function expandMacro(body, vars, onMissing) {
  return String(body || '').replace(/#([A-Za-z_][A-Za-z0-9_]*)/g, (all, name) => {
    const v = vars[name];
    if (v === undefined || v === null || !Number.isFinite(Number(v))) {
      if (onMissing) onMissing(name);
      return '0';
    }
    // A bare number, so the lexer reads it as the value of the word in
    // front of it: "X#toolChangeX" becomes "X-320".
    return String(Number(v));
  });
}
