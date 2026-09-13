// Windows for the things a setup creates from nothing.
//
// Adding a fixture is a task with a beginning and an end — choose what kind,
// say what units the file is in, commit or cancel — so it gets a window
// rather than a permanent strip of controls on a page that is mostly a
// list. Nothing is added to the scene until Add is pressed, so Escape is
// always safe.

import { el, field, select, checkbox, row, pickFile } from './dom.js';
import { parseSTL, bounds } from '../io/stl.js';
import { MM_PER_INCH } from '../core/util.js';
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

/**
 * New stock.
 *
 * Three shapes, because three is what a shop has: a block sawn to size, a
 * length of bar, and something that arrives already looking like a part —
 * a casting, a forging, a weldment, the last operation's output. The first
 * two are a handful of numbers; the third is a file, and the simulation
 * takes its top surface as the starting surface.
 */
export function openStockDialog(app, panel) {
  const cur = app.state.stock;
  const state = {
    shape: cur.shape === 'model' ? 'box' : cur.shape || 'box',
    size: [...cur.size],
    diameter: cur.diameter || Math.min(cur.size[0], cur.size[1]),
    height: cur.size[2],
    units: 'mm',
    centre: true,
    model: null,
    fileName: '',
  };

  const form = el('div.dialog-form');
  const fileLabel = el('div.hint', {}, 'No model chosen.');
  let dialog;

  const draw = () => {
    const kids = [];

    if (state.shape === 'box') {
      kids.push(row(['X', 'Y', 'Z'].map((a, i) => field(a, state.size[i], {
        min: 0.2, step: 1, unit: 'mm',
        onChange: (v) => { state.size[i] = Math.max(0.2, Number(v) || 0.2); },
      }))));
      kids.push(el('div.hint', {}, 'The block as it comes off the saw. X and Y are the footprint, Z the thickness.'));
    } else if (state.shape === 'round') {
      kids.push(row([
        field('Diameter', state.diameter, {
          min: 0.2, step: 1, unit: 'mm',
          onChange: (v) => { state.diameter = Math.max(0.2, Number(v) || 0.2); },
        }),
        field('Height', state.height, {
          min: 0.2, step: 1, unit: 'mm',
          onChange: (v) => { state.height = Math.max(0.2, Number(v) || 0.2); },
        }),
      ]));
      kids.push(el('div.hint', {}, 'A length of bar standing on its end. Everything outside the circle is air, so a cut that leaves the diameter removes nothing.'));
    } else {
      kids.push(row([el('button.btn', {
        type: 'button',
        onclick: async () => {
          const [file] = await pickFile('.stl');
          if (!file) return;
          try {
            const stl = parseSTL(await file.arrayBuffer());
            if (!stl.triangles) throw new Error('no triangles in it');
            const positions = stl.positions.slice();
            if (state.units === 'in') for (let i = 0; i < positions.length; i++) positions[i] *= MM_PER_INCH;
            const b = bounds(positions);
            state.model = { name: file.name.replace(/\.stl$/i, ''), positions, triangles: stl.triangles, size: b.size };
            state.fileName = file.name;
            state.size = [...b.size];
            fileLabel.textContent = `${file.name} — ${stl.triangles.toLocaleString()} triangles, ${b.size.map((v) => v.toFixed(1)).join(' × ')} mm`;
            dialog.setConfirmEnabled(true);
          } catch (err) {
            fileLabel.textContent = `${file.name}: ${err.message}`;
            dialog.setConfirmEnabled(false);
          }
        },
      }, 'Choose STL…')]));
      kids.push(fileLabel);
      kids.push(select('Units in the file', [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }],
        state.units, (v) => { state.units = v; state.model = null; fileLabel.textContent = 'Choose the file again for the new units.'; dialog.setConfirmEnabled(false); }));
      kids.push(el('div.hint', {}, 'The model\u2019s top surface becomes the starting surface, column by column. Like everything else in this simulation it cannot hold an undercut: what hides beneath the top surface is taken to be solid.'));
    }

    kids.push(checkbox('Centre it on the work origin, top face at Z0', state.centre, (v) => { state.centre = v; }));
    form.replaceChildren(...kids.filter(Boolean));
    if (dialog) dialog.setConfirmEnabled(state.shape !== 'model' || !!state.model);
  };

  const body = el('div.dialog-form', {}, [
    select('Shape', [
      { value: 'box', label: 'Rectangular block' },
      { value: 'round', label: 'Round bar' },
      { value: 'model', label: 'From a model (STL)' },
    ], state.shape, (v) => { state.shape = v; draw(); }),
    form,
  ]);

  dialog = new Dialog({
    title: 'Add stock',
    subtitle: 'What the tool starts with',
    width: 480,
    body,
    confirm: 'Add stock',
    onConfirm: () => {
      // A new billet starts square to the machine; it can be turned after.
      const patch = { shape: state.shape, model: null, rotation: 0 };
      if (state.shape === 'round') {
        patch.diameter = state.diameter;
        patch.size = [state.diameter, state.diameter, state.height];
      } else if (state.shape === 'model') {
        if (!state.model) return false;
        patch.model = state.model;
        patch.size = [...state.model.size];
      } else {
        patch.size = [...state.size];
      }
      if (state.centre) patch.origin = [-patch.size[0] / 2, -patch.size[1] / 2, -patch.size[2]];
      else patch.origin = [...app.state.stock.origin];
      app.setStock(patch);
      app.resetStock();
      panel.refresh();
      app.notify(`Stock is now a ${patch.shape === 'round' ? `Ø${patch.size[0]} × ${patch.size[2]} bar`
        : patch.shape === 'model' ? state.model.name
          : `${patch.size.map((v) => Number(v.toFixed(2))).join(' × ')} block`}. The cut was reset.`, 'ok');
      return true;
    },
  });
  draw();
  dialog.open();
  return dialog;
}
