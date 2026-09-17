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
import { DIALECTS } from '../gcode/dialects.js';
import { openNewSubprogramDialog, machineDialect, callLine } from './programDialogs.js';
import * as units from '../core/units.js';

/**
 * Which file the machine is in right now.
 *
 * A job is several files and the run walks through all of them, so "the
 * program" is not one text: it is whichever of them the block being
 * executed came from. Every move carries that with it — nothing for the
 * main program, the file's name for a subprogram, and "M6 macro" and the
 * like for something that lives in the machine.
 *
 * @returns {{kind:'main'|'sub'|'macro', name:string, sub:object|null}}
 */
export function runningFile(app) {
  const program = app.state.program;
  const mv = program && program.moves[app.simulator.moveIndex];
  const src = mv && mv.source;
  if (!src) return { kind: 'main', name: app.state.programName || 'program.nc', sub: null };
  const sub = app.state.subprograms.find((x) => x.name === src) || null;
  return { kind: sub ? 'sub' : 'macro', name: src, sub };
}

/** The text of that file, or '' when it is one nobody here holds. */
function textOf(app, showing) {
  if (showing.kind === 'main') return app.state.source || '';
  if (showing.sub) return showing.sub.text || '';
  const macro = (app.state.machine.macros || []).find((m) => showing.name.startsWith(String(m.code)));
  return macro ? (macro.body || '') : '';
}

export class ProgramPanel extends Panel {
  constructor(app) {
    super(app, [
      {
        id: 'editor',
        // The tab names the file that is running, because that is the one
        // underneath it. On a job of four files "Main" was a label that
        // was wrong three quarters of the time.
        label: () => runningFile(app).name,
        icon: 'open',
        hint: 'The file the machine is in: open, edit and re-read it',
        render: ProgramPanel.prototype.editorPage,
      },
      { id: 'subs', label: 'Programs', icon: 'library', hint: 'Every file in this job — the main program and what it calls', badge: () => app.state.subprograms.length + 1, render: ProgramPanel.prototype.subsPage },
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
    // The tab is named after the file being shown, and the ribbon is drawn
    // when a tab changes rather than on every repaint — so when that name
    // changes underneath it, it is asked for again.
    const name = runningFile(this.app).name;
    if (this._tabName !== name) {
      this._tabName = name;
      if (this.app.buildRibbon) this.app.buildRibbon();
    }
  }

  // ---- pages -------------------------------------------------------------

  /**
   * The file the machine is in, in an editor.
   *
   * It follows the run rather than staying on the main program: step into
   * a subprogram and the subprogram is what is shown, with its own line
   * numbers under its own highlight. That is the only way the highlighted
   * line means anything once a job is more than one file — before this it
   * pointed at whatever line of the main program happened to share a
   * number with the line running inside the called file.
   */
  editorPage() {
    const app = this.app;
    const showing = runningFile(app);
    this.showing = showing;
    const main = showing.kind === 'main';

    const bar = el('div.toolbar', {}, [
      button('Open…', () => this.openFile(), { variant: 'primary' }),
      button('Save', () => this.saveFile(), { disabled: !this.editor || !this.editor.value }),
      button('Re-read', () => this.reread(), { title: 'Interpret the text as it stands now' }),
      select('Examples', [{ value: '', label: 'Load an example…' }, ...EXAMPLES.map((e, i) => ({ value: String(i), label: e.name }))], '',
        (v, e) => { if (v === '') return; e.target.value = ''; this.loadExampleAt(Number(v)); }),
    ]);

    const strip = el('div.editor-showing', {}, [
      el('span.name', {}, showing.name),
      el('span.why', {}, main
        ? 'the main program'
        : showing.kind === 'sub'
          ? 'running — called by the main program'
          : "running — a macro that lives in the machine, so it is read here and changed on Machine \u203a Macros"),
      showing.kind === 'macro'
        ? button('Machine \u203a Macros', () => app.setPage('machine', 'macros'), { title: 'Where this one is kept' })
        : null,
    ]);

    if (!this.editor) {
      this.editor = new GcodeEditor(this.editorHost, {
        onInput: (text) => {
          // While a keystroke is waiting to be read, the editor holds the
          // newer text and the app holds the older one. Say so, or a redraw
          // in that window would push the old text back over the typing.
          this.typing = true;
          clearTimeout(this._debounce);
          this._debounce = setTimeout(() => {
            this.typing = false;
            this.commitEdit(text);
          }, 400);
        },
        onSeekLine: (line) => { if (this.showing.kind === 'main') this.app.seekToLine(line); },
      });
    } else if (this.editor.wrap.parentNode !== this.editorHost) {
      this.editorHost.appendChild(this.editor.wrap);
    }
    this.editor.setReadOnly(showing.kind === 'macro');
    this.syncEditor();
    if (app.state.program) {
      // Only the notes that belong to this text: a warning raised inside a
      // subprogram carries that file's line numbers, not these.
      this.editor.setMarkers(app.state.program.warnings.filter((w) => (w.source || null) === (main ? null : showing.name)));
    }

    return [bar, strip, this.editorHost];
  }

  /** Put an edit back where the text came from. */
  commitEdit(text) {
    const showing = this.showing || runningFile(this.app);
    if (showing.kind === 'sub' && showing.sub) {
      showing.sub.text = text;
      this.app.reinterpret();
      return;
    }
    if (showing.kind === 'macro') return;          // the machine's, not the job's
    this.app.loadProgram(text, this.app.state.programName);
  }

  reread() {
    this.commitEdit(this.editor ? this.editor.value : '');
  }

  // ---- subprograms -------------------------------------------------------
  //
  // A subprogram is a file, not a form to fill in. It is opened the way the
  // main program is opened and edited in the same editor. It answers to two
  // things: the O number written at the top of it, which is how a Fanuc
  // finds one, and the name it is saved under, which is how most other
  // controls do — so the name is the shop's to choose, and changeable.

  /** The subprogram the page is acting on. */
  get sub() {
    return this.app.state.subprograms.find((x) => x.id === this.subId) || null;
  }

  subsPage() {
    const app = this.app;
    const subs = app.state.subprograms;

    const bar = el('div.toolbar', {}, [
      button('Open…', () => this.openSubs(), { variant: 'primary', title: 'One file or several' }),
      button('New main…', () => this.newMain(), { title: 'Start an empty main program' }),
      button('New sub…', () => this.newSub(), { title: 'Start an empty subprogram' }),
      button('Save', () => this.saveSub(), { disabled: !this.sub }),
      button('Remove', () => this.deleteSub(), { disabled: !this.sub, variant: 'warn' }),
    ]);

    const list = el('div.list');

    // The main program is a file in this job like any other, so it is in
    // the list with the rest of them rather than on a page of its own.
    const mainLines = String(app.state.source || '').split('\n').length;
    const running = runningFile(app);
    list.appendChild(el(`div.list-item${this.subId === null ? '.selected' : ''}`, {
      onclick: () => { this.subId = null; this.render(); },
    }, [
      el('div.swatch', { style: { background: running.kind === 'main' ? '#0a7cff' : '#d0d4db' } }),
      el('div.list-main', {}, [
        el('div.list-title', {}, [el('span.tnum', {}, 'main'), app.state.programName || 'program.nc']),
        el('div.list-sub', {}, [
          `${mainLines} ${mainLines === 1 ? 'line' : 'lines'}`,
          running.kind === 'main' ? 'running' : 'the program that starts the job',
        ].join(' \u00b7 ')),
      ]),
    ]));

    if (!subs.length) {
      list.appendChild(el('div.empty', {}, [
        el('div.empty-title', {}, 'No subprograms'),
        el('div.hint', {}, 'A post that writes M98 P1000 expects a file called O1000 to sit beside the program; one that writes a name expects a file with that name. Open those files here and the calls resolve. A subprogram that lives in the machine rather than with the job belongs on Machine \u203a Macros instead.'),
      ]));
    }

    for (const sub of subs) {
      const o = programNumber(sub.text);
      const lines = String(sub.text || '').split('\n').length;
      const ran = this.ranFrom(sub.name);
      list.appendChild(el(`div.list-item${this.subId === sub.id ? '.selected' : ''}`, {
        onclick: () => { this.subId = sub.id; this.render(); },
      }, [
        el('div.swatch', { style: { background: ran ? '#0a7cff' : '#d0d4db' } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, [o === null ? null : el('span.tnum', {}, `O${o}`), sub.name]),
          el('div.list-sub', {}, [
            `${lines} ${lines === 1 ? 'line' : 'lines'}`,
            ran ? 'called by this program' : 'not called',
            o === null ? 'called by name' : null,
          ].filter(Boolean).join(' · ')),
        ]),
      ]));
    }

    const out = [bar, el('div.list-host', {}, [
      list,
      el('div.hint', {}, 'Call one by the O word at the top of it — M98 P1000 — or by its name, which is what most controls outside Fanuc read. Rename a file and the calls that use its name follow it.'),
    ])];

    const sub = this.sub;
    if (this.subId === null) {
      out.push(actionRow([
        { label: 'Open the main program', variant: 'primary', onClick: () => this.app.setPage('program', 'editor') },
        { label: 'Save', onClick: () => this.saveFile() },
      ]));
      out.push(el('div.hint', {}, 'The main program is edited on its own page, which follows the run: step into a subprogram and that file is what the page shows.'));
    }
    if (sub) {
      if (!this.subEditor) {
        this.subEditor = new GcodeEditor(this.subHost, {
          onInput: (text) => {
            const current = this.sub;
            if (!current) return;
            current.text = text;
            this.typingSub = true;
            clearTimeout(this._subDebounce);
            this._subDebounce = setTimeout(() => {
              this.typingSub = false;
              this.app.reinterpret();
            }, 400);
          },
        });
      } else if (this.subEditor.wrap.parentNode !== this.subHost) {
        this.subHost.appendChild(this.subEditor.wrap);
      }
      // Either a different file, or the same one loaded from elsewhere.
      if (!this.typingSub && (this.subEditorFor !== sub.id || this.subEditor.value !== (sub.text || ''))) {
        this.subEditor.setValue(sub.text || '');
        this.subEditorFor = sub.id;
      }
      const program = app.state.program;
      this.subEditor.setMarkers(program ? program.warnings.filter((w) => w.source === sub.name) : []);
      // The name is the file's, so it is edited here rather than fixed at
      // the moment the file was made.
      out.push(row([
        field('Name', sub.name, {
          type: 'text',
          onChange: (v) => this.renameSub(sub, v),
          title: 'What this file is called, and what a call by name asks for',
        }),
      ]));
      out.push(el('div.hint', {}, `Called with ${callLine(machineDialect(this.app), { name: sub.name, number: programNumber(sub.text) || 0 })}`));
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
    const subs = this.app.state.subprograms;
    openNewSubprogramDialog(this.app, {
      subtitle: 'A file this job carries with it',
      names: subs.map((s) => s.name),
      numbers: subs.map((s) => programNumber(s.text)),
      from: 1000,
      onCreate: (file) => {
        const sub = { id: uid('sub'), ...file };
        subs.push(sub);
        this.subId = sub.id;
        this.subEditorFor = null;
        this.app.reinterpret();
        this.render();
      },
    });
  }

  /**
   * Start a main program from nothing.
   *
   * The same window as a new subprogram, because it is the same act: a
   * name, and whatever the control needs at the top of a file. The only
   * difference is where it lands, and that an existing program is not
   * thrown away without being asked about.
   */
  newMain() {
    const app = this.app;
    const had = (app.state.source || '').trim();
    openNewSubprogramDialog(app, {
      title: 'New main program',
      subtitle: 'The file the job starts in',
      defaultName: 'program.nc',
      names: [app.state.programName, ...app.state.subprograms.map((sx) => sx.name)].filter(Boolean),
      numbers: app.state.subprograms.map((sx) => programNumber(sx.text)),
      from: 1,
      onCreate: (file) => {
        if (had && !window.confirm(`Replace ${app.state.programName || 'the main program'}? What is in it now is not saved anywhere else.`)) return;
        app.loadProgram(file.text || '', file.name);
        this.subId = null;
        app.setPage('program', 'editor');
      },
    });
  }

  /**
   * Rename a file.
   *
   * The name is not decoration: a program that calls this file by name asks
   * for exactly this, so the program is re-read afterwards and a call that
   * has just been broken — or just been fixed — says so straight away.
   */
  renameSub(sub, name) {
    const next = String(name || '').trim();
    if (!next || next === sub.name) { this.render(); return; }
    sub.name = next;
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

  /**
   * Show whatever program the app is holding.
   *
   * The editor keeps its own text across redraws — that is what preserves
   * the caret and the undo stack — so a program that arrives from anywhere
   * else has to be put into it: opening a project, loading an example,
   * anything that calls loadProgram. Typing is the one case where the
   * editor is ahead of the app, and it says so while it is.
   */
  syncEditor() {
    if (!this.editor || this.typing) return;
    const showing = this.showing || runningFile(this.app);
    const text = textOf(this.app, showing);
    if (this.editor.value !== text) this.editor.setValue(text);
  }

  setText(text) {
    if (this.editor) this.editor.setValue(text);
  }

  /**
   * Highlight the line that is running — in the file it is running in.
   *
   * @param {number} line
   * @param {string|null} source which file that line was counted in
   */
  setActiveLine(line, source = null) {
    if (!this.editor || this.page !== 'editor') return;
    const showing = this.showing || runningFile(this.app);
    const shown = showing.kind === 'main' ? null : showing.name;
    // The run has moved into another file: show that one instead. A
    // redraw mid-keystroke would push the old text over the typing, so a
    // page being typed into is left alone until the typing stops.
    if ((source || null) !== shown) {
      if (!this.typing) this.render();
      return;
    }
    this.editor.setActiveLine(line);
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
    if (this.page === 'summary' || this.page === 'subs') {
      this.render();
      return;
    }
    // A different file is running: the page names it and shows it, so it
    // is drawn again rather than patched.
    const showing = runningFile(this.app);
    if (!this.showing || this.showing.kind !== showing.kind || this.showing.name !== showing.name) {
      this.render();
      return;
    }
    // The program may have been replaced from somewhere else entirely.
    this.showing = showing;
    this.syncEditor();
    if (this.editor && this.app.state.program) {
      // Only the notes that belong to this text: a warning raised inside a
      // subprogram carries that file's line numbers, not these.
      const shown = showing.kind === 'main' ? null : showing.name;
      this.editor.setMarkers(this.app.state.program.warnings.filter((w) => (w.source || null) === shown));
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

    // A program read against the wrong control is a page of errors and no
    // toolpath. That is not a hundred and fifty mistakes, it is one, and
    // the answer to it belongs at the top of the page that lists them.
    if (program.suggested && DIALECTS[program.suggested]) {
      const name = DIALECTS[program.suggested].name;
      this.summaryHost.appendChild(section('Written for another control', [
        el('div.inline-warning', {}, `This program is written for a ${name}; this machine reads ${DIALECTS[app.state.machine.controller.dialect] ? DIALECTS[app.state.machine.controller.dialect].name : 'something else'}. Almost everything below follows from that — the > in front of every line, the words this reader does not know, the labels.`),
        actionRow([
          { label: `Read it as a ${name}`, variant: 'primary', onClick: () => app.setControl(program.suggested), hint: 'Puts this machine on that control and reads the program again' },
        ]),
      ]));
    }

    const s = program.stats;
    const b = s.bounds;
    const grid = el('div.stat-grid', {}, [
      ['Moves', String(s.moveCount)],
      ['Blocks', String(s.blockCount)],
      ['Cycle time', fmtDuration(s.cycleTime)],
      // Path length is quoted the way a shop quotes it: metres, or feet.
      ['Cutting', units.distanceU(s.feedDistance)],
      ['Rapids', units.distanceU(s.rapidDistance)],
      ['Tools used', program.toolChanges.length ? [...new Set(program.toolChanges.map((t) => `T${t.tool}`))].join(' ') : 'none'],
    ].map(([k, v]) => el('div.stat', {}, [el('div.stat-label', {}, k), el('div.stat-value', {}, v)])));

    const extents = el('table.extents', {}, [
      el('tr', {}, [el('th', {}, ''), el('th', {}, 'min'), el('th', {}, 'max'), el('th', {}, 'span')]),
      ...['X', 'Y', 'Z'].map((axis, i) => el('tr', {}, [
        el('th', {}, axis),
        el('td', {}, units.len(b.min[i], 3)),
        el('td', {}, units.len(b.max[i], 3)),
        el('td', {}, units.len(b.max[i] - b.min[i], 3)),
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

    // Lines that set the machine's own tables rather than the part. They
    // are skipped, and saying so here is the difference between skipped
    // and quietly lost.
    if (program.settings && program.settings.length) {
      const names = [...new Set(program.settings.map((x) => x.name))];
      this.summaryHost.appendChild(section(`Machine table (${program.settings.length} line${program.settings.length === 1 ? '' : 's'})`, [
        el('div.hint', {}, `${names.join(', ')} — these fill in the control's own tool table. The simulator cuts with the assembly in the pot the program calls for, so they are read and passed over rather than taken as coordinates.`),
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
