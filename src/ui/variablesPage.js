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
import { DIALECTS } from '../gcode/dialects.js';

/** More rows than this and the page asks for a search instead. */
const MAX_ROWS = 300;
/** A history longer than this shows its most recent changes. */
const MAX_HISTORY = 60;

/** What a row's tag says: its type, and where it lives when not in the main program. */
function tagOf(row) {
  if (row.kind === 'machine') return 'machine';
  if (row.kind === 'register') return row.preset ? 'set on the machine' : '';
  return row.scope ? `${row.type} · ${row.scope}` : row.type;
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
    this.host.append(
      el('div.vars-toolbar', {}, [
        this.search,
        el('label.checkbox', { title: 'Show each value as it was on the move the machine is on; off, as the program left it' }, [this.followBox, el('span', {}, 'Follow the run')]),
      ]),
      this.status,
      this.listHost,
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

  /** The move whose values are shown. */
  moveShown() {
    const sim = this.app.simulator;
    if (!this.follow || sim.finished) return Infinity;
    return sim.moveIndex;
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
    const groups = [
      { kind: 'declared', title: 'In the program', hint: null },
      { kind: 'register', title: 'Parameters', hint: null },
      { kind: 'machine', title: 'Machine data', hint: 'Named parameters this machine holds, read by the program without declaring them. They are set on Machine › Macros.' },
    ];
    let budget = MAX_ROWS;
    for (const g of groups) {
      const rows = shown.filter((r) => r.kind === g.kind);
      if (!rows.length) continue;
      const body = rows.slice(0, Math.max(0, budget)).map((r) => this.rowNode(r));
      budget -= body.length;
      const head = el('div.vars-group-head', {}, [el('span', {}, g.title), el('span.vars-count', {}, String(rows.length))]);
      this.listHost.append(head, ...body);
      if (rows.length > body.length) {
        this.listHost.appendChild(el('div.hint', {}, `${rows.length - body.length} more — search to narrow the list.`));
      }
      if (g.hint) {
        this.listHost.appendChild(el('div.hint.vars-hint', {}, [
          g.hint, ' ',
          button('Open', () => app.setPage('machine', 'macros'), { title: 'Machine › Macros, where these are set' }),
        ]));
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
      onclick: () => this.goTo(this.timeline.changeAt(row, this.moveShown())),
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
    this.updateCell(cell, this.moveShown(), true);
  }

  /** Run the machine to just before a change, and stay on this page. */
  goTo(change) {
    if (!change) return;
    if (!this.follow) {
      this.follow = true;
      this.followBox.checked = true;
    }
    this.app.seekToMove(change.move);
  }

  /** Bring the values on screen up to the move the machine is on. */
  update(force = false) {
    const t = this.timeline;
    if (!t || !t.count) return;
    const m = this.moveShown();
    if (!force && m === this.at) return;
    this.at = m;
    const program = this.app.state.program;
    const mv = program && Number.isFinite(m) ? program.moves[m] : null;
    this.status.textContent = Number.isFinite(m)
      ? (mv ? `On move ${m + 1} of ${program.moves.length} · line ${mv.line}${mv.source ? ` in ${mv.source}` : ''}` : 'Before the first move')
      : 'As the program left them';
    const changed = Number.isFinite(m) ? t.changedAt(m) : null;
    for (const cell of this.cells.values()) this.updateCell(cell, m, false, changed);
  }

  updateCell(cell, m, force, changed = Number.isFinite(m) ? this.timeline.changedAt(m) : null) {
    const t = this.timeline;
    const i = t.indexAt(cell.row, m);
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

  /** What to say when the program keeps nothing. */
  emptyState() {
    const app = this.app;
    const controller = app.state.machine.controller || {};
    const d = DIALECTS[controller.dialect] || null;
    const siemens = d && d.namedVariables;
    const mark = (app.state.program && app.state.program.variablePrefix) || '#';
    return el('div.vars-empty', {}, [
      el('div.hint', {}, 'This program does not set any variables.'),
      siemens
        ? el('div.hint', {}, [
          'A program declares its own with DEF and uses them by name:',
          el('pre.vars-example', {}, 'DEF REAL DEPTH=5, STEP=2.5\nDEF INT PASSES=0\nG1 Z=-DEPTH F200\nPASSES=PASSES+1'),
          `R parameters (${mark}1, ${mark}2 …) need no declaring. A name the program does not declare is looked up in the machine's own data, set on Machine › Macros.`,
        ])
        : el('div.hint', {}, `When it does — ${mark}100 = 5 — each one is listed here with the value it held on the move the machine is on, and the line that set it.`),
    ]);
  }
}
