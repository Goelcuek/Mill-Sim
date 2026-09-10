// Tools panel: the library of assemblies, cutters and holders, plus the
// parametric editors that create them.

import { el, field, select, button, row, section, clear, checkbox, download, pickFile } from './dom.js';
import { TOOL_TYPES, TOOL_FIELDS } from '../tools/toolDefs.js';
import { TAPERS, HOLDER_TYPES } from '../tools/holderDefs.js';
import { describeAssembly } from '../tools/assembly.js';
import { PreviewViewer } from './preview.js';
import { fmt } from '../core/util.js';

export class ToolsPanel {
  constructor(app) {
    this.app = app;
    this.root = el('div.panel');
    this.mode = 'assemblies';
    this.selected = { assembly: null, tool: null, holder: null };
    this.previewHost = el('div.preview');
    this.preview = null;
    this.render();
    app.library.onChange(() => this.render());
  }

  ensurePreview() {
    if (!this.preview && this.previewHost.isConnected) {
      this.preview = new PreviewViewer(this.previewHost);
    }
    return this.preview;
  }

  refresh() { this.render(); }

  /** Create a new library entry of the given kind and select it. */
  create(kind) {
    const lib = this.app.library;
    this.mode = kind;
    if (kind === 'assemblies') this.selected.assembly = lib.addAssembly().id;
    else if (kind === 'tools') this.selected.tool = lib.addTool().id;
    else this.selected.holder = lib.addHolder().id;
    this.app.setTab('tools');
    this.render();
  }

  async importLibrary() {
    const app = this.app;
    const [file] = await pickFile('.json,application/json');
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (app.library.fromJSON(data, { merge: true })) app.notify(`Merged ${file.name} into the library.`, 'ok');
      else app.notify('That file contains no tools, holders or assemblies.', 'error');
    } catch (err) {
      app.notify(`Could not read ${file.name}: ${err.message}`, 'error');
    }
  }

  /** Buttons for the contextual ribbon row. */
  actions() {
    const app = this.app;
    const lib = app.library;
    const sub = (id, label) => {
      const b = el('button.btn', { type: 'button', onclick: () => { this.mode = id; this.render(); app.buildActions(); } }, label);
      if (this.mode === id) b.classList.add('active');
      return b;
    };
    return [
      el('span.actions-label', {}, 'Library'),
      el('div.actions-group', {}, [sub('assemblies', 'Assemblies'), sub('tools', 'Cutters'), sub('holders', 'Holders')]),
      el('div.actions-sep'),
      el('div.actions-group', {}, [
        button('New assembly', () => this.create('assemblies')),
        button('New cutter', () => this.create('tools')),
        button('New holder', () => this.create('holders')),
      ]),
      el('div.actions-sep'),
      el('div.actions-group', {}, [
        button('Export STL', () => app.exportAssemblyStl(this.currentBuilt()), { title: 'Write the selected assembly as a solid model' }),
        button('Export library', () => download('mill-sim-library.json', JSON.stringify(lib.toJSON(), null, 2), 'application/json')),
      ]),
    ];
  }

  render() {
    // Committing a field can blur it, which fires change -> library update ->
    // render again. Let the outer call finish and re-run once at the end.
    if (this.rendering) {
      this.renderQueued = true;
      return;
    }
    this.rendering = true;
    const scrollTop = this.root.scrollTop;
    clear(this.root);

    this.root.appendChild(el('div.tabs.subtabs', {}, [
      this.subTab('assemblies', 'Assemblies'),
      this.subTab('tools', 'Cutters'),
      this.subTab('holders', 'Holders'),
    ]));

    if (this.mode === 'assemblies') this.renderAssemblies();
    else if (this.mode === 'tools') this.renderTools();
    else this.renderHolders();

    this.root.appendChild(this.librarySection());
    this.root.scrollTop = scrollTop;
    this.rendering = false;
    if (this.renderQueued) {
      this.renderQueued = false;
      this.render();
      return;
    }
    requestAnimationFrame(() => this.updatePreview());
  }

  subTab(id, label) {
    return el(`button.subtab${this.mode === id ? '.active' : ''}`, {
      type: 'button',
      onclick: () => { this.mode = id; this.render(); },
    }, label);
  }

  updatePreview() {
    const p = this.ensurePreview();
    if (!p) return;
    const built = this.currentBuilt();
    p.setAssembly(built);
  }

  currentBuilt() {
    const app = this.app;
    const lib = app.library;
    const machine = app.state.machine;
    if (this.mode === 'assemblies' && this.selected.assembly) return lib.build(this.selected.assembly, machine);
    if (this.mode === 'tools' && this.selected.tool) {
      const t = lib.tool(this.selected.tool);
      return t ? lib.buildDraft(t, null, Math.max((t.fluteLength || 10) * 1.5, 12), machine) : null;
    }
    if (this.mode === 'holders' && this.selected.holder) {
      const h = lib.holder(this.selected.holder);
      const t = lib.tools[0];
      return h ? lib.buildDraft(t, h, Math.max((t && t.fluteLength) || 20, 20) * 1.4, machine) : null;
    }
    return null;
  }

  // ---- assemblies --------------------------------------------------------

  renderAssemblies() {
    const app = this.app;
    const lib = app.library;
    const list = el('div.list');

    for (const a of lib.assemblies) {
      const built = lib.build(a.id, app.state.machine);
      const active = this.selected.assembly === a.id;
      const item = el(`div.list-item${active ? '.selected' : ''}`, {
        onclick: () => {
          this.selected.assembly = a.id;
          this.render();
        },
      }, [
        el('div.list-main', {}, [
          el('div.list-title', {}, [el('span.tnum', {}, `T${a.number || '–'}`), a.name]),
          el('div.list-sub', {}, built ? describeAssembly(built) : 'incomplete assembly'),
        ]),
        el('div.list-actions', {}, [
          button('⧉', (e) => { e.stopPropagation(); const c = lib.addAssembly({ ...a, id: undefined, name: `${a.name} copy` }); this.selected.assembly = c.id; }, { title: 'Duplicate' }),
          button('✕', (e) => { e.stopPropagation(); lib.removeAssembly(a.id); }, { title: 'Delete', variant: 'warn' }),
        ]),
      ]);
      list.appendChild(item);
    }

    this.root.appendChild(section('Assemblies', [
      el('div.hint', {}, 'An assembly pairs a cutter with a holder and a stickout. The T number is what an M06 tool change selects.'),
      list,
      row([button('+ New assembly', () => { const a = lib.addAssembly(); this.selected.assembly = a.id; })]),
    ]));

    const a = lib.assembly(this.selected.assembly);
    if (a) this.root.appendChild(this.assemblyEditor(a));

    const issues = lib.audit(app.state.machine);
    if (issues.length) {
      this.root.appendChild(section(`Library check (${issues.length})`, [
        el('ul.issues', {}, issues.map((i) => el(`li.issue-${i.level}`, {}, i.text))),
      ]));
    }
  }

  assemblyEditor(a) {
    const app = this.app;
    const lib = app.library;
    const built = lib.build(a.id, app.state.machine);
    const set = (patch) => {
      lib.updateAssembly(a.id, patch);
      app.refreshSlots();
    };

    const stats = el('div.stats');
    if (built) {
      stats.appendChild(this.statGrid([
        ['Cutting Ø', `${fmt(built.cutRadius * 2, 3)} mm`],
        ['Flute length', `${fmt(built.fluteLength, 2)} mm`],
        ['Stickout', `${fmt(built.stickout, 2)} mm`],
        ['Tip to gauge line', `${fmt(built.gaugeLength, 1)} mm`],
        ['Widest body', `${fmt(built.bodyRadius * 2, 1)} mm`],
        ['Assembly length', `${fmt(built.totalLength, 1)} mm`],
      ]));
      if (built.warnings.length) {
        stats.appendChild(el('ul.issues', {}, built.warnings.map((w) => el('li.issue-warning', {}, w))));
      }
    }

    return section(`Editing · ${a.name}`, [
      this.previewHost,
      row([
        field('Name', a.name, { type: 'text', onChange: (v) => set({ name: v || 'Assembly' }) }),
        field('T number', a.number, { min: 0, step: 1, onChange: (v) => set({ number: Math.max(0, Math.round(v || 0)) }) }),
      ]),
      row([
        select('Cutter', [{ value: '', label: '— none —' }, ...lib.tools.map((t) => ({ value: t.id, label: t.name }))], a.toolId, (v) => set({ toolId: v })),
        select('Holder', [{ value: '', label: '— bare cutter —' }, ...lib.holders.map((h) => ({ value: h.id, label: h.name }))], a.holderId, (v) => set({ holderId: v })),
      ]),
      row([
        field('Stickout', a.stickout, {
          min: 1, step: 1, unit: 'mm',
          title: 'Distance from the holder face to the tool tip. Shorter is stiffer; longer clears more.',
          onChange: (v) => set({ stickout: Math.max(1, v || 1) }),
        }),
        button('Use in viewport', () => app.setActiveAssembly(a.id), { title: 'Show this assembly when no tool change has happened yet.' }),
      ]),
      stats,
    ]);
  }

  statGrid(pairs) {
    return el('div.stat-grid', {}, pairs.map(([k, v]) => el('div.stat', {}, [
      el('div.stat-label', {}, k),
      el('div.stat-value', {}, v),
    ])));
  }

  // ---- cutters -----------------------------------------------------------

  renderTools() {
    const lib = this.app.library;
    const list = el('div.list');
    for (const t of lib.tools) {
      list.appendChild(el(`div.list-item${this.selected.tool === t.id ? '.selected' : ''}`, {
        onclick: () => { this.selected.tool = t.id; this.render(); },
      }, [
        el('div.swatch', { style: { background: t.color || '#c8ccd4' } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, t.name),
          el('div.list-sub', {}, `${TOOL_TYPES[t.type] ? TOOL_TYPES[t.type].label : t.type} · Ø${fmt(t.diameter, 2)} · ${t.fluteCount}F`),
        ]),
        el('div.list-actions', {}, [
          button('⧉', (e) => { e.stopPropagation(); const c = lib.duplicateTool(t.id); if (c) this.selected.tool = c.id; }, { title: 'Duplicate' }),
          button('✕', (e) => { e.stopPropagation(); lib.removeTool(t.id); }, { title: 'Delete', variant: 'warn' }),
        ]),
      ]));
    }

    this.root.appendChild(section('Cutters', [
      list,
      row([button('+ New cutter', () => { const t = lib.addTool(); this.selected.tool = t.id; })]),
    ]));

    const t = lib.tool(this.selected.tool);
    if (t) this.root.appendChild(this.toolEditor(t));
  }

  toolEditor(t) {
    const app = this.app;
    const lib = app.library;
    const set = (patch) => {
      lib.updateTool(t.id, patch);
      app.refreshSlots();
    };

    const spec = TOOL_TYPES[t.type] || TOOL_TYPES.flat;
    const inputs = [];
    for (let i = 0; i < spec.fields.length; i += 2) {
      const pair = spec.fields.slice(i, i + 2).map((key) => {
        const meta = TOOL_FIELDS[key] || { label: key, unit: 'mm', step: 0.1 };
        return field(meta.label, t[key], {
          min: meta.min, max: meta.max, step: meta.step, unit: meta.unit,
          onChange: (v) => {
            let val = v;
            if (meta.integer) val = Math.round(val || 1);
            if (meta.min !== undefined) val = Math.max(meta.min, val || meta.min);
            set({ [key]: val });
          },
        });
      });
      inputs.push(row(pair));
    }

    const built = lib.buildDraft(t, null, Math.max((t.fluteLength || 10) * 1.5, 12), app.state.machine);
    const warnings = built.warnings.length
      ? el('ul.issues', {}, built.warnings.map((w) => el('li.issue-warning', {}, w)))
      : null;

    const c = t.cutting || {};
    return section(`Editing · ${t.name}`, [
      this.previewHost,
      row([
        field('Name', t.name, { type: 'text', onChange: (v) => set({ name: v || 'Tool' }) }),
        select('Type', Object.entries(TOOL_TYPES).map(([k, v]) => ({ value: k, label: v.label })), t.type, (v) => {
          set({ type: v });
          this.render();
        }),
      ]),
      ...inputs,
      row([
        el('label.field', {}, [
          el('span.field-label', {}, 'Colour'),
          el('input', { type: 'color', value: t.color || '#c8ccd4', oninput: (e) => set({ color: e.target.value }) }),
        ]),
        select('Substrate', [
          { value: 'carbide', label: 'Carbide' },
          { value: 'hss', label: 'HSS' },
          { value: 'cobalt', label: 'Cobalt' },
          { value: 'ceramic', label: 'Ceramic' },
        ], t.material, (v) => set({ material: v })),
      ]),
      el('div.stat-value.dim', {}, `Max cutting Ø ${fmt(built.cutRadius * 2, 3)} mm · flute ${fmt(built.fluteLength, 2)} mm · OAL ${fmt(built.length, 1)} mm`),
      warnings,
      section('Reference cutting data', [
        el('div.hint', {}, 'Stored with the tool for your own reference. The simulator uses the feed rates in the program, not these.'),
        row([
          field('Spindle', c.rpm, { min: 0, step: 100, unit: 'rpm', onChange: (v) => set({ cutting: { ...c, rpm: v } }) }),
          field('Feed', c.feed, { min: 0, step: 50, unit: 'mm/min', onChange: (v) => set({ cutting: { ...c, feed: v } }) }),
        ]),
        row([
          field('Plunge', c.plunge, { min: 0, step: 25, unit: 'mm/min', onChange: (v) => set({ cutting: { ...c, plunge: v } }) }),
          field('Axial DOC', c.doc, { min: 0, step: 0.1, unit: 'mm', onChange: (v) => set({ cutting: { ...c, doc: v } }) }),
          field('Radial WOC', c.woc, { min: 0, step: 0.1, unit: 'mm', onChange: (v) => set({ cutting: { ...c, woc: v } }) }),
        ]),
      ], { collapsed: true }),
    ]);
  }

  // ---- holders -----------------------------------------------------------

  renderHolders() {
    const lib = this.app.library;
    const list = el('div.list');
    for (const h of lib.holders) {
      list.appendChild(el(`div.list-item${this.selected.holder === h.id ? '.selected' : ''}`, {
        onclick: () => { this.selected.holder = h.id; this.render(); },
      }, [
        el('div.swatch', { style: { background: h.color || '#8d97a8' } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, h.name),
          el('div.list-sub', {}, `${HOLDER_TYPES[h.type] || h.type} · ${(TAPERS[h.taper] || TAPERS.none).label}`),
        ]),
        el('div.list-actions', {}, [
          button('⧉', (e) => { e.stopPropagation(); const c = lib.duplicateHolder(h.id); if (c) this.selected.holder = c.id; }, { title: 'Duplicate' }),
          button('✕', (e) => { e.stopPropagation(); lib.removeHolder(h.id); }, { title: 'Delete', variant: 'warn' }),
        ]),
      ]));
    }

    this.root.appendChild(section('Holders', [
      list,
      row([button('+ New holder', () => { const h = lib.addHolder(); this.selected.holder = h.id; })]),
    ]));

    const h = lib.holder(this.selected.holder);
    if (h) this.root.appendChild(this.holderEditor(h));
  }

  holderEditor(h) {
    const app = this.app;
    const lib = app.library;
    const set = (patch) => {
      lib.updateHolder(h.id, patch);
      app.refreshSlots();
    };
    const setStage = (i, patch) => {
      const stages = h.stages.map((s, k) => (k === i ? { ...s, ...patch } : s));
      set({ stages });
    };

    const stageRows = h.stages.map((s, i) => row([
      el('span.stage-index', {}, `${i + 1}`),
      field('Ø bottom', s.dia, { min: 0.5, step: 1, unit: 'mm', onChange: (v) => setStage(i, { dia: Math.max(0.5, v || 1) }) }),
      field('Ø top', s.topDia, { min: 0.5, step: 1, unit: 'mm', onChange: (v) => setStage(i, { topDia: Math.max(0.5, v || 1) }) }),
      field('Length', s.length, { min: 0.5, step: 1, unit: 'mm', onChange: (v) => setStage(i, { length: Math.max(0.5, v || 1) }) }),
      button('✕', () => set({ stages: h.stages.filter((_, k) => k !== i) }), { title: 'Remove stage', variant: 'warn' }),
    ], 'stage-row'));

    const built = lib.buildDraft(lib.tools[0], h, 40, app.state.machine);

    return section(`Editing · ${h.name}`, [
      this.previewHost,
      row([
        field('Name', h.name, { type: 'text', onChange: (v) => set({ name: v || 'Holder' }) }),
        select('Type', Object.entries(HOLDER_TYPES).map(([k, v]) => ({ value: k, label: v })), h.type, (v) => set({ type: v })),
      ]),
      row([
        select('Spindle interface', Object.entries(TAPERS).map(([k, v]) => ({ value: k, label: v.label })), h.taper, (v) => set({ taper: v }), {
          title: 'Sets the flange diameter below the gauge line. The taper itself is inside the spindle and is not modelled.',
        }),
        el('label.field', {}, [
          el('span.field-label', {}, 'Colour'),
          el('input', { type: 'color', value: h.color || '#8d97a8', oninput: (e) => set({ color: e.target.value }) }),
        ]),
      ]),
      el('div.hint', {}, 'Stages are stacked from the nose upwards. Each is a cone from its bottom diameter to its top diameter. The stack ends at the gauge line, where the spindle nose mates — the taper above it sits inside the spindle and can never hit anything, so it is not drawn or checked.'),
      ...stageRows,
      row([
        button('+ Add stage', () => set({ stages: [...h.stages, { dia: 40, topDia: 40, length: 20 }] })),
      ]),
      el('div.stat-value.dim', {}, `Projection ${fmt(built.holder ? built.holder.length : 0, 1)} mm from the gauge line · nose Ø${fmt(built.holder ? built.holder.noseDia : 0, 1)} · widest Ø${fmt(built.holder ? built.holder.maxDia : 0, 1)}`),
    ]);
  }

  // ---- library file operations -------------------------------------------

  librarySection() {
    const app = this.app;
    const lib = app.library;
    return section('Library file', [
      row([
        button('Export JSON', () => {
          download('mill-sim-library.json', JSON.stringify(lib.toJSON(), null, 2), 'application/json');
        }),
        button('Import JSON', () => this.importLibrary()),
      ]),
      row([
        button('Export tool as STL', () => app.exportAssemblyStl(this.currentBuilt()), { title: 'Write the selected assembly as a solid model.' }),
        button('Restore defaults', () => {
          lib.loadDefaults();
          app.refreshSlots();
          app.notify('Library reset to the built-in tools.', 'ok');
        }, { variant: 'warn' }),
      ]),
      checkbox('Remember library in this browser', app.state.persistLibrary, (v) => app.setPersistLibrary(v)),
    ], { collapsed: true });
  }
}
