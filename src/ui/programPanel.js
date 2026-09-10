// Program panel: the G-code editor, what the interpreter made of it, and
// everything it wants to warn you about before you press play.

import { el, button, row, section, clear, select, download, pickFile } from './dom.js';
import { GcodeEditor } from './editor.js';
import { fmt, fmtDuration } from '../core/util.js';
import { EXAMPLES, loadExample } from '../examples.js';

export class ProgramPanel {
  constructor(app) {
    this.app = app;
    this.root = el('div.panel.panel-program');
    this.editorHost = el('div.editor-host');
    this.summaryHost = el('div.summary-host');
    this.editor = null;
    this.render();
  }

  render() {
    clear(this.root);
    const app = this.app;

    this.root.appendChild(el('div.toolbar', {}, [
      el('span.hint', {}, 'Open, save and load examples from the ribbon above.'),
    ]));

    this.root.appendChild(this.editorHost);
    this.root.appendChild(this.summaryHost);

    if (!this.editor) {
      this.editor = new GcodeEditor(this.editorHost, {
        onInput: (text) => {
          clearTimeout(this._debounce);
          this._debounce = setTimeout(() => this.app.loadProgram(text, this.app.state.programName), 400);
        },
        onSeekLine: (line) => this.app.seekToLine(line),
      });
      if (this.app.state.source) this.editor.setValue(this.app.state.source);
    } else {
      this.editorHost.appendChild(this.editor.wrap);
    }

    this.refreshSummary();
  }

  setText(text) {
    if (this.editor) this.editor.setValue(text);
  }

  setActiveLine(line) {
    if (this.editor) this.editor.setActiveLine(line);
  }

  refresh() {
    this.refreshSummary();
  }

  /** Buttons for the contextual ribbon row. */
  actions() {
    const app = this.app;
    const picker = select('', [{ value: '', label: 'Examples…' }, ...EXAMPLES.map((e, i) => ({ value: String(i), label: e.name }))], '', async (v, e) => {
      if (v === '') return;
      const ex = EXAMPLES[Number(v)];
      e.target.value = '';
      if (!ex) return;
      try {
        app.notify(`Loading ${ex.name}…`, 'info');
        const code = await loadExample(ex);
        this.setText(code);
        if (ex.setup) app.applyExampleSetup(ex.setup);
        app.loadProgram(code, `${ex.name}.nc`);
        app.notify(ex.description, 'ok');
      } catch (err) {
        app.notify(err.message, 'error');
      }
    });
    picker.style.flex = '0 0 220px';

    return [
      el('span.actions-label', {}, 'Program'),
      el('div.actions-group', {}, [
        button('Open…', async () => {
          const [file] = await pickFile('.nc,.gcode,.tap,.ngc,.cnc,.txt,.mpf,.eia');
          if (!file) return;
          const text = await file.text();
          this.setText(text);
          app.loadProgram(text, file.name);
        }),
        button('Save', () => download(app.state.programName || 'program.nc', this.editor ? this.editor.value : '', 'text/plain')),
        button('Re-parse', () => app.loadProgram(this.editor ? this.editor.value : '', app.state.programName)),
        picker,
      ]),
      el('div.actions-sep'),
      el('div.actions-group', {}, [
        button('Fit view to path', () => app.fitToProgram()),
        button('Fit stock to path', () => { app.fitStockToProgram(); app.panels.setup.refresh(); }),
      ]),
    ];
  }

  refreshSummary() {
    const app = this.app;
    const program = app.state.program;
    clear(this.summaryHost);
    if (!program) {
      this.summaryHost.appendChild(el('div.hint', {}, 'Open a program or pick an example to begin.'));
      return;
    }

    if (this.editor) this.editor.setMarkers(program.warnings);

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

    this.summaryHost.appendChild(section('Program', [grid, extents, row([
      button('Fit view to path', () => this.app.fitToProgram()),
      button('Fit stock to path', () => this.app.fitStockToProgram()),
    ])]));

    const errors = program.warnings.filter((w) => w.severity === 'error');
    const warns = program.warnings.filter((w) => w.severity !== 'error');
    if (program.warnings.length) {
      this.summaryHost.appendChild(section(`Interpreter notes (${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'})`, [
        el('ul.issues', {}, program.warnings.slice(0, 120).map((w) => el(`li.issue-${w.severity}`, {
          onclick: () => {
            this.editor.focusLine(w.line);
            this.app.seekToLine(w.line);
          },
          title: 'Jump to this line',
        }, [el('span.issue-line', {}, `L${w.line}`), w.message]))),
      ]));
    }
  }
}
