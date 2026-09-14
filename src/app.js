// Application shell: owns the state, wires the panels to the scene and
// drives the simulation clock.

import * as THREE from 'three';

import { Viewer } from './scene/viewer.js';
import { StockView } from './scene/stockView.js';
import { ToolView } from './scene/toolView.js';
import { ToolpathView } from './scene/toolpathView.js';
import { MachineView, DEFAULT_MACHINE, MACHINE_SETTINGS } from './scene/machineView.js';
import { defaultMacros, DEFAULT_PARAMETERS, makeMacro, normaliseCode } from './machine/macros.js';
import { MachineParts } from './machine/parts.js';
import { PRESETS, buildPreset } from './machine/presets.js';
import { Kinematics } from './machine/kinematics.js';
import { ModelsView } from './scene/modelsView.js';
import { PickController } from './scene/pickController.js';
import { StockGizmo } from './scene/stockGizmo.js';
import { MeasureView, circleThrough } from './scene/measureView.js';
import { OriginView } from './scene/originView.js';

import { ToolLibrary } from './tools/library.js';
import { Stock } from './sim/stock.js';
import { columnFor, describeShape, stockGrid } from './sim/stockShape.js';
import { Simulator } from './sim/simulator.js';
import { silhouetteSpheres } from './sim/collision.js';
import { interpret } from './gcode/interpreter.js';
import { FLAVOUR_DIALECT, controlName } from './gcode/dialects.js';

import { heightmapToTriangles, latheToTriangles, boxToTriangles } from './io/mesh.js';
import { buildTargetMap, compareToTarget } from './sim/target.js';
import { writeSTL, writeOBJ, parseSTL } from './io/stl.js';
import { writeZip, readZip } from './io/zip.js';
import { writeProject, readProject, isProject } from './io/project.js';

import { el, clear, button, download, pickFile } from './ui/dom.js';
import { SetupPanel } from './ui/setupPanel.js';
import { MachinePanel } from './ui/machinePanel.js';
import { ToolsPanel } from './ui/toolsPanel.js';
import { ProgramPanel } from './ui/programPanel.js';
import { ResultsPanel } from './ui/resultsPanel.js';
import { ViewPanel } from './ui/viewPanel.js';
import { Ribbon } from './ui/ribbon.js';
import { resolveBackground, DEFAULT_BACKGROUND } from './scene/backgrounds.js';
import { fmt, fmtDuration, clamp, uid, clone, wrapAngle, deg2rad, rad2deg } from './core/util.js';

/** Cell sizes offered for the simulation grid, coarse to fine. */
export const RESOLUTIONS = [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.075, 0.05, 0.035, 0.025];

/** A drag, in the words the Stock page uses: millimetres and degrees. */
function placementText(move, turn) {
  const parts = [];
  const axes = ['X', 'Y', 'Z'];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(move[i]) > 5e-4) parts.push(`${axes[i]} ${move[i] > 0 ? '+' : '−'}${fmt(Math.abs(move[i]), 2)} mm`);
  }
  const deg = rad2deg(turn);
  if (Math.abs(deg) > 0.05) parts.push(`turned ${deg > 0 ? '+' : '−'}${fmt(Math.abs(deg), 1)}°`);
  return parts.join('  ');
}

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
      stock: {
        shape: 'box',
        size: [120, 80, 25],
        origin: [-60, -40, -25],
        /**
         * How far the billet is turned in the vice, in degrees about Z.
         *
         * Only about Z: material runs in columns from the base upwards, so
         * a block tipped about X or Y is a solid this model cannot hold.
         * Tilting the *part* is what the machine's rotaries do.
         */
        rotation: 0,
        resolution: 0.28,
        /** Round bar only. */
        diameter: 80,
        /** A model used as stock: its triangles, kept in memory only. */
        model: null,
      },
      machine: {
        ...DEFAULT_MACHINE,
        controller: { ...DEFAULT_MACHINE.controller },
        // Fresh copies: editing this machine's macros must not edit the
        // defaults every other machine starts from.
        macros: defaultMacros(DEFAULT_MACHINE.controller.flavour),
        parameters: { ...DEFAULT_PARAMETERS },
        subprograms: [],
      },
      wcs: { G54: [0, 0, 0], G55: [0, 0, 0], G56: [0, 0, 0], G57: [0, 0, 0], G58: [0, 0, 0], G59: [0, 0, 0] },
      machineZero: [0, 0, 250],
      /** Which work offset the Setup panel and the placement tools act on. */
      wcsEdit: 'G54',
      display: {
        grid: true, axes: true, stock: true, tool: true, holder: true,
        toolpath: true, rapids: true, backplot: 'all', toolOpacity: 1, origins: true,
        sectionPct: 100, stockColor: '#b9c0cb', toolColors: true, showLimits: false,
        background: DEFAULT_BACKGROUND, backgroundCustom: '#8b93a3',
      },
      program: null,
      source: '',
      programName: 'program.nc',
      /**
       * Subprogram files the main program may call with M98. Kept beside
       * the main text rather than inside it, because that is how they
       * arrive from the post and how they live on the control.
       */
      subprograms: [],
      playing: false,
      speed: '4',
      activeAssemblyId: null,
      persistLibrary: true,
      exportDecimate: 1,
      seekTarget: null,
      /** What has been measured on the part, newest last. */
      measurements: [],
      /**
       * What the crash model looks for.
       *
       * `nearMiss` is how much room the assembly is asked to leave: zero
       * means report metal in metal and nothing else, which is what a check
       * was before anyone could ask for clearance. `parts` says which of
       * the assembly is checked at all — a shop that models its holders
       * generously would rather not be told about the holder every block.
       */
      checks: {
        nearMiss: 0,
        parts: { tool: true, shank: true, holder: true, spindle: true },
        rapidIntoStock: true,
      },
      /** How far the cutter may pass the reference surface before it gouges. */
      gougeTolerance: 0.02,
    };

    this.library = new ToolLibrary();
    if (!this.library.restore()) this.library.loadDefaults();
    /** Said out loud once the notifier exists; see `start()`. */
    this.libraryRepaired = this.library.repaired || [];
    this.simulator = new Simulator();
    this.stock = null;

    this.buildLayout();
    this.buildScene();
    this.buildPanels();
    this.buildTransport();

    this.rebuildStock();
    this.refreshSlots();
    this.applyDisplay();

    this.viewer.onFrame((dt, redrawing) => this.frame(dt, redrawing));
    this.viewer.start();
    this.bindKeys();

    this.library.onChange(() => {
      if (this.state.persistLibrary) this.library.save();
      this.scheduleSlotRefresh();
    });

    requestAnimationFrame(() => this.fitToScene());
    if (this.libraryRepaired.length) {
      this.notify(`The stored library had no ${this.libraryRepaired.join(' and no ')}, so the built-in ${this.libraryRepaired.length === 1 ? 'set was' : 'sets were'} put back. Anything else you had saved is untouched.`, 'info');
    }
    this.notify('Pick an example in the Program tab, or open your own G-code.', 'info');
  }

  // ---- layout ------------------------------------------------------------

  buildLayout() {
    clear(this.root);

    this.ribbon = new Ribbon();
    this.ribbon.onNavigate((tabId, pageId) => this.setPage(tabId, pageId));
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

  /**
   * The ribbon is navigation and nothing else: the tabs say which part of
   * the job you are working on, the row under them says which page of it.
   * Every page is a panel's own, and so is everything that acts on it —
   * that is what keeps one control from growing two homes.
   */
  buildRibbon() {
    if (!this.panels) return;
    this.ribbon.setTabs(this.tabOrder.map(([id, label]) => ({
      id,
      label,
      pages: this.panels[id] ? this.panels[id].pages : [],
    })));
    const panel = this.panels[this.activeTab];
    this.ribbon.setActive(this.activeTab, panel ? panel.page : null);
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
    // The grid and the origin axes mark work zero, so they ride the table.
    this.viewer.setHelperFrame(this.machineView.workGroup);

    this.toolView = new ToolView();
    this.viewer.add(this.toolView.group);

    this.measure = new MeasureView(this.viewer, this.viewOverlay);

    this.pick = new PickController(this.viewer, {
      stock: () => this.stock,
      models: () => this.models,
      machine: () => this.state.machine,
      origins: () => Object.entries(this.state.wcs).map(([name, point]) => ({ name, point })),
      // Work coordinates are whatever the table is carrying, which in
      // full-machine view is somewhere else entirely.
      workFrame: () => this.machineView.workGroup,
      bodies: () => this.machineView.pickMeshes(),
      axisOrigins: () => {
        const kin = this.machineView.kinematics;
        const out = [];
        for (const node of kin.order) {
          const g = this.machineView.nodeGroups.get(node.id);
          if (!g) continue;
          g.updateWorldMatrix(true, false);
          const e = g.matrixWorld.elements;
          out.push({ name: node.name, point: [e[12], e[13], e[14]] });
        }
        return out;
      },
    });
    this.pick.onUpdate = (s) => this.renderPickBar(s);

    // The block gets handles of its own, like the fixtures have.
    this.stockGizmo = new StockGizmo(this.viewer, {
      frame: () => this.machineView.workGroup,
      onPreview: (move, turn) => this.previewStockPlacement(move, turn),
      onCommit: (move, turn) => this.commitStockPlacement(move, turn),
      onChange: (move, turn) => this.showPlacementBar(placementText(move, turn)),
    });
    this.bindViewportSelection();
    this.refreshOrigins();
  }

  /**
   * Click something to work on it.
   *
   * A list is a poor way to say "that one" about a thing you can see. So a
   * plain click in the viewport selects what it lands on — the block, or a
   * fixture — puts the handles on it and opens the page that describes it.
   * A click on nothing puts the handles away.
   *
   * A click is only a click when it did not orbit the camera and did not
   * land on a handle, which is what the two guards below are for.
   */
  bindViewportSelection() {
    const dom = this.viewer.renderer.domElement;
    let downAt = null;
    dom.addEventListener('pointerdown', (e) => {
      downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    });
    dom.addEventListener('pointerup', (e) => {
      const from = downAt;
      downAt = null;
      if (!from || e.button !== 0) return;
      if (this.activeTab !== 'setup') return;            // handles live on Setup
      if (this.pick.active) return;                      // a pick owns this click
      if (this.gizmoBusy()) return;                      // that was a handle
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) return;   // an orbit
      this.selectAt(e);
    });
  }

  /** Is a transform handle under the pointer, or being pulled? */
  gizmoBusy() {
    const m = this.models.gizmo;
    return this.stockGizmo.busy || !!(m && (m.dragging || m.axis));
  }

  selectAt(event) {
    const hit = this.pick.objectAt(event);
    if (!hit) { this.clearSelection(); return; }
    if (hit.kind === 'model') this.selectModel(hit.model);
    else this.selectStock();
  }

  /** Put the handles on a fixture and open the page that describes it. */
  selectModel(model) {
    this.stockGizmo.detach();
    this.models.select(model);
    this.setPage('setup', 'fixtures');
  }

  /** Put the handles on the block and open the Stock page. */
  selectStock() {
    this.models.select(null);
    this.attachStockGizmo();
    this.setPage('setup', 'stock');
    if (this.panels && this.panels.setup) this.panels.setup.refresh();
  }

  clearSelection() {
    const had = this.stockGizmo.attached || !!this.models.selected;
    this.stockGizmo.detach();
    this.models.select(null);
    this.showPlacementBar(null);
    if (had && this.panels && this.panels.setup) this.panels.setup.refresh();
  }

  /** Where the handles sit: the middle of the block, turned as it is. */
  attachStockGizmo() {
    const s = this.state.stock;
    this.stockGizmo.attach({
      centre: [
        s.origin[0] + s.size[0] / 2,
        s.origin[1] + s.size[1] / 2,
        s.origin[2] + s.size[2] / 2,
      ],
      rotation: deg2rad(s.rotation || 0),
    });
  }

  /**
   * Show the drag before it is real.
   *
   * Moving the stock rebuilds a grid of up to twenty million columns, which
   * is not something to do sixty times a second — so the drag moves the
   * picture and the release moves the block.
   */
  previewStockPlacement(move, turn) {
    const g = this.stockView.group;
    if (!move[0] && !move[1] && !move[2] && !turn) {
      g.matrixAutoUpdate = true;
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
      g.scale.set(1, 1, 1);
      g.updateMatrix();
    } else {
      const s = this.state.stock;
      const cx = s.origin[0] + s.size[0] / 2;
      const cy = s.origin[1] + s.size[1] / 2;
      g.matrixAutoUpdate = false;
      g.matrix
        .makeTranslation(cx + move[0], cy + move[1], move[2])
        .multiply(new THREE.Matrix4().makeRotationZ(turn))
        .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, 0));
    }
    g.matrixWorldNeedsUpdate = true;
    this.viewer.invalidate();
  }

  /** The drag is over: move the block itself. */
  commitStockPlacement(move, turn) {
    const s = this.state.stock;
    // A drag lands on a float; a setup sheet is written in microns. Rounding
    // here is what keeps "Min X" from reading −51.803870054701065.
    const round = (v, places) => Number(v.toFixed(places));
    const origin = [0, 1, 2].map((i) => round(s.origin[i] + move[i], 3));
    const rotation = round(wrapAngle((Number(s.rotation) || 0) + rad2deg(turn)), 2);
    this.previewStockPlacement([0, 0, 0], 0);
    this.showPlacementBar(null);
    this.setStock({ origin, rotation });
    this.attachStockGizmo();
    if (this.panels && this.panels.setup) this.panels.setup.refresh();
    this.notify(`Stock ${placementText(move, turn) || 'unchanged'}. The cut was reset.`, 'ok');
  }

  /** What a drag is doing, while it is doing it. */
  showPlacementBar(text) {
    if (!this.pickBar) return;
    if (this.pick && this.pick.active) return;
    clear(this.pickBar);
    if (!text) { this.pickBar.classList.remove('on'); return; }
    this.pickBar.classList.add('on');
    this.pickBar.append(
      el('span.pick-title', {}, 'Stock'),
      el('span.pick-coord', {}, text),
      el('span.pick-hint', {}, 'release to move the block'),
    );
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
    this.setPage(id, null);
  }

  /**
   * Show one page of one tab. Passing a null page keeps whichever page that
   * tab was last on, so coming back to a tab lands where you left it.
   */
  setPage(tabId, pageId) {
    if (this.pick && this.pick.active) this.pick.cancel();
    const panel = this.panels[tabId];
    if (!panel) return;
    // Placement handles belong to the setup. Leaving them standing while a
    // program runs would only put something in the way of the part.
    if (tabId !== 'setup' && this.stockGizmo) this.clearSelection();
    this.activeTab = tabId;
    if (pageId) panel.setPage(pageId);
    if (this.panelHost.firstChild !== panel.root) {
      clear(this.panelHost);
      this.panelHost.appendChild(panel.root);
      panel.render();
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
      button('⤢', () => this.fitToScene(), { title: 'Fit the job in the view (F)' }),
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
      if (e.key === 'Escape') { this.clearSelection(); return; }
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'r' || e.key === 'R') this.reset();
      else if (e.key === 'ArrowRight') this.stepMove();
      else if (e.key === 'f' || e.key === 'F') this.fitToScene();
    });
  }

  // ---- state changes -----------------------------------------------------

  /**
   * Change what the crash model looks for.
   *
   * A rule that changes what counts as a crash changes the findings, and
   * findings come out of a run — so the run is done again rather than left
   * showing what the old rule found.
   */
  setChecks(patch) {
    const checks = this.state.checks;
    // Merge the parts rather than replace them: a patch that turns the
    // spindle nose off says nothing about the holder, and assigning over
    // the whole object would have quietly dropped the rest.
    const parts = patch.parts ? { ...checks.parts, ...patch.parts } : checks.parts;
    Object.assign(checks, patch, { parts });
    this.simulator.retune({ checks, fixtures: this.models.collisionBoxes() });
    if (patch.parts) this.refreshSlots();
    this.rerunIfFinished();
    if (this.panels && this.panels.setup) this.panels.setup.refresh();
  }

  /** Re-check a run that has already been made, without moving anything. */
  rerunIfFinished() {
    if (!this.state.program || !this.simulator.finished) return;
    this.resetStock();
    this.runToEnd();
  }

  setStock(patch) {
    Object.assign(this.state.stock, patch);
    this.normaliseStock();
    this.rebuildStock();
  }

  /**
   * Keep the stock's description honest about itself.
   *
   * A round bar's footprint is its diameter in both directions, and a
   * stock that says it is a model but has no model is a block.
   */
  normaliseStock() {
    const s = this.state.stock;
    if (s.shape === 'round') {
      const d = Math.max(s.diameter || Math.min(s.size[0], s.size[1]), 0.2);
      s.diameter = d;
      s.size = [d, d, Math.max(s.size[2], 0.2)];
    }
    if (s.shape === 'model' && !(s.model && s.model.positions)) s.shape = 'box';
    // A bar is the same bar however it is turned, and an angle is an angle.
    if (s.shape === 'round') s.rotation = 0;
    else s.rotation = wrapAngle(Number(s.rotation) || 0);
  }

  rebuildStock() {
    const s = this.state.stock;
    // The columns are axis-aligned whatever the billet is doing, so a block
    // clamped at an angle is simulated in a grid big enough for its corners
    // while its own size stays what the shop typed in.
    const grid = stockGrid(s);
    this.stock = new Stock({
      origin: grid.origin,
      size: grid.size,
      resolution: s.resolution,
      // What shape it starts as. A plain block needs no sampler, and gets
      // none, so nothing changes for the case that is already right.
      column: columnFor(s),
    });
    this.stockView.setStock(this.stock, { renderer: this.viewer.renderer });
    this.viewer.setGridExtent(Math.max(s.size[0], s.size[1]));
    this.applyDisplay();
    this.simulator.load({ stock: this.stock });
    this.refreshTarget();
    this.refreshOrigins();
    this.refreshResults();
    // The handles sit on the middle of the block, which has just moved.
    if (this.stockGizmo && this.stockGizmo.attached) this.attachStockGizmo();
    // The Stock page describes this block — its shape, its grid, what is
    // left of it — so it is redrawn with it rather than left saying what
    // the last one was.
    if (this.panels && this.panels.setup) this.panels.setup.refresh();
    this.viewer.invalidate();
  }

  resetStock() {
    if (this.stock) this.stock.reset();
    this.simulator.reset();
    this.stockView.sync(true);
    this.refreshResults();
    this.viewer.invalidate();
  }

  /**
   * Change something about the machine.
   *
   * Only a change to the chain itself re-reads the program, because that is
   * what resets the run. Switching between part and full-machine view is a
   * question about the picture, and it used to throw away the cut — you
   * looked at the machine and your finished part went back to a solid
   * block.
   */
  setMachine(patch) {
    const presetChanged = patch.preset && patch.preset !== 'custom'
      && patch.preset !== this.state.machine.preset;
    const chainChanged = presetChanged
      || patch.controller !== undefined
      || patch.spindleDiameter !== undefined || patch.spindleLength !== undefined;
    Object.assign(this.state.machine, patch);
    this.machineView.setConfig(this.state.machine);
    this.machineView.setLimitsVisible(this.state.display.showLimits);
    if (presetChanged) {
      // A different chain means different castings; nothing hung on the old
      // axes belongs on the new ones.
      for (const p of this.machineParts.parts) p.nodeId = null;
    }
    if (chainChanged) {
      this.applyKinematics();
      this.scheduleSlotRefresh();
    } else {
      this.applyMachineParts();
      this.simulator.retune({ machine: this.state.machine });
      if (this.panels && this.panels.machine) this.panels.machine.refresh();
    }
    this.viewer.invalidate();
  }

  /**
   * Push the current chain everywhere it is needed: the rig, the simulator
   * and the interpreter, which needs it for G53.1.
   */
  applyKinematics() {
    const kin = this.machineView.kinematics;
    kin.rebuild();
    // The readout lists this machine's axes, so it is rebuilt with it.
    this.buildHud();
    this.applyMachineParts();          // which re-rigs the tree as it goes
    this.simulator.load({ machine: this.state.machine, kinematics: kin });
    if (this.state.source) this.loadProgram(this.state.source, this.state.programName);
    if (this.panels && this.panels.machine) this.panels.machine.refresh();
    this.viewer.invalidate();
  }

  /**
   * Mate a body to a point: click a point on it, click where that point
   * should sit, and the body moves so the two coincide.
   *
   * The delta is measured in the scene and then carried into the frame of
   * the axis that carries the body, because that is where its placement is
   * stored — a saddle nudged 20 mm has moved 20 mm along its own slide, not
   * along the floor, and the two are different once anything has rotated.
   */
  mateBodyByPoints(part) {
    if (!part) return;
    if (!part.nodeId) {
      this.notify('Put the body on an axis first — mating moves it within whatever carries it.', 'error');
      return;
    }
    if (this.state.machine.mode !== 'machine') {
      this.setMachine({ mode: 'machine' });
      this.notify('Switched to the full machine so there is something to mate against.', 'info');
    }
    this.pick.begin({
      steps: 2,
      space: 'world',
      bodies: true,
      title: `Mate ${part.name}`,
      hints: [`Click a point on ${part.name}`, 'Click where that point should sit'],
      onDone: ([a, b]) => {
        const node = this.machineView.nodeGroups.get(part.nodeId);
        const delta = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (node) {
          node.updateWorldMatrix(true, false);
          const basis = new THREE.Matrix4().extractRotation(node.matrixWorld).invert();
          delta.applyMatrix4(basis);
        }
        this.machineParts.nudge(part, [delta.x, delta.y, delta.z]);
        this.applyMachineParts();
        if (this.panels && this.panels.machine) this.panels.machine.refresh();
        this.notify(`${part.name} moved ${fmt(delta.x, 2)}, ${fmt(delta.y, 2)}, ${fmt(delta.z, 2)} mm on its axis.`, 'ok');
      },
    });
    this.buildRibbon();
  }

  /**
   * Start a machine from nothing: one control, and one base that does not
   * move.
   *
   * Nothing else is guessed. A table and a spindle are only the shape most
   * mills happen to have, and pre-drawing them makes the chain look finished
   * when it is not — so the tool and the part both start on the base, the
   * Axes page says so, and the chain grows from there.
   *
   * The control is the one thing that cannot be added later: a machine has
   * the control it was built with, and everything that comes with it — how
   * its macros are spelled, what its M codes do, the files in its memory —
   * starts fresh here rather than carrying over from the machine before.
   *
   * @param {string} name
   * @param {string} [control] a controller flavour; see gcode/dialects.js
   * @param {string} [preset] one of the shapes a mill comes in, or nothing
   */
  newMachine(name, control, preset) {
    const flavour = FLAVOUR_DIALECT[control] ? control : this.state.machine.controller.flavour;
    this.state.machine.name = name || 'New machine';
    this.state.machine.controller = {
      ...DEFAULT_MACHINE.controller,
      flavour,
      dialect: FLAVOUR_DIALECT[flavour] || 'fanuc',
      syntax: null,
    };
    this.state.machine.macros = defaultMacros(flavour);
    // A preset is described in stand-in castings, so it keeps them. A bare
    // base is a machine you are about to model yourself, and a generic slab
    // on every axis you have not got to yet is only in the way.
    this.state.machine.proxies = !!(preset && PRESETS[preset]);
    this.state.machine.parameters = { ...DEFAULT_PARAMETERS };
    this.state.machine.subprograms = [];
    const def = {
      name: name || 'New machine',
      toolNode: 'base',
      workNode: 'base',
      spindleOffset: [0, 0, 0],
      tableOffset: [0, 0, 0],
      nodes: [
        { id: 'base', name: 'Base', kind: 'carrier', parent: null, origin: [0, 0, 0] },
      ],
    };
    // The iron: one of the shapes a mill comes in, or nothing at all.
    const known = preset && PRESETS[preset] ? preset : null;
    this.state.machine.preset = known || 'custom';
    this.machineView.setKinematics(known ? buildPreset(known) : new Kinematics(def));
    this.machineView.setConfig(this.state.machine);
    for (const p of this.machineParts.parts) p.nodeId = null;
    this.applyKinematics();
    this.reinterpret();
    this.setPage('machine', 'axes');
    if (known) {
      this.notify(`A ${PRESETS[known].label} with a ${controlName(flavour)} control. Change what you need on the Axes page and bring the bodies in on Assembly.`, 'ok');
      return;
    }
    this.notify(`An empty ${controlName(flavour)} machine: one base. Add axes with “Add axis…” — each says what it is mounted on and what it carries — then mark where the tool hangs and where the part clamps.`, 'ok');
  }

  /**
   * The machine as a set of files, ready to be zipped.
   *
   * Shared by "Save machine" and by the project file, which carries the
   * whole machine inside itself under `machine/`. The same bytes either
   * way, so there is only ever one description of a machine on disk.
   *
   * @param {string} [prefix] the folder the files go in, e.g. "machine/"
   */
  machineFiles(prefix = '') {
    const kin = this.machineView.kinematics;
    const machine = this.state.machine;
    const used = new Set();
    const unique = (name, ext) => {
      const base = String(name || 'part').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'part';
      let out = `${base}${ext}`;
      let n = 2;
      while (used.has(out)) out = `${base}-${n++}${ext}`;
      used.add(out);
      return out;
    };

    const files = [];
    const macros = (machine.macros || []).map((m) => {
      const file = `${prefix}macros/${unique(m.code, '.nc')}`;
      files.push({ name: file, data: `${m.body || ''}\n` });
      return { id: m.id, code: m.code, name: m.name, enabled: m.enabled, notes: m.notes, file };
    });

    const subprograms = (machine.subprograms || []).map((sub) => {
      const file = `${prefix}subprograms/${unique(sub.name.replace(/\.[^.]+$/, ''), '.nc')}`;
      files.push({ name: file, data: `${sub.text || ''}` });
      return { id: sub.id, name: sub.name, file };
    });

    const bodies = [];
    for (const part of this.machineParts.parts) {
      const pos = part.object.geometry.getAttribute('position');
      const file = `${prefix}bodies/${unique(part.name, '.stl')}`;
      files.push({ name: file, data: writeSTL(pos.array, { name: part.name }) });
      bodies.push({
        name: part.name,
        file,
        nodeId: part.nodeId,
        position: [...part.position],
        rotation: [...part.rotation],
      });
    }

    const def = {
      ...kin.toJSON(),
      controller: { ...machine.controller },
      parameters: { ...machine.parameters },
      // Everything else the Machine tab holds: the envelope, the table, the
      // spindle nose, the rates. Not the two display switches — whether the
      // full machine is drawn is about the window, not the machine.
      settings: Object.fromEntries(MACHINE_SETTINGS.map((k) => [k, clone(machine[k])])),
      /** Where the home switches are, which is what G28 and G53 mean. */
      machineZero: [...this.state.machineZero],
      macros,
      subprograms,
      bodies,
      savedBy: 'Mill-Sim',
      saved: new Date().toISOString(),
    };
    files.unshift({ name: `${prefix}machine.json`, data: JSON.stringify(def, null, 2) });
    return { def, files };
  }

  /**
   * Write the machine out as a folder.
   *
   * A machine is not one file. It is a chain, a control, the macros that
   * control runs, and however many castings somebody imported and mated —
   * and the chain is worth nothing without them, because "the saddle is on
   * Y" names a body that has to exist. A page cannot hand out a folder, so
   * it hands out a zip, which every operating system opens as one:
   *
   *   machine.json      the chain, the controller, the parameters, and
   *                     where every body sits on it
   *   macros/M6.nc      one file per macro, plain G-code, editable in any
   *                     editor and readable without this program
   *   subprograms/      the files that live in this control between jobs
   *   bodies/*.stl      the castings themselves
   *   README.txt        what the above is, for whoever opens it in a year
   */
  async exportMachine() {
    const kin = this.machineView.kinematics;
    const stem = (kin.name || 'machine').replace(/\s+/g, '-').toLowerCase();
    const { def, files } = this.machineFiles();
    files.push({
      name: 'README.txt',
      data: [
        `${kin.name} — a Mill-Sim machine.`,
        '',
        'machine.json  the kinematic chain, the controller settings, the',
        '              macro list and where each body sits on which axis.',
        'macros/       one G-code file per M code. Editing these edits what',
        '              the machine does at that code.',
        'subprograms/  the files that live in this control between jobs, the',
        '              ones any program on it can call with M98.',
        'bodies/       the castings, as STL, in millimetres, each in the',
        '              coordinates of the axis that carries it.',
        '',
        'Load the whole folder back with Machine > Layout > Load machine.',
        '',
      ].join('\n'),
    });

    try {
      download(`${stem}.zip`, await writeZip(files), 'application/zip');
      const bits = [
        `${def.macros.length} ${def.macros.length === 1 ? 'macro' : 'macros'}`,
        def.subprograms.length ? `${def.subprograms.length} ${def.subprograms.length === 1 ? 'subprogram' : 'subprograms'}` : null,
        `${def.bodies.length} ${def.bodies.length === 1 ? 'body' : 'bodies'}`,
      ].filter(Boolean);
      this.notify(`Saved ${stem}.zip — the chain, ${bits.join(', ')}.`, 'ok');
    } catch (err) {
      this.notify(`Could not write the machine: ${err.message}`, 'error');
    }
  }

  /**
   * Save the whole job: the program, the machine, the stock, the fixtures
   * and the tools, in one file.
   */
  async saveProject() {
    try {
      const { bytes, name, summary } = await writeProject(this);
      download(name, bytes, 'application/zip');
      this.notify(`Saved ${name} — ${summary.program}, ${summary.tools} cutters, ${summary.models} ${summary.models === 1 ? 'model' : 'models'} and the machine.`, 'ok');
    } catch (err) {
      this.notify(`Could not write the project: ${err.message}`, 'error');
    }
  }

  /** Open a project, or a machine — both are zips, and both say which. */
  async openProject() {
    const [file] = await pickFile('.zip,.millsim,.json');
    if (!file) return;
    try {
      if (/\.json$/i.test(file.name)) {
        await this.applyMachineDefinition(JSON.parse(await file.text()), null, file.name);
        return;
      }
      const entries = await readZip(await file.arrayBuffer());
      if (!isProject(entries)) {
        // A machine folder opened from the project page is still a machine;
        // there is no reason to make somebody find the other button.
        const machineJson = entries.get('machine.json');
        if (!machineJson) throw new Error('it holds neither a project.json nor a machine.json');
        await this.applyMachineDefinition(JSON.parse(new TextDecoder().decode(machineJson)), entries, file.name);
        return;
      }
      const summary = await readProject(this, entries);
      this.setPage('setup', 'project');
      this.notify(`Opened ${summary.name || file.name} — ${summary.program} on ${summary.machine}, ${summary.tools} cutters, ${summary.models} ${summary.models === 1 ? 'model' : 'models'}.`, 'ok');
    } catch (err) {
      this.notify(`Could not read ${file.name}: ${err.message}`, 'error');
    }
  }

  /** Load a machine: the whole folder, or a bare chain saved before. */
  async importMachine() {
    const [file] = await pickFile('.zip,.json');
    if (!file) return;
    try {
      if (/\.json$/i.test(file.name)) {
        await this.applyMachineDefinition(JSON.parse(await file.text()), null, file.name);
        return;
      }
      const entries = await readZip(await file.arrayBuffer());
      const jsonEntry = entries.get('machine.json')
        || [...entries.keys()].filter((k) => k.endsWith('machine.json')).map((k) => entries.get(k))[0];
      if (!jsonEntry) throw new Error('there is no machine.json in it.');
      await this.applyMachineDefinition(JSON.parse(new TextDecoder().decode(jsonEntry)), entries, file.name);
    } catch (err) {
      this.notify(`Could not read ${file.name}: ${err.message}`, 'error');
    }
  }

  /**
   * Put a machine definition in place.
   *
   * @param {object} def what machine.json held
   * @param {Map<string, Uint8Array>|null} entries the rest of the folder,
   *   when there was one: the macro bodies and the castings themselves.
   * @param {string} filename
   */
  async applyMachineDefinition(def, entries, filename) {
    if (!def || !Array.isArray(def.nodes) || !def.nodes.length) throw new Error('that file has no axes in it.');
    this.machineView.setKinematics(new Kinematics(def));
    this.state.machine.preset = 'custom';
    // The control the machine was saved with, whole: a machine does not
    // half-arrive on a control it was not built for. An older file that
    // names only its flavour still reads the macros that flavour reads.
    if (def.controller) {
      const c = { ...DEFAULT_MACHINE.controller, ...def.controller };
      if (!def.controller.dialect) c.dialect = FLAVOUR_DIALECT[c.flavour] || 'fanuc';
      this.state.machine.controller = c;
    }
    if (def.parameters) this.state.machine.parameters = { ...DEFAULT_PARAMETERS, ...def.parameters };

    // The travels, the table and the spindle nose: the crash model's idea
    // of the machine, which is no use if it stays behind when the machine
    // moves to another computer.
    if (def.settings) {
      for (const key of MACHINE_SETTINGS) {
        if (def.settings[key] !== undefined) this.state.machine[key] = clone(def.settings[key]);
      }
    }
    // A machine saved before stand-ins could be turned off was drawn with
    // them, so that is what it gets back rather than whatever the machine
    // before it happened to be set to.
    if (!def.settings || def.settings.proxies === undefined) this.state.machine.proxies = true;
    if (Array.isArray(def.machineZero) && def.machineZero.length === 3) {
      this.state.machineZero = def.machineZero.map(Number);
    }
    this.machineView.setConfig(this.state.machine);
    this.machineView.setLimitsVisible(this.state.display.showLimits);

    // Macro bodies live in their own files so they can be read and edited
    // outside this program; a machine.json on its own still carries the
    // list, and any body written inline.
    if (Array.isArray(def.macros)) {
      this.state.machine.macros = def.macros.map((m) => {
        let body = m.body || '';
        if (!body && entries && m.file && entries.has(m.file)) {
          body = new TextDecoder().decode(entries.get(m.file)).replace(/\s+$/, '');
        }
        return makeMacro({ ...m, body });
      });
    }

    // Subprograms that live in the machine, one file each.
    if (Array.isArray(def.subprograms)) {
      this.state.machine.subprograms = def.subprograms.map((sub) => ({
        id: sub.id || uid('msub'),
        name: sub.name || (sub.file || 'subprogram').split('/').pop(),
        text: sub.text || (entries && sub.file && entries.has(sub.file)
          ? new TextDecoder().decode(entries.get(sub.file))
          : ''),
      }));
    }

    // The castings, when the folder brought them.
    let loaded = 0;
    if (entries) {
      this.machineParts.clear();
      for (const body of def.bodies || []) {
        const data = body.file && entries.get(body.file);
        if (!data) continue;
        try {
          const stl = parseSTL(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
          const part = this.machineParts.add({ name: body.name || body.file, positions: stl.positions });
          part.source = { file: body.file, format: stl.format };
          loaded++;
        } catch (err) {
          this.notify(`${body.file}: ${err.message}`, 'error');
        }
      }
    } else {
      for (const p of this.machineParts.parts) {
        if (!this.machineView.nodeGroups.has(p.nodeId)) p.nodeId = null;
      }
    }
    const matched = def.bodies ? this.machineParts.restorePlacements(def.bodies) : 0;

    this.applyKinematics();
    this.setPage('machine', 'layout');
    const missing = (def.bodies || []).length - matched;
    this.notify(missing > 0
      ? `Loaded ${this.machineView.kinematics.name}. ${missing} ${missing === 1 ? 'body is' : 'bodies are'} still to import — that file carries the arrangement, not the geometry.`
      : `Loaded ${this.machineView.kinematics.name}${loaded ? ` with ${loaded} ${loaded === 1 ? 'body' : 'bodies'}` : ''}.`, 'ok');
  }

  /** Hang each body on the axis it has been assembled onto. */
  applyMachineParts() {
    const map = new Map();
    for (const part of this.machineParts.parts) {
      if (!part.nodeId || !this.machineView.nodeGroups.has(part.nodeId)) continue;
      this.machineParts.applyTransform(part);
      if (!map.has(part.nodeId)) map.set(part.nodeId, []);
      map.get(part.nodeId).push(part.object);
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
    this.viewer.setBackground(resolveBackground(d.background, d.backgroundCustom));
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

  /**
   * Read a library file into the current one.
   *
   * @param {File} file
   * @param {boolean} merge add to what is here, rather than replace it
   */
  async importLibraryFile(file, merge = true) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const stats = this.library.fromJSON(data, { merge });
      if (!stats) {
        this.notify(`${file.name} has no tools in it that this could read. Mill-Sim libraries and Fusion 360 / HSMWorks tool libraries are both understood; a post or a setup sheet is not.`, 'error');
        return;
      }
      this.refreshSlots();
      const bits = [
        stats.tools ? `${stats.tools} ${stats.tools === 1 ? 'cutter' : 'cutters'}` : null,
        stats.holders ? `${stats.holders} ${stats.holders === 1 ? 'holder' : 'holders'}` : null,
        stats.assemblies ? `${stats.assemblies} ${stats.assemblies === 1 ? 'assembly' : 'assemblies'}` : null,
      ].filter(Boolean);
      this.notify(`${merge ? 'Added' : 'Loaded'} ${bits.join(', ')} from ${file.name}.`, 'ok');
      this.setPage('tools', 'assemblies');
    } catch (err) {
      this.notify(`Could not read ${file.name}: ${err.message}`, 'error');
    }
  }

  /** Add a macro to the machine in the spindle, so to speak. */
  addMacro(patch) {
    const mac = makeMacro(patch);
    if (!Array.isArray(this.state.machine.macros)) this.state.machine.macros = [];
    this.state.machine.macros.push(mac);
    return mac;
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
      // Only the parts of the assembly the rules ask about. The tool and
      // its shank are one silhouette, so they stand or fall together.
      const parts = this.state.checks.parts;
      const points = [
        ...(parts.tool === false && parts.shank === false ? [] : built.toolPoints),
        ...(parts.holder === false ? [] : built.holderPoints),
        ...(parts.spindle === false ? [] : built.spindlePoints),
      ];
      const spheres = silhouetteSpheres(points);
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
      checks: this.state.checks,
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

  /**
   * Read the current program again.
   *
   * Anything that changes what the control would make of the same text —
   * a subprogram, a macro, a parameter, the controller's power-up state —
   * goes through here rather than reaching into loadProgram's arguments.
   */
  reinterpret() {
    if (this.state.source) return this.loadProgram(this.state.source, this.state.programName);
    return null;
  }

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
      controller: this.state.machine.controller,
      // The other two things a control reads: the shop's subprograms, and
      // what this machine's builder made its M codes do.
      // The job's own files first: a program that brings its own O1000
      // means that one, not the machine's.
      subprograms: [...this.state.subprograms, ...(this.state.machine.subprograms || [])],
      macros: this.state.machine.macros,
      parameters: this.state.machine.parameters,
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
    // The machine comes first: changing the chain reloads the program, and
    // the stock has to be the right size before that runs.
    if (setup.machine) {
      Object.assign(this.state.stock, setup.stock || {});
      if (setup.stock) this.rebuildStock();
      this.setMachine(setup.machine);
      this.panels.setup.refresh();
      this.panels.machine.refresh();
      return;
    }
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
  }

  pause() {
    this.state.playing = false;
    if (this.playBtn) this.playBtn.textContent = '▶';
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

  /**
   * One tick of the loop.
   *
   * @param {number} dt seconds since the last tick
   * @param {boolean} redrawing whether the viewer is about to draw anyway
   *
   * Nothing here runs when the program is paused and nothing has changed.
   * Posing the machine means solving the chain and an inverse-kinematics
   * solve on top; rewriting the readout means rebuilding a piece of the
   * document. Doing either sixty times a second to produce the picture
   * that is already on screen is how an idle simulator ends up holding a
   * core at full tilt.
   */
  frame(dt, redrawing) {
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
      // The tool has moved, so the picture is stale whatever else happened.
      this.viewer.invalidate();
      this.showAssembly(sim.activeSlot);
      this.stockView.sync();
      this.updateTransport();
      this._resultTick = (this._resultTick || 0) + 1;
      if (this._resultTick % 20 === 0) this.refreshResults();
    }

    if (!worked && !redrawing) return;

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

  /**
   * The readout over the viewport.
   *
   * Its nodes are built once and only their text is rewritten. Setting
   * innerHTML would reparse and rebuild this markup on every frame of a
   * run, which is a surprising amount of work to display six numbers.
   */
  buildHud() {
    const cell = (cls, text) => el(cls, {}, text);
    this.hudFields = {};
    const val = (key) => (this.hudFields[key] = el('b'));
    const dim = (key) => (this.hudFields[key] = el('span'));

    // Whatever this machine has beyond the tip: the rotaries, and any extra
    // slide such as W. A 3-axis mill gets no second row at all.
    const extras = this.machineView ? this.machineView.kinematics.extras() : [];
    this.hudExtras = extras.map((n) => n.letter);
    const extraRow = extras.length
      ? el('div.hud-row', {}, extras.flatMap((n) => [cell('span.hud-axis', n.letter), val(`ax${n.letter}`)]))
      : null;

    clear(this.hud);
    this.hud.append(...[
      el('div.hud-row', {}, [
        cell('span', 'X'), val('x'), cell('span', 'Y'), val('y'), cell('span', 'Z'), val('z'),
      ]),
      extraRow,
      el('div.hud-row.dim', {}, [dim('tool'), dim('toolName'), dim('feed'), dim('rpm')]),
      el('div.hud-row.dim', {}, [cell('span', 'removed'), val('removed')]),
    ].filter(Boolean));
  }

  updateHud() {
    const sim = this.simulator;
    const mv = this.state.program && this.state.program.moves[sim.moveIndex];
    const slot = sim.activeSlot;
    const errors = sim.collisions.filter((c) => c.severity === 'error');

    if (!this.hudFields) this.buildHud();
    const f = this.hudFields;
    const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    set(f.x, fmt(sim.pos[0], 3));
    set(f.y, fmt(sim.pos[1], 3));
    set(f.z, fmt(sim.pos[2], 3));
    if (this.hudExtras && this.hudExtras.length) {
      const values = sim.currentPose().values || {};
      for (const L of this.hudExtras) {
        const node = f[`ax${L}`];
        if (node) set(node, fmt(values[L] || 0, 3));
      }
    }
    set(f.tool, `T${sim.currentTool || '–'}`);
    set(f.toolName, slot ? slot.built.tool.def.name : 'no tool');
    set(f.feed, mv ? (mv.kind === 'rapid' ? 'G0 rapid' : `F${fmt(mv.feed, 0)}`) : '');
    set(f.rpm, mv && mv.rpm ? `S${mv.rpm}` : '');
    set(f.removed, `${fmt(sim.removedVolume / 1000, 2)} cm³`);

    this.toolView.setAlert(errors.length > 0 && this.state.playing && errors[errors.length - 1].moveIndex >= sim.moveIndex - 2);

    if (errors.length) {
      this.badge.style.display = '';
      this.badge.textContent = `${errors.length} collision${errors.length === 1 ? '' : 's'}`;
      this.badge.onclick = () => this.setPage('results', 'findings');
    } else {
      this.badge.style.display = 'none';
    }
  }

  refreshResults() {
    if (!this.panels) return;
    if (this.activeTab === 'results') this.panels.results.refresh();
    // The ribbon carries the finding count, so it follows the run.
    if (this.ribbon) this.buildRibbon();
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
    this.notify('Fixture added. Click it in the viewport to put handles on it — drag to move, or the rings to turn it — or type exact coordinates.', 'ok');
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

  // ---- measuring ---------------------------------------------------------
  //
  // Everything picked is in work coordinates, which is what a drawing is
  // in: "40.002 from the datum" means the same thing here as on the print.

  /** Two points: the distance between them, and its three components. */
  measureDistance() {
    this.pick.begin({
      steps: 2,
      title: 'Measure',
      hints: ['Click the first point', 'Click the second point'],
      onDone: ([a, b]) => {
        const delta = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        this.addMeasurement({
          kind: 'distance',
          points: [a, b],
          delta,
          value: Math.hypot(delta[0], delta[1], delta[2]),
        });
      },
    });
    this.buildRibbon();
  }

  /** Three points on a bore or a boss: its diameter and centre. */
  measureCircle() {
    this.pick.begin({
      steps: 3,
      title: 'Measure a circle',
      hints: ['Click a point on the circle', 'Click a second point', 'Click a third point'],
      onDone: (points) => {
        const circle = circleThrough(...points);
        if (!circle) {
          this.notify('Those three points are in a line, so there is no circle through them.', 'error');
          return;
        }
        this.addMeasurement({
          kind: 'circle',
          points,
          centre: circle.centre,
          value: circle.radius * 2,
        });
      },
    });
    this.buildRibbon();
  }

  addMeasurement(item) {
    this.state.measurements.push({ id: uid('meas'), ...item });
    this.refreshMeasurements();
    const m = this.state.measurements[this.state.measurements.length - 1];
    this.notify(m.kind === 'circle'
      ? `Ø${fmt(m.value, 3)} mm, centre X ${fmt(m.centre[0], 3)} Y ${fmt(m.centre[1], 3)} Z ${fmt(m.centre[2], 3)}.`
      : `${fmt(m.value, 3)} mm — ΔX ${fmt(m.delta[0], 3)}  ΔY ${fmt(m.delta[1], 3)}  ΔZ ${fmt(m.delta[2], 3)}.`, 'ok');
  }

  removeMeasurement(id) {
    this.state.measurements = this.state.measurements.filter((m) => m.id !== id);
    this.refreshMeasurements();
  }

  clearMeasurements() {
    this.state.measurements = [];
    this.refreshMeasurements();
  }

  refreshMeasurements() {
    // Drawn in the work frame, so they stay on the part when the table moves.
    this.measure.attach(this.pick.frameObject() || this.viewer.scene);
    this.measure.setItems(this.state.measurements);
    if (this.panels && this.panels.view) this.panels.view.refresh();
    // The page's count is in the ribbon, so it is redrawn with the list.
    if (this.ribbon) this.buildRibbon();
    this.viewer.invalidate();
  }

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
