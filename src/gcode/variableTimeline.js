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
  const regs = (program && program.registers) || { banks: [(program && program.variablePrefix) || '#'], ranges: [] };
  // Longest first, so VC12 is a VC and not a V followed by C12.
  const banks = [...regs.banks].sort((a, b) => b.length - a.length);

  /** R5, #100, PT 3: which bank and which number, or null for a name. */
  const registerOf = (local) => {
    for (const b of banks) {
      if (local.startsWith(b) && /^\d+$/.test(local.slice(b.length))) return { bank: b, number: Number(local.slice(b.length)) };
    }
    return null;
  };
  /** The range a register falls in; one of its own when the table has none. */
  const groupOf = (bank, n) => regs.ranges.find((r) => r.bank === bank && n >= r.from && n <= r.to)
    || { bank, from: 0, to: 1e9, label: `${bank} variables` };

  const byKey = new Map();
  for (const t of trace) {
    let r = byKey.get(t.key);
    if (!r) {
      const { base, local, scope, element } = splitKey(t.key);
      const decl = declared.get(scope ? `${base} · ${scope}` : base) || null;
      const reg = decl ? null : registerOf(local);
      r = {
        key: t.key,
        name: local,
        base,
        scope,
        element,
        bank: reg ? reg.bank : null,
        number: reg ? reg.number : null,
        group: reg ? groupOf(reg.bank, reg.number) : null,
        type: decl ? decl.type : 'REAL',
        kind: decl ? (decl.global ? 'machine' : 'declared') : reg ? 'register' : 'declared',
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
  // registers, range by range in the order the control lists them and by
  // number within one; then what the machine holds.
  const order = { declared: 0, register: 1, machine: 2 };
  const firstSeen = new Map([...byKey.keys()].map((k, i) => [k, i]));
  const rangeIndex = (r) => {
    const i = regs.ranges.indexOf(r.group);
    return i < 0 ? regs.ranges.length : i;
  };
  const rows = [...byKey.values()].sort((a, b) => (order[a.kind] - order[b.kind])
    || (a.kind === 'register' ? (rangeIndex(a) - rangeIndex(b))
      || (banks.indexOf(a.bank) - banks.indexOf(b.bank))
      || (a.number - b.number)
      || ((a.scope ? 1 : 0) - (b.scope ? 1 : 0)) : 0)
    || (firstSeen.get(a.key) - firstSeen.get(b.key)));

  // The same rows, in the groups the page shows them under.
  const groups = [];
  for (const r of rows) {
    const id = r.kind === 'register' ? `reg:${r.group.bank}:${r.group.from}` : r.kind;
    let g = groups.find((x) => x.id === id);
    if (!g) {
      g = r.kind === 'register'
        ? { id, kind: 'register', range: r.group, label: r.group.label, span: spanOf(r.group), note: r.group.note || null, rows: [] }
        : { id, kind: r.kind, label: r.kind === 'machine' ? 'Machine data' : 'In the program', span: '', note: null, rows: [] };
      groups.push(g);
    }
    g.rows.push(r);
  }

  /**
   * The index of the last change in force at a point in the run, or -1.
   *
   * A point is a move — in force while move m runs — or, when the run is
   * being stepped a block at a time, a block: everything up to and
   * including block b. Both only ever go up through the record, so either
   * is a binary search.
   */
  const indexAt = (row, at) => {
    const byBlock = at !== null && typeof at === 'object' && at.block !== null && at.block !== undefined;
    const limit = byBlock ? at.block : (typeof at === 'object' && at !== null ? at.move : at);
    const field = byBlock ? 'block' : 'move';
    const c = row.changes;
    let lo = 0;
    let hi = c.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((c[mid][field] ?? -1) <= limit) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  };

  /** Moves whose blocks changed something, and the blocks themselves. */
  const byMove = new Map();
  const byBlock = new Map();
  for (const t of trace) {
    let s = byMove.get(t.move);
    if (!s) byMove.set(t.move, (s = new Set()));
    s.add(t.key);
    if (t.block !== undefined && t.block >= 0) {
      let b = byBlock.get(t.block);
      if (!b) byBlock.set(t.block, (b = new Set()));
      b.add(t.key);
    }
  }

  return {
    rows,
    groups,
    count: rows.length,
    truncated: !!(program && program.variableTraceTruncated),
    /** The change in force at a point: {value, line, move, src, block}, or null before the first. */
    changeAt(row, at) {
      const i = indexAt(row, at);
      return i < 0 ? null : row.changes[i];
    },
    valueAt(row, at) {
      const i = indexAt(row, at);
      return i < 0 ? undefined : row.changes[i].value;
    },
    /** Which keys the blocks just before move m changed — or block b itself, stepping. */
    changedAt(at) {
      if (at !== null && typeof at === 'object' && at.block !== null && at.block !== undefined) return byBlock.get(at.block) || new Set();
      const m = typeof at === 'object' && at !== null ? at.move : at;
      return byMove.get(m) || new Set();
    },
    indexAt,
  };
}

/** The numbers a range covers, the way the control writes them: #100–#199, RG0–RG99. */
export function spanOf(r) {
  if (!r) return '';
  return r.to >= 99999 ? `${r.bank}${r.from} and up` : `${r.bank}${r.from}–${r.bank}${r.to}`;
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
