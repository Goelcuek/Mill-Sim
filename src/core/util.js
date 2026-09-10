// Small dependency-free helpers shared across the app.

export const MM_PER_INCH = 25.4;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;

/** Round to a sane number of decimals for display. */
export function fmt(v, decimals = 3) {
  if (!Number.isFinite(v)) return '–';
  const s = v.toFixed(decimals);
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(Math.floor(s)).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${s.toFixed(1)}s`;
  return `${s.toFixed(2)}s`;
}

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/** Deep clone for plain JSON-ish data. */
export function clone(obj) {
  return obj === undefined ? obj : JSON.parse(JSON.stringify(obj));
}

/** Shallow-merge `patch` into a copy of `base` (one level of nesting). */
export function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Numeric guard: returns `fallback` when v is not a finite number. */
export function num(v, fallback = 0) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : fallback;
}
