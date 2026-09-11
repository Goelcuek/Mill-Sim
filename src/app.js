// Application shell: owns the state, wires the panels to the scene and
// drives the simulation clock.

import * as THREE from 'three';

import { Viewer } from './scene/viewer.js';
import { StockView } from './scene/stockView.js';
import { ToolView } from './scene/toolView.js';
import { ToolpathView } from './scene/toolpathView.js';
import { MachineView, DEFAULT_MACHINE } from './scene/machineView.js';
import { MachineParts } from './machine/parts.js';
import { PRESETS } from './machine/presets.js';
import { Kinematics } from './machine/kinematics.js';
import { ModelsView } from './scene/modelsView.js';
import { PickController } from './scene/pickController.js';
import { OriginView } from './scene/originView.js';

import { ToolLibrary } from './tools/library.js';
import { Stock } from './sim/stock.js';
import { Simulator } from './sim/simulator.js';
import { silhouetteSpheres } from './sim/collision.js';
import { interpret } from './gcode/interpreter.js';

import { heightmapToTriangles, latheToTriangles, boxToTriangles } from './io/mesh.js';
import { buildTargetMap, compareToTarget } from './sim/target.js';
import { writeSTL, writeOBJ } from './io/stl.js';

import { el, clear, button, download, pickFile } from './ui/dom.js';
import { SetupPanel } from './ui/setupPanel.js';
import { MachinePanel } from './ui/machinePanel.js';
import { ToolsPanel } from './ui/toolsPanel.js';
import { ProgramPanel } from './ui/programPanel.js';
import { ResultsPanel } from './ui/resultsPanel.js';
import { ViewPanel } from './ui/viewPanel.js';
import { Ribbon } from './ui/ribbon.js';
import { confirmDialog } from './ui/dialog.js';
import {
  openToolDialog, openHolderDialog, openAssemblyDialog,
  openStockDialog, openMachineDialog,
} from './ui/toolDialogs.js';
import { EXAMPLES } from './examples.js';
import { fmt, fmtDuration, clamp } from './core/util.js';

/** Cell sizes offered for the simulation grid, coarse to fine. */
export const RESOLUTIONS = [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.075, 0.05, 0.035, 0.025];

const SPEEDS = [
  { value: '0.25', label: '¼×' },
  { value: '1', label: '1×' },
  { value: '4', label: '4×' },
  { value: '20', label: '20×' },
  { value: '100', label: '100×' },
  { value: 'max', label: 'Max' },
];

export class App {
  constructor(root) {
    this.root = root;
    this.state = {
      stock: { size: [120, 80, 25], origin: [-60, -40, -25], resolution: 0.28 },
      machine: { ...DEFAULT_MACHINE },
      wcs: { G54: [0, 0, 0], G55: [0, 0, 0], G56: [0, 0, 0], G57: [0, 0, 0], G58: [0, 0, 0], G59: [0, 0, 0] },
      machineZero: [0, 0, 250],
      /** Which work offset the Setup panel and the placement tools act on. */
      wcsEdit: 'G54',
      display: {
        grid: true, axes: true, stock: true, tool: true, holder: true,
        toolpath: true, rapids: true, backplot: 'all', toolOpacity: 1, origins: true,
        sectionPct: 100, stockColor: '#8e97a6', toolColors: true, showLimits: false,
      },
      program: null,
      source: '',
      programName: 'program.nc',
      playing: false,
      speed: '4',
      activeAssemblyId: null,
      persistLibrary: true,
      exportDecimate: 1,
      seekTarget: null,
      /** How far the cutter may pass the reference surface before it gouges. */
      gougeTolerance: 0.02,
    };

    this.library = new ToolLibrary();
    if (!this.library.restore()) this.library.loadDefaults();
    this.simulator = new Simulator();
    this.stock = null;

    this.buildLayout();
    this.buildScene();
    this.buildPanels();
    this.buildTransport();

    this.rebuildStock();
    this.refreshSlots();
    this.applyDisplay();

    this.viewer.onFrame((dt) => this.frame(dt));
    this.viewer.start();
    this.bindKeys();

    this.library.onChange(() => {
      if (this.state.persistLibrary) this.library.save();
      this.scheduleSlotRefresh();
    });

    requestAnimationFrame(() => this.fitToScene());
    this.notify('Pick an example in the Program tab, or open your own G-code.', 'info');
  }

  // ---- layout ------------------------------------------------------------

  buildLayout() {
    clear(this.root);

    this.ribbon = new Ribbon();
    this.ribbon.onSelect((id) => this.setTab(id));
    this.panelHost = el('div.panel-host');
    this.sidebar = el('aside.sidebar', {}, [this.panelHost]);

    this.viewportHost = el('div.viewport');
    this.hud = el('div.hud');
    this.badge = el('div.crash-badge');
    this.pickBar = el('div.pick-bar');
    this.viewOverlay = el('div.view-overlay', {}, [this.hud, this.badge]);
    this.viewportHost.appendChild(this.viewOverlay);
    this.viewportHost.appendChild(this.pickBar);

    this.transport = el('div.transport');
    this.toast = el('div.toast-host');

    this.root.appendChild(el('header.titlebar', {}, [
      el('div.brand', {}, [el('span.brand-mark', {}, '⌗'), el('span', {}, 'Mill-Sim')]),
      this.quickAccess(),
      el('div.spacer'),
      this.statusStrip = el('div.title-status'),
    ]));
    this.root.appendChild(this.ribbon.root);
    this.root.appendChild(el('div.workspace', {}, [
      this.sidebar,
      el('main.main', {}, [this.viewportHost, this.transport]),
    ]));
    this.root.appendChild(this.toast);
  }

  /** The always-visible strip beside the title: the few verbs used constantly. */
  quickAccess() {
    const mk = (label, title, fn) => button(label, fn, { title });
    this.quickPlay = mk('▶', 'Play / pause (Space)', () => this.togglePlay());
    this.quickPlay.classList.add('icon');
    return el('div.quick-access', {}, [
      this.quickPlay,
      Object.assign(mk('⏭', 'Step one move (→)', () => this.stepMove()), { className: 'btn icon' }),
      Object.assign(mk('⏮', 'Back to the start (R)', () => this.reset()), { className: 'btn icon' }),
      el('div.actions-sep'),
      Object.assign(mk('⤢', 'Fit the job (F)', () => this.fitToScene()), { className: 'btn icon' }),
    ]);
  }

  /**
   * The ribbon. Groups are rebuilt each time a tab is drawn, so pressed
   * states and disabled reasons always reflect what is actually loaded.
   */
  buildRibbon() {
    const d = () => this.state.display;
    const show = (label, key, ic) => ({
      kind: 'toggle', icon: ic, label, checked: d()[key],
      onChange: (v) => { this.setDisplay({ [key]: v }); this.buildRibbon(); },
    });
    const picking = () => (this.pick && this.pick.active ? this.pick.request.title : '');
    const selected = () => this.models.selected;
    const toolsPanel = () => this.panels.tools;

    this.ribbon.setTabs([
      {
        id: 'setup',
        label: 'Setup',
        groups: () => [
          {
            label: 'Stock',
            items: [
              { kind: 'big', icon: 'cube', label: 'Stock…', hint: 'Size, position and simulation resolution', onClick: () => openStockDialog(this, RESOLUTIONS) },
              {
                kind: 'stack',
                items: [
                  { icon: 'fit', label: 'Fit to program', disabled: !this.state.program, hint: this.state.program ? 'Size the block around the toolpath' : 'Load a program first', onClick: () => { this.fitStockToProgram(); this.panels.setup.refresh(); } },
                  { icon: 'target', label: 'Centre on zero', onClick: () => { const sz = this.state.stock.size; this.setStock({ origin: [-sz[0] / 2, -sz[1] / 2, -sz[2]] }); this.panels.setup.refresh(); } },
                  { icon: 'reset', label: 'Reset the cut', onClick: () => this.resetStock() },
                ],
              },
            ],
          },
          {
            label: 'Place by clicking',
            items: [
              { kind: 'big', icon: 'move', label: 'Move stock', active: picking() === 'Move stock', onClick: () => this.moveStockByPoints() },
              { kind: 'big', icon: 'target', label: `Set ${this.state.wcsEdit}`, hint: 'Click the point that should read X0 Y0 Z0', active: picking().startsWith('Set '), onClick: () => this.setOriginByPoint() },
              {
                kind: 'stack',
                items: [
                  { icon: 'move', label: `Move ${this.state.wcsEdit}`, active: picking() === `Move ${this.state.wcsEdit}`, onClick: () => this.moveOriginByPoints() },
                  { icon: 'move', label: 'Move model', disabled: !selected(), hint: selected() ? 'Two-point move of the selected model' : 'Select a model first', onClick: () => this.moveModelByPoints() },
                  { icon: 'point', label: 'Zero to corner', hint: 'Minimum X/Y corner of the top face', onClick: () => { const st = this.stock; this.applyWcs(this.state.wcsEdit, [st.origin[0], st.origin[1], st.top]); } },
                ],
              },
            ],
          },
          {
            label: 'Work offset',
            items: [
              {
                kind: 'select', label: 'Active', width: 84, value: this.state.wcsEdit,
                options: Object.keys(this.state.wcs).map((k) => ({ value: k, label: k })),
                onChange: (v) => this.setWcsEdit(v),
              },
              { kind: 'toggle', icon: 'eye', label: 'Markers', checked: d().origins, onChange: (v) => { this.setDisplay({ origins: v }); this.buildRibbon(); } },
            ],
          },
          {
            label: 'Fixtures',
            items: [
              { kind: 'big', icon: 'import', label: 'Import…', hint: 'Bring in an STL fixture, clamp or reference part', onClick: () => this.panels.setup.importDialog() },
              {
                kind: 'stack',
                items: [
                  { icon: 'vice', label: 'Vice jaws', onClick: () => { this.addPrimitiveFixture('vice'); this.refreshFixtures(); } },
                  { icon: 'ruler', label: 'Parallels', onClick: () => { this.addPrimitiveFixture('parallels'); this.refreshFixtures(); } },
                  { icon: 'clamp', label: 'Toe clamp', onClick: () => { this.addPrimitiveFixture('clamp'); this.refreshFixtures(); } },
                ],
              },
            ],
          },
          {
            label: 'Machine',
            items: [
              { kind: 'big', icon: 'machine', label: 'Machine…', onClick: () => openMachineDialog(this) },
              {
                kind: 'stack',
                items: [
                  { icon: 'view', label: this.state.machine.mode === 'machine' ? 'Show part only' : 'Show full machine', onClick: () => { this.setMachine({ mode: this.state.machine.mode === 'machine' ? 'part' : 'machine' }); this.buildRibbon(); } },
                  { icon: 'gauge', label: 'Travel envelope', active: d().showLimits, onClick: () => { this.setDisplay({ showLimits: !d().showLimits }); this.buildRibbon(); } },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'machine',
        label: 'Machine',
        groups: () => {
          const kin = this.machineView.kinematics;
          const panel = () => this.panels.machine;
          const sel = () => panel().selected;
          return [
            {
              label: 'Configuration',
              items: [
                {
                  kind: 'select', label: 'Machine', width: 220, value: this.state.machine.preset,
                  options: Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })),
                  onChange: (v) => { this.setMachine({ preset: v }); this.setTab('machine'); },
                },
                { kind: 'text', label: 'Layout', value: kin.configuration },
                { kind: 'text', label: 'Axes', value: kin.axes().map((n) => n.letter).join(' ') || '–' },
              ],
            },
            {
              label: 'Axes',
              items: [
                { kind: 'big', icon: 'machine', label: 'Add axis', hint: 'Insert a joint under the selected one', onClick: () => { this.setTab('machine'); panel().addAxis(); } },
                {
                  kind: 'stack',
                  items: [
                    { icon: 'cutter', label: 'Tool hangs here', disabled: !sel() || (sel() && sel().id === kin.toolNode), onClick: () => { kin.toolNode = sel().id; panel().commit(); } },
                    { icon: 'cube', label: 'Part clamps here', disabled: !sel() || (sel() && sel().id === kin.workNode), onClick: () => { kin.workNode = sel().id; panel().commit(); } },
                    { icon: 'trash', label: 'Delete axis', disabled: !sel(), onClick: () => panel().deleteAxis() },
                  ],
                },
              ],
            },
            {
              label: 'Castings',
              items: [
                { kind: 'big', icon: 'import', label: 'Import STL…', hint: 'Bring in a casting and hang it on an axis', onClick: async () => { this.setTab('machine'); await panel().importFiles(await pickFile('.stl', true)); } },
                {
                  kind: 'stack',
                  items: [
                    { icon: 'reset', label: 'Remove all', disabled: !this.machineParts.parts.length, onClick: () => { this.machineParts.clear(); this.applyMachineParts(); panel().refresh(); } },
                    { icon: 'export', label: 'Export machine', hint: 'Save the chain as JSON', onClick: () => download(`${kin.name.replace(/\s+/g, '-').toLowerCase()}.json`, JSON.stringify(kin.toJSON(), null, 2), 'application/json') },
                    { icon: 'import', label: 'Import machine', hint: 'Load a chain saved earlier', onClick: () => this.importKinematics() },
                  ],
                },
              ],
            },
            {
              label: 'View',
              items: [
                { kind: 'big', icon: 'view', label: this.state.machine.mode === 'machine' ? 'Part only' : 'Full machine', onClick: () => { this.setMachine({ mode: this.state.machine.mode === 'machine' ? 'part' : 'machine' }); this.buildRibbon(); } },
                {
                  kind: 'stack',
                  items: [
                    { icon: 'gauge', label: 'Travel envelope', active: d().showLimits, onClick: () => { this.setDisplay({ showLimits: !d().showLimits }); this.buildRibbon(); } },
                    { icon: 'machine', label: 'Machine…', hint: 'Travels, table and rates', onClick: () => openMachineDialog(this) },
                  ],
                },
              ],
            },
          ];
        },
      },
      {
        id: 'tools',
        label: 'Tools',
        groups: () => [
          {
            label: 'Create',
            items: [
              { kind: 'big', icon: 'cutter', label: 'New cutter', hint: 'End mill, ball nose, drill, chamfer…', onClick: () => openToolDialog(this, null) },
              { kind: 'big', icon: 'holder', label: 'New holder', onClick: () => openHolderDialog(this, null) },
              { kind: 'big', icon: 'assembly', label: 'New assembly', hint: 'Pair a cutter with a holder and a stickout', onClick: () => openAssemblyDialog(this, null) },
            ],
          },
          {
            label: 'Selected',
            items: [
              { kind: 'big', icon: 'edit', label: 'Edit…', disabled: !toolsPanel().hasSelection(), hint: 'Open the editor for the selected item', onClick: () => toolsPanel().editSelected() },
              {
                kind: 'stack',
                items: [
                  { icon: 'copy', label: 'Duplicate', disabled: !toolsPanel().hasSelection(), onClick: () => toolsPanel().duplicateSelected() },
                  { icon: 'trash', label: 'Delete', disabled: !toolsPanel().hasSelection(), onClick: () => toolsPanel().deleteSelected() },
                  { icon: 'export', label: 'Export STL', disabled: !toolsPanel().currentBuilt(), onClick: () => this.exportAssemblyStl(toolsPanel().currentBuilt()) },
                ],
              },
            ],
          },
          {
            label: 'Library',
            items: [
              { kind: 'big', icon: 'library', label: 'Library', hint: `${this.library.assemblies.length} assemblies, ${this.library.tools.length} cutters, ${this.library.holders.length} holders`, onClick: () => toolsPanel().showAll() },
              {
                kind: 'stack',
                items: [
                  { icon: 'export', label: 'Export JSON', onClick: () => download('mill-sim-library.json', JSON.stringify(this.library.toJSON(), null, 2), 'application/json') },
                  { icon: 'import', label: 'Import JSON', onClick: () => toolsPanel().importLibrary() },
                  { icon: 'reset', label: 'Restore built-in', onClick: () => confirmDialog({
                    title: 'Restore the built-in tools?',
                    message: 'Your cutters, holders and assemblies will be replaced by the ones Mill-Sim ships with. This cannot be undone.',
                    confirm: 'Restore', danger: true,
                    onConfirm: () => { this.library.loadDefaults(); this.refreshSlots(); this.notify('Library reset to the built-in tools.', 'ok'); },
                  }) },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'program',
        label: 'Program',
        groups: () => [
          {
            label: 'File',
            items: [
              { kind: 'big', icon: 'open', label: 'Open…', onClick: () => this.panels.program.openFile() },
              { kind: 'big', icon: 'save', label: 'Save', onClick: () => this.panels.program.saveFile() },
              {
                kind: 'select', label: 'Examples', width: 210, value: '',
                options: [{ value: '', label: 'Load an example…' }, ...EXAMPLES.map((e, i) => ({ value: String(i), label: e.name }))],
                onChange: (v, e) => { if (v === '') return; e.target.value = ''; this.panels.program.loadExampleAt(Number(v)); },
              },
            ],
          },
          {
            label: 'Interpret',
            items: [
              { kind: 'big', icon: 'reset', label: 'Re-parse', onClick: () => this.loadProgram(this.panels.program.editor ? this.panels.program.editor.value : '', this.state.programName) },
              {
                kind: 'stack',
                items: [
                  { icon: 'fit', label: 'Fit view to path', onClick: () => this.fitToProgram() },
                  { icon: 'cube', label: 'Fit stock to path', disabled: !this.state.program, onClick: () => { this.fitStockToProgram(); this.panels.setup.refresh(); } },
                ],
              },
            ],
          },
          {
            label: 'Program',
            items: [
              { kind: 'text', label: 'Moves', value: this.state.program ? String(this.state.program.stats.moveCount) : '–' },
              { kind: 'text', label: 'Cycle time', value: this.state.program ? fmtDuration(this.state.program.stats.cycleTime) : '–' },
              { kind: 'text', label: 'Notes', value: this.state.program ? String(this.state.program.warnings.length) : '–' },
            ],
          },
        ],
      },
      {
        id: 'results',
        label: 'Results',
        groups: () => [
          {
            label: 'Run',
            items: [
              { kind: 'big', icon: this.state.playing ? 'pause' : 'play', label: this.state.playing ? 'Pause' : 'Play', onClick: () => this.togglePlay() },
              { kind: 'big', icon: 'end', label: 'Run to end', onClick: () => this.runToEnd() },
              {
                kind: 'stack',
                items: [
                  { icon: 'step', label: 'Step one move', onClick: () => this.stepMove() },
                  { icon: 'rewind', label: 'Back to start', onClick: () => this.reset() },
                ],
              },
              {
                kind: 'select', label: 'Speed', width: 86, value: this.state.speed,
                options: SPEEDS.map((sp) => ({ value: sp.value, label: sp.label })),
                onChange: (v) => { this.state.speed = v; this.speedSelect.value = v; },
              },
            ],
          },
          {
            label: 'Export',
            items: [
              { kind: 'big', icon: 'export', label: 'Part as STL', onClick: () => this.exportStockStl() },
              {
                kind: 'stack',
                items: [
                  { icon: 'export', label: 'Part as OBJ', onClick: () => this.exportStockObj() },
                  { icon: 'report', label: 'Collision report', onClick: () => download('mill-sim-report.md', this.buildReport(), 'text/markdown') },
                  { icon: 'camera', label: 'Screenshot', onClick: () => this.saveScreenshot() },
                ],
              },
            ],
          },
          {
            label: 'Findings',
            items: [
              { kind: 'text', label: 'Collisions', value: String(this.simulator.collisions.filter((c) => c.severity === 'error').length) },
              { kind: 'text', label: 'Removed', value: `${fmt(this.simulator.removedVolume / 1000, 2)} cm³` },
              {
                kind: 'number', label: 'Gouge tol.', unit: 'mm', width: 76,
                value: this.state.gougeTolerance, step: 0.005, min: 0,
                hint: 'How far a cut may pass the reference surface before it counts as a gouge',
                onChange: (v) => { this.setGougeTolerance(v); this.buildRibbon(); },
              },
            ],
          },
        ],
      },
      {
        id: 'view',
        label: 'View',
        groups: () => [
          {
            label: 'Camera',
            items: [
              { kind: 'big', icon: 'view', label: 'Isometric', onClick: () => this.viewer.setView('iso') },
              {
                kind: 'stack',
                items: [
                  { icon: 'point', label: 'Top', onClick: () => this.viewer.setView('top') },
                  { icon: 'point', label: 'Front', onClick: () => this.viewer.setView('front') },
                  { icon: 'point', label: 'Right', onClick: () => this.viewer.setView('right') },
                ],
              },
              { kind: 'big', icon: 'fit', label: 'Fit', onClick: () => this.fitToScene() },
            ],
          },
          {
            label: 'Show',
            items: [
              {
                kind: 'stack',
                items: [show('Stock', 'stock', 'cube'), show('Tool', 'tool', 'cutter'), show('Holder', 'holder', 'holder')],
              },
              {
                kind: 'stack',
                items: [show('Toolpath', 'toolpath', 'point'), show('Rapid moves', 'rapids', 'move'), show('Work origins', 'origins', 'target')],
              },
              {
                kind: 'stack',
                items: [show('Grid', 'grid', 'grid'), show('Axes', 'axes', 'axes'), {
                  kind: 'toggle', icon: 'cutter', label: 'Colour by tool', checked: d().toolColors,
                  onChange: (v) => { this.setDisplay({ toolColors: v }); this.buildRibbon(); },
                }],
              },
            ],
          },
          {
            label: 'Inspect',
            items: [
              {
                kind: 'number', label: 'Section', unit: '%', width: 76,
                value: Math.round(d().sectionPct), step: 5, min: 0, max: 100,
                hint: 'Clip the stock above this height to see into a pocket',
                onChange: (v) => this.setDisplay({ sectionPct: clamp(v, 0, 100) }),
              },
              {
                kind: 'number', label: 'Tool opacity', unit: '%', width: 86,
                value: Math.round(d().toolOpacity * 100), step: 10, min: 10, max: 100,
                onChange: (v) => this.setDisplay({ toolOpacity: clamp(v, 10, 100) / 100 }),
              },
              {
                kind: 'select', label: 'Backplot', width: 130, value: d().backplot,
                options: [
                  { value: 'all', label: 'Whole program' },
                  { value: 'remaining', label: 'Still to cut' },
                  { value: 'done', label: 'Already cut' },
                ],
                onChange: (v) => this.setDisplay({ backplot: v }),
              },
            ],
          },
        ],
      },
    ]);
    this.ribbon.active = this.activeTab || this.ribbon.active;
    this.ribbon.renderTabs();
    this.ribbon.renderBand();
  }

  // ---- scene -------------------------------------------------------------

  buildScene() {
    this.viewer = new Viewer(this.viewportHost);
    this.machineParts = new MachineParts();
    this.machineView = new MachineView();
    this.machineView.setConfig(this.state.machine);
    this.viewer.add(this.machineView.group);

    this.stockView = new StockView();
    this.toolpathView = new ToolpathView();
    this.models = new ModelsView(this.viewer);

    // Everything expressed in work coordinates rides on the machine table.
    this.machineView.workGroup.add(this.stockView.group);
    this.machineView.workGroup.add(this.toolpathView.group);
    this.machineView.workGroup.add(this.models.group);

    this.originView = new OriginView();
    this.machineView.workGroup.add(this.originView.group);

    this.toolView = new ToolView();
    this.viewer.add(this.toolView.group);

    this.pick = new PickController(this.viewer, {
      stock: () => this.stock,
      models: () => this.models,
      machine: () => this.state.machine,
      origins: () => Object.entries(this.state.wcs).map(([name, point]) => ({ name, point })),
    });
    this.pick.onUpdate = (s) => this.renderPickBar(s);
    this.refreshOrigins();
  }

  refreshOrigins() {
    this.originView.set(this.state.wcs, this.state.wcsEdit);
    this.originView.setVisible(this.state.display.origins);
    this.viewer.invalidate();
  }

  /** The instruction bar shown while a pick is in progress. */
  renderPickBar(s) {
    if (!s.active) {
      this.pickBar.classList.remove('on');
      clear(this.pickBar);
      this.buildRibbon();
      return;
    }
    const hint = s.request.hints[Math.min(s.step, s.request.hints.length - 1)];
    clear(this.pickBar);
    this.pickBar.classList.add('on');
    this.pickBar.appendChild(el('span.pick-title', {}, s.request.title));
    this.pickBar.appendChild(el('span.pick-hint', {}, hint));
    if (s.hover) {
      this.pickBar.appendChild(el('span.pick-kind', { dataset: { kind: s.hover.kind } },
        `${s.hover.kind === 'surface' ? 'surface' : s.hover.kind} · ${s.hover.label || ''}`.trim()));
      this.pickBar.appendChild(el('span.pick-coord', {},
        `X ${fmt(s.hover.point[0], 2)}  Y ${fmt(s.hover.point[1], 2)}  Z ${fmt(s.hover.point[2], 2)}`));
    }
    if (s.step === 1 && s.hover) {
      const a = s.points[0];
      const d = [s.hover.point[0] - a[0], s.hover.point[1] - a[1], s.hover.point[2] - a[2]];
      this.pickBar.appendChild(el('span.pick-coord', {},
        `Δ ${fmt(d[0], 2)}, ${fmt(d[1], 2)}, ${fmt(d[2], 2)}`));
      this.pickBar.appendChild(el('span.pick-lock', {},
        s.axisLock === null ? 'X / Y / Z to lock an axis' : `locked to ${'XYZ'[s.axisLock]}`));
      if (s.axisLock !== null) this.pickBar.lastChild.classList.add('on');
    }
    this.pickBar.appendChild(button('Cancel', () => this.pick.cancel(), { title: 'Escape' }));
  }

  saveScreenshot() {
    const url = this.viewer.screenshot();
    const a = el('a', { href: url, download: 'mill-sim.png' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---- panels ------------------------------------------------------------

  buildPanels() {
    this.panels = {
      setup: new SetupPanel(this),
      machine: new MachinePanel(this),
      tools: new ToolsPanel(this),
      program: new ProgramPanel(this),
      results: new ResultsPanel(this),
      view: new ViewPanel(this),
    };
    this.tabOrder = [
      ['setup', 'Setup'],
      ['machine', 'Machine'],
      ['tools', 'Tools'],
      ['program', 'Program'],
      ['results', 'Results'],
      ['view', 'View'],
    ];
    this.buildRibbon();
    this.setTab('setup');
  }

  setTab(id) {
    if (this.pick && this.pick.active) this.pick.cancel();
    this.activeTab = id;
    if (this.ribbon.active !== id) {
      this.ribbon.active = id;
      this.ribbon.renderTabs();
    }
    clear(this.panelHost);
    const panel = this.panels[id];
    if (panel) {
      this.panelHost.appendChild(panel.root);
      if (panel.refresh) panel.refresh();
    }
    this.buildRibbon();
  }

  // ---- transport ---------------------------------------------------------

  buildTransport() {
    this.playBtn = button('▶', () => this.togglePlay(), { title: 'Play / pause (Space)', variant: 'primary' });
    this.scrub = el('input.scrub', {
      type: 'range', min: 0, max: 1000, step: 1, value: 0,
      oninput: (e) => {
        const total = this.simulator.totalTime;
        this.seekTo((Number(e.target.value) / 1000) * total);
      },
    });
    this.timeLabel = el('span.time', {}, '0.00s / 0.00s');
    this.lineLabel = el('span.pill', {}, 'line –');
    this.speedSelect = el('select.speed', {
      onchange: (e) => { this.state.speed = e.target.value; },
    }, SPEEDS.map((s) => el('option', { value: s.value, selected: s.value === this.state.speed }, s.label)));
    this.seekNote = el('span.pill.seeking', {}, 'seeking…');
    this.seekNote.style.display = 'none';

    clear(this.transport);
    this.transport.append(
      button('⏮', () => this.reset(), { title: 'Back to the start (R)' }),
      this.playBtn,
      button('⏭', () => this.stepMove(), { title: 'Advance one move (→)' }),
      button('⏭⏭', () => this.runToEnd(), { title: 'Simulate the whole program now' }),
      this.scrub,
      this.timeLabel,
      this.lineLabel,
      this.seekNote,
      this.speedSelect,
    );
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape' && this.pick.active) { this.pick.cancel(); return; }
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'r' || e.key === 'R') this.reset();
      else if (e.key === 'ArrowRight') this.stepMove();
      else if (e.key === 'f' || e.key === 'F') this.fitToScene();
    });
  }

  // ---- state changes -----------------------------------------------------

  setStock(patch) {
    Object.assign(this.state.stock, patch);
    this.rebuildStock();
  }

  rebuildStock() {
    const s = this.state.stock;
    this.stock = new Stock({ origin: s.origin, size: s.size, resolution: s.resolution });
    this.stockView.setStock(this.stock, { renderer: this.viewer.renderer });
    this.applyDisplay();
    this.simulator.load({ stock: this.stock });
    this.refreshTarget();
    this.refreshOrigins();
    this.refreshResults();
    this.viewer.invalidate();
  }

  resetStock() {
    if (this.stock) this.stock.reset();
    this.simulator.reset();
    this.stockView.sync(true);
    this.refreshResults();
    this.viewer.invalidate();
  }

  setMachine(patch) {
    const presetChanged = patch.preset && patch.preset !== this.state.machine.preset;
    Object.assign(this.state.machine, patch);
    this.machineView.setConfig(this.state.machine);
    this.machineView.setLimitsVisible(this.state.display.showLimits);
    if (presetChanged) {
      // A different chain means different castings; nothing hung on the old
      // axes belongs on the new ones.
      for (const p of this.machineParts.parts) p.nodeId = null;
    }
    this.applyKinematics();
    this.scheduleSlotRefresh();
    this.viewer.invalidate();
  }

  /**
   * Push the current chain everywhere it is needed: the rig, the simulator
   * and the interpreter, which needs it for G53.1.
   */
  applyKinematics() {
    const kin = this.machineView.kinematics;
    kin.rebuild();
    this.applyMachineParts();          // which re-rigs the tree as it goes
    this.simulator.load({ machine: this.state.machine, kinematics: kin });
    if (this.state.source) this.loadProgram(this.state.source, this.state.programName);
    if (this.panels && this.panels.machine) this.panels.machine.refresh();
    this.viewer.invalidate();
  }

  /** Load a chain saved with "Export machine". */
  async importKinematics() {
    const [file] = await pickFile('.json');
    if (!file) return;
    try {
      const def = JSON.parse(await file.text());
      if (!def || !Array.isArray(def.nodes) || !def.nodes.length) throw new Error('That file has no axes in it.');
      this.machineView.setKinematics(new Kinematics(def));
      for (const p of this.machineParts.parts) {
        if (!this.machineView.nodeGroups.has(p.nodeId)) p.nodeId = null;
      }
      this.applyKinematics();
      this.setTab('machine');
      this.notify(`Loaded ${this.machineView.kinematics.name}.`, 'ok');
    } catch (err) {
      this.notify(`Could not read that machine: ${err.message}`, 'error');
    }
  }

  /** Hang each imported casting on the axis it has been assigned to. */
  applyMachineParts() {
    const map = new Map();
    for (const part of this.machineParts.parts) {
      if (part.nodeId && this.machineView.nodeGroups.has(part.nodeId)) map.set(part.nodeId, part.object);
    }
    this.machineView.setNodeModels(map);
    this.viewer.invalidate();
  }

  setWcs(wcs) {
    this.state.wcs = wcs;
    this.refreshOrigins();
    if (this.state.source) this.loadProgram(this.state.source, this.state.programName);
  }

  setMachineZero(v) {
    this.state.machineZero = v;
    if (this.state.source) this.loadProgram(this.state.source, this.state.programName);
  }

  setDisplay(patch) {
    Object.assign(this.state.display, patch);
    this.applyDisplay();
  }

  applyDisplay() {
    const d = this.state.display;
    this.viewer.setGridVisible(d.grid);
    this.viewer.setAxesVisible(d.axes);
    this.stockView.setVisible(d.stock);
    this.stockView.setStockColor(d.stockColor);
    this.stockView.setShowToolColors(d.toolColors);
    this.toolView.setVisible(d.tool);
    this.toolView.setHolderVisible(d.holder);
    this.toolView.setOpacity(d.toolOpacity);
    this.toolpathView.setVisible(d.toolpath);
    this.toolpathView.setShowRapids(d.rapids);
    this.toolpathView.setMode(d.backplot);
    this.machineView.setLimitsVisible(d.showLimits);
    if (this.originView) this.originView.setVisible(d.origins);

    if (this.stock) {
      const pct = clamp(d.sectionPct, 0, 100) / 100;
      const z = this.stock.base + (this.stock.top - this.stock.base) * pct;
      this.stockView.setSection(pct >= 1 ? null : z);
    }
    this.viewer.invalidate();
  }

  setPersistLibrary(on) {
    this.state.persistLibrary = on;
    if (on) this.library.save();
  }

  setActiveAssembly(id) {
    this.state.activeAssemblyId = id;
    this.refreshSlots();
    this.notify('That assembly is now the fallback for programs without a tool change.', 'ok');
  }

  scheduleSlotRefresh() {
    clearTimeout(this._slotTimer);
    this._slotTimer = setTimeout(() => this.refreshSlots(), 180);
  }

  /** Rebuild the T-number → assembly table the simulator uses. */
  refreshSlots() {
    const machine = this.state.machine;
    const slots = new Map();
    let index = 0;
    for (const a of this.library.assemblies) {
      const built = this.library.build(a.id, machine);
      if (!built) continue;
      const spheres = silhouetteSpheres([...built.toolPoints, ...built.holderPoints, ...built.spindlePoints]);
      const slot = { built, spheres, index: index % 8, assemblyId: a.id };
      index++;
      const n = Number(a.number);
      if (n) slots.set(n, slot);
      if (a.id === this.state.activeAssemblyId) this.fallbackSlot = slot;
    }
    if (!this.state.activeAssemblyId || !this.fallbackSlot) {
      this.fallbackSlot = slots.values().next().value || null;
    }

    this.simulator.load({
      slots,
      fallbackSlot: this.fallbackSlot,
      machine: this.state.machine,
      fixtures: this.models.collisionBoxes(),
      stock: this.stock,
      program: this.state.program,
    });

    this.slots = slots;
    this.showAssembly(this.simulator.activeSlot);
    this.refreshResults();
    this.viewer.invalidate();
  }

  refreshFixtures() {
    this.simulator.fixtures = this.models.collisionBoxes();
    this.scheduleTargetRefresh();
    this.viewer.invalidate();
  }

  scheduleTargetRefresh() {
    clearTimeout(this._targetTimer);
    this._targetTimer = setTimeout(() => this.refreshTarget(), 200);
  }

  /**
   * Project the reference parts onto the stock grid so the carver can tell
   * stock removal from gouging.
   */
  refreshTarget() {
    const parts = this.models.models
      .filter((m) => m.visible && m.role === 'reference')
      .map((m) => ({ positions: this.models.worldPositions(m) }));

    const started = performance.now();
    this.target = parts.length && this.stock ? buildTargetMap(this.stock, parts) : null;
    this.simulator.target = this.target;
    this.simulator.gougeTolerance = this.state.gougeTolerance;
    if (parts.length && this.target) {
      this.notify(`Reference surface mapped in ${(performance.now() - started).toFixed(0)} ms — cuts past it will be reported as gouges.`, 'ok');
    }
    this.refreshResults();
  }

  setGougeTolerance(mm) {
    this.state.gougeTolerance = Math.max(0, mm || 0);
    this.simulator.gougeTolerance = this.state.gougeTolerance;
    this.refreshResults();
  }

  /** Where the finished stock stands against the reference part. */
  compareToReference() {
    if (!this.target || !this.stock) return null;
    return compareToTarget(this.stock, this.target, this.state.gougeTolerance);
  }

  showAssembly(slot) {
    if (this._shownSlot === slot) return;
    this._shownSlot = slot;
    this.toolView.setAssembly(slot ? slot.built : null);
    this.toolView.setHolderVisible(this.state.display.holder);
    this.toolView.setOpacity(this.state.display.toolOpacity);
  }

  // ---- program -----------------------------------------------------------

  loadProgram(text, name) {
    this.state.source = text;
    if (name) this.state.programName = name;
    const program = interpret(text, {
      rapidRate: this.state.machine.rapidRate,
      wcs: this.state.wcs,
      machineZero: this.state.machineZero,
      g30: this.state.machineZero,
      kinematics: this.machineView ? this.machineView.kinematics : null,
      gaugeLength: this.fallbackSlot ? this.fallbackSlot.built.gaugeLength : 0,
    });
    this.state.program = program;
    this.toolpathView.setProgram(program);
    this.simulator.load({
      program,
      stock: this.stock,
      slots: this.slots || new Map(),
      fallbackSlot: this.fallbackSlot,
      machine: this.state.machine,
      kinematics: this.machineView ? this.machineView.kinematics : null,
      fixtures: this.models.collisionBoxes(),
    });
    this.pause();
    this.updateTransport();
    if (this.panels) {
      this.panels.program.refresh();
      this.refreshResults();
    }
    this.viewer.invalidate();
    return program;
  }

  applyExampleSetup(setup) {
    if (setup.stock) {
      Object.assign(this.state.stock, setup.stock);
      this.rebuildStock();
      this.panels.setup.refresh();
    }
  }

  // ---- playback ----------------------------------------------------------

  togglePlay() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.state.program) {
      this.notify('Load a program first.', 'error');
      return;
    }
    if (this.simulator.finished) this.simulator.reset();
    this.state.playing = true;
    this.playBtn.textContent = '⏸';
    if (this.quickPlay) this.quickPlay.textContent = '⏸';
    if (this.activeTab === 'results') this.buildRibbon();
  }

  pause() {
    this.state.playing = false;
    if (this.playBtn) this.playBtn.textContent = '▶';
    if (this.quickPlay) this.quickPlay.textContent = '▶';
    if (this.ribbon && this.activeTab === 'results') this.buildRibbon();
  }

  reset() {
    this.pause();
    this.simulator.reset();
    this.stockView.sync(true);
    this.state.seekTarget = null;
    this.updateTransport();
    this.refreshResults();
    this.viewer.invalidate();
  }

  stepMove() {
    if (!this.state.program) return;
    this.pause();
    const sim = this.simulator;
    const target = sim.moveIndex;
    let guard = 0;
    while (sim.moveIndex === target && !sim.finished && guard++ < 4000) sim.run(Infinity, 8);
    this.stockView.sync();
    this.updateTransport();
    this.refreshResults();
  }

  runToEnd() {
    if (!this.state.program) {
      this.notify('Load a program first.', 'error');
      return;
    }
    this.pause();
    this.state.seekTarget = Infinity;
    this.notify('Simulating the whole program…', 'info');
  }

  seekTo(time) {
    this.pause();
    this.state.seekTarget = time;
  }

  seekToLine(line, time) {
    if (!this.state.program) return;
    if (time !== undefined && time !== null) {
      this.seekTo(time);
      return;
    }
    let acc = 0;
    for (const mv of this.state.program.moves) {
      if (mv.line >= line) break;
      acc += mv.time;
    }
    this.seekTo(acc);
  }

  // ---- frame -------------------------------------------------------------

  frame(dt) {
    const sim = this.simulator;
    let worked = false;

    if (this.state.seekTarget !== null) {
      const target = this.state.seekTarget;
      sim.seek(target, 26);
      worked = true;
      if (sim.finished || sim.time >= target - 1e-6) {
        this.state.seekTarget = null;
        this.seekNote.style.display = 'none';
        this.refreshResults();
      } else {
        this.seekNote.style.display = '';
        this.seekNote.textContent = `simulating… ${(sim.progress * 100).toFixed(0)}%`;
      }
    } else if (this.state.playing) {
      const speed = this.state.speed === 'max' ? Infinity : parseFloat(this.state.speed);
      const r = sim.run(Number.isFinite(speed) ? dt * speed : Infinity, 14);
      worked = true;
      if (r.done) {
        this.pause();
        this.refreshResults();
        this.notify(sim.collisions.length
          ? `Program finished with ${sim.collisions.length} issue${sim.collisions.length === 1 ? '' : 's'} — see Results.`
          : 'Program finished with no collisions.', sim.collisions.some((c) => c.severity === 'error') ? 'error' : 'ok');
      }
    }

    if (worked) {
      this.showAssembly(sim.activeSlot);
      if (this.stockView.sync()) this.viewer.invalidate();
      this.updateTransport();
      this._resultTick = (this._resultTick || 0) + 1;
      if (this._resultTick % 20 === 0) this.refreshResults();
    }

    if (sim.activeSlot) this.machineView.setAssemblyLength(sim.activeSlot.built.totalLength);
    if (this.originView && this.state.display.origins) this.originView.update(this.viewer.camera);
    const pose = this.state.program ? sim.currentPose() : this.parkPose();
    const placed = this.machineView.update(pose);
    this.toolView.setPose(placed.tip, placed.dir);
    this.toolpathView.setProgress(sim.progress);
    if (this.state.display.toolpath && this.state.program) {
      const r = sim.activeSlot ? sim.activeSlot.built.cutRadius : 1;
      this.toolpathView.setMarker(sim.pos[0], sim.pos[1], sim.pos[2], Math.min(Math.max(r * 0.35, 0.6), 3));
    } else {
      this.toolpathView.hideMarker();
    }
    this.updateHud();
  }

  /** Where the tool sits when there is no program to position it. */
  parkPosition() {
    const top = this.stock ? this.stock.top : 0;
    return [0, 0, top + 45];
  }

  parkPose() {
    const p = this.parkPosition();
    return { values: { X: p[0], Y: p[1], Z: p[2] }, tip: p, dir: [0, 0, 1], rot: { A: 0, B: 0, C: 0 } };
  }

  updateTransport() {
    const sim = this.simulator;
    const total = sim.totalTime;
    this.scrub.value = String(Math.round(sim.progress * 1000));
    this.timeLabel.textContent = `${fmtDuration(sim.time)} / ${fmtDuration(total)}`;
    const mv = this.state.program && this.state.program.moves[sim.moveIndex];
    this.lineLabel.textContent = mv ? `line ${mv.line}` : 'line –';
    if (this.panels && this.activeTab === 'program' && mv) this.panels.program.setActiveLine(mv.line);
  }

  updateHud() {
    const sim = this.simulator;
    const mv = this.state.program && this.state.program.moves[sim.moveIndex];
    const slot = sim.activeSlot;
    const errors = sim.collisions.filter((c) => c.severity === 'error');

    this.hud.innerHTML = `
      <div class="hud-row"><span>X</span><b>${fmt(sim.pos[0], 3)}</b><span>Y</span><b>${fmt(sim.pos[1], 3)}</b><span>Z</span><b>${fmt(sim.pos[2], 3)}</b></div>
      <div class="hud-row dim">
        <span>T${sim.currentTool || '–'}</span>
        <span>${slot ? slot.built.tool.def.name : 'no tool'}</span>
        <span>${mv ? (mv.kind === 'rapid' ? 'G0 rapid' : `F${fmt(mv.feed, 0)}`) : ''}</span>
        <span>${mv && mv.rpm ? `S${mv.rpm}` : ''}</span>
      </div>
      <div class="hud-row dim"><span>removed</span><b>${fmt(sim.removedVolume / 1000, 2)} cm³</b></div>`;

    this.toolView.setAlert(errors.length > 0 && this.state.playing && errors[errors.length - 1].moveIndex >= sim.moveIndex - 2);

    if (errors.length) {
      this.badge.style.display = '';
      this.badge.textContent = `${errors.length} collision${errors.length === 1 ? '' : 's'}`;
      this.badge.onclick = () => this.setTab('results');
    } else {
      this.badge.style.display = 'none';
    }
  }

  refreshResults() {
    if (this.panels && this.activeTab === 'results') this.panels.results.refresh();
  }

  // ---- helpers used by the panels ----------------------------------------

  /**
   * Frame the job. Deliberately ignores the tool and the backplot: both
   * reach up to the home position, and framing a 25 mm part against a
   * 250 mm retract leaves nothing to look at.
   */
  fitToScene() {
    const box = new THREE.Box3();
    box.union(this.stockView.boundingBox());
    const md = this.models.boundingBox();
    if (!md.isEmpty()) box.union(md);
    if (this.state.machine.mode === 'machine') box.union(this.machineView.boundingBox());
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(100, 100, 100));
    this.viewer.fit(box);
  }

  fitToProgram() {
    const box = this.toolpathView.boundingBox();
    if (box.isEmpty()) {
      this.fitToScene();
      return;
    }
    // Clip the retract height so a G28 does not dominate the framing.
    const stockTop = this.stock ? this.stock.top : 0;
    box.max.z = Math.min(box.max.z, stockTop + Math.max(40, (box.max.z - box.min.z) * 0.2));
    this.viewer.fit(box);
  }

  fitStockToProgram() {
    const program = this.state.program;
    if (!program || !program.moves.length) {
      this.notify('No program to size the stock from.', 'error');
      return;
    }
    const b = program.stats.bounds;
    const pad = 6;
    const size = [
      Math.max(b.max[0] - b.min[0] + pad * 2, 10),
      Math.max(b.max[1] - b.min[1] + pad * 2, 10),
      Math.max(b.max[2] - b.min[2], 5),
    ];
    // Rapids to the home position blow up the Z span; clamp to the cutting depth.
    const cutMin = program.moves.reduce((m, mv) => (mv.kind === 'rapid' ? m : Math.min(m, mv.to[2], mv.from[2])), Infinity);
    const depth = Number.isFinite(cutMin) ? Math.max(-cutMin + 4, 5) : size[2];
    this.setStock({
      size: [size[0], size[1], depth],
      origin: [b.min[0] - pad, b.min[1] - pad, -depth],
    });
    this.fitToScene();
    this.notify(`Stock set to ${fmt(size[0], 1)} × ${fmt(size[1], 1)} × ${fmt(depth, 1)} mm.`, 'ok');
  }

  addPrimitiveFixture(kind) {
    const s = this.state.stock;
    const specs = {
      vice: [
        { name: 'Vice jaw (fixed)', min: [-90, s.origin[1] - 26, s.origin[2] - 4], max: [90, s.origin[1] - 8, s.origin[2] + s.size[2] * 0.45] },
        { name: 'Vice jaw (moving)', min: [-90, s.origin[1] + s.size[1] + 8, s.origin[2] - 4], max: [90, s.origin[1] + s.size[1] + 26, s.origin[2] + s.size[2] * 0.45] },
      ],
      parallels: [
        { name: 'Parallel', min: [s.origin[0], s.origin[1] + 6, s.origin[2] - 20], max: [s.origin[0] + s.size[0], s.origin[1] + 16, s.origin[2]] },
        { name: 'Parallel', min: [s.origin[0], s.origin[1] + s.size[1] - 16, s.origin[2] - 20], max: [s.origin[0] + s.size[0], s.origin[1] + s.size[1] - 6, s.origin[2]] },
      ],
      clamp: [
        { name: 'Toe clamp', min: [s.origin[0] + s.size[0] + 4, -20, s.origin[2] + s.size[2] * 0.4], max: [s.origin[0] + s.size[0] + 46, 20, s.origin[2] + s.size[2] + 18] },
      ],
    };
    for (const spec of specs[kind] || []) {
      const box = boxToTriangles(spec.min, spec.max);
      const model = this.models.add({ name: spec.name, positions: box.positions, role: kind === 'parallels' ? 'fixture' : 'clamp', recentre: false });
      model.source = { file: 'built-in primitive', format: 'box', size: [spec.max[0] - spec.min[0], spec.max[1] - spec.min[1], spec.max[2] - spec.min[2]] };
    }
    this.notify('Fixture added. Drag it with the gizmo or type exact coordinates.', 'ok');
  }

  dropModelToTable(model) {
    model.object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model.object);
    if (box.isEmpty()) return;
    const dz = this.state.machine.tableZ - box.min.z;
    model.object.position.z += dz;
    this.models.setTransform(model, {});
  }

  // ---- placement ---------------------------------------------------------
  //
  // Every placement tool is the same conversation: pick a point on the
  // thing, pick where that point should end up, apply the delta. It reads
  // the way a machinist sets a job — "this corner goes there" — instead of
  // asking anybody to compute an offset in their head.

  /** Translate the stock so point A lands on point B. */
  moveStockByPoints() {
    this.pick.begin({
      steps: 2,
      title: 'Move stock',
      hints: ['Click a point on the stock', 'Click where that point should go'],
      onDone: ([a, b]) => {
        const origin = this.state.stock.origin.map((v, i) => v + (b[i] - a[i]));
        this.setStock({ origin });
        this.panels.setup.refresh();
        this.notify(`Stock moved ${fmt(b[0] - a[0], 2)}, ${fmt(b[1] - a[1], 2)}, ${fmt(b[2] - a[2], 2)} mm. The cut was reset.`, 'ok');
      },
    });
    this.buildRibbon();
  }

  /** Translate the selected model so point A lands on point B. */
  moveModelByPoints() {
    const model = this.models.selected;
    if (!model) {
      this.notify('Select a model in the list first.', 'error');
      return;
    }
    this.pick.begin({
      steps: 2,
      title: `Move ${model.name}`,
      hints: [`Click a point on ${model.name}`, 'Click where that point should go'],
      onDone: ([a, b]) => {
        const p = model.object.position;
        this.models.setTransform(model, { position: [p.x + (b[0] - a[0]), p.y + (b[1] - a[1]), p.z + (b[2] - a[2])] });
        this.refreshFixtures();
        this.panels.setup.refresh();
        this.notify(`${model.name} moved ${fmt(b[0] - a[0], 2)}, ${fmt(b[1] - a[1], 2)}, ${fmt(b[2] - a[2], 2)} mm.`, 'ok');
      },
    });
    this.buildRibbon();
  }

  /** Translate the work offset being edited so point A lands on point B. */
  moveOriginByPoints() {
    const key = this.state.wcsEdit;
    this.pick.begin({
      steps: 2,
      title: `Move ${key}`,
      hints: ['Click a point to measure from', 'Click where that point should go'],
      onDone: ([a, b]) => {
        const cur = this.state.wcs[key];
        this.applyWcs(key, [cur[0] + (b[0] - a[0]), cur[1] + (b[1] - a[1]), cur[2] + (b[2] - a[2])]);
      },
    });
    this.buildRibbon();
  }

  /** Drop the work zero straight onto a picked point. */
  setOriginByPoint() {
    const key = this.state.wcsEdit;
    this.pick.begin({
      steps: 1,
      title: `Set ${key} zero`,
      hints: [`Click the point that should read X0 Y0 Z0 in ${key}`],
      onDone: ([p]) => this.applyWcs(key, p),
    });
    this.buildRibbon();
  }

  applyWcs(key, point) {
    const wcs = { ...this.state.wcs, [key]: [point[0], point[1], point[2]] };
    this.setWcs(wcs);
    this.panels.setup.refresh();
    this.notify(`${key} zero set to X ${fmt(point[0], 3)}  Y ${fmt(point[1], 3)}  Z ${fmt(point[2], 3)}.`, 'ok');
  }

  setWcsEdit(key) {
    this.state.wcsEdit = key;
    this.refreshOrigins();
    this.panels.setup.refresh();
    this.buildRibbon();
  }

  // ---- exports -----------------------------------------------------------

  exportStockStl() {
    if (!this.stock) return;
    const mesh = heightmapToTriangles(this.stock, { decimate: this.state.exportDecimate });
    const buffer = writeSTL(mesh.positions, { name: 'machined-stock' });
    download('machined-part.stl', new Blob([buffer], { type: 'model/stl' }));
    this.notify(`Exported ${mesh.triangles.toLocaleString()} triangles.`, 'ok');
  }

  exportStockObj() {
    if (!this.stock) return;
    const mesh = heightmapToTriangles(this.stock, { decimate: this.state.exportDecimate });
    download('machined-part.obj', writeOBJ(mesh.positions, { name: 'machined-stock' }), 'text/plain');
    this.notify(`Exported ${mesh.triangles.toLocaleString()} triangles.`, 'ok');
  }

  exportAssemblyStl(built) {
    if (!built) {
      this.notify('Select an assembly first.', 'error');
      return;
    }
    const parts = [
      latheToTriangles(built.toolPoints, { segments: 96 }),
      built.holderPoints.length > 1 ? latheToTriangles(built.holderPoints, { segments: 96 }) : null,
    ].filter(Boolean);
    const total = parts.reduce((n, p) => n + p.positions.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      all.set(p.positions, o);
      o += p.positions.length;
    }
    const buffer = writeSTL(all, { name: built.tool.def.name });
    download(`${built.tool.def.name.replace(/\W+/g, '-').toLowerCase()}.stl`, new Blob([buffer], { type: 'model/stl' }));
    this.notify('Assembly exported as STL.', 'ok');
  }

  exportModelStl(model) {
    if (!model) {
      this.notify('Select a model first.', 'error');
      return;
    }
    const positions = this.models.worldPositions(model);
    const buffer = writeSTL(positions, { name: model.name });
    download(`${model.name.replace(/\W+/g, '-').toLowerCase()}.stl`, new Blob([buffer], { type: 'model/stl' }));
  }

  buildReport() {
    const sim = this.simulator;
    const program = this.state.program;
    const lines = [];
    lines.push('# Mill-Sim verification report', '');
    lines.push(`Generated ${new Date().toISOString()}`, '');
    lines.push('## Job', '');
    lines.push(`- Program: \`${this.state.programName}\``);
    if (program) {
      lines.push(`- Blocks: ${program.stats.blockCount}, moves: ${program.stats.moveCount}`);
      lines.push(`- Estimated cycle time: ${fmtDuration(program.stats.cycleTime)}`);
    }
    const s = this.state.stock;
    lines.push(`- Stock: ${s.size.join(' × ')} mm at origin ${s.origin.join(', ')}`);
    lines.push(`- Simulation grid: ${this.stock.nx} × ${this.stock.ny} columns, ${fmt(this.stock.dx, 3)} mm cells`);
    lines.push(`- Material removed: ${fmt(sim.removedVolume / 1000, 2)} cm³ of ${fmt(this.stock.stockVolume / 1000, 2)} cm³`);
    lines.push(`- Simulated: ${(sim.progress * 100).toFixed(1)}% of the program`, '');

    lines.push('## Tool assemblies', '');
    lines.push('| T | Assembly | Cutter | Holder | Stickout |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const a of this.library.assemblies) {
      const built = this.library.build(a.id, this.state.machine);
      if (!built) continue;
      lines.push(`| ${a.number} | ${a.name} | Ø${fmt(built.cutRadius * 2, 2)} ${built.tool.def.type} | ${built.holder ? built.holder.def.name : '—'} | ${fmt(built.stickout, 1)} mm |`);
    }
    lines.push('');

    lines.push('## Collisions', '');
    if (!sim.collisions.length) {
      lines.push('None found.');
    } else {
      lines.push('| Severity | Type | Line | Detail |');
      lines.push('| --- | --- | --- | --- |');
      for (const c of sim.collisions) {
        lines.push(`| ${c.severity} | ${c.label} | ${c.line} | ${c.message}${c.count > 1 ? ` (${c.count}×)` : ''} |`);
      }
    }
    lines.push('');

    if (program && program.warnings.length) {
      lines.push('## Interpreter notes', '');
      for (const w of program.warnings) lines.push(`- **L${w.line}** (${w.severity}) ${w.message}`);
    }
    return lines.join('\n');
  }

  // ---- notifications -----------------------------------------------------

  notify(message, level = 'info') {
    const node = el(`div.toast.toast-${level}`, {}, message);
    this.toast.appendChild(node);
    setTimeout(() => node.classList.add('show'), 10);
    setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => node.remove(), 400);
    }, level === 'error' ? 7000 : 3800);
    while (this.toast.children.length > 4) this.toast.firstChild.remove();
  }
}
