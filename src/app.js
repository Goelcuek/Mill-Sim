// Application shell: owns the state, wires the panels to the scene and
// drives the simulation clock.

import * as THREE from 'three';

import { Viewer } from './scene/viewer.js';
import { StockView } from './scene/stockView.js';
import { ToolView } from './scene/toolView.js';
import { ToolpathView } from './scene/toolpathView.js';
import { MachineView, DEFAULT_MACHINE } from './scene/machineView.js';
import { ModelsView } from './scene/modelsView.js';

import { ToolLibrary } from './tools/library.js';
import { Stock } from './sim/stock.js';
import { Simulator } from './sim/simulator.js';
import { silhouetteSpheres } from './sim/collision.js';
import { interpret } from './gcode/interpreter.js';

import { heightmapToTriangles, latheToTriangles, boxToTriangles } from './io/mesh.js';
import { writeSTL, writeOBJ } from './io/stl.js';

import { el, clear, button, download } from './ui/dom.js';
import { SetupPanel } from './ui/setupPanel.js';
import { ToolsPanel } from './ui/toolsPanel.js';
import { ProgramPanel } from './ui/programPanel.js';
import { ModelsPanel } from './ui/modelsPanel.js';
import { ResultsPanel } from './ui/resultsPanel.js';
import { fmt, fmtDuration, clamp } from './core/util.js';

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
      display: {
        grid: true, axes: true, stock: true, tool: true, holder: true,
        toolpath: true, rapids: true, backplot: 'all', toolOpacity: 1,
        sectionPct: 100, stockColor: '#6b7688', toolColors: true, showLimits: false,
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

    this.fitToScene();
    this.notify('Pick an example in the Program tab, or open your own G-code.', 'info');
  }

  // ---- layout ------------------------------------------------------------

  buildLayout() {
    clear(this.root);

    this.tabsBar = el('div.tabs');
    this.panelHost = el('div.panel-host');
    this.sidebar = el('aside.sidebar', {}, [this.tabsBar, this.panelHost]);

    this.viewportHost = el('div.viewport');
    this.hud = el('div.hud');
    this.badge = el('div.crash-badge');
    this.viewOverlay = el('div.view-overlay', {}, [this.hud, this.badge]);
    this.viewportHost.appendChild(this.viewOverlay);

    this.transport = el('div.transport');
    this.toast = el('div.toast-host');

    this.root.appendChild(el('header.topbar', {}, [
      el('div.brand', {}, [el('span.brand-mark', {}, '⌗'), el('span', {}, 'Mill-Sim'), el('span.brand-sub', {}, '3-axis CNC mill verification')]),
      el('div.spacer'),
      this.viewButtons(),
    ]));
    this.root.appendChild(el('div.workspace', {}, [
      this.sidebar,
      el('main.main', {}, [this.viewportHost, this.transport]),
    ]));
    this.root.appendChild(this.toast);
  }

  viewButtons() {
    const mk = (label, name, title) => button(label, () => this.viewer.setView(name), { title });
    return el('div.view-buttons', {}, [
      mk('ISO', 'iso', 'Isometric view'),
      mk('Top', 'top', 'Look down Z'),
      mk('Front', 'front', 'Look along +Y'),
      mk('Right', 'right', 'Look along −X'),
      button('Fit', () => this.fitToScene(), { title: 'Frame everything in the scene' }),
    ]);
  }

  // ---- scene -------------------------------------------------------------

  buildScene() {
    this.viewer = new Viewer(this.viewportHost);
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

    this.toolView = new ToolView();
    this.viewer.add(this.toolView.group);
  }

  // ---- panels ------------------------------------------------------------

  buildPanels() {
    this.panels = {
      setup: new SetupPanel(this),
      tools: new ToolsPanel(this),
      program: new ProgramPanel(this),
      models: new ModelsPanel(this),
      results: new ResultsPanel(this),
    };
    this.tabOrder = [
      ['setup', 'Setup'],
      ['tools', 'Tools'],
      ['program', 'Program'],
      ['models', 'Models'],
      ['results', 'Results'],
    ];
    clear(this.tabsBar);
    for (const [id, label] of this.tabOrder) {
      this.tabsBar.appendChild(el('button.tab', {
        type: 'button',
        dataset: { tab: id },
        onclick: () => this.setTab(id),
      }, label));
    }
    this.setTab('program');
  }

  setTab(id) {
    this.activeTab = id;
    for (const node of this.tabsBar.children) node.classList.toggle('active', node.dataset.tab === id);
    clear(this.panelHost);
    this.panelHost.appendChild(this.panels[id].root);
    if (this.panels[id].refresh) this.panels[id].refresh();
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
    this.stockView.setStock(this.stock);
    this.applyDisplay();
    this.simulator.load({ stock: this.stock });
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
    Object.assign(this.state.machine, patch);
    this.machineView.setConfig(this.state.machine);
    this.machineView.setLimitsVisible(this.state.display.showLimits);
    this.simulator.load({ machine: this.state.machine });
    this.scheduleSlotRefresh();
    this.viewer.invalidate();
  }

  setWcs(wcs) {
    this.state.wcs = wcs;
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
    this.viewer.invalidate();
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
    });
    this.state.program = program;
    this.toolpathView.setProgram(program);
    this.simulator.load({
      program,
      stock: this.stock,
      slots: this.slots || new Map(),
      fallbackSlot: this.fallbackSlot,
      machine: this.state.machine,
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
    const tip = this.machineView.update(this.state.program ? sim.pos : this.parkPosition());
    this.toolView.setPosition(tip[0], tip[1], tip[2]);
    this.toolpathView.setProgress(sim.progress);
    if (this.state.display.toolpath) {
      const r = sim.activeSlot ? sim.activeSlot.built.cutRadius : 1;
      this.toolpathView.setMarker(sim.pos[0], sim.pos[1], sim.pos[2], Math.max(r * 0.5, 0.7));
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
