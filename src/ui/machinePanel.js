// Machine: the kinematic chain, drawn as the tree it is.
//
// A slaved axis lives inside its master's folder, so the indentation *is*
// the chain: what moves what, read top to bottom. Selecting a node opens
// its properties here, where they can be changed. Adding an axis or a
// casting starts from nothing, so each gets a window.

import { el, field, select, checkbox, button, row, section, clear } from './dom.js';
import { Panel, addBar, actionRow } from './panel.js';
import { icon } from './icons.js';
import { openAxisDialog, openBodyDialog, openNewMachineDialog } from './machineDialogs.js';
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
      { id: 'assembly', label: 'Assembly', icon: 'import', hint: 'Import bodies and assemble the machine from them', badge: () => app.machineParts.parts.length || null, render: MachinePanel.prototype.assemblyPage },
      { id: 'controller', label: 'Controller', icon: 'report', hint: 'Which G-code this machine reads', render: MachinePanel.prototype.controllerPage },
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

  /**
   * Publish a change to the chain.
   *
   * Every edit on this page goes through here: the chain is re-ordered, the
   * rig and the simulator are handed the new one, and the panel is redrawn
   * so the tree shows what was just done rather than what was there before.
   */
  commit() {
    this.kin.rebuild();
    this.app.applyKinematics();
    this.render();
  }

  // ---- pages -------------------------------------------------------------

  layoutPage() {
    return [this.presetSection()];
  }

  axesPage() {
    const sel = this.selected;
    return [this.treeSection(), sel ? this.axisSection(sel) : null];
  }

  assemblyPage() {
    const body = this.selectedBody;
    return [this.partsSection(), body ? this.bodySection(body) : null];
  }

  controllerPage() {
    return [this.controllerSection()];
  }

  /** The body the Assembly page is acting on. */
  get selectedBody() {
    return (this.bodyId && this.app.machineParts.byId(this.bodyId)) || null;
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

    // A machine loaded from a file is not one of the presets, so the list
    // says so rather than naming whichever preset happened to be showing
    // when it was loaded.
    const custom = app.state.machine.preset === 'custom';
    const options = Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label }));
    if (custom) options.unshift({ value: 'custom', label: `${k.name} (loaded)` });

    return section('Machine', [
      select(custom ? 'Machine' : 'Start from', options,
        app.state.machine.preset, (v) => {
          if (v === 'custom') return;
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
      el('div.hint', {}, 'Presets are starting points. Change a pivot, flip a sign, or start from a bare base and build the chain yourself — the simulation follows whatever the chain says.'),
      actionRow([
        { label: 'New machine…', variant: 'primary', onClick: () => openNewMachineDialog(app), hint: 'Start from a bare base and build the chain yourself' },
      ]),
      actionRow([
        { label: 'Save machine…', onClick: () => app.exportKinematics(), hint: 'The chain, the controller and where every body sits' },
        { label: 'Load machine…', onClick: () => app.importKinematics(), hint: 'Read a machine saved earlier' },
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
        el('span.axis-end', {}, [
          node.id === k.toolNode ? el('span', { title: 'The tool hangs here' }, icon('cutter')) : null,
          node.id === k.workNode ? el('span', { title: 'The part is clamped here' }, icon('cube')) : null,
        ]),
      ]);
      tree.appendChild(item);
      for (const child of children) renderNode(child, depth + 1);
    };

    for (const root of k.roots()) renderNode(root, 0);
    if (!k.nodes.length) tree.appendChild(el('div.hint', {}, 'This machine has no axes.'));

    const sel = this.selected;
    // The two ends of the chain are what make it a machine rather than a
    // pile of joints, so an unfinished one says so plainly instead of
    // quietly simulating a tool bolted to the part.
    const ends = k.toolNode === k.workNode
      ? el('div.inline-warning', {}, `The tool and the part are both on ${k.byId.get(k.toolNode)?.name || 'the base'}. Build the chain down to a spindle and a table, then select each end and press the button under the tree.`)
      : null;

    return section('Axes', [
      addBar('Add axis…', () => openAxisDialog(this.app, this), { hint: 'Put a new joint into the chain' }),
      tree,
      el('div.hint', {}, 'Indentation is the chain: everything nested under an axis rides on it. The cutter marks where the tool hangs, the block where the part is clamped.'),
      ends,
      actionRow([
        { label: 'Tool hangs here', disabled: !sel || sel.id === k.toolNode, onClick: () => { k.toolNode = sel.id; this.commit(); }, hint: 'The spindle nose is on this node' },
        { label: 'Part clamps here', disabled: !sel || sel.id === k.workNode, onClick: () => { k.workNode = sel.id; this.commit(); }, hint: 'The fixture and the stock sit on this node' },
        { label: 'Delete axis', disabled: !sel, variant: 'warn', onClick: () => this.deleteAxis() },
      ]),
    ]);
  }

  /**
   * @param {object} [spec] what the Add window collected: a letter, a kind,
   *   what it is mounted on and what it takes over carrying. Omitted, a
   *   sensible joint is made under whatever is selected.
   */
  addAxis(spec = null) {
    const k = this.kin;
    const s = spec || {};
    const parent = (s.parent && k.byId.get(s.parent)) || this.selected || k.byId.get(k.toolNode) || k.roots()[0] || null;
    const used = new Set(k.axes().map((n) => n.letter));
    const letter = 'letter' in s ? s.letter : (['A', 'B', 'C', 'X', 'Y', 'Z'].find((L) => !used.has(L)) || null);
    const node = makeAxis({
      ...s,
      letter,
      name: s.name || (letter ? `${letter} axis` : 'New carrier'),
      parent: parent ? parent.id : null,
      limits: s.limits || { min: -360, max: 360 },
    });
    k.nodes.push(node);
    // What the new axis carries is stated, not guessed. Naming the spindle
    // here is what "an A axis above the spindle" means: the spindle stops
    // hanging off the base and hangs off A instead, so A swings it.
    for (const id of [].concat(s.carries || [])) {
      const child = k.byId.get(id);
      if (child && child !== node && child.parent === node.parent) child.parent = node.id;
    }
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

    const parentOptions = [{ value: '', label: 'nothing — this is a root' },
      ...k.nodes.filter((n) => n !== node && !k.pathTo(n.id).includes(node))
        .map((n) => ({ value: n.id, label: n.name }))];

    // The same two questions the Add window asks, so a wrong answer there
    // is corrected in the same words rather than by hunting through the
    // tree for the child that needs re-parenting.
    const kids = k.children(node.id);
    const adoptable = k.children(node.parent).filter((n) => n !== node);

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
      select('Mounted on', parentOptions, node.parent || '', (v) => set({ parent: v || null }),
        { title: 'What this joint is bolted to, so what carries it around' }),
    ];

    if (kids.length <= 1) {
      body.push(select('Carries', [
        { value: '', label: 'nothing yet — the end of this branch' },
        ...kids.map((n) => ({ value: n.id, label: n.name })),
        ...adoptable.map((n) => ({ value: n.id, label: n.name })),
      ], kids.length === 1 ? kids[0].id : '', (v) => {
        for (const child of kids) child.parent = node.parent;
        const chosen = v ? k.byId.get(v) : null;
        if (chosen) chosen.parent = node.id;
        this.commit();
      }, { title: 'What rides on this joint, so what it moves' }));
    } else {
      body.push(el('div.hint', {}, `Carries ${kids.map((n) => n.name).join(', ')}. To take one off, open it and change what it is mounted on.`));
    }

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

  // ---- assembly ----------------------------------------------------------

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
    const kin = this.kin;

    const list = el('div.list');
    if (!app.machineParts.parts.length) {
      list.appendChild(el('div.empty', {}, [
        el('div.empty-title', {}, 'Nothing imported yet'),
        el('div.hint', {}, 'Bring in the machine as STL bodies — a base, a saddle, a table, a head — then put each one on the axis that carries it. A body on the base never moves; a body on X rides the X slide. Until then each axis draws a plain proxy.'),
      ]));
    }
    for (const part of app.machineParts.parts) {
      const node = part.nodeId ? kin.byId.get(part.nodeId) : null;
      const fixed = node && kin.branchOf(node.id) === 'base' && node.kind === 'carrier';
      const placed = part.position.some((v) => Math.abs(v) > 1e-6) || part.rotation.some((v) => Math.abs(v) > 1e-6);
      list.appendChild(el(`div.list-item${this.bodyId === part.id ? '.selected' : ''}`, {
        onclick: () => { this.bodyId = part.id; this.render(); },
      }, [
        el(`div.swatch${node ? '.on' : ''}`, { style: { background: node ? (fixed ? '#7b8494' : '#0a7cff') : '#d0d4db' } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, part.name),
          el('div.list-sub', {}, [
            node ? (fixed ? `${node.name} · fixed` : node.name) : 'not assembled',
            ` · ${part.size.map((v) => fmt(v, 0)).join(' × ')} mm`,
            placed ? ' · moved' : '',
          ].join('')),
        ]),
        el('div.list-actions', {}, [
          button('✕', (e) => {
            e.stopPropagation();
            if (this.bodyId === part.id) this.bodyId = null;
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
    }, 'or drop STL bodies here');

    const waiting = app.machineParts.unassigned().length;
    return section(`Bodies (${app.machineParts.parts.length})`, [
      addBar('Add body…', () => openBodyDialog(this.app, this), { hint: 'Import an STL and say which axis carries it' }),
      drop,
      waiting ? el('div.hint', {}, `${waiting} ${waiting === 1 ? 'body is' : 'bodies are'} not on an axis yet, so ${waiting === 1 ? 'it is' : 'they are'} not drawn.`) : null,
      list,
      actionRow([
        { label: 'Remove all', disabled: !app.machineParts.parts.length, variant: 'warn', onClick: () => { app.machineParts.clear(); this.bodyId = null; app.applyMachineParts(); this.render(); } },
      ]),
    ]);
  }

  /**
   * One body: which axis carries it, and where it sits on that axis.
   *
   * Assembling is mostly mating — click a point on the body, click where
   * that point belongs — so that is the primary action. The numbers are
   * there for when you know them.
   */
  bodySection(part) {
    const app = this.app;
    const kin = this.kin;
    const node = part.nodeId ? kin.byId.get(part.nodeId) : null;

    const carriers = kin.order.map((n) => {
      const branch = kin.branchOf(n.id);
      const fixed = n.kind === 'carrier' && branch === 'base';
      return {
        value: n.id,
        label: `${n.name}${fixed ? ' — fixed' : n.letter ? ` — moves with ${n.letter}` : ''}`,
      };
    });

    const setPos = (i, v) => {
      const p = [...part.position];
      p[i] = Number(v) || 0;
      app.machineParts.place(part, { position: p });
      app.applyMachineParts();
    };
    const setRot = (i, v) => {
      const r = [...part.rotation];
      r[i] = Number(v) || 0;
      app.machineParts.place(part, { rotation: r });
      app.applyMachineParts();
    };

    return section(part.name, [
      select('Mounted on', [{ value: '', label: 'not assembled' }, ...carriers], part.nodeId || '', (v) => {
        app.machineParts.assign(part, v || null);
        app.applyMachineParts();
        this.render();
      }),
      el('div.hint', {}, node
        ? (kin.branchOf(node.id) === 'base' && node.kind === 'carrier'
          ? 'On the base: this body never moves.'
          : `Rides ${node.name}, so it moves with everything that carries it.`)
        : 'Not on an axis yet, so it is not drawn.'),
      addBar('Mate by two points…', () => app.mateBodyByPoints(part), {
        disabled: !part.nodeId,
        hint: 'Click a point on this body, then the point it should sit on',
      }),
      el('div.hint', {}, 'The body moves so the two points coincide. Joints snap as targets, so a casting can be dropped straight onto its own pivot.'),
      row(TRAVEL_AXES.map((a, i) => field(a, Number(part.position[i].toFixed(3)), {
        step: 1, unit: 'mm', onChange: (v) => setPos(i, v),
      }))),
      row(['RX', 'RY', 'RZ'].map((a, i) => field(a, Number(part.rotation[i].toFixed(2)), {
        step: 15, unit: '°', onChange: (v) => setRot(i, v),
      }))),
      actionRow([
        { label: 'Back to the joint', onClick: () => { app.machineParts.place(part, { position: [0, 0, 0], rotation: [0, 0, 0] }); app.applyMachineParts(); this.render(); }, hint: 'Put it back on its axis origin' },
        { label: 'Deselect', onClick: () => { this.bodyId = null; this.render(); } },
      ]),
    ]);
  }

  // ---- controller --------------------------------------------------------

  /**
   * What the control makes of a program before the program says anything.
   *
   * Controls do not agree on their power-up state, and a program posted for
   * one machine read by another is the classic way to crash: the second one
   * starts in inches, or reads I/J as absolute, or comes up in G18. So these
   * belong to the machine, and changing one re-reads the program.
   */
  controllerSection() {
    const app = this.app;
    const c = app.state.machine.controller;
    const set = (patch) => {
      app.setMachine({ controller: { ...c, ...patch } });
      this.render();
    };

    return section('Controller', [
      select('Flavour', [
        { value: 'fanuc', label: 'Fanuc' },
        { value: 'haas', label: 'Haas' },
        { value: 'fidia', label: 'Fidia' },
        { value: 'generic', label: 'Generic ISO' },
      ], c.flavour, (v) => set({ flavour: v })),
      el('div.hint', {}, 'The five-axis codes read are the Fanuc ones — G68.2, G69, G53.1, G43.4 and G43.5. The flavour is recorded with the machine; it does not yet change how they are interpreted.'),

      el('div.dialog-section-label', {}, 'Power-up state'),
      row([
        select('Units', [{ value: 'mm', label: 'Millimetres (G21)' }, { value: 'in', label: 'Inches (G20)' }],
          c.metric ? 'mm' : 'in', (v) => set({ metric: v === 'mm' })),
        select('Plane', [
          { value: '17', label: 'G17 — XY' },
          { value: '18', label: 'G18 — ZX' },
          { value: '19', label: 'G19 — YZ' },
        ], String(c.plane), (v) => set({ plane: Number(v) })),
      ]),
      row([
        select('Distance', [{ value: 'abs', label: 'Absolute (G90)' }, { value: 'inc', label: 'Incremental (G91)' }],
          c.absolute ? 'abs' : 'inc', (v) => set({ absolute: v === 'abs' })),
        select('Arc centres', [
          { value: 'inc', label: 'Incremental I/J/K (G91.1)' },
          { value: 'abs', label: 'Absolute I/J/K (G90.1)' },
        ], c.arcCentreAbsolute ? 'abs' : 'inc', (v) => set({ arcCentreAbsolute: v === 'abs' })),
      ]),
      row([
        select('Feed mode', [
          { value: '94', label: 'Per minute (G94)' },
          { value: '95', label: 'Per revolution (G95)' },
        ], String(c.feedMode), (v) => set({ feedMode: Number(v) })),
      ]),
      el('div.hint', {}, 'A program that names these itself overrides them on the block it appears in. These are what applies until it does.'),
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
