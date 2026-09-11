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
  // Where the window opens pointing. Adding a joint to the end of a branch
  // nearly always means putting it above that end rather than below it — a
  // rotary goes between the head and the spindle nose, not under the nose —
  // so a leaf is read as "above this", and everything else as "under this".
  const at = kin.byId.get((panel.selected && panel.selected.id) || kin.toolNode) || kin.roots()[0] || null;
  const leaf = at && at.parent && kin.byId.has(at.parent) && !kin.children(at.id).length;
  const spec = {
    letter: free,
    kind: AXIS_LETTERS[free].kind,
    axis: AXIS_LETTERS[free].axis.slice(),
    parent: at ? (leaf ? at.parent : at.id) : null,
    carries: leaf ? at.id : '',
    name: `${free} axis`,
    limits: { min: -360, max: 360 },
  };

  const nameField = field('Name', spec.name, {
    type: 'text',
    onChange: (v) => { spec.name = v || `${spec.letter} axis`; drawChain(); },
  });
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

  // Two questions, both answered here rather than inferred from the shape
  // of the tree: what holds the new axis, and what it takes over carrying.
  // Together they say exactly where in the chain it lands — mounting an A
  // on the base and having it carry the spindle is how the head gets a
  // swivel above it.
  const where = el('div.dialog-form');
  const chain = el('div.chain-preview');

  const label = (n) => `${n.name}${n.letter ? ` — moves with ${n.letter}` : kin.branchOf(n.id) === 'base' && n.kind === 'carrier' ? ' — fixed' : ''}`;
  const parentOptions = kin.order.map((n) => ({ value: n.id, label: label(n) }));

  const drawChain = () => {
    const parent = kin.byId.get(spec.parent);
    const carried = spec.carries ? kin.byId.get(spec.carries) : null;
    const names = [...(parent ? kin.pathTo(parent.id).map((n) => n.name) : []), spec.name || 'the new axis'];
    chain.replaceChildren(
      el('span', {}, names.slice(0, -1).map((n) => `${n} → `).join('')),
      el('b', {}, names[names.length - 1]),
      el('span', {}, carried ? ` → ${carried.name}${kin.children(carried.id).length ? ' →…' : ''}` : ''),
    );
  };

  const drawWhere = () => {
    const kids = kin.children(spec.parent);
    if (!kids.some((n) => n.id === spec.carries)) spec.carries = kids.length === 1 ? kids[0].id : '';
    where.replaceChildren(
      row([
        select('Mounted on', parentOptions, spec.parent, (v) => { spec.parent = v; drawWhere(); },
          { title: 'What holds the new axis, so what carries it around' }),
        select('Carries', [
          { value: '', label: 'nothing — a new branch' },
          ...kids.map((n) => ({ value: n.id, label: n.name })),
        ], spec.carries, (v) => { spec.carries = v; drawChain(); },
          { title: 'What moves onto the new axis, so what it swings or slides' }),
      ]),
      chain,
      el('div.hint', {}, 'Carries takes something off what it is mounted on and puts it on the new axis instead — that is how an A goes above the spindle: mount it on the base, have it carry the spindle. Leave it empty to start a fresh branch.'),
    );
    drawChain();
  };

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
          drawChain();
        }),
      (kindSelect = select('Kind', KINDS, spec.kind, (v) => { spec.kind = v; drawTravel(); })),
    ]),
    nameField,
    travel,
    el('div.dialog-section-label', {}, 'Where it goes'),
    where,
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
  drawWhere();
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
    select('Mounted on', carriers, state.nodeId, (v) => { state.nodeId = v; }),
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
    el('div.hint', {}, 'You get one thing: a base that does not move. Build the chain out from it on the Axes page — each axis says what it is mounted on and what it carries — then mark where the tool hangs and where the part clamps, and bring the bodies in on Assembly.'),
    el('div.inline-warning', {}, 'The machine you have now is replaced, and any bodies already imported come off their axes. Save it first if you want to keep it.'),
  ]);

  const dialog = new Dialog({
    title: 'New machine',
    subtitle: 'A bare base, and nothing else',
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
