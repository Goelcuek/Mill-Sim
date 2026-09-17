// Editors for library items, as modal windows.
//
// Making a cutter is a discrete task: choose a shape, fill in its
// dimensions, look at it, commit. That reads far better as a small window
// with a live preview and an OK button than as fields appended to a
// scrolling side panel, and it means the same editor serves "new" and
// "edit" without either one hijacking the sidebar.
//
// Every dialog works on a draft copy. Cancel throws the draft away; nothing
// touches the library until OK.

import { el, field, select, row, button, clear, pickFile } from './dom.js';
import { Dialog } from './dialog.js';
import { PreviewViewer } from './preview.js';
import { TOOL_TYPES, TOOL_FIELDS, DEFAULT_TOOL } from '../tools/toolDefs.js';
import { TAPERS, HOLDER_TYPES, DEFAULT_HOLDER } from '../tools/holderDefs.js';
import { describeAssembly } from '../tools/assembly.js';
import { fmt, clone } from '../core/util.js';
import * as units from '../core/units.js';

/** A preview pane that rebuilds whenever the draft changes. */
function previewPane() {
  const host = el('div.dialog-preview');
  let viewer = null;
  return {
    host,
    show(built) {
      if (!viewer) viewer = new PreviewViewer(host);
      viewer.setAssembly(built);
    },
    dispose() {
      if (viewer) viewer.dispose();
      viewer = null;
    },
  };
}

/**
 * Create or edit a cutter.
 * @param {object} app
 * @param {string|null} toolId  null to create a new one
 */
export function openToolDialog(app, toolId = null) {
  const lib = app.library;
  const existing = toolId ? lib.tool(toolId) : null;
  const draft = existing ? clone(existing) : { ...clone(DEFAULT_TOOL), id: '', name: 'New end mill' };

  const preview = previewPane();
  const form = el('div.dialog-form');
  const stats = el('div.dialog-stats');

  const rebuild = () => {
    const built = lib.buildDraft(draft, null, Math.max((draft.fluteLength || 10) * 1.5, 12), app.state.machine);
    preview.show(built);
    clear(stats);
    stats.appendChild(el('div.stat-value.dim', {},
      `Max cutting Ø ${units.lenU(built.cutRadius * 2, 3)} · flute ${units.lenU(built.fluteLength, 2)} · OAL ${units.lenU(built.tool.length, 1)}`));
    for (const w of built.warnings) {
      stats.appendChild(el('div.inline-warning', {}, w));
    }
  };

  const renderForm = () => {
    clear(form);
    const spec = TOOL_TYPES[draft.type] || TOOL_TYPES.flat;

    form.appendChild(row([
      field('Name', draft.name, { type: 'text', onInput: (v) => { draft.name = v; } }),
      select('Shape', Object.entries(TOOL_TYPES).map(([k, v]) => ({ value: k, label: v.label })), draft.type, (v) => {
        draft.type = v;
        renderForm();
        rebuild();
      }),
    ]));

    for (let i = 0; i < spec.fields.length; i += 2) {
      form.appendChild(row(spec.fields.slice(i, i + 2).map((key) => {
        const meta = TOOL_FIELDS[key] || { label: key, unit: 'mm', step: 0.1 };
        return field(meta.label, draft[key], {
          min: meta.min, max: meta.max, step: meta.step, unit: meta.unit,
          onChange: (v) => {
            let val = v;
            if (meta.integer) val = Math.round(val || 1);
            if (meta.min !== undefined) val = Math.max(meta.min, val || meta.min);
            draft[key] = val;
            rebuild();
          },
        });
      })));
    }

    const c = draft.cutting || {};
    form.appendChild(row([
      el('label.field', {}, [
        el('span.field-label', {}, 'Colour'),
        el('input', { type: 'color', value: draft.color || '#c8ccd4', oninput: (e) => { draft.color = e.target.value; rebuild(); } }),
      ]),
      select('Substrate', [
        { value: 'carbide', label: 'Carbide' },
        { value: 'hss', label: 'HSS' },
        { value: 'cobalt', label: 'Cobalt' },
        { value: 'ceramic', label: 'Ceramic' },
      ], draft.material, (v) => { draft.material = v; }),
    ]));

    form.appendChild(el('div.dialog-section-label', {}, 'Reference cutting data'));
    form.appendChild(el('div.hint', {}, 'Stored with the tool for your own reference. The simulator uses the feed rates in the program.'));
    form.appendChild(row([
      field('Spindle', c.rpm, { min: 0, step: 100, unit: 'rpm', onChange: (v) => { draft.cutting = { ...c, rpm: v }; } }),
      field('Feed', c.feed, { min: 0, step: 50, unit: 'mm/min', onChange: (v) => { draft.cutting = { ...c, feed: v }; } }),
    ]));
    form.appendChild(row([
      field('Axial DOC', c.doc, { min: 0, step: 0.1, unit: 'mm', onChange: (v) => { draft.cutting = { ...c, doc: v }; } }),
      field('Radial WOC', c.woc, { min: 0, step: 0.1, unit: 'mm', onChange: (v) => { draft.cutting = { ...c, woc: v }; } }),
    ]));
  };

  renderForm();

  const dlg = new Dialog({
    title: existing ? `Edit cutter · ${existing.name}` : 'New cutter',
    subtitle: 'Dimensions drive the simulation; the preview updates as you type.',
    width: 720,
    body: el('div.dialog-split', {}, [form, el('div.dialog-side', {}, [preview.host, stats])]),
    confirm: existing ? 'Save' : 'Create',
    onConfirm: () => {
      if (!draft.name.trim()) draft.name = 'Cutter';
      if (existing) lib.updateTool(existing.id, draft);
      else {
        const made = lib.addTool(draft);
        if (app.panels.tools) app.panels.tools.selected.tool = made.id;
      }
      app.refreshSlots();
      app.notify(existing ? `${draft.name} updated.` : `${draft.name} added to the library.`, 'ok');
    },
    onClosed: () => preview.dispose(),
  });
  dlg.open();
  rebuild();
  return dlg;
}

/** Create or edit a holder. */
export function openHolderDialog(app, holderId = null) {
  const lib = app.library;
  const existing = holderId ? lib.holder(holderId) : null;
  const draft = existing ? clone(existing) : { ...clone(DEFAULT_HOLDER), id: '', name: 'New holder' };

  const preview = previewPane();
  const form = el('div.dialog-form');
  const stats = el('div.dialog-stats');

  const rebuild = () => {
    const built = lib.buildDraft(lib.tools[0], draft, 40, app.state.machine);
    preview.show(built);
    clear(stats);
    if (built.holder) {
      stats.appendChild(el('div.stat-value.dim', {},
        `Projection ${units.lenU(built.holder.length, 1)} from the gauge line · nose Ø${units.len(built.holder.noseDia, 1)} · widest Ø${units.lenU(built.holder.maxDia, 1)}`));
    }
  };

  const renderForm = () => {
    clear(form);
    form.appendChild(row([
      field('Name', draft.name, { type: 'text', onInput: (v) => { draft.name = v; } }),
      select('Type', Object.entries(HOLDER_TYPES).map(([k, v]) => ({ value: k, label: v })), draft.type, (v) => { draft.type = v; }),
    ]));
    form.appendChild(row([
      select('Spindle interface', Object.entries(TAPERS).map(([k, v]) => ({ value: k, label: v.label })), draft.taper, (v) => {
        draft.taper = v;
        rebuild();
      }, { title: 'Sets the flange diameter below the gauge line. The taper itself is inside the spindle and is not modelled.' }),
      el('label.field', {}, [
        el('span.field-label', {}, 'Colour'),
        el('input', { type: 'color', value: draft.color || '#8d97a8', oninput: (e) => { draft.color = e.target.value; rebuild(); } }),
      ]),
    ]));

    form.appendChild(el('div.dialog-section-label', {}, 'Body stages, nose upwards'));
    form.appendChild(el('div.hint', {}, 'Each stage is a cone from its bottom diameter to its top diameter. The stack ends at the gauge line, where the spindle nose mates.'));

    draft.stages.forEach((st, i) => {
      form.appendChild(row([
        el('span.stage-index', {}, `${i + 1}`),
        field('Ø bottom', st.dia, { min: 0.5, step: 1, unit: 'mm', onChange: (v) => { st.dia = Math.max(0.5, v || 1); rebuild(); } }),
        field('Ø top', st.topDia, { min: 0.5, step: 1, unit: 'mm', onChange: (v) => { st.topDia = Math.max(0.5, v || 1); rebuild(); } }),
        field('Length', st.length, { min: 0.5, step: 1, unit: 'mm', onChange: (v) => { st.length = Math.max(0.5, v || 1); rebuild(); } }),
        button('✕', () => {
          draft.stages.splice(i, 1);
          renderForm();
          rebuild();
        }, { title: 'Remove stage', variant: 'warn' }),
      ], 'stage-row'));
    });

    form.appendChild(row([button('+ Add stage', () => {
      draft.stages.push({ dia: 40, topDia: 40, length: 20 });
      renderForm();
      rebuild();
    })]));
  };

  renderForm();

  const dlg = new Dialog({
    title: existing ? `Edit holder · ${existing.name}` : 'New holder',
    subtitle: 'Modelled from the nose up to the gauge line.',
    width: 760,
    body: el('div.dialog-split', {}, [form, el('div.dialog-side', {}, [preview.host, stats])]),
    confirm: existing ? 'Save' : 'Create',
    onConfirm: () => {
      if (!draft.name.trim()) draft.name = 'Holder';
      if (existing) lib.updateHolder(existing.id, draft);
      else {
        const made = lib.addHolder(draft);
        if (app.panels.tools) app.panels.tools.selected.holder = made.id;
      }
      app.refreshSlots();
      app.notify(existing ? `${draft.name} updated.` : `${draft.name} added to the library.`, 'ok');
    },
    onClosed: () => preview.dispose(),
  });
  dlg.open();
  rebuild();
  return dlg;
}

/** Create or edit an assembly: cutter + holder + stickout. */
export function openAssemblyDialog(app, assemblyId = null) {
  const lib = app.library;
  const existing = assemblyId ? lib.assembly(assemblyId) : null;
  const nextNumber = lib.assemblies.reduce((m, a) => Math.max(m, Number(a.number) || 0), 0) + 1;
  const draft = existing
    ? clone(existing)
    : {
      id: '', name: `T${nextNumber} · new assembly`, number: nextNumber,
      toolId: lib.tools[0] ? lib.tools[0].id : '',
      holderId: lib.holders[0] ? lib.holders[0].id : '',
      stickout: 35, notes: '',
    };

  const preview = previewPane();
  const form = el('div.dialog-form');
  const stats = el('div.dialog-stats');

  const rebuild = () => {
    const tool = lib.tool(draft.toolId);
    if (!tool) {
      clear(stats);
      stats.appendChild(el('div.inline-warning', {}, 'Pick a cutter to see the assembly.'));
      preview.show(null);
      return;
    }
    const built = lib.buildDraft(tool, lib.holder(draft.holderId), draft.stickout, app.state.machine);
    preview.show(built);
    clear(stats);
    stats.appendChild(el('div.stat-grid', {}, [
      ['Cutting Ø', units.lenU(built.cutRadius * 2, 3)],
      ['Flute length', units.lenU(built.fluteLength, 2)],
      ['Stickout', units.lenU(built.stickout, 2)],
      ['Tip to gauge', units.lenU(built.gaugeLength, 1)],
      ['Widest body', units.lenU(built.bodyRadius * 2, 1)],
      ['Total length', units.lenU(built.totalLength, 1)],
    ].map(([k, v]) => el('div.stat', {}, [
      el('div.stat-label', {}, k),
      el('div.stat-value', {}, v),
    ]))));
    stats.appendChild(el('div.stat-value.dim', {}, describeAssembly(built)));
    for (const w of built.warnings) stats.appendChild(el('div.inline-warning', {}, w));
  };

  const renderForm = () => {
    clear(form);
    form.appendChild(row([
      field('Name', draft.name, { type: 'text', onInput: (v) => { draft.name = v; } }),
      field('T number', draft.number, {
        min: 0, step: 1,
        title: 'The number an M06 tool change selects',
        onChange: (v) => { draft.number = Math.max(0, Math.round(v || 0)); },
      }),
    ]));
    form.appendChild(row([
      select('Cutter', [{ value: '', label: '— none —' }, ...lib.tools.map((t) => ({ value: t.id, label: t.name }))], draft.toolId, (v) => {
        draft.toolId = v;
        rebuild();
      }),
      button('New…', () => openToolDialog(app, null), { title: 'Create a cutter without leaving this window' }),
    ]));
    form.appendChild(row([
      select('Holder', [{ value: '', label: '— bare cutter —' }, ...lib.holders.map((h) => ({ value: h.id, label: h.name }))], draft.holderId, (v) => {
        draft.holderId = v;
        rebuild();
      }),
      button('New…', () => openHolderDialog(app, null)),
    ]));
    form.appendChild(row([
      field('Stickout', draft.stickout, {
        min: 1, step: 1, unit: 'mm',
        title: 'Holder face to tool tip. Shorter is stiffer; longer clears more.',
        onChange: (v) => { draft.stickout = Math.max(1, v || 1); rebuild(); },
      }),
    ]));
  };

  renderForm();

  const dlg = new Dialog({
    title: existing ? `Edit assembly · ${existing.name}` : 'New tool assembly',
    subtitle: 'A cutter, a holder and a stickout — this is what a T number selects.',
    width: 760,
    body: el('div.dialog-split', {}, [form, el('div.dialog-side', {}, [preview.host, stats])]),
    confirm: existing ? 'Save' : 'Create',
    onConfirm: () => {
      if (!draft.toolId) {
        app.notify('An assembly needs a cutter.', 'error');
        return false;
      }
      if (existing) lib.updateAssembly(existing.id, draft);
      else {
        const made = lib.addAssembly(draft);
        if (app.panels.tools) app.panels.tools.selected.assembly = made.id;
      }
      app.refreshSlots();
      app.notify(existing ? `${draft.name} updated.` : `${draft.name} added to the library.`, 'ok');
      return true;
    },
    onClosed: () => preview.dispose(),
  });
  dlg.open();
  rebuild();
  return dlg;
}

/** Stock size, position and simulation resolution. */

/**
 * Bringing somebody else's library in.
 *
 * Two questions have to be answered together — which file, and whether it
 * joins this library or replaces it — so they are answered in a window
 * rather than by a button that guesses. Replacing matters: a shop's
 * library carries its own T numbers, and merging renumbers whatever
 * collides, which is exactly wrong when the program you are about to run
 * was posted against those numbers.
 */
export function openLibraryImportDialog(app) {
  const state = { file: null, mode: 'merge', units: 'mm' };
  const fileLabel = el('div.hint', {}, 'No file chosen.');
  const unitRow = el('div.dialog-form');

  // JSON libraries carry their own unit. A text tool list does not: an NX
  // library is metric or english by the directory it sits in, and a
  // spreadsheet says nothing at all, so it is asked for — but only when it
  // is going to be used.
  const syncUnits = () => {
    const name = (state.file && state.file.name) || '';
    unitRow.hidden = /\.(json|tools|hsmlib)$/i.test(name) || !state.file;
  };

  const body = el('div.dialog-form', {}, [
    row([el('button.btn', {
      type: 'button',
      onclick: async () => {
        const [file] = await pickFile('.json,.tools,.hsmlib,.dat,.csv,.tsv,.txt,application/json,text/csv');
        state.file = file || null;
        fileLabel.textContent = file ? file.name : 'No file chosen.';
        syncUnits();
        dialog.setConfirmEnabled(!!file);
      },
    }, 'Choose file…')]),
    fileLabel,
    el('div.hint', {}, 'A library exported from Mill-Sim, or a tool library from Fusion 360 or HSMWorks — those are read directly, geometry, feeds and T numbers. A Siemens NX ASCII tool library (tool_database.dat and its neighbours) is read too, as is a tool list saved as CSV: the columns are matched by what they mean, so NX\u2019s FLUTE_LN, ISO\u2019s LCF and a plain \u201cFlute Length\u201d all land in the same place.'),
    unitRow,
    select('How', [
      { value: 'merge', label: 'Add to this library' },
      { value: 'replace', label: 'Replace this library' },
    ], state.mode, (v) => { state.mode = v; }),
    el('div.hint', {}, 'Adding keeps what is here and moves any incoming T number that is already taken. Replacing keeps the incoming numbering, which is what you want when the programs were posted against it.'),
  ]);

  unitRow.replaceChildren(
    select('Units in the file', [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }],
      state.units, (v) => { state.units = v; }),
    el('div.hint', {}, 'A text tool list carries no unit. NX keeps its metric and english libraries in separate directories \u2014 this is which one this file came from.'),
  );

  const dialog = new Dialog({
    title: 'Import a tool library',
    subtitle: 'Mill-Sim, Fusion or NX',
    width: 480,
    body,
    confirm: 'Import',
    onConfirm: () => {
      if (!state.file) return false;
      app.importLibraryFile(state.file, state.mode === 'merge', state.units);
      return true;
    },
  });
  syncUnits();
  dialog.setConfirmEnabled(false);
  dialog.open();
  return dialog;
}
