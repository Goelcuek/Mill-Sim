// Program panel: the G-code, and what the interpreter made of it.
//
// Four pages, because a job is not one file. The main program is what the
// post wrote; subprograms are the files it calls with M98 and which live
// beside it on the control; macros are what the *machine* does at an M
// code, which is a property of the machine and travels with it. Keeping
// all three here is what makes "what will this machine do with this
// program" answerable in one place.
//
// The editors keep their own DOM across redraws — a textarea that is thrown
// away loses the caret, the scroll position and the undo stack — so
// switching pages detaches them rather than rebuilding them.

import { el, button, row, section, clear, select, field, checkbox, download, pickFile } from './dom.js';
import { Panel, addBar, actionRow } from './panel.js';
import { openSubprogramDialog, openMacroDialog, openParameterDialog } from './programDialogs.js';
import { PARAMETER_HINTS, macroReferences } from '../machine/macros.js';
import { GcodeEditor } from './editor.js';
import { fmt, fmtDuration } from '../core/util.js';
import { EXAMPLES, loadExample } from '../examples.js';

export class ProgramPanel extends Panel {
  constructor(app) {
    super(app, [
      { id: 'editor', label: 'Main', icon: 'open', hint: 'The program itself: open, edit and re-read it', render: ProgramPanel.prototype.editorPage },
      { id: 'subs', label: 'Subprograms', icon: 'library', hint: 'The files M98 calls', badge: () => app.state.subprograms.length || null, render: ProgramPanel.prototype.subsPage },
      { id: 'macros', label: 'Macros', icon: 'machine', hint: 'What this machine does at each M code', badge: () => (app.state.machine.macros || []).filter((m) => m.enabled).length || null, render: ProgramPanel.prototype.macrosPage },
      { id: 'summary', label: 'Summary', icon: 'report', hint: 'What the interpreter made of it', badge: () => (app.state.program && app.state.program.warnings.length) || null, render: ProgramPanel.prototype.summaryPage },
    ]);
    this.root.classList.add('panel-program');
    this.editorHost = el('div.editor-host');
    this.subHost = el('div.editor-host');
    this.summaryHost = el('div.summary-host');
    this.editor = null;
    this.subEditor = null;
    /** Which subprogram and which macro the pages are acting on. */
    this.subId = null;
    this.macroId = null;
    this.render();
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

  /** The subprogram the page is acting on. */
  get sub() {
    return this.app.state.subprograms.find((x) => x.id === this.subId) || null;
  }

  subsPage() {
    const app = this.app;
    const subs = app.state.subprograms;
    const list = el('div.list');

    if (!subs.length) {
      list.appendChild(el('div.empty', {}, [
        el('div.empty-title', {}, 'No subprograms'),
        el('div.hint', {}, 'A post that writes M98 P1000 expects a file called O1000 to be on the control. Add it here and the call resolves; without it the interpreter can only report a missing subprogram. A program that carries its own O-numbered sections needs nothing here.'),
      ]));
    }

    for (const sub of subs) {
      const lines = String(sub.text || '').split('\n').length;
      const calls = this.callCount(sub);
      list.appendChild(el(`div.list-item${this.subId === sub.id ? '.selected' : ''}`, {
        onclick: () => { this.subId = sub.id; this.render(); },
      }, [
        el('div.swatch', { style: { background: calls ? '#0a7cff' : '#d0d4db' } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, [el('span.tnum', {}, `O${sub.number}`), sub.name]),
          el('div.list-sub', {}, `${lines} ${lines === 1 ? 'line' : 'lines'} · ${calls ? `called ${calls} ${calls === 1 ? 'time' : 'times'}` : 'never called'}`),
        ]),
      ]));
    }

    const out = [section(`Subprograms (${subs.length})`, [
      addBar('Add subprogram…', () => openSubprogramDialog(app, this), { hint: 'A file the main program calls with M98' }),
      list,
      actionRow([
        { label: 'Save as file', disabled: !this.sub, onClick: () => { const x = this.sub; download(`O${x.number}.nc`, x.text || '', 'text/plain'); } },
        { label: 'Delete', disabled: !this.sub, variant: 'warn', onClick: () => this.deleteSub() },
      ]),
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
            this._subDebounce = setTimeout(() => this.app.loadProgram(this.app.state.source, this.app.state.programName), 400);
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
      out.push(el('div.section-label-row', {}, el('div.dialog-section-label', {}, `O${sub.number} — ${sub.name}`)));
      out.push(this.subHost);
    }
    return out;
  }

  /** How often the loaded program actually called this subprogram. */
  callCount(sub) {
    const program = this.app.state.program;
    if (!program) return 0;
    return program.moves.filter((m) => m.source === sub.name).length ? 1 : 0;
  }

  deleteSub() {
    const app = this.app;
    app.state.subprograms = app.state.subprograms.filter((x) => x.id !== this.subId);
    this.subId = null;
    this.subEditorFor = null;
    app.loadProgram(app.state.source, app.state.programName);
    this.render();
  }

  // ---- macros ------------------------------------------------------------

  macrosPage() {
    const app = this.app;
    const machine = app.state.machine;
    const macros = machine.macros || [];
    const list = el('div.list');

    for (const mac of macros) {
      const refs = macroReferences(mac.body);
      list.appendChild(el(`div.list-item${this.macroId === mac.id ? '.selected' : ''}`, {
        onclick: () => { this.macroId = mac.id; this.render(); },
        ondblclick: () => openMacroDialog(app, this, mac.id),
        title: 'Double-click to edit',
      }, [
        el('div.swatch', { style: { background: mac.enabled ? '#1a9d4b' : '#d0d4db' } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, [el('span.tnum', {}, mac.code), mac.name]),
          el('div.list-sub', {}, [
            mac.enabled ? 'runs' : 'not used',
            `${String(mac.body || '').trim().split('\n').length} lines`,
            refs.length ? `reads ${refs.map((r) => `#${r}`).join(' ')}` : null,
          ].filter(Boolean).join(' · ')),
        ]),
        el('div.list-actions', {}, [
          button(mac.enabled ? 'Turn off' : 'Turn on', (e) => {
            e.stopPropagation();
            mac.enabled = !mac.enabled;
            app.loadProgram(app.state.source, app.state.programName);
            this.render();
          }),
        ]),
      ]));
    }

    const selected = macros.find((m) => m.id === this.macroId) || null;

    const params = section('Machine parameters', [
      addBar('Add parameter…', () => openParameterDialog(app, this), { hint: 'A number of your own that macros can read' }),
      ...Object.keys(machine.parameters || {}).map((key) => row([
        field(key, machine.parameters[key], {
          type: 'number', step: 1,
          // The ones this program ships know what they are; one the user
          // added could be an angle or a dwell, so it is left unlabelled.
          unit: PARAMETER_HINTS[key] ? 'mm' : '',
          title: PARAMETER_HINTS[key] || `Read by a macro as #${key}`,
          onChange: (v) => {
            machine.parameters[key] = Number(v) || 0;
            app.loadProgram(app.state.source, app.state.programName);
          },
        }),
        button('✕', () => {
          delete machine.parameters[key];
          app.loadProgram(app.state.source, app.state.programName);
          this.render();
        }, { title: `Remove #${key}`, variant: 'warn' }),
      ])),
      el('div.hint', {}, 'A macro reads these by name — #toolChangeX in a body becomes this number. They belong to the machine, so they are saved with it and a program that moves to another machine picks up that machine\u2019s positions.'),
    ]);

    return [
      section(`M codes (${macros.length})`, [
        addBar('Add macro…', () => openMacroDialog(app, this, null), { hint: 'Say what this machine does at an M code' }),
        el('div.hint', {}, 'A control does not really do M06 — it runs a program the machine builder wrote, which retracts, goes to the change position and swaps the tool. That is what these are. They belong to the machine, not to the part program, and they are saved with it.'),
        list,
        actionRow([
          { label: 'Edit…', variant: 'primary', disabled: !selected, onClick: () => openMacroDialog(app, this, this.macroId) },
          {
            label: selected && selected.enabled ? 'Turn off' : 'Turn on',
            disabled: !selected,
            hint: 'Whether this machine actually runs it',
            onClick: () => {
              selected.enabled = !selected.enabled;
              app.loadProgram(app.state.source, app.state.programName);
              this.render();
            },
          },
          { label: 'Duplicate', disabled: !selected, onClick: () => this.duplicateMacro() },
          { label: 'Delete', disabled: !selected, variant: 'warn', onClick: () => this.deleteMacro() },
        ]),
      ]),
      params,
    ];
  }

  duplicateMacro() {
    const app = this.app;
    const mac = (app.state.machine.macros || []).find((m) => m.id === this.macroId);
    if (!mac) return;
    const copy = app.addMacro({ ...mac, id: undefined, name: `${mac.name} copy`, enabled: false });
    this.macroId = copy.id;
    this.render();
  }

  deleteMacro() {
    const app = this.app;
    app.state.machine.macros = (app.state.machine.macros || []).filter((m) => m.id !== this.macroId);
    this.macroId = null;
    app.loadProgram(app.state.source, app.state.programName);
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
    if (this.page === 'summary' || this.page === 'subs' || this.page === 'macros') this.render();
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
