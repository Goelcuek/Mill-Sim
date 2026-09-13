// Windows for the two things that are written rather than opened: a macro,
// and a machine parameter for one to read.
//
// A macro is a decision with several parts that only mean anything together
// — a code, whether the machine runs it, and the G-code itself — so it is
// filled in and committed as a whole. A subprogram is not: it is a file,
// and files are opened, which is why there is no window for one.

import { el, field, select, row, checkbox, button } from './dom.js';
import { Dialog } from './dialog.js';
import { MACRO_CATALOGUE, normaliseCode, macroReferences } from '../machine/macros.js';
import { DIALECTS, FLAVOUR_DIALECT, COMPARISONS, LOGIC, resolveDialect, sampleFor } from '../gcode/dialects.js';

/** A monospace editor box, for the things that are G-code. */
function codeBox(value, onChange, rows = 12) {
  const area = el('textarea.code-box', {
    spellcheck: false,
    wrap: 'off',
    rows,
    oninput: (e) => onChange(e.target.value),
  });
  area.value = value || '';
  return area;
}

/**
 * A macro: what the machine does when it reads an M code.
 *
 * @param {object} app
 * @param {object} panel
 * @param {string|null} macroId  null to make a new one
 */
export function openMacroDialog(app, panel, macroId = null) {
  const machine = app.state.machine;
  const existing = (machine.macros || []).find((m) => m.id === macroId) || null;
  const draft = existing
    ? { ...existing }
    : { code: 'M6', name: 'Tool change', enabled: true, body: '(what the machine does at this code)\n', notes: '' };

  const refs = el('div.hint');
  const drawRefs = () => {
    const used = macroReferences(draft.body);
    const known = Object.keys(machine.parameters || {});
    const words = ['T', 'S', 'P', 'Q', 'R', 'H', 'D', 'M'];
    const unknown = used.filter((r) => !known.includes(r) && !words.includes(r));
    refs.replaceChildren(...[
      el('b', {}, 'Reads: '),
      el('span', {}, used.length ? used.map((r) => `#${r}`).join(', ') : 'nothing yet'),
      el('br'),
      el('span', {}, `Available: ${words.map((w) => `#${w}`).join(' ')} from the calling block, and ${known.length ? known.map((k) => `#${k}`).join(' ') : 'no machine parameters yet'}.`),
      unknown.length ? el('div.inline-warning', {}, `Nothing is set for ${unknown.map((u) => `#${u}`).join(', ')} — those will read as 0.`) : null,
    ].filter(Boolean));
  };

  const codeField = field('Code', draft.code, {
    type: 'text',
    onChange: (v) => {
      const code = normaliseCode(v);
      draft.code = code || draft.code;
      codeField.input.value = draft.code;
      const known = MACRO_CATALOGUE.find((c) => c.code === draft.code);
      if (known && !existing) {
        draft.name = known.name;
        nameField.input.value = known.name;
      }
    },
  });
  const nameField = field('Name', draft.name, { type: 'text', onChange: (v) => { draft.name = v || draft.code; } });

  const body = el('div.dialog-form', {}, [
    row([
      select('Common codes', [{ value: '', label: 'pick one…' }, ...MACRO_CATALOGUE.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))],
        MACRO_CATALOGUE.some((c) => c.code === draft.code) ? draft.code : '', (v) => {
          if (!v) return;
          const known = MACRO_CATALOGUE.find((c) => c.code === v);
          draft.code = known.code;
          draft.name = known.name;
          codeField.input.value = known.code;
          nameField.input.value = known.name;
        }),
      codeField,
    ]),
    nameField,
    checkbox('This machine runs it', draft.enabled, (v) => { draft.enabled = v; }),
    el('div.hint', {}, 'A macro that runs changes what every program does at that code — extra rapids, a dwell, a park. That is what a real machine does; it is off until you say so because it also changes the simulation.'),
    el('div.dialog-section-label', {}, 'What the machine does'),
    codeBox(draft.body, (v) => { draft.body = v; drawRefs(); }),
    refs,
    el('div.hint', {}, 'Ordinary G-code, read by the ordinary interpreter: G28 to a home switch, G53 for machine coordinates, G4 for the carousel. #name is substituted before it is read.'),
  ]);
  drawRefs();

  const dialog = new Dialog({
    title: existing ? `Edit ${existing.code}` : 'Add a macro',
    subtitle: 'What this machine does when it reads the code',
    width: 560,
    body,
    confirm: existing ? 'Apply' : 'Add macro',
    onConfirm: () => {
      if (existing) Object.assign(existing, draft);
      else panel.macroId = app.addMacro(draft).id;
      app.loadProgram(app.state.source, app.state.programName);
      panel.render();
      return true;
    },
  });
  dialog.open();
  return dialog;
}

/** A named number of the user's own, for macros to read. */
export function openParameterDialog(app, panel) {
  const state = { name: '', value: 0 };
  const body = el('div.dialog-form', {}, [
    row([
      field('Name', '', { type: 'text', onChange: (v) => { state.name = String(v || '').replace(/[^A-Za-z0-9_]/g, ''); } }),
      field('Value', 0, { type: 'number', step: 1, onChange: (v) => { state.value = Number(v) || 0; } }),
    ]),
    el('div.hint', {}, 'Letters, digits and underscores. A macro body reads it as #name, so "palletY" becomes #palletY.'),
  ]);

  const dialog = new Dialog({
    title: 'Add a machine parameter',
    subtitle: 'A number the macros can read',
    width: 440,
    body,
    confirm: 'Add',
    onConfirm: () => {
      if (!state.name) return false;
      app.state.machine.parameters[state.name] = state.value;
      app.loadProgram(app.state.source, app.state.programName);
      panel.render();
      return true;
    },
  });
  dialog.open();
  return dialog;
}

/**
 * What this control's macro language looks like.
 *
 * The syntax is a table, not a parser, so it can be edited: a control
 * nobody here has ever seen is described rather than waited for. The
 * fields are the whole description — change the sigil and the reader reads
 * the new one from the next block on.
 */
export function openSyntaxDialog(app, panel) {
  const controller = app.state.machine.controller;
  const base = DIALECTS[controller.dialect || FLAVOUR_DIALECT[controller.flavour] || 'fanuc'] || DIALECTS.fanuc;
  const draft = JSON.parse(JSON.stringify(resolveDialect(base.id, controller.syntax)));

  const sample = el('pre.code-sample');
  const drawSample = () => { sample.textContent = sampleFor(draft); };

  const text = (label, value, onChange, title) => field(label, value ?? '', {
    type: 'text', title, onChange: (v) => { onChange(String(v || '').trim()); drawSample(); },
  });

  const body = el('div.dialog-form', {}, [
    el('div.hint', {}, base.notes),

    el('div.dialog-section-label', {}, 'Variables'),
    row([
      text('Marked by', draft.sigil || '', (v) => { draft.sigil = v || null; }, 'The character in front of a variable, as in #100. Leave it empty for controls that use a letter instead.'),
      text('Or these letters', draft.letters.join(' '), (v) => { draft.letters = v.split(/[\s,]+/).filter(Boolean).map((x) => x.toUpperCase()); }, 'R for Siemens, Q for Heidenhain, V for Okuma. Separate several with spaces.'),
    ]),
    row([
      select('Grouped with', [{ value: '[]', label: '[ square ]' }, { value: '()', label: '( round )' }],
        draft.group.join(''), (v) => { draft.group = v === '()' ? ['(', ')'] : ['[', ']']; drawSample(); }),
      select('Values written', [{ value: 'plain', label: 'X100 — straight after the letter' }, { value: 'equals', label: 'X=100 — with an equals' }],
        draft.wordEquals ? 'equals' : 'plain', (v) => { draft.wordEquals = v === 'equals'; drawSample(); }),
    ]),

    el('div.dialog-section-label', {}, 'Comparisons'),
    row(COMPARISONS.slice(0, 3).map((op) => text(op.toUpperCase(), draft.compare[op], (v) => { draft.compare[op] = v; }))),
    row(COMPARISONS.slice(3).map((op) => text(op.toUpperCase(), draft.compare[op], (v) => { draft.compare[op] = v; }))),
    row(LOGIC.map((op) => text(op.toUpperCase(), draft.logic[op], (v) => { draft.logic[op] = v; }))),

    el('div.dialog-section-label', {}, 'Control flow'),
    el('div.hint', {}, 'Leave a word empty where the control does not have it — Siemens has no THEN and no DO, and closes a loop with ENDWHILE rather than END 1.'),
    row([
      text('If', draft.keywords.if, (v) => { draft.keywords.if = v || null; }),
      text('Then', draft.keywords.then, (v) => { draft.keywords.then = v || null; }),
      text('Jump', draft.keywords.goto, (v) => { draft.keywords.goto = v || null; }),
      text('Jump back', draft.keywords.gotoBack, (v) => { draft.keywords.gotoBack = v || null; }),
    ]),
    row([
      text('While', draft.keywords.while, (v) => { draft.keywords.while = v || null; }),
      text('Do', draft.keywords.do, (v) => { draft.keywords.do = v || null; }),
      text('End', draft.keywords.end, (v) => { draft.keywords.end = v || null; }),
      text('End while', draft.keywords.endWhile, (v) => { draft.keywords.endWhile = v || null; }),
    ]),
    row([
      text('For', draft.keywords.for, (v) => { draft.keywords.for = v || null; }),
      text('To', draft.keywords.to, (v) => { draft.keywords.to = v || null; }),
      text('End for', draft.keywords.endFor, (v) => { draft.keywords.endFor = v || null; }),
    ]),
    row([
      text('Repeat', draft.keywords.repeat, (v) => { draft.keywords.repeat = v || null; }),
      text('Until', draft.keywords.until, (v) => { draft.keywords.until = v || null; }),
      select('Jumps go to', [{ value: 'line', label: 'a line number (N100)' }, { value: 'name', label: 'a named label (MARK1:)' }],
        draft.labels, (v) => { draft.labels = v; }),
    ]),

    el('div.dialog-section-label', {}, 'Comments'),
    row([
      checkbox('( round brackets ) are a comment', draft.parenComments !== false, (v) => { draft.parenComments = v; }),
      text('To end of line', (draft.lineComments || []).join(' '), (v) => { draft.lineComments = v.split(/\s+/).filter(Boolean); }),
    ]),
    el('div.hint', {}, 'A control that computes with round brackets cannot also read them as a remark — that is how X=SIN(30) turns into a comment.'),

    el('div.dialog-section-label', {}, 'What that reads like'),
    sample,
  ]);
  drawSample();

  const dialog = new Dialog({
    title: 'Macro syntax',
    subtitle: `Starting from ${base.name}`,
    width: 620,
    body,
    confirm: 'Apply',
    onConfirm: () => {
      controller.dialect = base.id;
      controller.syntax = draft;
      app.setMachine({ controller: { ...controller } });
      panel.render();
      app.notify('Macro syntax updated; the program was read again.', 'ok');
      return true;
    },
    extra: [button('Back to standard', () => {
      controller.syntax = null;
      app.setMachine({ controller: { ...controller } });
      panel.render();
      dialog.close(true);
      app.notify(`Back to ${base.name} as it comes.`, 'ok');
    })],
  });
  dialog.open();
  return dialog;
}
