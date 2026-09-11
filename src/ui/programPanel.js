// Program panel: the G-code, and what the interpreter made of it.
//
// Two pages. The editor keeps its own DOM across redraws — a textarea that
// is thrown away loses the caret, the scroll position and the undo stack —
// so switching pages detaches it rather than rebuilding it.

import { el, button, row, section, clear, select, download, pickFile } from './dom.js';
import { Panel, actionRow } from './panel.js';
import { GcodeEditor } from './editor.js';
import { fmt, fmtDuration } from '../core/util.js';
import { EXAMPLES, loadExample } from '../examples.js';

export class ProgramPanel extends Panel {
  constructor(app) {
    super(app, [
      { id: 'editor', label: 'G-code', icon: 'open', hint: 'Open, edit and re-read the program', render: ProgramPanel.prototype.editorPage },
      { id: 'summary', label: 'Summary', icon: 'report', hint: 'What the interpreter made of it', badge: () => (app.state.program && app.state.program.warnings.length) || null, render: ProgramPanel.prototype.summaryPage },
    ]);
    this.root.classList.add('panel-program');
    this.editorHost = el('div.editor-host');
    this.summaryHost = el('div.summary-host');
    this.editor = null;
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
    else if (this.editor && this.app.state.program) this.editor.setMarkers(this.app.state.program.warnings);
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
