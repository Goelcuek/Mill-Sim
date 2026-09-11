// Windows for the things a setup creates from nothing.
//
// Adding a fixture is a task with a beginning and an end — choose what kind,
// say what units the file is in, commit or cancel — so it gets a window
// rather than a permanent strip of controls on a page that is mostly a
// list. Nothing is added to the scene until Add is pressed, so Escape is
// always safe.

import { el, field, select, checkbox, row, pickFile } from './dom.js';
import { Dialog } from './dialog.js';
import { MODEL_ROLES } from '../scene/modelsView.js';

const KINDS = [
  { value: 'vice', label: 'Vice jaws', hint: 'A pair of jaws with the work held between them' },
  { value: 'parallels', label: 'Parallels', hint: 'Two bars to stand the work on inside the vice' },
  { value: 'clamp', label: 'Toe clamp', hint: 'A step clamp bearing on the top face' },
  { value: 'stl', label: 'STL file…', hint: 'Your own fixture, clamp or reference part' },
];

/**
 * @param {object} app
 * @param {{importFiles:(files:File[]) => Promise<void>, refresh:() => void}} panel
 */
export function openFixtureDialog(app, panel) {
  const state = { kind: 'vice', units: 'mm', role: 'fixture', recentre: true, files: [] };

  const fileLabel = el('div.hint', {}, 'No file chosen.');
  const pick = el('button.btn', {
    type: 'button',
    onclick: async () => {
      state.files = await pickFile('.stl', true);
      fileLabel.textContent = state.files.length
        ? state.files.map((f) => f.name).join(', ')
        : 'No file chosen.';
      sync();
    },
  }, 'Choose STL…');

  const stlBlock = el('div.dialog-form', {}, [
    row([pick]),
    fileLabel,
    row([
      select('Units in the file', [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }],
        state.units, (v) => { state.units = v; }),
      select('Role', Object.entries(MODEL_ROLES).map(([k, v]) => ({ value: k, label: v.label })),
        state.role, (v) => { state.role = v; }),
    ]),
    checkbox('Sit it on Z0 and centre it in XY', state.recentre, (v) => { state.recentre = v; }),
    el('div.hint', {}, 'STL carries no units, so pick the right one here. Fixtures and clamps are collision-checked against the whole tool assembly; a reference part is not — it is the shape the job should produce, and cutting past it is reported as a gouge.'),
  ]);

  const kindHint = el('div.hint');

  const sync = () => {
    stlBlock.hidden = state.kind !== 'stl';
    kindHint.textContent = (KINDS.find((k) => k.value === state.kind) || {}).hint || '';
    dialog.setConfirmEnabled(state.kind !== 'stl' || state.files.length > 0);
  };

  const body = el('div.dialog-form', {}, [
    select('What to add', KINDS.map((k) => ({ value: k.value, label: k.label })), state.kind, (v) => {
      state.kind = v;
      sync();
    }),
    kindHint,
    stlBlock,
  ]);

  const dialog = new Dialog({
    title: 'Add a fixture',
    subtitle: 'Clamps, parallels and reference parts around the job',
    width: 460,
    body,
    confirm: 'Add',
    onConfirm: () => {
      if (state.kind === 'stl') {
        if (!state.files.length) return false;
        panel.importFiles(state.files, { units: state.units, role: state.role, recentre: state.recentre });
      } else {
        app.addPrimitiveFixture(state.kind);
        app.refreshFixtures();
        panel.refresh();
      }
      return true;
    },
  });
  sync();
  dialog.open();
  return dialog;
}
