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

import { el, field, select, row, button, clear } from './dom.js';
import { Dialog } from './dialog.js';
import { PreviewViewer } from './preview.js';
import { TOOL_TYPES, TOOL_FIELDS, DEFAULT_TOOL } from '../tools/toolDefs.js';
import { TAPERS, HOLDER_TYPES, DEFAULT_HOLDER } from '../tools/holderDefs.js';
import { describeAssembly } from '../tools/assembly.js';
import { fmt, clone } from '../core/util.js';

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
      `Max cutting Ø ${fmt(built.cutRadius * 2, 3)} mm · flute ${fmt(built.fluteLength, 2)} mm · OAL ${fmt(built.tool.length, 1)} mm`));
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
        `Projection ${fmt(built.holder.length, 1)} mm from the gauge line · nose Ø${fmt(built.holder.noseDia, 1)} · widest Ø${fmt(built.holder.maxDia, 1)}`));
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
      ['Cutting Ø', `${fmt(built.cutRadius * 2, 3)} mm`],
      ['Flute length', `${fmt(built.fluteLength, 2)} mm`],
      ['Stickout', `${fmt(built.stickout, 2)} mm`],
      ['Tip to gauge', `${fmt(built.gaugeLength, 1)} mm`],
      ['Widest body', `${fmt(built.bodyRadius * 2, 1)} mm`],
      ['Total length', `${fmt(built.totalLength, 1)} mm`],
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
export function openStockDialog(app, RESOLUTIONS) {
  const draft = clone(app.state.stock);
  const info = el('div.hint');
  const update = () => {
    const cells = Math.round(draft.size[0] / draft.resolution) * Math.round(draft.size[1] / draft.resolution);
    const mb = (cells * 5) / 1e6;
    info.innerHTML = `About <b>${(cells / 1e6).toFixed(2)} M</b> columns, roughly <b>${mb.toFixed(0)} MB</b>.`;
  };
  update();

  const axes = ['X', 'Y', 'Z'];
  const body = el('div.dialog-form', {}, [
    el('div.dialog-section-label', {}, 'Size'),
    row(axes.map((a, i) => field(a, draft.size[i], {
      min: 1, step: 1, unit: 'mm', onChange: (v) => { draft.size[i] = Math.max(1, v || 1); update(); },
    }))),
    el('div.dialog-section-label', {}, 'Minimum corner'),
    row(axes.map((a, i) => field(a, draft.origin[i], {
      step: 1, unit: 'mm', onChange: (v) => { draft.origin[i] = v || 0; },
    }))),
    el('div.dialog-section-label', {}, 'Simulation resolution'),
    select('Cell size', RESOLUTIONS.map((r) => ({ value: r, label: `${r} mm` })), draft.resolution, (v) => {
      draft.resolution = Number(v);
      update();
    }),
    info,
    el('div.hint', {}, 'Finer cells give sharper corners and scallops but cost memory. 0.2–0.4 mm suits most parts; 0.025 mm is for inspecting a finish.'),
  ]);

  new Dialog({
    title: 'Stock',
    subtitle: 'The block of material the program cuts.',
    width: 460,
    body,
    confirm: 'Apply',
    onConfirm: () => {
      app.setStock(draft);
      app.panels.setup.refresh();
      app.notify('Stock updated. The cut was reset.', 'ok');
    },
  }).open();
}

/** Machine envelope, table and spindle nose. */
export function openMachineDialog(app) {
  const m = clone(app.state.machine);
  const axes = ['X', 'Y', 'Z'];
  const body = el('div.dialog-form', {}, [
    row([
      select('View', [
        { value: 'part', label: 'Part only' },
        { value: 'machine', label: 'Full machine' },
      ], m.mode, (v) => { m.mode = v; }),
      field('Table top Z', m.tableZ, { step: 5, unit: 'mm', onChange: (v) => { m.tableZ = v || 0; m.table.z = v || 0; } }),
    ]),
    row([
      field('Spindle nose Ø', m.spindleDiameter, { min: 0, step: 5, unit: 'mm', onChange: (v) => { m.spindleDiameter = Math.max(0, v || 0); } }),
      field('Nose length', m.spindleLength, { min: 0, step: 5, unit: 'mm', onChange: (v) => { m.spindleLength = Math.max(0, v || 0); } }),
    ]),
    el('div.hint', {}, 'The spindle nose is part of the crash model, so a plunge that buries the spindle is caught even when the holder clears.'),
    row([field('Rapid rate', m.rapidRate, { min: 100, step: 500, unit: 'mm/min', onChange: (v) => { m.rapidRate = Math.max(100, v || 1000); } })]),
    el('div.dialog-section-label', {}, 'Travel limits'),
    row(axes.map((a, i) => field(`${a} min`, m.limits.min[i], { step: 10, unit: 'mm', onChange: (v) => { m.limits.min[i] = v || 0; } }))),
    row(axes.map((a, i) => field(`${a} max`, m.limits.max[i], { step: 10, unit: 'mm', onChange: (v) => { m.limits.max[i] = v || 0; } }))),
  ]);

  new Dialog({
    title: 'Machine',
    subtitle: '3-axis vertical machining centre.',
    width: 500,
    body,
    confirm: 'Apply',
    onConfirm: () => {
      app.setMachine(m);
      app.panels.setup.refresh();
    },
  }).open();
}
