// Windows for the things a machine gains from nothing: a new joint in the
// chain, and a casting to hang on one.
//
// Both are decisions with several parts that only make sense together — an
// axis needs a letter, a kind and somewhere to sit before it means anything
// — so they are filled in and committed as a whole rather than typed into a
// panel one field at a time while the chain re-solves underneath.

import { el, field, select, row, pickFile } from './dom.js';
import { Dialog } from './dialog.js';
import { AXIS_LETTERS } from '../machine/kinematics.js';

const KINDS = [
  { value: 'linear', label: 'Linear — slides along its direction' },
  { value: 'rotary', label: 'Rotary — turns about its direction' },
  { value: 'carrier', label: 'Carrier — a bracket that does not move' },
];

const DIRECTIONS = [
  { value: '1,0,0', label: '+X' },
  { value: '-1,0,0', label: '−X' },
  { value: '0,1,0', label: '+Y' },
  { value: '0,-1,0', label: '−Y' },
  { value: '0,0,1', label: '+Z' },
  { value: '0,0,-1', label: '−Z' },
];

/**
 * @param {object} app
 * @param {{kin:object, selected:object, addAxis:(spec:object) => void}} panel
 */
export function openAxisDialog(app, panel) {
  const kin = panel.kin;
  const used = new Set(kin.axes().map((n) => n.letter));
  const free = Object.keys(AXIS_LETTERS).find((L) => !used.has(L)) || 'A';
  const spec = {
    letter: free,
    kind: AXIS_LETTERS[free].kind,
    axis: AXIS_LETTERS[free].axis.slice(),
    parent: (panel.selected && panel.selected.id) || kin.toolNode,
    name: `${free} axis`,
    limits: { min: -360, max: 360 },
  };

  const nameField = field('Name', spec.name, { type: 'text', onChange: (v) => { spec.name = v || `${spec.letter} axis`; } });
  const travel = el('div.dialog-form');

  const drawTravel = () => {
    const unit = spec.kind === 'rotary' ? '°' : 'mm';
    travel.replaceChildren(
      row([
        select('Direction', DIRECTIONS, `${spec.axis[0]},${spec.axis[1]},${spec.axis[2]}`,
          (v) => { spec.axis = v.split(',').map(Number); }),
        field('Travel from', spec.limits.min, { unit, step: 10, onChange: (v) => { spec.limits.min = Number(v) || 0; } }),
        field('to', spec.limits.max, { unit, step: 10, onChange: (v) => { spec.limits.max = Number(v) || 0; } }),
      ]),
    );
    travel.hidden = spec.kind === 'carrier';
  };

  const parentOptions = kin.nodes.map((n) => ({ value: n.id, label: n.name }));
  // Declared before the body so the letter handler can reach it.
  let kindSelect;

  const body = el('div.dialog-form', {}, [
    row([
      select('Letter', [{ value: '', label: 'none (carrier)' }, ...Object.keys(AXIS_LETTERS).map((L) => ({ value: L, label: L }))],
        spec.letter, (v) => {
          spec.letter = v || null;
          const known = AXIS_LETTERS[v];
          if (known) {
            spec.kind = known.kind;
            spec.axis = known.axis.slice();
            spec.name = `${v} axis`;
          } else {
            spec.kind = 'carrier';
            spec.name = 'Carrier';
          }
          nameField.input.value = spec.name;
          kindSelect.input.value = spec.kind;
          drawTravel();
        }),
      (kindSelect = select('Kind', KINDS, spec.kind, (v) => { spec.kind = v; drawTravel(); })),
    ]),
    nameField,
    select('Carried by', parentOptions, spec.parent, (v) => { spec.parent = v; }),
    el('div.hint', {}, 'Where the carrier holds exactly one thing, the new axis goes between them — that is what “a W axis between the ram and the head” means. Where it forks, as the base does between the head and the table, the new axis is carried alongside instead.'),
    travel,
  ]);

  const dialog = new Dialog({
    title: 'Add an axis',
    subtitle: 'A new joint in the kinematic chain',
    width: 520,
    body,
    confirm: 'Add axis',
    onConfirm: () => {
      panel.addAxis(spec);
      return true;
    },
  });
  drawTravel();
  dialog.open();
  return dialog;
}

/**
 * @param {object} app
 * @param {{kin:object, selected:object, importFiles:Function}} panel
 */
/**
 * @param {object} app
 * @param {{kin:object, selected:object, importFiles:Function}} panel
 */
export function openBodyDialog(app, panel) {
  const kin = panel.kin;
  const state = {
    files: [],
    units: 'mm',
    origin: 'as-is',
    nodeId: (panel.selected && panel.selected.id) || kin.roots()[0]?.id || kin.toolNode,
  };

  const fileLabel = el('div.hint', {}, 'No file chosen.');
  const carriers = kin.order.map((n) => {
    const fixed = n.kind === 'carrier' && kin.branchOf(n.id) === 'base';
    return { value: n.id, label: `${n.name}${fixed ? ' — fixed' : n.letter ? ` — moves with ${n.letter}` : ''}` };
  });

  const body = el('div.dialog-form', {}, [
    row([el('button.btn', {
      type: 'button',
      onclick: async () => {
        state.files = await pickFile('.stl', true);
        fileLabel.textContent = state.files.length ? state.files.map((f) => f.name).join(', ') : 'No file chosen.';
        dialog.setConfirmEnabled(state.files.length > 0);
      },
    }, 'Choose STL…')]),
    fileLabel,
    select('Carried by', carriers, state.nodeId, (v) => { state.nodeId = v; }),
    el('div.hint', {}, 'A body on the base never moves. A body on an axis rides that axis and everything carrying it — put the saddle on Y, the table on X, the head on Z.'),
    row([
      select('Units in the file', [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }],
        state.units, (v) => { state.units = v; }),
      select('Origin', [{ value: 'as-is', label: 'As exported' }, { value: 'base', label: 'Centre on its base' }],
        state.origin, (v) => { state.origin = v; }),
    ]),
    el('div.hint', {}, 'Leave the origin as exported if the bodies were modelled in one assembly — they will land in the right places relative to each other. Otherwise drop them in and mate them.'),
  ]);

  const dialog = new Dialog({
    title: 'Add a body',
    subtitle: 'An STL of the machine, carried by one axis',
    width: 480,
    body,
    confirm: 'Add body',
    onConfirm: () => {
      if (!state.files.length) return false;
      panel.importFiles(state.files, { units: state.units, origin: state.origin, nodeId: state.nodeId });
      return true;
    },
  });
  dialog.setConfirmEnabled(false);
  dialog.open();
  return dialog;
}

/** Start a machine from nothing. */
export function openNewMachineDialog(app) {
  const state = { name: 'New machine' };
  const body = el('div.dialog-form', {}, [
    field('Name', state.name, { type: 'text', onChange: (v) => { state.name = v || 'New machine'; } }),
    el('div.hint', {}, 'You get a base that does not move, a table to clamp to and a spindle to hang the tool on — and no axes. Add those one at a time on the Axes page, then bring the bodies in on Assembly.'),
    el('div.inline-warning', {}, 'The machine you have now is replaced, and any bodies already imported come off their axes. Save it first if you want to keep it.'),
  ]);

  const dialog = new Dialog({
    title: 'New machine',
    subtitle: 'Start from an empty chain',
    width: 460,
    body,
    confirm: 'Create',
    onConfirm: () => {
      app.newMachine(state.name);
      return true;
    },
  });
  dialog.open();
  return dialog;
}
