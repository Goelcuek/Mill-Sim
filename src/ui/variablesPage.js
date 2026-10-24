// Program › Variables: what every variable held, as the program runs.
//
// The Summary says what the variables came to when the program ended. That
// answers the wrong question when a part comes out wrong half way through:
// what matters is what DEPTH was on the pass that cut too deep. So this
// page follows the run — every value is the one in force on the move the
// machine is on — and each one says which line last set it, one click from
// going there.
//
// Its nodes are built once per program and only their text is rewritten as
// the run moves. A page of three hundred rows rebuilt sixty times a second
// is the readout competing with the cut for the same frame.

import { el, clear, button } from './dom.js';
import { formatVariable } from '../gcode/variableTimeline.js';
import { registersOf, parseRegisterKey } from '../gcode/dialects.js';
import { machineDialect } from './programDialogs.js';
import { DEFAULT_PARAMETERS } from '../machine/macros.js';

/** More rows than this and the page asks for a search instead. */
const MAX_ROWS = 300;
/** A history longer than this shows its most recent changes. */
const MAX_HISTORY = 60;

/** What a row's tag says: its type, and where it lives when not in the main program. */
function tagOf(row) {
  if (row.kind === 'machine') return 'machine';
  if (row.kind === 'register') {
    // A local belongs to a call: the main program's, or the macro's.
    if (row.group && row.group.local) return row.scope || 'main program';
    return row.preset ? 'set on the machine' : '';
  }
  return row.scope ? `${row.type} · ${row.scope}` : row.type;
}

/** What a shop keeps in the registers before a run, said for this control. */
function presetHint(dialect, regs) {
  if (regs.main === '#') {
    return 'What the control holds before the program starts. #500 to #999 are kept through power off — part counts, probing results, a shop\u2019s own offsets — and #100 to #199 are whatever the last program left. Set them here and the program reads them as it would on the machine.';
  }
  if (regs.banks.includes('RG') && regs.banks.includes('PT')) {
    return 'RG and PT registers as the operator left them on the control: RG50, PT3. A program that branches on an item number reads the number dialled in here.';
  }
  if (dialect.namedVariables) {
    return `${regs.main} parameters as the channel holds them — R10 — or a name the program reads without declaring it, the control\u2019s global user data: SAFEZ.`;
  }
  return `${regs.banks.join(' and ')} registers as the control holds them before the program starts.`;
}

/** What to type, for this control. */
function presetExample(dialect, regs) {
  if (regs.main === '#') return '#500';
  if (regs.banks.length > 1) return regs.banks.map((b, i) => `${b}${i ? 3 : 50}`).join(' or ');
  return dialect.namedVariables ? `${regs.main}10 or SAFEZ` : `${regs.main}10`;
}

/** A star that says whether its variable is on the readout. */
function showPin(pin, on) {
  pin.classList.toggle('on', on);
  pin.textContent = on ? '★' : '☆';
  pin.title = on ? 'Take off the readout' : 'Show on the readout over the viewport';
  pin.setAttribute('aria-pressed', on ? 'true' : 'false');
}

export class VariablesView {
  constructor(app) {
    this.app = app;
    this.query = '';
    /** Values at the move the machine is on, or as the program ended. */
    this.follow = true;
    /** Rows whose history is open, by key. */
    this.opened = new Set();
    this.host = el('div.vars-host');
    this.listHost = el('div.vars-list');
    this.status = el('div.vars-status');
    this.search = el('input.vars-search', {
      type: 'search',
      placeholder: 'Find a variable',
      'aria-label': 'Find a variable',
      oninput: (e) => { this.query = e.target.value.trim().toUpperCase(); this.buildList(); },
    });
    this.followBox = el('input', {
      type: 'checkbox',
      checked: true,
      onchange: (e) => { this.follow = e.target.checked; this.update(true); },
    });
    this.presetHost = el('div.vars-presets');
    this.host.append(
      el('div.vars-toolbar', {}, [
        this.search,
        el('label.checkbox', { title: 'Show each value as it was on the move the machine is on; off, as the program left it' }, [this.followBox, el('span', {}, 'Follow the run')]),
      ]),
      this.status,
      this.listHost,
      this.presetHost,
    );
    /** key -> {row, value, where, node, history} for the rows on screen. */
    this.cells = new Map();
    this.timeline = null;
    this.at = null;
  }

  /** The page, brought up to date with whatever program is loaded. */
  render() {
    const t = this.app.variables();
    if (t !== this.timeline) {
      this.timeline = t;
      this.buildList();
    } else {
      this.update(true);
    }
    return [this.host];
  }

  /**
   * Where in the run the values are shown: the move being made, the block
   * single block has stopped after, or — not following — the end.
   */
  position() {
    if (!this.follow) return { move: Infinity, block: null };
    return this.app.runPosition();
  }

  matches(row) {
    return !this.query || row.key.toUpperCase().includes(this.query);
  }

  buildList() {
    const app = this.app;
    const t = this.timeline;
    const program = app.state.program;
    clear(this.listHost);
    this.cells.clear();
    this.at = null;
    this.buildPresets();

    if (!program) {
      this.listHost.appendChild(el('div.hint', {}, 'Open a program or pick an example to begin.'));
      return;
    }
    if (!t || !t.count) {
      this.listHost.appendChild(this.emptyState());
      this.status.textContent = '';
      return;
    }

    const shown = t.rows.filter((r) => this.matches(r));
    // The control's own groups: Local, Common, Retained on a Fanuc; RG and
    // PT on a Fidia. Each says which numbers it covers, because "#512" is
    // only meaningful to someone who knows that it survives a power cycle.
    let budget = MAX_ROWS;
    for (const g of t.groups) {
      const rows = g.rows.filter((r) => this.matches(r));
      if (!rows.length) continue;
      const body = rows.slice(0, Math.max(0, budget)).map((r) => this.rowNode(r));
      budget -= body.length;
      const head = el('div.vars-group-head', { title: g.note || '' }, [
        el('span', {}, [g.label, g.span ? el('span.vars-span', {}, g.span) : null]),
        el('span.vars-count', {}, String(rows.length)),
      ]);
      this.listHost.append(head);
      if (g.note) this.listHost.appendChild(el('div.vars-note', {}, g.note));
      this.listHost.append(...body);
      if (rows.length > body.length) {
        this.listHost.appendChild(el('div.hint', {}, `${rows.length - body.length} more — search to narrow the list.`));
      }
      if (g.kind === 'machine') {
        this.listHost.appendChild(el('div.hint.vars-hint', {}, 'Named data this machine holds, read by the program without declaring it. Set it under Starting values below.'));
      }
    }
    if (!shown.length) this.listHost.appendChild(el('div.hint', {}, `Nothing called ${this.query}.`));
    if (t.truncated) {
      this.listHost.appendChild(el('div.inline-warning', {}, 'The program changed its variables more times than are kept. Values are right up to where the record stops; after that they are the last ones written down.'));
    }
    this.update(true);
  }

  rowNode(row) {
    const app = this.app;
    const pinned = app.watch.has(row.key);
    const value = el('span.var-value');
    const where = el('button.var-where', {
      type: 'button',
      title: 'Go to the move this was set before',
      onclick: () => this.goTo(this.timeline.changeAt(row, this.position())),
    });
    const pin = el('button.var-pin', { type: 'button', onclick: () => app.toggleWatch(row.key) });
    showPin(pin, pinned);
    const tag = tagOf(row);
    const name = el('button.var-name', {
      type: 'button',
      title: `${row.changes.length} change${row.changes.length === 1 ? '' : 's'} — show them`,
      onclick: () => {
        if (this.opened.has(row.key)) this.opened.delete(row.key); else this.opened.add(row.key);
        this.fillHistory(cell);
      },
    }, [el('span.var-key', {}, row.name), tag ? el('span.var-type', {}, tag) : null]);
    const node = el('div.var-row', { dataset: { key: row.key } }, [pin, name, value, where]);
    const history = el('div.var-history');
    const wrap = el('div.var-item', {}, [node, history]);
    const cell = { row, value, where, node, history, wrap, pin, last: null };
    this.cells.set(row.key, cell);
    this.fillHistory(cell);
    return wrap;
  }

  /** The stars, after a pin has been put on or taken off from anywhere. */
  syncPins() {
    for (const cell of this.cells.values()) showPin(cell.pin, this.app.watch.has(cell.row.key));
  }

  /** The list of changes under a row, when it is open. */
  fillHistory(cell) {
    clear(cell.history);
    const open = this.opened.has(cell.row.key);
    cell.history.style.display = open ? '' : 'none';
    cell.items = null;
    if (!open) return;
    const all = cell.row.changes;
    const from = Math.max(0, all.length - MAX_HISTORY);
    if (from > 0) cell.history.appendChild(el('div.hint', {}, `The last ${MAX_HISTORY} of ${all.length} changes.`));
    cell.items = all.slice(from).map((c, i) => {
      const item = el('button.var-change', { type: 'button', onclick: () => this.goTo(c), title: 'Go there' }, [
        el('span.var-change-line', {}, c.src ? `L${c.line} · ${c.src}` : (c.line ? `L${c.line}` : 'before the program')),
        el('span.var-change-value', {}, formatVariable(c.value, cell.row.type)),
      ]);
      item.dataset.index = String(from + i);
      return item;
    });
    cell.history.append(...cell.items);
    cell.lastIndex = undefined;
    this.updateCell(cell, this.position(), true);
  }

  /** Run the machine to just before a change, and stay on this page. */
  goTo(change) {
    if (!change) return;
    if (!this.follow) {
      this.follow = true;
      this.followBox.checked = true;
    }
    // To the line that set it, when the record says which block that was:
    // the run stops just after it, as single block would.
    if (change.block !== undefined && change.block >= 0) this.app.seekToBlock(change.block);
    else this.app.seekToMove(change.move);
  }

  /** Bring the values on screen up to where the run is. */
  update(force = false) {
    const t = this.timeline;
    if (!t || !t.count) return;
    const at = this.position();
    const key = `${at.move}:${at.block}`;
    if (!force && key === this.at) return;
    this.at = key;
    const program = this.app.state.program;
    const live = at.block !== null || Number.isFinite(at.move);
    if (at.block !== null) {
      const b = this.app.currentBlock();
      this.status.textContent = b ? `Single block · after line ${b.line}${b.source ? ` in ${b.source}` : ''}` : 'Single block';
    } else {
      const mv = program && live ? program.moves[at.move] : null;
      this.status.textContent = live
        ? (mv ? `On move ${at.move + 1} of ${program.moves.length} · line ${mv.line}${mv.source ? ` in ${mv.source}` : ''}` : 'Before the first move')
        : 'As the program left them';
    }
    const changed = live ? t.changedAt(at) : null;
    for (const cell of this.cells.values()) this.updateCell(cell, at, false, changed);
  }

  updateCell(cell, at, force, changed = (at.block !== null || Number.isFinite(at.move)) ? this.timeline.changedAt(at) : null) {
    const t = this.timeline;
    const i = t.indexAt(cell.row, at);
    if (!force && i === cell.lastIndex) {
      cell.node.classList.toggle('changed', !!(changed && changed.has(cell.row.key)));
      return;
    }
    cell.lastIndex = i;
    const c = i < 0 ? null : cell.row.changes[i];
    cell.value.textContent = c ? formatVariable(c.value, cell.row.type) : '–';
    cell.value.classList.toggle('unset', !c);
    cell.where.textContent = c ? (c.line ? `L${c.line}` : 'preset') : '';
    cell.where.disabled = !c;
    cell.where.title = c
      ? (c.line ? `Set on line ${c.line}${c.src ? ` of ${c.src}` : ''} — go there` : 'Set before the program started')
      : 'Not set yet at this point in the run';
    cell.node.classList.toggle('changed', !!(changed && changed.has(cell.row.key)));
    if (cell.items) {
      for (const item of cell.items) item.classList.toggle('current', Number(item.dataset.index) === i);
    }
  }

  // ---- starting values ---------------------------------------------------

  /** The machine's parameters that are registers, or names the program can read. */
  presets(dialect, regs) {
    const params = this.app.state.machine.parameters || {};
    const out = [];
    for (const [key, value] of Object.entries(params)) {
      const reg = parseRegisterKey(key, regs);
      if (reg) out.push({ key, label: `${reg.bank}${reg.n}`, value, reg });
      // The tool-change and park positions are the macros' business and
      // have their own page; a name a shop added is shown here.
      else if (dialect.namedVariables && !(key in DEFAULT_PARAMETERS)) out.push({ key, label: key.toUpperCase(), value, reg: null });
    }
    return out.sort((a, b) => (a.reg ? 0 : 1) - (b.reg ? 0 : 1)
      || (a.reg && b.reg ? regs.banks.indexOf(a.reg.bank) - regs.banks.indexOf(b.reg.bank) || a.reg.n - b.reg.n : a.label.localeCompare(b.label)));
  }

  /**
   * Starting values: what the control holds before the program starts.
   *
   * On the machine an operator sets #500 or RG 50 on the control's own
   * variable page, and the program branches on what it finds. Here they
   * belong to the machine for the same reason, and are kept with it.
   */
  buildPresets() {
    const app = this.app;
    const dialect = machineDialect(app);
    const regs = registersOf(dialect);
    const host = this.presetHost;
    clear(host);
    const list = this.presets(dialect, regs);
    const message = el('div.vars-error');
    const commit = () => {
      app.reinterpret();
      // No program loaded: nothing re-reads, so the list is drawn here.
      if (!app.state.program) this.buildPresets();
    };

    const rows = list.map((p) => el('div.var-preset', {}, [
      el('span.var-key', {}, p.label),
      el('input.vars-input.var-preset-value', {
        type: 'number',
        step: 'any',
        value: String(p.value),
        'aria-label': `Starting value of ${p.label}`,
        onchange: (e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          app.state.machine.parameters[p.key] = v;
          commit();
        },
      }),
      el('button.var-preset-remove', {
        type: 'button',
        title: `Forget ${p.label}: the program finds it empty`,
        onclick: () => { delete app.state.machine.parameters[p.key]; commit(); },
      }, '✕'),
    ]));

    const name = el('input.vars-input', { type: 'text', placeholder: presetExample(dialect, regs), 'aria-label': 'Variable' });
    const value = el('input.vars-input.var-preset-value', { type: 'number', step: 'any', placeholder: '0', 'aria-label': 'Value' });
    const add = () => {
      const res = this.presetKey(name.value, dialect, regs);
      if (res.error) { message.textContent = res.error; return; }
      const v = Number(value.value || 0);
      if (!Number.isFinite(v)) { message.textContent = 'The value has to be a number.'; return; }
      const params = app.state.machine.parameters;
      // "50" and "RG50" are the same register: one entry, under the new spelling.
      for (const key of Object.keys(params)) {
        const reg = parseRegisterKey(key, regs);
        if (res.reg && reg && reg.bank === res.reg.bank && reg.n === res.reg.n) delete params[key];
        if (!res.reg && key.toUpperCase() === res.key) delete params[key];
      }
      params[res.key] = v;
      message.textContent = '';
      commit();
    };
    const onEnter = (e) => { if (e.key === 'Enter') add(); };
    name.addEventListener('keydown', onEnter);
    value.addEventListener('keydown', onEnter);

    host.append(
      el('div.vars-group-head', {}, [el('span', {}, 'Starting values'), el('span.vars-count', {}, list.length ? String(list.length) : '')]),
      el('div.vars-note', {}, presetHint(dialect, regs)),
      ...rows,
      el('div.var-preset.var-preset-add', {}, [name, value, button('Set', add, { title: 'Hold this value before the program starts' })]),
      message,
    );
  }

  /** What a typed name means: a register in a bank this control has, or a name. */
  presetKey(text, dialect, regs) {
    const typed = String(text || '').trim();
    if (!typed) return { error: `Type a variable: ${presetExample(dialect, regs)}.` };
    const reg = parseRegisterKey(typed, regs);
    if (reg) {
      const range = regs.ranges.find((r) => r.bank === reg.bank && reg.n >= r.from && reg.n <= r.to);
      if (!range && regs.strict) {
        const has = regs.ranges.filter((r) => r.bank === reg.bank).map((r) => (r.to >= 99999 ? `${r.bank}${r.from} up` : `${r.bank}${r.from}–${r.bank}${r.to}`));
        return { error: `${reg.bank}${reg.n} is not a variable on this control, which has ${has.join(', ')}.` };
      }
      if (range && range.local) {
        return { error: `${range.bank}${range.from}–${range.bank}${range.to} belong to the call that is running, and the control starts each one empty. Use a common one: ${reg.bank}100 or ${reg.bank}500.` };
      }
      return { key: `${reg.bank}${reg.n}`, reg };
    }
    if (dialect.namedVariables && /^[A-Za-z_][A-Za-z0-9_]+$/.test(typed)) return { key: typed.toUpperCase(), reg: null };
    return { error: `${typed} is not one of this control\u2019s variables. It has ${regs.banks.join(' and ')}: ${presetExample(dialect, regs)}.` };
  }

  /** What to say when the program keeps nothing. */
  emptyState() {
    const app = this.app;
    const d = machineDialect(app);
    const siemens = d && d.namedVariables;
    const regs = registersOf(d);
    const mark = regs.main;
    // How this control sets one: #100 = 5, R100 = 5, RG 50 1.
    const example = d.assignEquals === false
      ? regs.banks.map((b, i) => `${b} ${i ? 3 : 50} ${i ? 2 : 1}`).join(' or ')
      : `${mark}100 = 5`;
    return el('div.vars-empty', {}, [
      el('div.hint', {}, 'This program does not set any variables.'),
      siemens
        ? el('div.hint', {}, [
          'A program declares its own with DEF and uses them by name:',
          el('pre.vars-example', {}, 'DEF REAL DEPTH=5, STEP=2.5\nDEF INT PASSES=0\nG1 Z=-DEPTH F200\nPASSES=PASSES+1'),
          `R parameters (${mark}1, ${mark}2 …) need no declaring. A name the program does not declare is looked up in the machine's own data, set under Starting values below.`,
        ])
        : el('div.hint', {}, `When it does — ${example} — each one is listed here with the value it held on the move the machine is on, and the line that set it.`),
    ]);
  }
}
