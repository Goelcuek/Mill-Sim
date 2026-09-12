// Windows for the parts of a job that are made rather than opened: a
// subprogram file, a macro, and a machine parameter for a macro to read.
//
// Each is a decision with several parts that only mean anything together —
// a subprogram needs a number before M98 can find it, a macro needs a code
// before it can run — so each is filled in and committed as a whole.

import { el, field, select, row, checkbox, pickFile } from './dom.js';
import { Dialog } from './dialog.js';
import { MACRO_CATALOGUE, normaliseCode, macroReferences } from '../machine/macros.js';
import { uid } from '../core/util.js';

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
 * A subprogram file: what M98 P____ finds.
 */
export function openSubprogramDialog(app, panel) {
  const used = new Set(app.state.subprograms.map((s) => Number(s.number)));
  let next = 1000;
  while (used.has(next)) next += 1;

  const state = { name: 'Subprogram', number: next, text: `O${next}\n(subprogram)\n\nM99\n` };
  const nameField = field('Name', state.name, { type: 'text', onChange: (v) => { state.name = v || 'Subprogram'; } });
  const fileLabel = el('div.hint', {}, 'Or start from a file.');

  const body = el('div.dialog-form', {}, [
    row([
      field('O number', state.number, {
        type: 'number', step: 1, min: 1,
        onChange: (v) => { state.number = Math.max(1, Math.round(Number(v) || 0)); },
      }),
      nameField,
    ]),
    el('div.hint', {}, 'M98 P' + next + ' in the main program calls this file. If the text starts with its own O number that one wins, which is how a file copied off a control keeps working.'),
    row([el('button.btn', {
      type: 'button',
      onclick: async () => {
        const [file] = await pickFile('.nc,.gcode,.tap,.ngc,.cnc,.txt,.sub');
        if (!file) return;
        state.text = await file.text();
        state.name = file.name.replace(/\.[^.]+$/, '');
        nameField.input.value = state.name;
        fileLabel.textContent = `${file.name} — ${state.text.split('\n').length} lines`;
        const m = state.text.match(/^\s*O\s*(\d+)/m);
        if (m) state.number = Number(m[1]);
      },
    }, 'Open a file…')]),
    fileLabel,
  ]);

  const dialog = new Dialog({
    title: 'Add a subprogram',
    subtitle: 'A file the main program can call with M98',
    width: 480,
    body,
    confirm: 'Add',
    onConfirm: () => {
      const sub = { id: uid('sub'), name: state.name, number: state.number, text: state.text };
      app.state.subprograms.push(sub);
      panel.subId = sub.id;
      panel.subEditorFor = null;
      app.loadProgram(app.state.source, app.state.programName);
      panel.render();
      return true;
    },
  });
  dialog.open();
  return dialog;
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
