// Windows for the two things that are written rather than opened: a macro,
// and a machine parameter for one to read.
//
// A macro is a decision with several parts that only mean anything together
// — a code, whether the machine runs it, and the G-code itself — so it is
// filled in and committed as a whole. A subprogram is not: it is a file,
// and files are opened, which is why there is no window for one.

import { el, field, select, row, checkbox } from './dom.js';
import { Dialog } from './dialog.js';
import { MACRO_CATALOGUE, normaliseCode, macroReferences } from '../machine/macros.js';

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
