// The tool library, as a browser.
//
// Four pages: the tool table, the cutters and holders that feed it, and the
// library as a whole. Editing happens in a window, so this panel's job is to
// show what is in the library, what is wrong with it, and to act on whatever
// is selected — Edit, Duplicate, Delete and Export sit under the list they
// apply to rather than in the ribbon, where they would be a second copy of
// the same three buttons.

import { el, button, row, section, clear, checkbox, download } from './dom.js';
import { Panel, addBar, actionRow } from './panel.js';
import { TOOL_TYPES } from '../tools/toolDefs.js';
import { TAPERS, HOLDER_TYPES } from '../tools/holderDefs.js';
import { describeAssembly } from '../tools/assembly.js';
import { openToolDialog, openHolderDialog, openAssemblyDialog, openLibraryImportDialog } from './toolDialogs.js';
import { confirmDialog } from './dialog.js';
import { fmt } from '../core/util.js';

export class ToolsPanel extends Panel {
  constructor(app) {
    super(app, [
      { id: 'assemblies', label: 'Tool table', icon: 'assembly', hint: 'What each T number loads', badge: () => app.library.assemblies.length, render: ToolsPanel.prototype.renderAssemblies },
      { id: 'tools', label: 'Cutters', icon: 'cutter', badge: () => app.library.tools.length, render: ToolsPanel.prototype.renderTools },
      { id: 'holders', label: 'Holders', icon: 'holder', badge: () => app.library.holders.length, render: ToolsPanel.prototype.renderHolders },
      { id: 'library', label: 'Library', icon: 'library', hint: 'Import, export and reset the whole library', render: ToolsPanel.prototype.renderLibrary },
    ]);
    this.selected = { assembly: null, tool: null, holder: null };
    this.render();
    app.library.onChange(() => this.render());
  }

  /** The page id doubles as the kind of thing the page lists. */
  get mode() { return this.page; }

  // ---- what acts on the selection -----------------------------------------

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
    this.app.setPage('tools', 'assemblies');
  }


  // ---- rendering ----------------------------------------------------------

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

  /** The Edit / Duplicate / Delete row every list on this panel carries. */
  selectionRow(extra = []) {
    const has = this.hasSelection();
    return actionRow([
      { label: 'Edit…', disabled: !has, variant: 'primary', onClick: () => this.editSelected() },
      { label: 'Duplicate', disabled: !has, onClick: () => this.duplicateSelected() },
      { label: 'Delete', disabled: !has, variant: 'warn', onClick: () => this.deleteSelected() },
      ...extra,
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

    const out = [section('Tool table', [
      addBar('Add assembly…', () => openAssemblyDialog(app, null), { hint: 'Pair a cutter with a holder and a stickout' }),
      el('div.hint', {}, 'An assembly pairs a cutter with a holder and a stickout. The T number is what an M06 tool change selects.'),
      list,
      this.selectionRow([
        { label: 'Export STL', disabled: !this.currentBuilt(), onClick: () => app.exportAssemblyStl(this.currentBuilt()) },
      ]),
    ])];

    const issues = lib.audit(app.state.machine);
    if (issues.length) {
      out.push(section(`Library check (${issues.length})`, [
        el('ul.issues', {}, issues.map((i) => el(`li.issue-${i.level}`, {}, i.text))),
      ]));
    }
    return out;
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
    return section('Cutters', [
      addBar('Add cutter…', () => openToolDialog(app, null), { hint: 'End mill, ball nose, drill, chamfer…' }),
      list,
      this.selectionRow(),
    ]);
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
    return section('Holders', [
      addBar('Add holder…', () => openHolderDialog(app, null), { hint: 'Shrink fit, collet chuck, end mill holder…' }),
      list,
      this.selectionRow(),
    ]);
  }

  renderLibrary() {
    const app = this.app;
    const lib = app.library;
    return section('Library', [
      el('div.hint', { html: `<b>${lib.assemblies.length}</b> assemblies · <b>${lib.tools.length}</b> cutters · <b>${lib.holders.length}</b> holders` }),
      checkbox('Keep the library in this browser', app.state.persistLibrary, (v) => app.setPersistLibrary(v)),
      el('div.hint', {}, 'Saved to local storage, so it survives a reload on this machine only. Export the JSON to move it somewhere else.'),
      actionRow([
        { label: 'Export JSON', onClick: () => download('mill-sim-library.json', JSON.stringify(lib.toJSON(), null, 2), 'application/json') },
        { label: 'Import library…', variant: 'primary', onClick: () => openLibraryImportDialog(app), hint: 'A Mill-Sim library, or one exported from Fusion 360' },
      ]),
      actionRow([
        {
          label: 'Put the built-in tools back',
          hint: 'Adds whichever of the shipped cutters, holders and assemblies are missing, and leaves yours alone',
          onClick: () => {
            const added = lib.mergeDefaults();
            app.refreshSlots();
            app.notify(added
              ? `Put ${added} built-in ${added === 1 ? 'item' : 'items'} back. Nothing of yours was touched.`
              : 'Every built-in tool, holder and assembly is already here.', 'ok');
          },
        },
      ]),
      actionRow([
        {
          label: 'Restore the built-in library',
          variant: 'warn',
          onClick: () => confirmDialog({
            title: 'Restore the built-in tools?',
            message: 'Your cutters, holders and assemblies will be replaced by the ones Mill-Sim ships with. This cannot be undone.',
            confirm: 'Restore',
            danger: true,
            onConfirm: () => {
              lib.loadDefaults();
              app.refreshSlots();
              app.notify('Library reset to the built-in tools.', 'ok');
            },
          }),
        },
      ]),
    ]);
  }
}
