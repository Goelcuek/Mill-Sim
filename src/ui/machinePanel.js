// Machine: the kinematic chain, drawn as the tree it is.
//
// A slaved axis lives inside its master's folder, so the indentation *is*
// the chain: what moves what, read top to bottom. Selecting a node opens
// its properties here, where they can be changed. Adding an axis or a
// casting starts from nothing, so each gets a window.

import { el, field, select, checkbox, button, row, section, clear } from './dom.js';
import { Panel, addBar, actionRow } from './panel.js';
import { icon } from './icons.js';
import { openAxisDialog, openCastingDialog } from './machineDialogs.js';
import { AXIS_LETTERS, makeAxis } from '../machine/kinematics.js';
import { PRESETS } from '../machine/presets.js';
import { fmt } from '../core/util.js';

const KINDS = [
  { value: 'linear', label: 'Linear' },
  { value: 'rotary', label: 'Rotary' },
  { value: 'carrier', label: 'Carrier (no motion)' },
];

const BRANCH_LABEL = {
  tool: 'spindle side',
  work: 'table side',
  base: 'shared',
  other: 'detached',
};

const DIRECTIONS = [
  { value: '1,0,0', label: '+X' },
  { value: '-1,0,0', label: '−X' },
  { value: '0,1,0', label: '+Y' },
  { value: '0,-1,0', label: '−Y' },
  { value: '0,0,1', label: '+Z' },
  { value: '0,0,-1', label: '−Z' },
];

const TRAVEL_AXES = ['X', 'Y', 'Z'];

const dirKey = (v) => `${v[0]},${v[1]},${v[2]}`;

export class MachinePanel extends Panel {
  constructor(app) {
    super(app, [
      { id: 'layout', label: 'Layout', icon: 'machine', hint: 'Which machine this is, and how it is drawn', render: MachinePanel.prototype.layoutPage },
      { id: 'axes', label: 'Axes', icon: 'axes', hint: 'The kinematic chain and what each joint does', render: MachinePanel.prototype.axesPage },
      { id: 'castings', label: 'Castings', icon: 'import', hint: 'Your own STLs, hung on the axes that carry them', badge: () => app.machineParts.parts.length || null, render: MachinePanel.prototype.castingsPage },
      { id: 'limits', label: 'Travels', icon: 'gauge', hint: 'Travel limits, the table surface and rapid rate', render: MachinePanel.prototype.limitsPage },
    ]);
    this.selectedId = null;
    this.render();
  }

  get kin() { return this.app.machineView.kinematics; }

  get selected() {
    const k = this.kin;
    return (this.selectedId && k.byId.get(this.selectedId)) || null;
  }

  // ---- pages -------------------------------------------------------------

  layoutPage() {
    return [this.presetSection()];
  }

  axesPage() {
    const sel = this.selected;
    return [this.treeSection(), sel ? this.axisSection(sel) : null];
  }

  castingsPage() {
    return [this.partsSection()];
  }

  limitsPage() {
    return [this.travelSection()];
  }

  // ---- preset ------------------------------------------------------------

  presetSection() {
    const app = this.app;
    const k = this.kin;
    const rot = k.rotaries();

    const info = el('div.hint', {}, [
      el('b', {}, k.configuration),
      ` · ${k.axes().length} axes`,
      rot.length ? ` · rotaries ${rot.map((n) => n.letter).join(' and ')}` : ' · no rotaries',
    ]);

    return section('Machine', [
      select('Start from', Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })),
        app.state.machine.preset, (v) => {
          app.setMachine({ preset: v });
          this.selectedId = null;
          this.render();
        }),
      info,
      row([
        select('Draw', [{ value: 'part', label: 'Part only' }, { value: 'machine', label: 'Full machine' }],
          app.state.machine.mode, (v) => { app.setMachine({ mode: v }); this.render(); },
          { title: 'In full-machine view every casting moves the way the real machine does.' }),
      ]),
      el('div.hint', {}, 'Presets are starting points. Change a pivot, flip a sign or hang your own castings on the axes and the simulation follows.'),
      actionRow([
        { label: 'Save machine…', onClick: () => app.exportKinematics(), hint: 'Write the chain out as JSON' },
        { label: 'Load machine…', onClick: () => app.importKinematics(), hint: 'Read a chain saved earlier' },
      ]),
    ]);
  }

  // ---- the tree ----------------------------------------------------------

  treeSection() {
    const k = this.kin;
    const tree = el('div.axis-tree');

    const renderNode = (node, depth) => {
      const branch = k.branchOf(node.id);
      const children = k.children(node.id);
      const master = node.slaveTo ? k.byId.get(node.slaveTo) : null;
      const part = this.app.machineParts.forNode(node.id)[0];

      const badge = node.letter
        ? el(`span.axis-badge.${node.kind}`, {}, node.letter)
        : el('span.axis-badge.carrier', {}, '•');

      const sub = [];
      sub.push(node.kind === 'carrier' ? 'carrier' : `${node.kind} · ${dirLabel(node.axis)}`);
      sub.push(BRANCH_LABEL[branch] || branch);
      if (master) sub.push(`slaved to ${master.letter || master.name}${node.slaveRatio !== 1 ? ` × ${fmt(node.slaveRatio, 3)}` : ''}`);
      if (part) sub.push(part.name);

      const item = el(`div.axis-node${this.selectedId === node.id ? '.selected' : ''}`, {
        style: { paddingLeft: `${8 + depth * 16}px` },
        onclick: () => { this.selectedId = node.id; this.render(); },
      }, [
        el('span.axis-twist', {}, children.length ? '▾' : ''),
        badge,
        el('div.list-main', {}, [
          el('div.list-title', {}, node.name),
          el('div.list-sub', {}, sub.join(' · ')),
        ]),
        node.id === k.toolNode ? el('span.axis-end', { title: 'The tool hangs here' }, icon('cutter'))
          : node.id === k.workNode ? el('span.axis-end', { title: 'The part is clamped here' }, icon('cube'))
            : el('span'),
      ]);
      tree.appendChild(item);
      for (const child of children) renderNode(child, depth + 1);
    };

    for (const root of k.roots()) renderNode(root, 0);
    if (!k.nodes.length) tree.appendChild(el('div.hint', {}, 'This machine has no axes.'));

    const sel = this.selected;
    return section('Axes', [
      addBar('Add axis…', () => openAxisDialog(this.app, this), { hint: 'Insert a joint into the chain' }),
      tree,
      el('div.hint', {}, 'Indentation is the chain: everything nested under an axis is carried by it.'),
      actionRow([
        { label: 'Tool hangs here', disabled: !sel || sel.id === k.toolNode, onClick: () => { k.toolNode = sel.id; this.commit(); } },
        { label: 'Part clamps here', disabled: !sel || sel.id === k.workNode, onClick: () => { k.workNode = sel.id; this.commit(); } },
        { label: 'Delete axis', disabled: !sel, variant: 'warn', onClick: () => this.deleteAxis() },
      ]),
    ]);
  }

  /**
   * @param {object} [spec] what the Add window collected; omitted, a
   *   sensible new joint is made under whatever is selected.
   */
  addAxis(spec = null) {
    const k = this.kin;
    const parent = (spec && spec.parent && k.byId.get(spec.parent)) || this.selected || k.byId.get(k.toolNode);
    const used = new Set(k.axes().map((n) => n.letter));
    const letter = (spec && spec.letter) || ['A', 'B', 'C', 'X', 'Y', 'Z'].find((L) => !used.has(L)) || null;
    const node = makeAxis({
      ...(spec || {}),
      letter,
      name: (spec && spec.name) || (letter ? `${letter} axis` : 'New carrier'),
      parent: parent ? parent.id : null,
      limits: (spec && spec.limits) || { min: -360, max: 360 },
    });
    // Where the parent carries exactly one thing, the new axis goes between
    // them — that is what "a W axis between the ram and the spindle" means,
    // and it is the usual reason to add one. Where the parent forks, as the
    // base does between the head and the table, there is no unambiguous
    // link to insert into, so the new axis is simply carried alongside.
    const siblings = k.children(node.parent);
    if (siblings.length === 1) siblings[0].parent = node.id;
    k.nodes.push(node);
    this.selectedId = node.id;
    this.commit();
  }

  deleteAxis() {
    const k = this.kin;
    const node = this.selected;
    if (!node) return;
    if (node.id === k.toolNode || node.id === k.workNode) {
      this.app.notify('That node is one end of the chain — the tool or the part hangs on it. Reassign it first.', 'error');
      return;
    }
    for (const child of k.children(node.id)) child.parent = node.parent;
    for (const other of k.nodes) if (other.slaveTo === node.id) other.slaveTo = null;
    k.nodes = k.nodes.filter((n) => n !== node);
    this.app.machineParts.forNode(node.id).forEach((p) => { p.nodeId = null; });
    this.selectedId = null;
    this.commit();
  }

  // ---- one axis ----------------------------------------------------------

  axisSection(node) {
    const k = this.kin;
    const app = this.app;
    const set = (patch) => { Object.assign(node, patch); this.commit(); };

    const letterOptions = [{ value: '', label: 'none (carrier)' },
      ...Object.keys(AXIS_LETTERS).map((L) => ({ value: L, label: L }))];

    const parentOptions = [{ value: '', label: 'base (nothing)' },
      ...k.nodes.filter((n) => n !== node && !k.pathTo(n.id).includes(node))
        .map((n) => ({ value: n.id, label: n.name }))];

    const masterOptions = [{ value: '', label: 'not slaved' },
      ...k.axes().filter((n) => n !== node).map((n) => ({ value: n.id, label: `${n.letter} — ${n.name}` }))];

    const part = app.machineParts.forNode(node.id)[0];
    const partOptions = [{ value: '', label: 'proxy geometry' },
      ...app.machineParts.parts.map((p) => ({ value: p.id, label: p.name }))];

    const body = [
      field('Name', node.name, { type: 'text', onChange: (v) => set({ name: v || 'Axis' }) }),
      row([
        select('Letter', letterOptions, node.letter || '', (v) => {
          const spec = AXIS_LETTERS[v];
          set({ letter: v || null, kind: spec ? spec.kind : 'carrier', axis: spec ? spec.axis.slice() : node.axis });
        }),
        select('Kind', KINDS, node.kind, (v) => set({ kind: v })),
      ]),
      select('Carried by', parentOptions, node.parent || '', (v) => set({ parent: v || null })),
    ];

    if (node.kind !== 'carrier') {
      body.push(row([
        select('Direction', DIRECTIONS, dirKey(node.axis), (v) => set({ axis: v.split(',').map(Number) })),
        checkbox('Reverse', node.invert, (v) => set({ invert: v })),
      ]));
      body.push(row([
        field('Min', node.limits.min, { type: 'number', onChange: (v) => set({ limits: { ...node.limits, min: Number(v) } }) }),
        field('Max', node.limits.max, { type: 'number', onChange: (v) => set({ limits: { ...node.limits, max: Number(v) } }) }),
      ]));
      body.push(row([
        select('Slaved to', masterOptions, node.slaveTo || '', (v) => {
          // Slaving an axis also moves it into its master's folder, unless
          // it already rides on it further down the chain. That keeps one
          // meaning for the indentation: what carries what.
          const patch = { slaveTo: v || null };
          if (v && !k.pathTo(node.id).some((n) => n.id === v)) patch.parent = v;
          set(patch);
        }),
        field('Ratio', node.slaveRatio, { type: 'number', step: 0.001, onChange: (v) => set({ slaveRatio: Number(v) || 1 }) }),
      ]));
      if (node.slaveTo) {
        const master = k.byId.get(node.slaveTo);
        body.push(el('div.hint', {}, `This axis ignores its own word and follows ${master ? master.name : 'its master'}${node.slaveRatio !== 1 ? ` at ${fmt(node.slaveRatio, 3)}×` : ''}, which is why it sits in that folder.`));
      }
    }

    body.push(row([
      field('Pivot X', node.origin[0], { type: 'number', onChange: (v) => set({ origin: [Number(v), node.origin[1], node.origin[2]] }) }),
      field('Pivot Y', node.origin[1], { type: 'number', onChange: (v) => set({ origin: [node.origin[0], Number(v), node.origin[2]] }) }),
      field('Pivot Z', node.origin[2], { type: 'number', onChange: (v) => set({ origin: [node.origin[0], node.origin[1], Number(v)] }) }),
    ]));
    body.push(el('div.hint', {}, 'The pivot is where this joint sits in its parent, so for a rotary it is the centre of rotation.'));

    body.push(select('Casting', partOptions, part ? part.id : '', (v) => {
      const chosen = v ? app.machineParts.byId(v) : null;
      if (part && part !== chosen) app.machineParts.assign(part, null);
      if (chosen) app.machineParts.assign(chosen, node.id);
      app.applyMachineParts();
      this.render();
    }));

    body.push(row([
      button('Tool hangs here', () => { k.toolNode = node.id; this.commit(); }, { disabled: k.toolNode === node.id }),
      button('Part clamps here', () => { k.workNode = node.id; this.commit(); }, { disabled: k.workNode === node.id }),
    ]));

    return section(`${node.letter ? `${node.letter} — ` : ''}${node.name}`, body);
  }

  // ---- imported castings -------------------------------------------------

  /**
   * @param {File[]} files
   * @param {{units?:string, origin?:string, nodeId?:string}} [opts]
   *   What the Add window collected; a drop onto the page falls back to the
   *   selected axis, which is the one the user is looking at.
   */
  async importFiles(files, opts = {}) {
    const app = this.app;
    const target = opts.nodeId || (this.selected && this.selected.id) || null;
    for (const file of files || []) {
      try {
        const part = await app.machineParts.addFromFile(file, { units: opts.units || 'mm', origin: opts.origin || 'as-is' });
        if (target) app.machineParts.assign(part, target);
        app.notify(`Imported ${part.name} — ${part.triangles.toLocaleString()} triangles.`, 'ok');
      } catch (err) {
        app.notify(err.message, 'error');
      }
    }
    app.applyMachineParts();
    this.render();
  }

  partsSection() {
    const app = this.app;

    const list = el('div.list');
    if (!app.machineParts.parts.length) {
      list.appendChild(el('div.empty', {}, [
        el('div.empty-title', {}, 'No castings imported'),
        el('div.hint', {}, 'Until one is, each axis draws a plain proxy that says where it is and which way it moves. Export each casting about its own joint and leave the origin as exported; that way the pivot numbers stay at zero.'),
      ]));
    }
    for (const part of app.machineParts.parts) {
      const node = part.nodeId ? this.kin.byId.get(part.nodeId) : null;
      list.appendChild(el(`div.list-item${node && node.id === this.selectedId ? '.selected' : ''}`, {
        onclick: () => { if (node) { this.selectedId = node.id; this.setPage('axes'); } },
      }, [
        el('div.list-main', {}, [
          el('div.list-title', {}, part.name),
          el('div.list-sub', {}, `${node ? node.name : 'not on an axis'} · ${part.triangles.toLocaleString()} tris · ${part.size.map((v) => fmt(v, 0)).join(' × ')} mm`),
        ]),
        el('div.list-actions', {}, [
          button('✕', (e) => {
            e.stopPropagation();
            app.machineParts.remove(part);
            app.applyMachineParts();
            this.render();
          }, { title: 'Remove', variant: 'warn' }),
        ]),
      ]));
    }

    // Dropping a file is the same act as pressing Add, so it stays here.
    const drop = el('div.dropzone', {
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        this.importFiles([...e.dataTransfer.files].filter((f) => /\.stl$/i.test(f.name)));
      },
    }, 'or drop STL castings here');

    return section('Castings', [
      addBar('Add casting…', () => openCastingDialog(this.app, this), { hint: 'Import an STL and hang it on an axis' }),
      drop,
      list,
      actionRow([
        { label: 'Remove all', disabled: !app.machineParts.parts.length, variant: 'warn', onClick: () => { app.machineParts.clear(); app.applyMachineParts(); this.render(); } },
      ]),
    ]);
  }

  // ---- travels -----------------------------------------------------------

  /**
   * The machine's own envelope: what the crash model checks the assembly
   * against, as opposed to the joint travels on the Axes page, which are
   * what the chain itself can reach.
   */
  travelSection() {
    const app = this.app;
    const m = app.state.machine;

    return [
      section('Travel limits', [
        checkbox('Check travel limits', m.limits.enabled, (v) => {
          app.setMachine({ limits: { ...m.limits, enabled: v } });
          this.render();
        }),
        m.limits.enabled ? row(TRAVEL_AXES.map((a, i) => field(`${a} min`, m.limits.min[i], {
          step: 10, unit: 'mm',
          onChange: (v) => {
            const min = [...m.limits.min];
            min[i] = v || 0;
            app.setMachine({ limits: { ...m.limits, min } });
          },
        }))) : null,
        m.limits.enabled ? row(TRAVEL_AXES.map((a, i) => field(`${a} max`, m.limits.max[i], {
          step: 10, unit: 'mm',
          onChange: (v) => {
            const max = [...m.limits.max];
            max[i] = v || 0;
            app.setMachine({ limits: { ...m.limits, max } });
          },
        }))) : null,
        el('div.hint', {}, 'These are the tool tip\u2019s limits in work coordinates. Each rotary has its own travel on the Axes page, and both are checked. View \u203a Show draws the envelope in the viewport.'),
      ]),
      section('Table and spindle', [
        checkbox('Check the table surface', m.table.enabled, (v) => app.setMachine({ table: { ...m.table, enabled: v } })),
        row([
          field('Table top Z', m.tableZ, {
            step: 5, unit: 'mm',
            onChange: (v) => app.setMachine({ tableZ: v || 0, table: { ...m.table, z: v || 0 } }),
          }),
          field('Rapid rate', m.rapidRate, { min: 100, step: 500, unit: 'mm/min', onChange: (v) => app.setMachine({ rapidRate: Math.max(100, v || 1000) }) }),
        ]),
        row([
          field('Spindle nose \u00d8', m.spindleDiameter, { min: 0, step: 5, unit: 'mm', onChange: (v) => app.setMachine({ spindleDiameter: Math.max(0, v || 0) }) }),
          field('Nose length', m.spindleLength, { min: 0, step: 5, unit: 'mm', onChange: (v) => app.setMachine({ spindleLength: Math.max(0, v || 0) }) }),
        ]),
        el('div.hint', {}, 'The spindle nose is part of the crash model, so a plunge that buries the spindle is caught even when the holder clears.'),
      ]),
    ];
  }
}

function dirLabel(v) {
  const found = DIRECTIONS.find((d) => d.value === dirKey(v));
  return found ? found.label : `${fmt(v[0], 2)}, ${fmt(v[1], 2)}, ${fmt(v[2], 2)}`;
}
