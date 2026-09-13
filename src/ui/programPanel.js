// Program panel: the G-code, and what the interpreter made of it.
//
// A job is not one file. The main program is what the post wrote, and
// beside it are the subprograms it calls with M98 — ordinary files, opened
// the same way and edited in the same editor, because that is all they are.
// What the *machine* does at an M code is not part of the job at all; that
// lives with the machine, on Machine > Macros.
//
// The editors keep their own DOM across redraws — a textarea that is thrown
// away loses the caret, the scroll position and the undo stack — so
// switching pages detaches them rather than rebuilding them.

import { el, button, row, section, clear, select, field, checkbox, download, pickFile } from './dom.js';
import { Panel, addBar, actionRow } from './panel.js';
import { programNumber } from '../gcode/lexer.js';
import { uid } from '../core/util.js';
import { GcodeEditor } from './editor.js';
import { fmt, fmtDuration } from '../core/util.js';
import { EXAMPLES, loadExample } from '../examples.js';

export class ProgramPanel extends Panel {
  constructor(app) {
    super(app, [
      { id: 'editor', label: 'Main', icon: 'open', hint: 'The program itself: open, edit and re-read it', render: ProgramPanel.prototype.editorPage },
      { id: 'subs', label: 'Subprograms', icon: 'library', hint: 'The files this program calls with M98', badge: () => app.state.subprograms.length || null, render: ProgramPanel.prototype.subsPage },
      { id: 'summary', label: 'Summary', icon: 'report', hint: 'What the interpreter made of it', badge: () => (app.state.program && app.state.program.warnings.length) || null, render: ProgramPanel.prototype.summaryPage },
    ]);
    this.editorHost = el('div.editor-host');
    this.subHost = el('div.editor-host');
    this.summaryHost = el('div.summary-host');
    this.editor = null;
    this.subEditor = null;
    /** Which subprogram the page is acting on. */
    this.subId = null;
    this.render();
  }

  /**
   * Only the pages that host an editor get the fixed, unscrolling layout
   * the editor needs. Anything else is an ordinary panel that scrolls, or
   * its lower half is unreachable.
   */
  render() {
    const hostsEditor = this.page === 'editor' || this.page === 'subs';
    this.root.classList.toggle('panel-program', hostsEditor);
    super.render();
  }

  // ---- pages -------------------------------------------------------------

  editorPage() {
    const app = this.app;
    const bar = el('div.toolbar', {}, [
      button('Open…', () => this.openFile(), { variant: 'primary' }),
      button('Save', () => this.saveFile(), { disabled: !this.editor || !this.editor.value }),
      button('Re-read', () => app.loadProgram(this.editor ? this.editor.value : '', app.state.programName), { title: 'Interpret the text as it stands now' }),
      select('Examples', [{ value: '', label: 'Load an example…' }, ...EXAMPLES.map((e, i) => ({ value: String(i), label: e.name }))], '',
        (v, e) => { if (v === '') return; e.target.value = ''; this.loadExampleAt(Number(v)); }),
    ]);

    if (!this.editor) {
      this.editor = new GcodeEditor(this.editorHost, {
        onInput: (text) => {
          clearTimeout(this._debounce);
          this._debounce = setTimeout(() => this.app.loadProgram(text, this.app.state.programName), 400);
        },
        onSeekLine: (line) => this.app.seekToLine(line),
      });
      if (this.app.state.source) this.editor.setValue(this.app.state.source);
    } else if (this.editor.wrap.parentNode !== this.editorHost) {
      this.editorHost.appendChild(this.editor.wrap);
    }
    if (this.app.state.program) this.editor.setMarkers(this.app.state.program.warnings);

    return [bar, this.editorHost];
  }

  // ---- subprograms -------------------------------------------------------
  //
  // A subprogram is a file, not a form to fill in. It is opened the way the
  // main program is opened, edited in the same editor, and answers to the O
  // number written at the top of it — which is how the control finds it,
  // and so is the only thing here that matters.

  /** The subprogram the page is acting on. */
  get sub() {
    return this.app.state.subprograms.find((x) => x.id === this.subId) || null;
  }

  subsPage() {
    const app = this.app;
    const subs = app.state.subprograms;

    const bar = el('div.toolbar', {}, [
      button('Open…', () => this.openSubs(), { variant: 'primary', title: 'One file or several' }),
      button('New', () => this.newSub(), { title: 'Start an empty subprogram' }),
      button('Save', () => this.saveSub(), { disabled: !this.sub }),
      button('Remove', () => this.deleteSub(), { disabled: !this.sub, variant: 'warn' }),
    ]);

    const list = el('div.list');
    if (!subs.length) {
      list.appendChild(el('div.empty', {}, [
        el('div.empty-title', {}, 'No subprograms'),
        el('div.hint', {}, 'A post that writes M98 P1000 expects a file called O1000 to sit beside the program. Open those files here and the calls resolve. A subprogram that lives in the machine rather than with the job belongs on Machine \u203a Macros instead.'),
      ]));
    }

    for (const sub of subs) {
      const o = programNumber(sub.text);
      const lines = String(sub.text || '').split('\n').length;
      const ran = this.ranFrom(sub.name);
      list.appendChild(el(`div.list-item${this.subId === sub.id ? '.selected' : ''}`, {
        onclick: () => { this.subId = sub.id; this.render(); },
      }, [
        el('div.swatch', { style: { background: o === null ? '#d7263d' : ran ? '#0a7cff' : '#d0d4db' } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, [o === null ? null : el('span.tnum', {}, `O${o}`), sub.name]),
          el('div.list-sub', {}, o === null
            ? 'no O number on its first line, so M98 cannot find it'
            : `${lines} ${lines === 1 ? 'line' : 'lines'} · ${ran ? 'called by this program' : 'not called'}`),
        ]),
      ]));
    }

    const out = [bar, el('div.list-host', {}, [
      list,
      el('div.hint', {}, 'The number M98 asks for is the O word at the top of the file — rename the file freely, that is what the control reads.'),
    ])];

    const sub = this.sub;
    if (sub) {
      if (!this.subEditor) {
        this.subEditor = new GcodeEditor(this.subHost, {
          onInput: (text) => {
            const current = this.sub;
            if (!current) return;
            current.text = text;
            clearTimeout(this._subDebounce);
            this._subDebounce = setTimeout(() => this.app.reinterpret(), 400);
          },
        });
      } else if (this.subEditor.wrap.parentNode !== this.subHost) {
        this.subHost.appendChild(this.subEditor.wrap);
      }
      if (this.subEditorFor !== sub.id) {
        this.subEditor.setValue(sub.text || '');
        this.subEditorFor = sub.id;
      }
      const program = app.state.program;
      this.subEditor.setMarkers(program ? program.warnings.filter((w) => w.source === sub.name) : []);
      out.push(el('div.section-label-row', {}, el('div.dialog-section-label', {}, sub.name)));
      out.push(this.subHost);
    }
    return out;
  }

  /** Did the last run actually execute anything from this file? */
  ranFrom(name) {
    const program = this.app.state.program;
    return !!(program && program.moves.some((m) => m.source === name));
  }

  async openSubs() {
    const files = await pickFile('.nc,.gcode,.tap,.ngc,.cnc,.txt,.sub,.mpf,.eia', true);
    if (!files || !files.length) return;
    for (const file of files) {
      const sub = { id: uid('sub'), name: file.name, text: await file.text() };
      this.app.state.subprograms.push(sub);
      this.subId = sub.id;
    }
    this.subEditorFor = null;
    this.app.reinterpret();
    this.render();
  }

  newSub() {
    const taken = new Set(this.app.state.subprograms.map((s) => programNumber(s.text)));
    let n = 1000;
    while (taken.has(n)) n += 1;
    const sub = { id: uid('sub'), name: `O${n}.nc`, text: `O${n}\n\nM99\n` };
    this.app.state.subprograms.push(sub);
    this.subId = sub.id;
    this.subEditorFor = null;
    this.app.reinterpret();
    this.render();
  }

  saveSub() {
    const sub = this.sub;
    if (sub) download(sub.name, sub.text || '', 'text/plain');
  }

  deleteSub() {
    const app = this.app;
    app.state.subprograms = app.state.subprograms.filter((x) => x.id !== this.subId);
    this.subId = null;
    this.subEditorFor = null;
    app.reinterpret();
    this.render();
  }

  summaryPage() {
    this.refreshSummary();
    return [this.summaryHost];
  }

  setText(text) {
    if (this.editor) this.editor.setValue(text);
  }

  setActiveLine(line) {
    if (this.editor) this.editor.setActiveLine(line);
  }

  async openFile() {
    const [file] = await pickFile('.nc,.gcode,.tap,.ngc,.cnc,.txt,.mpf,.eia');
    if (!file) return;
    const text = await file.text();
    this.setText(text);
    this.app.loadProgram(text, file.name);
    this.app.setPage('program', 'editor');
  }

  saveFile() {
    download(this.app.state.programName || 'program.nc', this.editor ? this.editor.value : '', 'text/plain');
  }

  /** Load one of the shipped examples, along with the stock it was written for. */
  async loadExampleAt(index) {
    const app = this.app;
    const ex = EXAMPLES[index];
    if (!ex) return;
    try {
      app.notify(`Loading ${ex.name}…`, 'info');
      const code = await loadExample(ex);
      this.setText(code);
      if (ex.setup) app.applyExampleSetup(ex.setup);
      app.loadProgram(code, `${ex.name}.nc`);
      app.setPage('program', 'editor');
      app.notify(ex.description, 'ok');
    } catch (err) {
      app.notify(err.message, 'error');
    }
  }

  /** Called by the app on every re-interpret; harmless when off-screen. */
  refresh() {
    if (this.page === 'summary') this.render();
    else if (this.page === 'subs') {
      // The list says which files ran; only the editor keeps its own state.
      this.render();
    }
    else if (this.editor && this.app.state.program) {
      // Only the notes that belong to this text: a warning raised inside a
      // subprogram carries that file's line numbers, not these.
      this.editor.setMarkers(this.app.state.program.warnings.filter((w) => !w.source));
    }
  }

  refreshSummary() {
    const app = this.app;
    const program = app.state.program;
    clear(this.summaryHost);
    if (!program) {
      this.summaryHost.appendChild(el('div.hint', {}, 'Open a program or pick an example to begin.'));
      return;
    }

    const s = program.stats;
    const b = s.bounds;
    const grid = el('div.stat-grid', {}, [
      ['Moves', String(s.moveCount)],
      ['Blocks', String(s.blockCount)],
      ['Cycle time', fmtDuration(s.cycleTime)],
      ['Cutting', `${fmt(s.feedDistance / 1000, 2)} m`],
      ['Rapids', `${fmt(s.rapidDistance / 1000, 2)} m`],
      ['Tools used', program.toolChanges.length ? [...new Set(program.toolChanges.map((t) => `T${t.tool}`))].join(' ') : 'none'],
    ].map(([k, v]) => el('div.stat', {}, [el('div.stat-label', {}, k), el('div.stat-value', {}, v)])));

    const extents = el('table.extents', {}, [
      el('tr', {}, [el('th', {}, ''), el('th', {}, 'min'), el('th', {}, 'max'), el('th', {}, 'span')]),
      ...['X', 'Y', 'Z'].map((axis, i) => el('tr', {}, [
        el('th', {}, axis),
        el('td', {}, fmt(b.min[i], 3)),
        el('td', {}, fmt(b.max[i], 3)),
        el('td', {}, fmt(b.max[i] - b.min[i], 3)),
      ])),
    ]);

    this.summaryHost.appendChild(section('Program', [grid, extents, actionRow([
      { label: 'Fit the view to the path', onClick: () => this.app.fitToProgram() },
      { label: 'Fit the stock to the path', onClick: () => this.app.fitStockToProgram() },
    ])]));

    // What the macro variables came to, when the program used any. A macro
    // program that lands in the wrong place is usually a variable that is
    // not what its author thought, so this is the first place to look.
    if (program.variables && program.variables.length) {
      const mark = program.variablePrefix || '#';
      const grid = el('div.stat-grid', {}, program.variables.slice(0, 24).map((v) => el('div.stat', {}, [
        el('div.stat-label', {}, `${mark}${v.n}`),
        el('div.stat-value', {}, fmt(v.value, 4)),
      ])));
      this.summaryHost.appendChild(section(`Macro variables (${program.variables.length})`, [
        grid,
        el('div.hint', {}, program.variables.length > 24
          ? `The first 24, as they stood when the program ended. Anything local to a macro call is not listed.`
          : 'As they stood when the program ended. Anything local to a macro call is not listed.'),
      ]));
    }

    const errors = program.warnings.filter((w) => w.severity === 'error');
    const warns = program.warnings.filter((w) => w.severity !== 'error');
    if (program.warnings.length) {
      this.summaryHost.appendChild(section(`Interpreter notes (${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'})`, [
        el('ul.issues', {}, program.warnings.slice(0, 120).map((w) => el(`li.issue-${w.severity}`, {
          onclick: () => {
            this.app.seekToLine(w.line);
            this.app.setPage('program', 'editor');
            if (this.editor) this.editor.focusLine(w.line);
          },
          title: 'Jump to this line',
        }, [el('span.issue-line', {}, `L${w.line}`), w.message]))),
      ]));
    }
  }
}
