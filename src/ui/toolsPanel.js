// The tool library, as a browser.
//
// Four pages: the tool table, the cutters and holders that feed it, and the
// library as a whole. Editing happens in a window, so this panel's job is to
// show what is in the library, what is wrong with it, and to act on whatever
// is selected — Edit, Duplicate, Delete and Export sit under the list they
// apply to rather than in the ribbon, where they would be a second copy of
// the same three buttons.

import { el, button, row, section, clear, download } from './dom.js';
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
    /** The row Edit opens: the last one clicked without a modifier. */
    this.selected = { assembly: null, tool: null, holder: null };
    /**
     * Everything ticked, for the things that can be done to a pile of them.
     *
     * A library arrives forty cutters at a time and is tidied the same
     * way, so Delete works on a selection rather than on one row. Plain
     * click picks one, Ctrl (or Cmd) adds and removes, Shift takes the
     * run between the last one and this.
     */
    this.marked = { assembly: new Set(), tool: new Set(), holder: new Set() };
    this.render();
    app.library.onChange(() => this.render());
  }

  /** The page id doubles as the kind of thing the page lists. */
  get mode() { return this.page; }

  // ---- what acts on the selection -----------------------------------------

  hasSelection() {
    return this.selectedIds().length > 0;
  }

  /** Which of the three lists this page is: the key both maps are keyed by. */
  get kind() {
    if (this.mode === 'assemblies') return 'assembly';
    if (this.mode === 'tools') return 'tool';
    return 'holder';
  }

  /** The library array this page lists. */
  get rows() {
    const lib = this.app.library;
    if (this.mode === 'assemblies') return lib.assemblies;
    if (this.mode === 'tools') return lib.tools;
    return lib.holders;
  }

  selectedId() {
    return this.selected[this.kind];
  }

  /**
   * Everything the buttons under the list act on, in the order it is shown.
   *
   * A row deleted elsewhere stays in the set until something asks, so the
   * answer is filtered against what is actually in the library rather than
   * trusted.
   */
  selectedIds() {
    const marked = this.marked[this.kind];
    const ids = this.rows.filter((x) => marked.has(x.id)).map((x) => x.id);
    if (ids.length) return ids;
    const one = this.selected[this.kind];
    return one && this.rows.some((x) => x.id === one) ? [one] : [];
  }

  /**
   * A click on a row, with whatever was held down.
   *
   * @param {string} id
   * @param {MouseEvent} [event]
   */
  choose(id, event) {
    const kind = this.kind;
    const marked = this.marked[kind];
    const anchor = this.selected[kind];

    if (event && (event.ctrlKey || event.metaKey)) {
      // Building a pile one at a time. The row clicked without a modifier
      // is in the pile too, or ticking a second row would silently drop it.
      if (!marked.size && anchor) marked.add(anchor);
      if (marked.has(id)) marked.delete(id);
      else marked.add(id);
    } else if (event && event.shiftKey && anchor) {
      const ids = this.rows.map((x) => x.id);
      const from = ids.indexOf(anchor);
      const to = ids.indexOf(id);
      if (from >= 0 && to >= 0) {
        marked.clear();
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) marked.add(ids[i]);
      }
    } else {
      marked.clear();
    }
    this.selected[kind] = id;
    this.render();
  }

  /** Tick every row on this page, or none of them. */
  markAll(on) {
    const marked = this.marked[this.kind];
    marked.clear();
    if (on) for (const x of this.rows) marked.add(x.id);
    this.render();
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
    const ids = this.selectedIds();
    if (!ids.length) return;
    const made = [];
    for (const id of ids) {
      let copy = null;
      if (this.mode === 'assemblies') {
        const a = lib.assembly(id);
        if (a) copy = lib.addAssembly({ ...a, id: undefined, name: `${a.name} copy` });
      } else if (this.mode === 'tools') {
        copy = lib.duplicateTool(id);
      } else {
        copy = lib.duplicateHolder(id);
      }
      if (copy) made.push(copy.id);
    }
    if (!made.length) return;
    // The copies become the selection: they are what the next thing done
    // is almost certainly meant for.
    const marked = this.marked[this.kind];
    marked.clear();
    if (made.length > 1) for (const id of made) marked.add(id);
    this.selected[this.kind] = made[made.length - 1];
    this.app.refreshSlots();
    if (made.length > 1) this.app.notify(`Duplicated ${made.length} ${this.noun(made.length)}.`, 'ok');
  }

  /** What this page's rows are called, singular or plural. */
  noun(n = 1) {
    const one = this.mode === 'assemblies' ? 'assembly' : this.mode === 'tools' ? 'cutter' : 'holder';
    if (n === 1) return one;
    return one === 'assembly' ? 'assemblies' : `${one}s`;
  }

  deleteSelected() {
    const lib = this.app.library;
    const ids = this.selectedIds();
    if (!ids.length) return;
    const names = ids.map((id) => {
      const item = this.mode === 'assemblies' ? lib.assembly(id) : this.mode === 'tools' ? lib.tool(id) : lib.holder(id);
      return item ? item.name : null;
    }).filter(Boolean);
    if (!names.length) return;

    // Name them when the list is short enough to read, and count them when
    // it is not: nobody checks forty names, but everybody checks one.
    const listed = names.length <= 6
      ? names.map((n) => `"${n}"`).join(', ')
      : `${names.slice(0, 5).map((n) => `"${n}"`).join(', ')} and ${names.length - 5} more`;

    confirmDialog({
      title: names.length === 1 ? `Delete this ${this.noun(1)}?` : `Delete ${names.length} ${this.noun(names.length)}?`,
      message: `${listed} will be removed from the library. Assemblies that use ${names.length === 1 ? 'it' : 'them'} will need a replacement.`,
      confirm: names.length === 1 ? 'Delete' : `Delete ${names.length}`,
      danger: true,
      onConfirm: () => {
        const removed = lib.removeMany(this.mode, ids);
        this.marked[this.kind].clear();
        this.selected[this.kind] = null;
        this.app.refreshSlots();
        if (removed > 1) this.app.notify(`Deleted ${removed} ${this.noun(removed)}.`, 'ok');
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

  listItem({ id, selected, marked, onOpen, swatch, title, sub, extra }) {
    const on = marked || selected;
    return el(`div.list-item${on ? '.selected' : ''}${marked ? '.marked' : ''}`, {
      onclick: (e) => this.choose(id, e),
      ondblclick: onOpen,
      title: 'Double-click to edit. Ctrl-click to pick out several, Shift-click for a run of them.',
    }, [
      // A tick is what makes picking several out of a long list something
      // you can see rather than something you have to remember.
      el(`div.list-tick${marked ? '.on' : ''}`, {
        title: marked ? 'Ticked — click to untick' : 'Tick this one',
        onclick: (e) => {
          e.stopPropagation();
          this.choose(id, { ctrlKey: true });
        },
      }),
      swatch ? el('div.swatch', { style: { background: swatch } }) : null,
      el('div.list-main', {}, [
        el('div.list-title', {}, title),
        el('div.list-sub', {}, sub),
      ]),
      el('div.list-actions', {}, [
        button('Edit', (e) => { e.stopPropagation(); this.choose(id, null); onOpen(); }),
        ...(extra || []),
      ]),
    ]);
  }

  /** The Edit / Duplicate / Delete row every list on this panel carries. */
  selectionRow(extra = []) {
    const ids = this.selectedIds();
    const n = ids.length;
    const total = this.rows.length;
    const many = n > 1;
    const allOn = total > 0 && this.marked[this.kind].size === total;
    return [
      actionRow([
        // Edit is the one thing that only ever means one row, so it opens
        // the row that was clicked rather than refusing to choose.
        { label: 'Edit…', disabled: !this.selectedId(), variant: 'primary', onClick: () => this.editSelected() },
        { label: many ? `Duplicate ${n}` : 'Duplicate', disabled: !n, onClick: () => this.duplicateSelected() },
        { label: many ? `Delete ${n}` : 'Delete', disabled: !n, variant: 'warn', onClick: () => this.deleteSelected() },
        ...extra,
      ]),
      total > 1 ? actionRow([
        { label: allOn ? 'Tick none' : 'Tick all', onClick: () => this.markAll(!allOn) },
      ]) : null,
      el('div.hint', {}, many
        ? `${n} of ${total} ticked. Delete and Duplicate act on all of them; Edit opens the last one clicked.`
        : 'Tick the boxes, Ctrl-click or Shift-click to pick out several, then delete them in one go.'),
    ];
  }

  renderAssemblies() {
    const app = this.app;
    const lib = app.library;
    const list = el('div.list');

    for (const a of lib.assemblies) {
      const built = lib.build(a.id, app.state.machine);
      list.appendChild(this.listItem({
        id: a.id,
        selected: this.selected.assembly === a.id,
        marked: this.marked.assembly.has(a.id),
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
      ...this.selectionRow([
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
        id: t.id,
        selected: this.selected.tool === t.id,
        marked: this.marked.tool.has(t.id),
        onOpen: () => openToolDialog(app, t.id),
        swatch: t.color || '#c8ccd4',
        title: t.name,
        sub: `${TOOL_TYPES[t.type] ? TOOL_TYPES[t.type].label : t.type} · Ø${fmt(t.diameter, 2)} · ${t.fluteCount}F`,
      }));
    }
    return section('Cutters', [
      addBar('Add cutter…', () => openToolDialog(app, null), { hint: 'End mill, ball nose, drill, chamfer…' }),
      list,
      ...this.selectionRow(),
    ]);
  }

  renderHolders() {
    const app = this.app;
    const list = el('div.list');
    for (const h of app.library.holders) {
      list.appendChild(this.listItem({
        id: h.id,
        selected: this.selected.holder === h.id,
        marked: this.marked.holder.has(h.id),
        onOpen: () => openHolderDialog(app, h.id),
        swatch: h.color || '#8d97a8',
        title: h.name,
        sub: `${HOLDER_TYPES[h.type] || h.type} · ${(TAPERS[h.taper] || TAPERS.none).label}`,
      }));
    }
    return section('Holders', [
      addBar('Add holder…', () => openHolderDialog(app, null), { hint: 'Shrink fit, collet chuck, end mill holder…' }),
      list,
      ...this.selectionRow(),
    ]);
  }

  renderLibrary() {
    const app = this.app;
    const lib = app.library;
    return section('Library', [
      el('div.hint', { html: `<b>${lib.assemblies.length}</b> assemblies · <b>${lib.tools.length}</b> cutters · <b>${lib.holders.length}</b> holders` }),
      el('div.hint', {}, 'The library is kept on this machine and comes back when you reopen Mill-Sim. Export the JSON to move it somewhere else.'),
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
