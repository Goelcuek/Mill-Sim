// Machine: the kinematic chain, drawn as the tree it is.
//
// A slaved axis lives inside its master's folder, so the indentation *is*
// the chain: what moves what, read top to bottom. Selecting a node opens
// its properties here, where they can be changed. Adding an axis or a
// casting starts from nothing, so each gets a window.

import { el, field, select, checkbox, button, row, section, clear, pickFile, download } from './dom.js';
import { Panel, addBar, actionRow } from './panel.js';
import { icon } from './icons.js';
import { openAxisDialog, openBodyDialog, openNewMachineDialog } from './machineDialogs.js';
import { openMacroDialog, openParameterDialog, openSyntaxDialog } from './macroDialogs.js';
import { openNewSubprogramDialog, machineDialect, callLine } from './programDialogs.js';
import { PARAMETER_HINTS, macroReferences } from '../machine/macros.js';
import { DIALECTS, FLAVOUR_DIALECT, resolveDialect, describeDialect, sampleFor, controlName } from '../gcode/dialects.js';
import { programNumber } from '../gcode/lexer.js';
import { AXIS_LETTERS, makeAxis } from '../machine/kinematics.js';
import { PRESETS } from '../machine/presets.js';
import { MachineParts } from '../machine/parts.js';
import { fmt, uid } from '../core/util.js';
import { homeOf } from '../machine/config.js';
import * as units from '../core/units.js';

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
      { id: 'layout', label: 'Layout', icon: 'machine', hint: 'Which machine this is, what control it has, and how it is drawn', render: MachinePanel.prototype.layoutPage },
      { id: 'axes', label: 'Axes', icon: 'axes', hint: 'The kinematic chain and what each joint does', render: MachinePanel.prototype.axesPage },
      { id: 'assembly', label: 'Assembly', icon: 'import', hint: 'Import bodies and assemble the machine from them', badge: () => app.machineParts.parts.length || null, render: MachinePanel.prototype.assemblyPage },
      { id: 'macros', label: 'Macros', icon: 'code', hint: 'What this machine does at an M code, and the subprograms that live in it', badge: () => (app.state.machine.macros || []).filter((m) => m.enabled).length || null, render: MachinePanel.prototype.macrosPage },
      { id: 'limits', label: 'Travels', icon: 'gauge', hint: 'Machine zero, travel limits, the table surface and rapid rate', render: MachinePanel.prototype.limitsPage },
      { id: 'jog', label: 'Jog', icon: 'axes', hint: 'Wind the axes by hand and watch what the machine does', render: MachinePanel.prototype.jogPage },
    ]);
    this.selectedId = null;
    /** What the Macros page is acting on. */
    this.macroId = null;
    this.machineSubId = null;
    /** Whether moving a pivot leaves the castings hanging on it where they are. */
    this.holdAssembly = true;
    this.render();
  }

  /** Opening the Jog page takes the machine; leaving it gives it back. */
  setPage(id) {
    if (id === 'jog' && this.page !== 'jog') this.app.startJog();
    else if (id && id !== 'jog' && this.page === 'jog') this.app.stopJog();
    super.setPage(id);
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
    return [this.presetSection(), this.controlSection()];
  }

  axesPage() {
    const sel = this.selected;
    return [this.treeSection(), sel ? this.axisSection(sel) : null];
  }

  assemblyPage() {
    const body = this.selectedBody;
    return [this.partsSection(), body ? this.bodySection(body) : null];
  }

  macrosPage() {
    return [this.syntaxSection(), this.macroSection(), this.machineSubSection(), this.parameterSection()];
  }

  /** The body the Assembly page is acting on. */
  get selectedBody() {
    return (this.bodyId && this.app.machineParts.byId(this.bodyId)) || null;
  }

  limitsPage() {
    return [this.travelSection()];
  }

  /**
   * Moving the axes by hand.
   *
   * Every question about a machine that a drawing cannot answer — does the
   * head clear the clamp at this end of the table, where does the trunnion
   * put the part at 90° — is answered by winding the axes over and looking.
   * So the panel does what the pendant does, and nothing else: the picture
   * moves, the cut and the program stay exactly where they were.
   */
  jogPage() {
    const app = this.app;
    const k = this.kin;
    const axes = k.axes();
    const jog = app.jog || {};

    if (!axes.length) {
      return [section('Jog', [
        el('div.empty', {}, [
          el('div.empty-title', {}, 'No axes to move'),
          el('div.hint', {}, 'This machine is a base and nothing else. Add axes on the Axes page and they appear here.'),
        ]),
      ])];
    }

    // A linear axis is jogged over the machine's travels, which are the
    // numbers on the Travels page and are measured from home — so a slider
    // spans what the envelope allows, and follows it when either changes.
    // A rotary has no place in that envelope; its stops are its own. Both
    // come back from the same place the clamp uses, so the end of a slider
    // is exactly where the warning starts.

    // Updated as the sliders move: a redraw mid-drag would destroy the
    // slider under the pointer.
    const alarm = el('div.inline-warning');
    const showAlarm = () => {
      const bad = app.jogLimit();
      alarm.hidden = !bad;
      if (bad) {
        alarm.textContent = `Over travel: machine ${bad.axis}${units.len(bad.value, 2)} is past the `
          + `${bad.value > bad.limit ? 'maximum' : 'minimum'} of ${units.lenU(bad.limit, 2)}.`;
      }
    };

    const rows = [];
    for (const node of axes) {
      const rotary = node.kind === 'rotary';
      const range = app.jogRange(node.letter) || { min: rotary ? -360 : -1000, max: rotary ? 360 : 1000 };
      const lo = Math.max(range.min, rotary ? -100000 : -1e5);
      const hi = Math.min(range.max, rotary ? 100000 : 1e5);
      const value = Number(jog[node.letter] || 0);
      const step = rotary ? 1 : 1;

      // A rotary reads in degrees whatever lengths are shown in.
      const say = (v) => (rotary ? `${fmt(v, 3)} °` : units.lenU(v, 3));
      const readout = el('span.value', {}, say(value));
      const slider = el('input.jog-slider', {
        type: 'range',
        min: lo,
        max: hi,
        step: rotary ? 0.5 : 0.5,
        value,
        // Dragging redraws the machine on every frame and nothing else, so
        // it is cheap enough to follow the handle rather than the release.
        oninput: (e) => {
          const v = app.setJog(node.letter, parseFloat(e.target.value));
          // The handle goes back to where the axis actually got to. Left to
          // itself it stays under the pointer and reads a position the
          // machine never reached.
          if (String(v) !== e.target.value) e.target.value = String(v);
          readout.textContent = say(v);
          if (typed) typed.setValue(v);
          showAlarm();
        },
      });
      const nudge = (d) => {
        const v = app.setJog(node.letter, (Number(app.jog[node.letter]) || 0) + d);
        slider.value = String(v);
        readout.textContent = say(v);
        if (typed) typed.setValue(v);
        showAlarm();
      };
      const typed = field('', value, {
        step,
        unit: rotary ? '°' : 'mm',
        onChange: (v) => {
          const next = app.setJog(node.letter, v || 0);
          slider.value = String(next);
          readout.textContent = say(next);
          showAlarm();
        },
      });

      rows.push(el('div.jog-axis', {}, [
        el('div.jog-head', {}, [
          el(`span.axis-badge.${node.kind}`, {}, node.letter),
          el('span.jog-name', {}, node.name),
          readout,
        ]),
        slider,
        row([
          button('−10', () => nudge(-10)),
          button('−1', () => nudge(-1)),
          button('+1', () => nudge(1)),
          button('+10', () => nudge(10)),
          typed,
        ]),
      ]));
    }

    // A slide that the envelope governs has no stops of its own to be past
    // — reporting the Axes page numbers as well would be reporting a rule
    // that is no longer enforced.
    const owned = new Set(axes.filter((n) => !app.envelopeGoverned(n)).map((n) => n.letter));
    const over = (k.violations ? k.violations(jog) : []).filter((v) => owned.has(v.axis));
    showAlarm();
    return [section('Jog', [
      el('div.hint', {}, 'The axes as the pendant would move them. Nothing is cut and the run is not touched — press play, or leave this page, and the machine goes back to the program.'),
      ...rows,
      alarm,
      over && over.length
        ? el('div.inline-warning', {}, `Past the stops: ${over.map((v) => {
          const node = axes.find((n) => n.letter === v.axis);
          return `${v.axis} at ${node && node.kind === 'rotary' ? `${fmt(v.value, 2)}°` : units.lenU(v.value, 2)}`;
        }).join(', ')}.`)
        : null,
      actionRow([
        { label: 'All to zero', variant: 'primary', onClick: () => { for (const n of axes) app.setJog(n.letter, 0); this.render(); } },
        { label: 'Back to the program', onClick: () => { app.stopJog(); this.app.setPage('machine', 'axes'); } },
      ]),
      el('div.hint', {}, 'A linear slider spans the machine\u2019s travels \u2014 the envelope on the Travels page, measured from home and solved back onto the joint — and a rotary spans its own stops from the Axes page. Change either and the sliders follow. The end of a slider is exactly where the warning starts, because both ask the same question: the gauge line, measured from home, against the envelope.'),
    ])];
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
        checkbox('Stand-in castings', app.state.machine.proxies !== false, (v) => {
          app.setMachine({ proxies: v });
          this.render();
        }, { title: 'Draw a generic shape for an axis that has no body of its own' }),
      ]),
      // The colour the moving castings are painted. A shop with two of the
      // same machine in different colours is not an edge case.
      el('label.field', {}, [
        el('span.field-label', {}, 'Machine colour'),
        el('input', {
          type: 'color', value: app.machineView.accentColor(),
          oninput: (e) => { app.machineView.setAccent(e.target.value); app.viewer.invalidate(); },
          onchange: (e) => app.setMachine({ accent: e.target.value }),
        }),
      ]),
      el('div.hint', {}, app.state.machine.proxies === false
        ? emptyChainNote(k, app)
        : 'A stand-in is a generic slab, table or spindle drawn for an axis that has no body of its own, so a chain is visible before anything is imported. Turn it off while you are assembling real castings — then an axis you have not modelled shows nothing rather than something that is not your machine.'),
      el('div.hint', {}, 'Presets are starting points. Change a pivot, flip a sign, or start from a bare base and build the chain yourself — the simulation follows whatever the chain says.'),
      actionRow([
        { label: 'New machine…', variant: 'primary', onClick: () => openNewMachineDialog(app), hint: 'Start from a bare base and build the chain yourself' },
      ]),
      actionRow([
        { label: 'Save machine…', onClick: () => app.exportMachine(), hint: 'A zip holding the chain, the controller, the macros and every body as STL' },
        { label: 'Load machine…', onClick: () => app.importMachine(), hint: 'A machine folder saved earlier, or a bare chain as JSON' },
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
    const letter = 'letter' in s ? s.letter : (['A', 'B', 'C', 'X', 'Y', 'Z', 'U', 'V', 'W'].find((L) => !used.has(L)) || null);
    const node = makeAxis({
      ...s,
      letter,
      name: s.name || (letter ? `${letter} axis` : 'New carrier'),
      parent: parent ? parent.id : null,
    });
    // A rotary that is not told otherwise turns once each way. A slide has
    // no such natural number — its travel is the envelope on the Travels
    // page — so it starts unbounded rather than at a nonsense 360 mm.
    if (s.limits) node.limits = { ...s.limits };
    else if (node.kind === 'rotary') node.limits = { min: -360, max: 360 };
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
      // A slide along X, Y or Z is the thing the Travels page describes, so
      // its stops are read from there rather than typed again here. Two
      // places to say the same number is two numbers that disagree, and it
      // was the jog sliders that believed the wrong one.
      if (this.app.envelopeGoverned(node)) {
        const r = this.app.jogRange(node.letter);
        body.push(el('div.hint', {}, `Travel comes from the envelope on the Travels page${
          r && r.source === 'envelope' ? `: ${units.len(r.min, 1)} to ${units.lenU(r.max, 1)} on this joint` : ''
        }. Change it there and the jog sliders and the over-travel check follow.`));
      } else {
        body.push(row([
          field('Min', node.limits.min, { type: 'number', onChange: (v) => set({ limits: { ...node.limits, min: Number(v) } }) }),
          field('Max', node.limits.max, { type: 'number', onChange: (v) => set({ limits: { ...node.limits, max: Number(v) } }) }),
        ]));
      }
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

    // The pivot, and the two ways of getting it right. Typing it moves the
    // number; pointing at it is how anybody with the casting in front of
    // them would rather say where the middle of a bore is.
    const pivot = (i, v) => {
      const next = [...node.origin];
      next[i] = Number(v) || 0;
      app.setAxisPivot(node.id, next, this.holdAssembly);
    };
    const carried = app.machineParts.forNode(node.id).length + k.children(node.id).length;
    body.push(row([
      field('Pivot X', node.origin[0], { type: 'number', onChange: (v) => pivot(0, v) }),
      field('Pivot Y', node.origin[1], { type: 'number', onChange: (v) => pivot(1, v) }),
      field('Pivot Z', node.origin[2], { type: 'number', onChange: (v) => pivot(2, v) }),
    ]));
    body.push(actionRow([
      {
        label: 'Pick a point…',
        variant: 'primary',
        hint: 'Click the point this joint turns about',
        onClick: () => app.pickAxisPivot(node.id, { hold: this.holdAssembly }),
      },
      {
        label: 'Centre of a bore…',
        hint: 'Three clicks round a bore or a boss; its centre becomes the pivot',
        onClick: () => app.pickAxisPivot(node.id, { circle: true, hold: this.holdAssembly }),
      },
    ]));
    body.push(checkbox('Keep the assembly still', this.holdAssembly, (v) => {
      this.holdAssembly = v;
      this.render();
    }, { title: 'Move the pivot without moving the castings and joints that hang on it' }));
    body.push(el('div.hint', {}, this.holdAssembly
      ? `The pivot is where this joint sits in its parent, so for a rotary it is the centre of rotation. Moving it leaves everything that hangs on it — ${carried === 0 ? 'nothing, so far' : `${carried} ${carried === 1 ? 'thing' : 'things'}`} — exactly where it is, and changes only where this joint turns.`
      : 'The pivot is where this joint sits in its parent. With this off, the whole branch moves with it: the castings on this joint, the joints under it and everything on those. That is what you want while placing a bare chain, and not what you want once the machine is assembled.'));

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
            ` · ${units.triple(part.size, 0, ' × ')} ${units.lengthLabel()}`,
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
      app.machineParts.parts.length ? el('label.field', {}, [
        el('span.field-label', {}, 'Paint them all'),
        el('input', {
          type: 'color', value: MachineParts.defaultColor,
          oninput: (e) => {
            for (const part of app.machineParts.parts) app.machineParts.paint(part, e.target.value);
            app.viewer.invalidate();
          },
        }),
      ]) : null,
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
      // Painting the bodies is how an assembly stops being a silhouette:
      // saddle, way cover and head are one grey casting until they are
      // not, and telling them apart is the whole job on this page.
      el('label.field', {}, [
        el('span.field-label', {}, 'Colour'),
        el('input', {
          type: 'color', value: part.color || MachineParts.defaultColor,
          oninput: (e) => { app.machineParts.paint(part, e.target.value); app.viewer.invalidate(); },
        }),
      ]),
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

  // ---- the control -------------------------------------------------------

  /**
   * The control this machine has, and what it believes before a program
   * says anything.
   *
   * Which control it is, is not a setting. A machine arrives with its
   * control and keeps it: nobody swaps the Siemens in a mill for a Fanuc,
   * and a program posted for one read by the other is not a mode to toggle
   * but a different machine. So it is chosen when the machine is made and
   * only stated here.
   *
   * The power-up state is a genuine setting, and a sharp one: controls do
   * not agree about it, and the second machine starting in inches, or
   * reading I/J as absolute, or coming up in G18, is a classic way to
   * crash. Changing one re-reads the program.
   */
  controlSection() {
    const app = this.app;
    const c = app.state.machine.controller;
    const dialect = resolveDialect(c.dialect || FLAVOUR_DIALECT[c.flavour] || 'fanuc', c.syntax);
    const set = (patch) => {
      app.setMachine({ controller: { ...c, ...patch } });
      this.render();
    };

    return section('Control', [
      el('div.hint', {}, [
        el('b', {}, controlName(c.flavour)),
        ` · reads ${dialect.name}`,
      ]),
      el('div.hint', {}, 'The control comes with the machine, so it is chosen when the machine is made and does not change afterwards — start a new machine, or load one, to work with another. How its macros are spelled is on Macros, where the spellings can be matched to the control in front of you. The five-axis codes are the Fanuc ones on every control so far: G68.2, G69, G53.1, G43.4 and G43.5.'),

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

  // ---- macros ------------------------------------------------------------
  //
  // Everything on this page belongs to the machine rather than to the job:
  // what it does when it reads an M code, the subprograms that live in its
  // memory, and the positions those two read. All of it is saved with the
  // machine and arrives with it.

  /**
   * How this control writes a macro.
   *
   * `#100 = [#1 + 2]` is not "macro syntax", it is *Fanuc's*. The reader
   * takes a table of spellings, so the table is a setting — which is what
   * lets a shop describe the control in front of them instead of the one
   * this program happened to be written against.
   */
  syntaxSection() {
    const app = this.app;
    const c = app.state.machine.controller;
    const baseId = c.dialect || FLAVOUR_DIALECT[c.flavour] || 'fanuc';
    const dialect = resolveDialect(baseId, c.syntax);
    const edited = !!c.syntax;

    return section('Macro syntax', [
      // Which control this is came with the machine — see Layout. What can
      // be changed is how that control spells things, because two machines
      // wearing the same badge do not always agree about that.
      el('div.hint', {}, [el('b', {}, `Reads like ${DIALECTS[baseId] ? DIALECTS[baseId].name : baseId}`), `, because this is a ${controlName(c.flavour)}.`]),
      el('div.hint', {}, DIALECTS[baseId] ? DIALECTS[baseId].notes : ''),
      el('pre.code-sample', {}, sampleFor(dialect)),
      edited ? el('div.inline-warning', {}, `Edited: this machine does not read quite like a standard ${DIALECTS[baseId].name}. ${describeDialect(dialect)}`) : null,
      addBar('Edit syntax…', () => openSyntaxDialog(app, this), { hint: 'Change the spellings to match the control in front of you' }),
      el('div.hint', {}, 'Variables, brackets, comparisons, the control-flow words and what counts as a comment. The arithmetic underneath is the same on every control; only the spelling differs, and it is saved with the machine.'),
    ]);
  }

  macroSection() {
    const app = this.app;
    const macros = app.state.machine.macros || [];
    const list = el('div.list');

    for (const mac of macros) {
      const refs = macroReferences(mac.body);
      list.appendChild(el(`div.list-item${this.macroId === mac.id ? '.selected' : ''}`, {
        onclick: () => { this.macroId = mac.id; this.render(); },
        ondblclick: () => openMacroDialog(app, this, mac.id),
        title: 'Double-click to edit',
      }, [
        el('div.swatch', { style: { background: mac.enabled ? '#1a9d4b' : '#d0d4db' } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, [el('span.tnum', {}, mac.code), mac.name]),
          el('div.list-sub', {}, [
            mac.enabled ? 'runs' : 'not used',
            `${String(mac.body || '').trim().split('\n').length} lines`,
            refs.length ? `reads ${refs.map((r) => `#${r}`).join(' ')}` : null,
          ].filter(Boolean).join(' · ')),
        ]),
        el('div.list-actions', {}, [
          button(mac.enabled ? 'Turn off' : 'Turn on', (e) => {
            e.stopPropagation();
            mac.enabled = !mac.enabled;
            app.reinterpret();
            this.render();
          }),
        ]),
      ]));
    }

    const selected = macros.find((m) => m.id === this.macroId) || null;
    return section(`M codes (${macros.length})`, [
      addBar('Add macro…', () => openMacroDialog(app, this, null), { hint: 'Say what this machine does at an M code' }),
      el('div.hint', {}, 'A control does not really do M06 — it runs a program the machine builder wrote, which retracts, crosses to the change position and swaps the tool. That is what these are, and it is why two machines reading the same G-code do different things at the same code.'),
      list,
      actionRow([
        { label: 'Edit…', variant: 'primary', disabled: !selected, onClick: () => openMacroDialog(app, this, this.macroId) },
        {
          label: selected && selected.enabled ? 'Turn off' : 'Turn on',
          disabled: !selected,
          hint: 'Whether this machine actually runs it',
          onClick: () => {
            selected.enabled = !selected.enabled;
            app.reinterpret();
            this.render();
          },
        },
        { label: 'Duplicate', disabled: !selected, onClick: () => this.duplicateMacro() },
        { label: 'Delete', disabled: !selected, variant: 'warn', onClick: () => this.deleteMacro() },
      ]),
    ]);
  }

  duplicateMacro() {
    const mac = (this.app.state.machine.macros || []).find((m) => m.id === this.macroId);
    if (!mac) return;
    this.macroId = this.app.addMacro({ ...mac, id: undefined, name: `${mac.name} copy`, enabled: false }).id;
    this.render();
  }

  deleteMacro() {
    const app = this.app;
    app.state.machine.macros = (app.state.machine.macros || []).filter((m) => m.id !== this.macroId);
    this.macroId = null;
    app.reinterpret();
    this.render();
  }

  /**
   * Subprograms that live in the machine.
   *
   * A shop's probing cycles, its pallet routines, the builder's O9000
   * programs: files that are in the control's memory whatever job is
   * loaded, so any program can call them and none of them carries a copy.
   * They are the machine's, so they are saved and loaded with it.
   */
  machineSubSection() {
    const app = this.app;
    const subs = app.state.machine.subprograms || [];
    const list = el('div.list');

    if (!subs.length) {
      list.appendChild(el('div.empty', {}, [
        el('div.empty-title', {}, 'Nothing in the machine'),
        el('div.hint', {}, 'Files that stay on the control between jobs — probing cycles, pallet routines, the builder\u2019s own programs. Any program loaded on this machine can call them with M98, without carrying a copy. Subprograms that belong to one job go on Program \u203a Programs instead.'),
      ]));
    }

    for (const sub of subs) {
      const o = programNumber(sub.text);
      const lines = String(sub.text || '').split('\n').length;
      list.appendChild(el(`div.list-item${this.machineSubId === sub.id ? '.selected' : ''}`, {
        onclick: () => { this.machineSubId = sub.id; this.render(); },
      }, [
        el('div.swatch', { style: { background: '#7b8494' } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, [o === null ? null : el('span.tnum', {}, `O${o}`), sub.name]),
          el('div.list-sub', {}, [
            `${lines} ${lines === 1 ? 'line' : 'lines'}`,
            'in the machine',
            o === null ? 'called by name' : null,
          ].filter(Boolean).join(' · ')),
        ]),
      ]));
    }

    const selected = subs.find((x) => x.id === this.machineSubId) || null;
    const body = [
      addBar('Open files…', () => this.openMachineSubs(), { hint: 'One or several; they stay with this machine' }),
      list,
    ];

    if (selected) {
      body.push(row([
        field('Name', selected.name, {
          type: 'text',
          title: 'What this file is called, and what a call by name asks for',
          onChange: (v) => {
            const next = String(v || '').trim();
            if (!next || next === selected.name) { this.render(); return; }
            selected.name = next;
            app.reinterpret();
            this.render();
          },
        }),
      ]));
      body.push(el('div.hint', {}, `Called with ${callLine(machineDialect(app), { name: selected.name, number: programNumber(selected.text) || 0 })}`));
      const area = el('textarea.code-box', {
        spellcheck: false,
        wrap: 'off',
        rows: 14,
        oninput: (e) => {
          selected.text = e.target.value;
          clearTimeout(this._subDebounce);
          this._subDebounce = setTimeout(() => app.reinterpret(), 400);
        },
      });
      area.value = selected.text || '';
      body.push(area);
    }

    body.push(actionRow([
      { label: 'New file', onClick: () => this.newMachineSub(), hint: 'Start an empty one' },
      { label: 'Save as file', disabled: !selected, onClick: () => download(selected.name, selected.text || '', 'text/plain') },
      { label: 'Remove', disabled: !selected, variant: 'warn', onClick: () => this.removeMachineSub() },
    ]));

    return section(`Machine subprograms (${subs.length})`, body);
  }

  async openMachineSubs() {
    const files = await pickFile('.nc,.gcode,.tap,.ngc,.cnc,.txt,.sub,.mpf,.eia', true);
    if (!files || !files.length) return;
    const app = this.app;
    if (!Array.isArray(app.state.machine.subprograms)) app.state.machine.subprograms = [];
    for (const file of files) {
      const sub = { id: uid('msub'), name: file.name, text: await file.text() };
      app.state.machine.subprograms.push(sub);
      this.machineSubId = sub.id;
    }
    app.reinterpret();
    this.render();
  }

  newMachineSub() {
    const app = this.app;
    if (!Array.isArray(app.state.machine.subprograms)) app.state.machine.subprograms = [];
    const subs = app.state.machine.subprograms;
    openNewSubprogramDialog(app, {
      subtitle: 'A file that stays on this control between jobs',
      names: subs.map((x) => x.name),
      numbers: subs.map((x) => programNumber(x.text)),
      from: 9000,
      onCreate: (file) => {
        const sub = { id: uid('msub'), ...file };
        subs.push(sub);
        this.machineSubId = sub.id;
        app.reinterpret();
        this.render();
      },
    });
  }

  removeMachineSub() {
    const app = this.app;
    app.state.machine.subprograms = (app.state.machine.subprograms || []).filter((x) => x.id !== this.machineSubId);
    this.machineSubId = null;
    app.reinterpret();
    this.render();
  }

  /** The named numbers macros read: where this machine's positions live. */
  parameterSection() {
    const app = this.app;
    const machine = app.state.machine;
    return section('Machine parameters', [
      addBar('Add parameter…', () => openParameterDialog(app, this), { hint: 'A number of your own that macros can read' }),
      ...Object.keys(machine.parameters || {}).map((key) => row([
        field(key, machine.parameters[key], {
          type: 'number',
          step: 1,
          unit: PARAMETER_HINTS[key] ? 'mm' : '',
          title: PARAMETER_HINTS[key] || `Read by a macro as #${key}`,
          onChange: (v) => {
            machine.parameters[key] = Number(v) || 0;
            app.reinterpret();
          },
        }),
        button('✕', () => {
          delete machine.parameters[key];
          app.reinterpret();
          this.render();
        }, { title: `Remove #${key}`, variant: 'warn' }),
      ])),
      el('div.hint', {}, 'A macro reads these by name — #toolChangeX in a body becomes this number. They belong to the machine, so a program that moves to another machine picks up that machine\u2019s positions.'),
      el('div.hint', {}, 'A name that is a number is one of the control\u2019s registers instead: 50 is what a Fidia program means by RG 50, so a program that branches on an item number can be read at the number the operator dialled in.'),
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
    const home = homeOf(m);
    const wcsKey = app.state.wcsEdit;
    const wcs = app.state.wcs[wcsKey] || [0, 0, 0];

    return [
      // Machine zero. Everything a control says about where it is, it says
      // from here — so it is one section with the envelope that hangs off
      // it rather than a lone field on another tab.
      section('Home position', [
        el('div.hint', {}, 'Machine zero: where the tip stands with every axis at its home switch. G53 and G28 are measured from here, and so are the travels below — move it and the envelope goes with the machine rather than staying behind in the scene.'),
        row(TRAVEL_AXES.map((a, i) => field(`Home ${a}`, home[i], {
          step: 10, unit: 'mm',
          onChange: (v) => {
            const next = [...home];
            next[i] = v || 0;
            app.setHome(next);
          },
        }))),
        actionRow([
          { label: 'Pick a point…', variant: 'primary', hint: 'Click where the tip stands at home', onClick: () => app.pickHome() },
          { label: 'Above the stock', hint: 'Over the middle of the block, clear of it', onClick: () => app.homeAboveStock() },
        ]),
        el('div.hint', {}, `${wcsKey} zero reads ${TRAVEL_AXES.map((a, i) => `${a} ${units.len(wcs[i] - home[i], 3)}`).join('  ')} ${units.lengthLabel()} in machine coordinates — the numbers that go on the setup sheet.`),
      ]),
      section('Travel limits', [
        checkbox('Check travel limits', m.limits.enabled, (v) => {
          app.setMachine({ limits: { ...m.limits, enabled: v } });
          this.render();
        }),
        m.limits.enabled ? row(TRAVEL_AXES.map((a, i) => field(`${a} min`, m.limits.min[i], {
          step: 10, unit: 'mm',
          title: `How far the tip can go in −${a} from home`,
          onChange: (v) => {
            const min = [...m.limits.min];
            min[i] = v || 0;
            app.setMachine({ limits: { ...m.limits, min } });
          },
        }))) : null,
        m.limits.enabled ? row(TRAVEL_AXES.map((a, i) => field(`${a} max`, m.limits.max[i], {
          step: 10, unit: 'mm',
          title: `How far the tip can go in +${a} from home`,
          onChange: (v) => {
            const max = [...m.limits.max];
            max[i] = v || 0;
            app.setMachine({ limits: { ...m.limits, max } });
          },
        }))) : null,
        m.limits.enabled ? el('div.hint', {}, `Travel: ${TRAVEL_AXES.map((a, i) => `${a} ${units.len(m.limits.max[i] - m.limits.min[i], 1)}`).join(' · ')} ${units.lengthLabel()}.`) : null,
        el('div.hint', {}, 'Machine coordinates, measured from home, which is how a control reads them out and a manual writes them down: at home the tip is at 0, 0, 0 and these say how far it goes from there. Each rotary has its own travel on the Axes page, and both are checked. View \u203a Show draws the envelope in the viewport.'),
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

/** With stand-ins off, what is actually drawn for this chain. */
function emptyChainNote(kin, app) {
  const empty = kin.order.filter((n) => !app.machineParts.forNode(n.id).length).length;
  if (!empty) return 'Off — and every place in this chain has a body of its own, so there is nothing to stand in for.';
  return `Off: ${empty} of the ${kin.order.length} places in this chain ${empty === 1 ? 'has' : 'have'} no body yet, and ${empty === 1 ? 'it is' : 'they are'} drawn as nothing. Bring the castings in on Assembly.`;
}

function dirLabel(v) {
  const found = DIRECTIONS.find((d) => d.value === dirKey(v));
  return found ? found.label : units.triple(v, 2);
}
