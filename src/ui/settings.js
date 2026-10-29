// Preferences: what the person at the keyboard likes, kept between starts.
//
// Not the job. A project holds the program, the machine, the stock and the
// fixtures, and opens the same on anybody's computer; this holds the things
// that are one person's — which unit they read in, what the viewport looks
// like, how cautious the run is — and stays on this computer. In the
// desktop program that is its own profile folder, so it survives updates.

import { DEFAULT_BACKGROUND } from '../scene/backgrounds.js';

const KEY = 'millsim.settings';

/** Display switches that are a preference. The section plane and the deviation map are not: they belong to a look at one part. */
export const DISPLAY_KEYS = [
  'grid', 'axes', 'origins', 'edges', 'toolColors', 'stockColor', 'background', 'backgroundCustom',
  'rapids', 'toolpath', 'backplot', 'holder', 'tool', 'stock', 'showLimits', 'toolOpacity',
];

export const CHECK_KEYS = ['nearMiss', 'rapidIntoStock', 'stopOnCollision', 'reference', 'parts'];

export const DEFAULTS = {
  /** 'light', 'dark', or 'system' to follow the operating system. */
  theme: 'light',
  units: 'mm',
  /** Where the app opens: the first step, or wherever it was left. */
  startStep: 'last',
  lastStep: 'machine',
  /** Desktop only: open the machine used last time. */
  reopenMachine: true,
  /** Show the one-line guidance under each step's title. */
  stepHints: true,
  display: {
    grid: false, axes: true, origins: false, edges: true, toolColors: true, stockColor: '#b9c0cb',
    background: DEFAULT_BACKGROUND, backgroundCustom: '#8b93a3', rapids: true, toolpath: true, backplot: 'all',
    holder: true, tool: true, stock: true, showLimits: false, toolOpacity: 1,
  },
  /** What a new stock is simulated at, mm. */
  resolution: 0.28,
  speed: '4',
  checks: {
    nearMiss: 0,
    rapidIntoStock: true,
    stopOnCollision: true,
    reference: true,
    parts: { tool: true, shank: true, holder: true, spindle: true },
  },
  gougeTolerance: 0.02,
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue;
    const b = base[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : (typeof v === typeof b ? v : b);
  }
  return out;
}

let current = null;
const listeners = new Set();

/** The settings as they stand, read from storage the first time. */
export function settings() {
  if (current) return current;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* private window */ }
  current = merge(clone(DEFAULTS), stored);
  // Before there was a settings page the unit was kept on its own.
  if (!stored) {
    try {
      const u = localStorage.getItem('millsim.units');
      if (u === 'mm' || u === 'in') current.units = u;
    } catch { /* defaults, then */ }
  }
  return current;
}

/**
 * Change some of them and keep the result. Nested objects merge, so
 * `{ display: { grid: true } }` leaves the rest of the display alone.
 */
export function saveSettings(patch) {
  const next = merge(settings(), patch);
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* kept until reload */ }
  for (const fn of listeners) fn(next, patch);
  return next;
}

/** Everything back to how it came. */
export function resetSettings() {
  current = null;
  try { localStorage.removeItem(KEY); } catch { /* nothing kept */ }
  return saveSettings({});
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Only the keys of `obj` named in `keys`. */
export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

/** Light or dark, with "system" settled. */
export function resolvedTheme(theme = settings().theme) {
  if (theme === 'dark' || theme === 'light') return theme;
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(root = document.documentElement) {
  root.dataset.theme = resolvedTheme();
}
