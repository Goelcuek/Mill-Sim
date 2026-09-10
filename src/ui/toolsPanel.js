// The tool library, as a browser.
//
// Editing moved into modal windows, so this panel's job is to show what is
// in the library and what is wrong with it. Selecting an item arms the
// ribbon's Edit / Duplicate / Delete; double-clicking opens the editor.

import { el, button, row, section, clear, pickFile } from './dom.js';
import { TOOL_TYPES } from '../tools/toolDefs.js';
import { TAPERS, HOLDER_TYPES } from '../tools/holderDefs.js';
import { describeAssembly } from '../tools/assembly.js';
import { openToolDialog, openHolderDialog, openAssemblyDialog } from './toolDialogs.js';
import { confirmDialog } from './dialog.js';
import { fmt } from '../core/util.js';

export class ToolsPanel {
  constructor(app) {
    this.app = app;
    this.root = el('div.panel');
    this.mode = 'assemblies';
    this.selected = { assembly: null, tool: null, holder: null };
    this.render();
    app.library.onChange(() => this.render());
  }

  refresh() { this.render(); }

  // ---- what the ribbon asks about -----------------------------------------

  hasSelection() {
    return !!this.selectedId();
  }

  selectedId() {
    if (this.mode === 'assemblies') return this.selected.assembly;
    if (this.mode === 'tools') return this.selected.tool;
    return this.selected.holder;
  }

  editSelected() {
    const id = this.selectedId();
    if (!id) return;
    if (this.mode === 'assemblies') openAssemblyDialog(this.app, id);
    else if (this.mode === 'tools') openToolDialog(this.app, id);
    else openHolderDialog(this.app, id);
  }

  duplicateSelected() {
    const lib = this.app.library;
    const id = this.selectedId();
    if (!id) return;
    if (this.mode === 'assemblies') {
      const a = lib.assembly(id);
      const copy = lib.addAssembly({ ...a, id: undefined, name: `${a.name} copy` });
      this.selected.assembly = copy.id;
    } else if (this.mode === 'tools') {
      const copy = lib.duplicateTool(id);
      if (copy) this.selected.tool = copy.id;
    } else {
      const copy = lib.duplicateHolder(id);
      if (copy) this.selected.holder = copy.id;
    }
    this.app.refreshSlots();
  }

  deleteSelected() {
    const lib = this.app.library;
    const id = this.selectedId();
    if (!id) return;
    const kind = this.mode === 'assemblies' ? 'assembly' : this.mode === 'tools' ? 'cutter' : 'holder';
    const item = this.mode === 'assemblies' ? lib.assembly(id) : this.mode === 'tools' ? lib.tool(id) : lib.holder(id);
    if (!item) return;

    confirmDialog({
      title: `Delete this ${kind}?`,
      message: `"${item.name}" will be removed from the library. Assemblies that use it will need a replacement.`,
      confirm: 'Delete',
      danger: true,
      onConfirm: () => {
        if (this.mode === 'assemblies') lib.removeAssembly(id);
        else if (this.mode === 'tools') lib.removeTool(id);
        else lib.removeHolder(id);
        this.selected[this.mode === 'assemblies' ? 'assembly' : this.mode === 'tools' ? 'tool' : 'holder'] = null;
        this.app.refreshSlots();
      },
    });
  }

  /** The assembly whose geometry the ribbon exports. */
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
      return h ? lib.buildDraft(lib.tools[0], h, 40, machine) : null;
    }
    return null;
  }

  showAll() {
    this.mode = 'assemblies';
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

  // ---- rendering ----------------------------------------------------------

  render() {
    if (this.rendering) { this.queued = true; return; }
    this.rendering = true;
    const scrollTop = this.root.scrollTop;
    clear(this.root);

    this.root.appendChild(el('div.seg-row', {}, [
      el('div.segmented', {}, [
        this.subTab('assemblies', `Assemblies (${this.app.library.assemblies.length})`),
        this.subTab('tools', `Cutters (${this.app.library.tools.length})`),
        this.subTab('holders', `Holders (${this.app.library.holders.length})`),
      ]),
    ]));

    if (this.mode === 'assemblies') this.renderAssemblies();
    else if (this.mode === 'tools') this.renderTools();
    else this.renderHolders();

    this.root.scrollTop = scrollTop;
    this.rendering = false;
    if (this.queued) { this.queued = false; this.render(); }
    else if (this.app.ribbon) this.app.buildRibbon();
  }

  subTab(id, label) {
    return el(`button${this.mode === id ? '.active' : ''}`, {
      type: 'button',
      onclick: () => { this.mode = id; this.render(); },
    }, label);
  }

  listItem({ selected, onSelect, onOpen, swatch, title, sub, extra }) {
    return el(`div.list-item${selected ? '.selected' : ''}`, {
      onclick: onSelect,
      ondblclick: onOpen,
      title: 'Double-click to edit',
    }, [
      swatch ? el('div.swatch', { style: { background: swatch } }) : null,
      el('div.list-main', {}, [
        el('div.list-title', {}, title),
        el('div.list-sub', {}, sub),
      ]),
      el('div.list-actions', {}, [
        button('Edit', (e) => { e.stopPropagation(); onSelect(); onOpen(); }),
        ...(extra || []),
      ]),
    ]);
  }

  renderAssemblies() {
    const app = this.app;
    const lib = app.library;
    const list = el('div.list');

    for (const a of lib.assemblies) {
      const built = lib.build(a.id, app.state.machine);
      list.appendChild(this.listItem({
        selected: this.selected.assembly === a.id,
        onSelect: () => { this.selected.assembly = a.id; this.render(); },
        onOpen: () => openAssemblyDialog(app, a.id),
        title: [el('span.tnum', {}, `T${a.number || '–'}`), a.name],
        sub: built ? describeAssembly(built) : 'incomplete assembly',
        extra: [button('Use', (e) => { e.stopPropagation(); app.setActiveAssembly(a.id); }, { title: 'Use when the program has no tool change' })],
      }));
    }

    this.root.appendChild(section('Tool table', [
      el('div.hint', {}, 'An assembly pairs a cutter with a holder and a stickout. The T number is what an M06 tool change selects.'),
      list,
      row([button('+ New assembly', () => openAssemblyDialog(app, null), { variant: 'primary' })]),
    ]));

    const issues = lib.audit(app.state.machine);
    if (issues.length) {
      this.root.appendChild(section(`Library check (${issues.length})`, [
        el('ul.issues', {}, issues.map((i) => el(`li.issue-${i.level}`, {}, i.text))),
      ]));
    }
  }

  renderTools() {
    const app = this.app;
    const list = el('div.list');
    for (const t of app.library.tools) {
      list.appendChild(this.listItem({
        selected: this.selected.tool === t.id,
        onSelect: () => { this.selected.tool = t.id; this.render(); },
        onOpen: () => openToolDialog(app, t.id),
        swatch: t.color || '#c8ccd4',
        title: t.name,
        sub: `${TOOL_TYPES[t.type] ? TOOL_TYPES[t.type].label : t.type} · Ø${fmt(t.diameter, 2)} · ${t.fluteCount}F`,
      }));
    }
    this.root.appendChild(section('Cutters', [
      list,
      row([button('+ New cutter', () => openToolDialog(app, null), { variant: 'primary' })]),
    ]));
  }

  renderHolders() {
    const app = this.app;
    const list = el('div.list');
    for (const h of app.library.holders) {
      list.appendChild(this.listItem({
        selected: this.selected.holder === h.id,
        onSelect: () => { this.selected.holder = h.id; this.render(); },
        onOpen: () => openHolderDialog(app, h.id),
        swatch: h.color || '#8d97a8',
        title: h.name,
        sub: `${HOLDER_TYPES[h.type] || h.type} · ${(TAPERS[h.taper] || TAPERS.none).label}`,
      }));
    }
    this.root.appendChild(section('Holders', [
      list,
      row([button('+ New holder', () => openHolderDialog(app, null), { variant: 'primary' })]),
    ]));
  }
}
