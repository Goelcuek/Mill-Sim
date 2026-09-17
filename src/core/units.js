// What the numbers on screen are measured in.
//
// Everything inside this program is millimetres, always: the stock grid,
// the kinematics, the tool library, a saved project, a machine file. This
// module is the one place that turns those millimetres into whatever the
// person reading them works in, and turns what they type back. Nothing
// downstream of a panel ever sees an inch.
//
// That is deliberate and it is the whole design. A library written in inch
// mode is byte-for-byte the same file as one written in metric; switching
// mid-job changes what is drawn on the panels and nothing else. There is no
// second set of numbers to keep in step, and no conversion that can be
// applied twice.
//
// Three things are *not* this switch, and confusing any of them with it
// would be a bug:
//
//   * G20 and G21. Those are the program's units — what the numbers in the
//     G-code file mean — and they are the programmer's business, not the
//     reader's. A metric program stays metric when this is set to inches.
//   * The "units in the file" question on an STL or a tool-library import.
//     That is a statement about a file somebody else wrote.
//   * Angles. A degree is a degree.

import { MM_PER_INCH } from './util.js';

/** @type {'mm'|'in'} */
let mode = 'mm';
const listeners = new Set();

/** The unit lengths are shown in. */
export const units = () => mode;

export const isInch = () => mode === 'in';

/**
 * Switch what the panels show.
 *
 * @param {'mm'|'in'} next
 * @returns {boolean} whether it changed
 */
export function setUnits(next) {
  const want = next === 'in' || next === 'inch' ? 'in' : 'mm';
  if (want === mode) return false;
  mode = want;
  for (const fn of listeners) fn(mode);
  return true;
}

/** Called with the new unit whenever it changes. Returns an unsubscribe. */
export function onUnitsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- lengths -------------------------------------------------------------

/** Millimetres as the reader sees them. */
export const toDisplay = (mm) => (mode === 'in' ? mm / MM_PER_INCH : mm);

/** What the reader typed, as millimetres. */
export const fromDisplay = (v) => (mode === 'in' ? v * MM_PER_INCH : v);

/** 'mm' or 'in'. */
export const lengthLabel = () => mode;

/**
 * How many decimals a length wants.
 *
 * An inch is twenty-five millimetres, so a number written to three places
 * in millimetres needs four or five to say the same thing. Shop practice is
 * four — a tenth of a thou — so three-place millimetres become four-place
 * inches and the reader loses nothing.
 *
 * @param {number} decimals what the caller would have used for millimetres
 */
export const places = (decimals = 3) => (mode === 'in' ? Math.min(decimals + 1, 6) : decimals);

/** A step for a spin box, in display units, never finer than it can show. */
export const toStep = (mmStep) => {
  if (!Number.isFinite(mmStep) || mmStep <= 0) return mmStep;
  if (mode !== 'in') return mmStep;
  // 1 mm steps become 0.05", 0.1 mm become 0.005": round numbers to nudge
  // by rather than 0.03937.
  const inches = mmStep / MM_PER_INCH;
  const decade = 10 ** Math.floor(Math.log10(inches));
  for (const m of [1, 2, 5, 10]) {
    if (m * decade >= inches * 0.999) return Number((m * decade).toPrecision(2));
  }
  return Number(inches.toPrecision(2));
};

// ---- formatting ----------------------------------------------------------

const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

/**
 * A length, formatted, without its unit.
 *
 * @param {number} mm
 * @param {number} [decimals] what would have been used for millimetres
 */
export function len(mm, decimals = 3) {
  if (!Number.isFinite(mm)) return '–';
  return trim(toDisplay(mm).toFixed(places(decimals)));
}

/** A length with its unit, which is what most prose wants. */
export function lenU(mm, decimals = 3) {
  return `${len(mm, decimals)} ${lengthLabel()}`;
}

/** A feed rate, in whatever per minute. */
export function feed(mmPerMin, decimals = 0) {
  if (!Number.isFinite(mmPerMin)) return '–';
  return trim(toDisplay(mmPerMin).toFixed(mode === 'in' ? Math.max(decimals, 1) : decimals));
}

export const feedLabel = () => `${mode}/min`;

/** A feed rate with its unit. */
export const feedU = (mmPerMin, decimals = 0) => `${feed(mmPerMin, decimals)} ${feedLabel()}`;

/**
 * A volume of metal, in the unit a shop quotes it in.
 *
 * Cubic millimetres are useless to read, so metric quotes cubic
 * centimetres and inch quotes cubic inches.
 */
export function volume(mm3, decimals = 2) {
  if (!Number.isFinite(mm3)) return '–';
  const v = mode === 'in' ? mm3 / (MM_PER_INCH ** 3) : mm3 / 1000;
  return trim(v.toFixed(decimals));
}

export const volumeLabel = () => (mode === 'in' ? 'in³' : 'cm³');

export const volumeU = (mm3, decimals = 2) => `${volume(mm3, decimals)} ${volumeLabel()}`;

/**
 * A long distance — how far the tool travels over a program.
 *
 * Millimetres and inches are both the wrong size for it, so this is the
 * unit a shop quotes a path length in: metres, or feet.
 */
export function distance(mm, decimals = 2) {
  if (!Number.isFinite(mm)) return '\u2013';
  const v = mode === 'in' ? mm / (MM_PER_INCH * 12) : mm / 1000;
  return trim(v.toFixed(decimals));
}

export const distanceLabel = () => (mode === 'in' ? 'ft' : 'm');
export const distanceU = (mm, decimals = 2) => `${distance(mm, decimals)} ${distanceLabel()}`;

/** An area, for the odd place that quotes one. */
export const areaLabel = () => (mode === 'in' ? 'in²' : 'mm²');
export const area = (mm2, decimals = 1) => (Number.isFinite(mm2)
  ? trim((mode === 'in' ? mm2 / (MM_PER_INCH ** 2) : mm2).toFixed(decimals))
  : '–');

/**
 * A triple — a position, a size, an offset — as one string.
 *
 * @param {number[]} mm
 */
export const triple = (mm, decimals = 3, sep = ', ') => (Array.isArray(mm)
  ? mm.map((v) => len(v, decimals)).join(sep)
  : '–');
