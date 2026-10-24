// What every variable held, at any point in the run.
//
// The interpreter writes down each lasting change as it happens — the
// variable, its new value, the line, and the move it came before. This
// turns that list into something a readout can ask: what R1 was when the
// machine was on move 400, which variables the blocks before this move
// touched, and the whole history of one of them.
//
// A change made before move k is in force while move k runs, so "the value
// at move k" is the last change whose move is k or less.

/** The name a key is shown under: "POS[1] · ROUGH" is POS, in ROUGH. */
function splitKey(key) {
  const dot = key.indexOf(' · ');
  const scope = dot >= 0 ? key.slice(dot + 3) : null;
  const local = dot >= 0 ? key.slice(0, dot) : key;
  const br = local.indexOf('[');
  return { base: br >= 0 ? local.slice(0, br) : local, local, scope, element: br >= 0 };
}

/**
 * @param {object} program  what interpret() returned
 * @returns {{rows:Array, valueAt:Function, changeAt:Function, changedAt:Function,
 *            truncated:boolean, count:number}}
 */
export function variableTimeline(program) {
  const trace = (program && program.variableTrace) || [];
  const declared = new Map(((program && program.namedVariables) || []).map((v) => [v.key, v]));
  const prefix = (program && program.variablePrefix) || '#';

  const byKey = new Map();
  for (const t of trace) {
    let r = byKey.get(t.key);
    if (!r) {
      const { base, local, scope, element } = splitKey(t.key);
      const decl = declared.get(scope ? `${base} · ${scope}` : base) || null;
      // A number written with this control's mark — R5, #100 — is one of
      // its registers; anything else is a name somebody gave it.
      const register = !decl && t.key.startsWith(prefix) && /^\d+$/.test(t.key.slice(prefix.length));
      r = {
        key: t.key,
        name: local,
        base,
        scope,
        element,
        number: register ? Number(t.key.slice(prefix.length)) : null,
        type: decl ? decl.type : 'REAL',
        kind: decl ? (decl.global ? 'machine' : 'declared') : register ? 'register' : 'declared',
        // Set before the first block: the machine's, not the program's.
        preset: t.line === 0,
        line: decl ? decl.line : t.line,
        src: decl ? decl.src || null : t.src || null,
        changes: [],
      };
      byKey.set(t.key, r);
    }
    r.changes.push(t);
  }

  // The program's own first, in the order they were declared; then the
  // registers by number; then what the machine holds.
  const order = { declared: 0, register: 1, machine: 2 };
  const firstSeen = new Map([...byKey.keys()].map((k, i) => [k, i]));
  const rows = [...byKey.values()].sort((a, b) => (order[a.kind] - order[b.kind])
    || (a.kind === 'register' ? a.number - b.number : 0)
    || (firstSeen.get(a.key) - firstSeen.get(b.key)));

  /** The index of the last change in force at move m, or -1. */
  const indexAt = (row, m) => {
    const c = row.changes;
    let lo = 0;
    let hi = c.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].move <= m) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  };

  /** Moves whose blocks changed something, for "what changed here". */
  const byMove = new Map();
  for (const t of trace) {
    let s = byMove.get(t.move);
    if (!s) byMove.set(t.move, (s = new Set()));
    s.add(t.key);
  }

  return {
    rows,
    count: rows.length,
    truncated: !!(program && program.variableTraceTruncated),
    /** The change in force at move m: {value, line, move, src}, or null before the first. */
    changeAt(row, m) {
      const i = indexAt(row, m);
      return i < 0 ? null : row.changes[i];
    },
    valueAt(row, m) {
      const i = indexAt(row, m);
      return i < 0 ? undefined : row.changes[i].value;
    },
    /** Which keys the blocks just before move m changed. */
    changedAt(m) { return byMove.get(m) || new Set(); },
    indexAt,
  };
}

/** A value the way the control would show it. */
export function formatVariable(value, type, digits = 4) {
  if (value === undefined) return '–';
  if (typeof value === 'string') return `"${value}"`;
  if (type === 'BOOL') return value ? 'TRUE' : 'FALSE';
  if (type === 'INT') return String(Math.round(value));
  if (!Number.isFinite(value)) return String(value);
  // Enough places to tell 0.1 from 0.1001, and none that say nothing.
  return String(Number(value.toFixed(digits)));
}
