// Setup: the job. The block, where zero is, and what is clamped around it.
//
// Three pages, and everything that acts on them lives here rather than in
// the ribbon: the ribbon says which page you are on, this says what is on
// it. Fixtures are the one thing on these pages that gets created from
// nothing, so that is the one thing behind an Add button and a window.

import { el, field, select, checkbox, button, row, section } from './dom.js';
import { Panel, addBar, actionRow } from './panel.js';
import { openFixtureDialog, openStockDialog } from './setupDialogs.js';
import { MODEL_ROLES } from '../scene/modelsView.js';
import { fmt } from '../core/util.js';
import { describeShape } from '../sim/stockShape.js';
import { homeOf } from '../machine/config.js';
import { RESOLUTIONS } from '../app.js';
import * as units from '../core/units.js';

const AXES = ['X', 'Y', 'Z'];
const GIZMOS = [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale']];

export class SetupPanel extends Panel {
  constructor(app) {
    super(app, [
      { id: 'project', label: 'Project', icon: 'save', hint: 'The whole job in one file: program, machine, stock, tools and fixtures', render: SetupPanel.prototype.projectPage },
      { id: 'stock', label: 'Stock', icon: 'cube', hint: 'The block, where it sits and how finely it is simulated', render: SetupPanel.prototype.stockPage },
      { id: 'origin', label: 'Work offsets', icon: 'target', hint: 'Where X0 Y0 Z0 is for each offset', render: SetupPanel.prototype.originPage },
      { id: 'fixtures', label: 'Fixtures', icon: 'vice', hint: 'Vices, clamps, parallels and reference parts', badge: () => app.models.models.length || null, render: SetupPanel.prototype.fixturesPage },
      { id: 'checks', label: 'Checks', icon: 'gouge', hint: 'What counts as a crash: clearances, and what is checked at all', render: SetupPanel.prototype.checksPage },
    ]);
    this.gizmoMode = 'translate';
    /** Which handles the block gets: Move or Turn. */
    this.stockGizmoMode = 'translate';
    this.importOpts = { units: 'mm', role: 'fixture', recentre: true };
    // A fixture that has been moved is in a different place, and the crash
    // model has to hear about it: dragging a clamp into the tool's path and
    // being told nothing is the one thing this page must not do.
    app.models.onChange = (kind) => {
      if (kind && kind !== 'select') {
        app.refreshFixtures();
        if (kind === 'transform') app.rerunIfFinished();
      }
      this.refresh();
    };
    this.render();
  }

  // ---- pages -------------------------------------------------------------

  /**
   * The job as one file.
   *
   * Everything else on this tab describes one part of a setup; this page is
   * the setup itself, which is the only thing worth keeping when the
   * browser tab closes.
   */
  projectPage() {
    const app = this.app;
    const s = app.state;
    const kin = app.machineView.kinematics;
    const program = s.program;

    const stat = (label, value, dim) => el('div.stat', {}, [
      el('div.stat-label', {}, label),
      el(`div.stat-value${dim ? '.dim' : ''}`, {}, value),
    ]);

    return section('Project', [
      el('div.hint', {}, 'A setup is not a program. It is a program, the machine it runs on, the stock it starts from, where that stock sits, which tools the T numbers mean, and the clamps standing around it — and losing any one of those makes the rest unverifiable. They are saved together.'),
      actionRow([
        { label: 'Save project…', variant: 'primary', onClick: () => app.saveProject(), hint: 'One zip holding all of it' },
        { label: 'Open project…', onClick: () => app.openProject(), hint: 'A project saved earlier — or a machine folder' },
      ]),
      el('div.stat-grid', {}, [
        stat('Program', s.programName || 'none', !s.programName),
        stat('Blocks', program ? String(program.stats.blockCount) : '—', !program),
        stat('Subprograms', String(s.subprograms.length)),
        stat('Machine', kin.name, false),
        stat('Tool table', `${app.library.assemblies.length} assemblies`),
        stat('Models', `${app.models.models.length} loaded`),
      ]),
      el('div.hint', {}, 'Inside the zip: project.json for the setup, program/ for the G-code, machine/ laid out exactly as Save machine writes it, library.json for the tools, models/ and stock/ as STL. Every part of it opens in something else — a project only this program can read is a hostage, not an archive.'),
    ]);
  }

  stockPage() {
    return [this.stockSection()];
  }

  originPage() {
    return [this.originSection()];
  }

  /**
   * What the crash model looks for.
   *
   * A collision check is a rule, and a rule that cannot be adjusted is a
   * rule people learn to ignore: the shop that models its holders
   * generously gets a holder crash on every block and stops reading the
   * findings at all. So the distances and the exceptions live here, in one
   * place, rather than being hard-coded as "touching is bad".
   */
  checksPage() {
    const app = this.app;
    const c = app.state.checks;
    const parts = c.parts;

    const partRow = (key, label, hint) => checkbox(label, parts[key] !== false, (v) => {
      app.setChecks({ parts: { [key]: v } });
    }, { title: hint });

    const ignored = app.models.models.filter((m) => m.ignore).length;
    const special = app.models.models.filter((m) => Number.isFinite(m.clearance)).length;

    return [
      section('Clearance', [
        el('label.field', {}, [
          el('span.field-label', {}, ['Near miss ', el('span.value', {}, c.nearMiss > 0 ? units.lenU(c.nearMiss, 2) : 'off')]),
          // The slider is millimetres of clearance whichever way the unit
          // switch is set; only the readout changes, because a slider you
          // cannot land on a round number is worse than one in the other
          // unit.
          el('input', {
            type: 'range', min: 0, max: 10, step: 0.25, value: c.nearMiss,
            oninput: (e) => { app.state.checks.nearMiss = parseFloat(e.target.value); this.refresh(); },
            onchange: (e) => app.setChecks({ nearMiss: parseFloat(e.target.value) }),
          }),
        ]),
        el('div.hint', {}, c.nearMiss > 0
          ? `Anything that passes within ${units.lenU(c.nearMiss, 2)} of a fixture or the table is reported as a near miss — a warning, not a crash. That is the pass the operator watches with a hand on the feed hold.`
          : 'Off: only metal in metal is reported. Ask for room and the run also tells you where it came close, which is what you want before the first part rather than after it.'),
        checkbox('Report rapids that touch material', c.rapidIntoStock !== false, (v) => app.setChecks({ rapidIntoStock: v })),
        el('div.hint', {}, 'A G0 that removes material is a crash on the machine. Some posts rapid to the surface on purpose, so this can be turned off.'),
      ]),
      section('What is checked', [
        partRow('tool', 'The cutter and its shank', 'The flutes and the shank above them'),
        partRow('holder', 'The holder', 'Collet chuck, shrink fit, shell arbor'),
        partRow('spindle', 'The spindle nose', 'The face of the spindle itself'),
        el('div.hint', {}, 'Everything checked is checked against the fixtures, the table and the travel limits. Turning one off does not make it safe — it makes this program stop mentioning it.'),
      ]),
      section('Exceptions', [
        el('div.hint', {}, ignored || special
          ? `${ignored} ${ignored === 1 ? 'model is' : 'models are'} ignored and ${special} ${special === 1 ? 'asks' : 'ask'} for a clearance of their own.`
          : 'No model has a rule of its own yet.'),
        el('div.hint', {}, 'A fixture the tool is meant to touch — a soft jaw being cut, a sacrificial plate — can be ignored on its own, and a fragile one can ask for more room than everything else. Both live on the fixture, on Setup › Fixtures.'),
        actionRow([
          { label: 'Go to fixtures', onClick: () => app.setPage('setup', 'fixtures') },
        ]),
      ]),
    ];
  }

  fixturesPage() {
    const sel = this.app.models.selected;
    return [this.modelsSection(), sel ? this.placementSection(sel) : null];
  }

  // ---- stock -------------------------------------------------------------

  stockSection() {
    const app = this.app;
    const s = app.state.stock;

    const info = el('div.hint');
    const updateInfo = () => {
      const st = app.stock;
      if (!st) { info.textContent = ''; return; }
      const asked = app.state.stock.resolution;
      info.innerHTML = st.cell > asked * 1.05
        ? `Asked for <b>${units.lenU(asked, 3)}</b> cells; this block needs more columns than the memory budget allows, so it is simulated at <b>${units.lenU(st.cell, 3)}</b>.`
        : `Simulated at <b>${units.lenU(st.cell, 3)}</b> per column.`;
    };
    updateInfo();

    // Discrete steps rather than a linear sweep: the useful range spans two
    // orders of magnitude and the fine end is where the interesting choices
    // are. Committing only on release keeps a 12M-column rebuild off every
    // drag frame.
    const nearest = RESOLUTIONS.reduce((best, v) => (Math.abs(v - s.resolution) < Math.abs(best - s.resolution) ? v : best), RESOLUTIONS[0]);
    const resLabel = el('span.value', {}, units.lenU(nearest, 3));
    const res = el('input', {
      type: 'range', min: 0, max: RESOLUTIONS.length - 1, step: 1,
      value: RESOLUTIONS.indexOf(nearest),
      oninput: (e) => { resLabel.textContent = units.lenU(RESOLUTIONS[Number(e.target.value)], 3); },
      onchange: (e) => {
        app.setStock({ resolution: RESOLUTIONS[Number(e.target.value)] });
        updateInfo();
        this.refresh();
      },
    });

    // What the block is, rather than what it was asked to be: the grid it
    // was actually given, how much metal is in it, and how much is left.
    const detail = el('div.stat-grid');
    const updateDetail = () => {
      const st = app.stock;
      if (!st) { detail.replaceChildren(); return; }
      const remaining = st.remainingVolume();
      const cut = Math.max(st.stockVolume - remaining, 0);
      const stat = (label, value, dim) => el('div.stat', {}, [
        el('div.stat-label', {}, label),
        el(`div.stat-value${dim ? '.dim' : ''}`, {}, value),
      ]);
      detail.replaceChildren(
        stat('Shape', describeShape(s)),
        stat('Grid', `${st.nx} × ${st.ny}`),
        stat('Columns', st.cellCount >= 1e6 ? `${(st.cellCount / 1e6).toFixed(1)}M` : `${(st.cellCount / 1000).toFixed(0)}k`),
        stat('Cell', `${units.len(st.dx, 3)} × ${units.lenU(st.dy, 3)}`, true),
        stat('Stock', units.volumeU(st.stockVolume, 2)),
        stat('Removed', `${units.volumeU(cut, 2)} · ${st.stockVolume > 0 ? ((cut / st.stockVolume) * 100).toFixed(1) : '0'}%`),
      );
    };
    updateDetail();

    const setSize = (i, v, min = 0.2) => {
      const size = [...app.state.stock.size];
      size[i] = Math.max(min, v || min);
      app.setStock({ size });
      this.refresh();
    };

    // A block is three numbers, a bar is two, and a model is however it was
    // drawn — so the page asks for what this stock actually has.
    const shapeFields = s.shape === 'round'
      ? [row([
        field('Diameter', s.diameter, {
          min: 0.2, step: 1, unit: 'mm',
          onChange: (v) => { app.setStock({ diameter: Math.max(0.2, v || 0.2) }); this.refresh(); },
        }),
        field('Height', s.size[2], { min: 0.2, step: 1, unit: 'mm', onChange: (v) => setSize(2, v) }),
      ])]
      : s.shape === 'model'
        ? [
          el('div.hint', {}, `${s.model ? s.model.name : 'A model'} — ${s.model ? s.model.triangles.toLocaleString() : '0'} triangles, ${units.triple(s.size, 1, ' × ')} ${units.lengthLabel()}. Its top surface is the starting surface; the size comes from the model and is not typed in.`),
        ]
        : [row(AXES.map((a, i) => field(`Size ${a}`, s.size[i], {
          min: 0.2, step: 1, unit: 'mm', onChange: (v) => setSize(i, v),
        })))];

    return section('Stock', [
      addBar('Add stock…', () => openStockDialog(app, this), { hint: 'A block, a bar, or a model' }),
      ...shapeFields,
      row(AXES.map((a, i) => field(`Min ${a}`, s.origin[i], {
        step: 1, unit: 'mm',
        onChange: (v) => {
          const origin = [...app.state.stock.origin];
          origin[i] = v || 0;
          app.setStock({ origin });
          this.refresh();
        },
      }))),
      ...this.stockHandles(s),
      detail,
      actionRow([
        { label: 'Move by two points…', onClick: () => app.moveStockByPoints(), hint: 'Click a point on the stock, then click its destination' },
        { label: 'Centre on zero', onClick: () => { const sz = app.state.stock.size; app.setStock({ origin: [-sz[0] / 2, -sz[1] / 2, -sz[2]] }); this.refresh(); } },
      ]),
      actionRow([
        {
          label: 'Fit to the program',
          disabled: !app.state.program || s.shape === 'model',
          hint: s.shape === 'model' ? 'A model is whatever size it was drawn'
            : app.state.program ? 'Size the block around the toolpath' : 'Load a program first',
          onClick: () => { app.fitStockToProgram(); this.refresh(); },
        },
        { label: 'Reset the cut', onClick: () => app.resetStock(), hint: 'Put the material back and start the run over' },
      ]),
      el('label.field', {}, [
        el('span.field-label', {}, ['Simulation resolution ', resLabel]),
        res,
      ]),
      info,
      el('div.hint', {}, `Finer cells give sharper corners and scallops but cost memory. ${units.len(0.2, 3)}\u2013${units.lenU(0.4, 3)} suits most parts; ${units.lenU(0.025, 3)} is for inspecting a finish.`),
    ]);
  }

  /**
   * Dragging the block rather than typing where it goes.
   *
   * The handles are the same ones the fixtures have, with one ring missing:
   * the simulation is a field of vertical columns, so a block turned in the
   * vice is exact and a block tipped out of plane is a solid it cannot
   * hold. Tilting the part is what the machine's rotaries are for.
   */
  stockHandles(s) {
    const app = this.app;
    const on = !!(app.stockGizmo && app.stockGizmo.attached);
    const round = s.shape === 'round';

    const modes = el('div.btn-group', {}, [['translate', 'Move'], ['rotate', 'Turn']].map(([mode, label]) => el(`button.btn${this.stockGizmoMode === mode ? '.active' : ''}`, {
      type: 'button',
      disabled: !on || (mode === 'rotate' && round),
      title: mode === 'rotate' && round ? 'A bar is the same bar however it is turned' : '',
      onclick: () => {
        this.stockGizmoMode = mode;
        app.stockGizmo.setMode(mode);
        this.refresh();
      },
    }, label)));

    return [
      row([
        modes,
        button(on ? 'Hide handles' : 'Show handles', () => {
          if (on) app.clearSelection();
          else app.selectStock();
          this.refresh();
        }, { variant: on ? '' : 'primary' }),
        round ? null : field('Turned', Number((Number(s.rotation) || 0).toFixed(2)), {
          step: 5, unit: '°',
          title: 'How far the billet is turned in the vice, about Z',
          onChange: (v) => { app.setStock({ rotation: v || 0 }); this.refresh(); },
        }),
      ].filter(Boolean)),
      el('div.hint', {}, round
        ? 'Click the bar in the viewport to put handles on it and drag it where it is clamped. A bar has no angle to set — it is the same bar however it is turned.'
        : 'Click the block in the viewport to put handles on it: drag an arrow to slide it, or the ring to turn it in the vice. Only about Z — material runs in columns from the base upwards, so a block tipped out of plane is a solid this simulation cannot hold, and tilting the part is what the machine\u2019s rotaries do. Moving or turning it resets the cut.'),
    ];
  }

  // ---- work offsets ------------------------------------------------------

  originSection() {
    const app = this.app;
    const wcs = app.state.wcs;
    const editing = app.state.wcsEdit;

    // One header of axis labels, then a tight row per offset — six copies
    // of "X Y Z" is noise.
    const header = el('div.row.wcs-row', {}, [
      el('span.wcs-name', {}),
      ...AXES.map((a) => el('span.field-label', {}, a)),
    ]);

    const rows = Object.keys(wcs).map((key) => {
      const isActive = key === editing;
      return el(`div.row.wcs-row${isActive ? '.active' : ''}`, {}, [
        el(`button.btn.wcs-name${isActive ? '.active' : ''}`, {
          type: 'button',
          title: `Make ${key} the offset the placement tools act on`,
          onclick: () => app.setWcsEdit(key),
        }, key),
        ...AXES.map((a, i) => field('', Number(wcs[key][i].toFixed(4)), {
          step: 1,
          title: `${key} ${a}`,
          onChange: (v) => {
            const next = { ...app.state.wcs, [key]: [...app.state.wcs[key]] };
            next[key][i] = v || 0;
            app.setWcs(next);
          },
        })),
      ]);
    });

    return section('Work offsets', [
      el('div.hint', { html: `Scene position of each work origin. <b>${editing}</b> is the one the placement tools act on — click another name to switch.` }),
      header,
      ...rows,
      actionRow([
        { label: `Set ${editing} by clicking…`, variant: 'primary', hint: 'Click the point that should read X0 Y0 Z0', onClick: () => app.setOriginByPoint() },
        { label: 'Move by two points…', onClick: () => app.moveOriginByPoints() },
      ]),
      actionRow([
        {
          label: 'Zero to stock corner',
          hint: 'Minimum X/Y corner of the top face',
          onClick: () => { const st = app.stock; app.applyWcs(editing, [st.origin[0], st.origin[1], st.top]); },
        },
        {
          label: 'Zero to stock centre',
          hint: 'Centre of the top face',
          onClick: () => { const st = app.stock; app.applyWcs(editing, [st.origin[0] + st.size[0] / 2, st.origin[1] + st.size[1] / 2, st.top]); },
        },
      ]),
      // Machine zero is the machine's, not the job's: it is where the home
      // switches are, and the travel limits are measured from it too. Both
      // live together on Machine > Travels rather than half here.
      el('div.hint', {}, `G53 and G28 measure from machine zero, which is at ${units.triple(homeOf(app.state.machine), 2)} ${units.lengthLabel()}. ${editing} zero sits ${units.triple(homeOf(app.state.machine).map((v, i) => wcs[editing][i] - v), 2)} ${units.lengthLabel()} from it in machine coordinates.`),
      actionRow([
        { label: 'Machine zero and travels…', hint: 'On Machine \u203a Travels, with the envelope it measures', onClick: () => app.setPage('machine', 'limits') },
      ]),
    ]);
  }

  // ---- fixtures and models -----------------------------------------------

  async importFiles(files, opts = null) {
    const app = this.app;
    if (opts) Object.assign(this.importOpts, opts);
    for (const file of files || []) {
      try {
        const model = await app.models.addFromFile(file, this.importOpts);
        app.selectModel(model);
        app.notify(`Imported ${model.name} — ${model.triangles.toLocaleString()} triangles.`, 'ok');
      } catch (err) {
        app.notify(err.message, 'error');
      }
    }
    app.refreshFixtures();
    app.fitToScene();
  }

  /** Reached from elsewhere in the app: show the page that owns fixtures. */
  openFixtures() {
    this.app.setPage('setup', 'fixtures');
  }

  modelsSection() {
    const app = this.app;

    const list = el('div.list');
    if (!app.models.models.length) {
      list.appendChild(el('div.empty', {}, [
        el('div.empty-title', {}, 'Nothing clamped yet'),
        el('div.hint', {}, 'Add a vice, some parallels or a toe clamp, or bring in your own STL. Fixtures are collision-checked against the whole tool assembly; a reference part is the shape the job is meant to produce, and cutting past it is reported as a gouge.'),
      ]));
    }
    for (const m of app.models.models) {
      list.appendChild(el(`div.list-item${app.models.selected === m ? '.selected' : ''}`, {
        onclick: () => app.selectModel(m),
      }, [
        el('div.swatch', { style: { background: `#${MODEL_ROLES[m.role].color.toString(16).padStart(6, '0')}` } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, m.name),
          el('div.list-sub', {}, `${MODEL_ROLES[m.role].label} · ${m.triangles.toLocaleString()} tris`),
        ]),
        el('div.list-actions', {}, [
          button(m.visible ? 'Hide' : 'Show', (e) => {
            e.stopPropagation();
            app.models.setVisible(m, !m.visible);
            app.refreshFixtures();
            this.refresh();
          }),
          button('✕', (e) => {
            e.stopPropagation();
            app.models.remove(m);
            app.refreshFixtures();
          }, { title: 'Remove', variant: 'warn' }),
        ]),
      ]));
    }

    // Dropping a file is the same act as pressing Add, so it stays on the
    // page rather than hiding inside the window.
    const drop = el('div.dropzone', {
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        this.importFiles([...e.dataTransfer.files].filter((f) => /\.stl$/i.test(f.name)));
      },
    }, 'or drop STL files here — they land as fixtures; use Add for a reference part');

    return section(`Fixtures & models (${app.models.models.length})`, [
      addBar('Add fixture…', () => openFixtureDialog(this.app, this), { hint: 'A vice, parallels, a clamp, or an STL of your own' }),
      drop,
      list,
    ]);
  }

  placementSection(m) {
    const app = this.app;
    const o = m.object;
    const setPos = (i, v) => {
      const p = o.position.toArray();
      p[i] = v || 0;
      app.models.setTransform(m, { position: p });
      app.refreshFixtures();
    };
    const setRot = (i, deg) => {
      const r = [o.rotation.x, o.rotation.y, o.rotation.z];
      r[i] = ((deg || 0) * Math.PI) / 180;
      app.models.setTransform(m, { rotation: r });
      app.refreshFixtures();
    };
    const bb = m.mesh.geometry.boundingBox;
    const size = bb
      ? { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z }
      : { x: 0, y: 0, z: 0 };

    return section(`Placement · ${m.name}`, [
      el('div.hint', {}, 'Drag the handles in the viewport, or type the numbers. Clicking another fixture — or the stock — moves the handles to it; clicking nothing, or Escape, puts them away.'),
      row([button('Move by two points…', () => app.moveModelByPoints(), { variant: 'primary' })]),
      el('div.btn-group', {}, GIZMOS.map(([mode, label]) => el(`button.btn${this.gizmoMode === mode ? '.active' : ''}`, {
        type: 'button',
        onclick: () => {
          this.gizmoMode = mode;
          app.models.setGizmoMode(mode);
          this.refresh();
        },
      }, label))),
      row(AXES.map((a, i) => field(a, Number(o.position.toArray()[i].toFixed(3)), {
        step: 1, unit: 'mm', onChange: (v) => setPos(i, v),
      }))),
      row(['RX', 'RY', 'RZ'].map((a, i) => field(a, Number((([o.rotation.x, o.rotation.y, o.rotation.z][i] * 180) / Math.PI).toFixed(2)), {
        step: 15, unit: '°', onChange: (v) => setRot(i, v),
      }))),
      row([
        field('Scale', Number(o.scale.x.toFixed(4)), {
          min: 0.001, step: 0.1,
          onChange: (v) => {
            const sc = Math.max(0.001, v || 1);
            app.models.setTransform(m, { scale: [sc, sc, sc] });
            app.refreshFixtures();
          },
        }),
        select('Role', Object.entries(MODEL_ROLES).map(([k, v]) => ({ value: k, label: v.label })), m.role, (v) => {
          app.models.setRole(m, v);
          app.refreshFixtures();
          this.refresh();
        }),
      ]),
      el('label.field', {}, [
        el('span.field-label', {}, 'Opacity'),
        el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: m.material.opacity, oninput: (e) => app.models.setOpacity(m, parseFloat(e.target.value)) }),
      ]),
      el('div.hint', {}, `Local size ${units.triple([size.x, size.y, size.z], 1, ' × ')} ${units.lengthLabel()}. Collision uses each model's oriented bounding box — import an awkward fixture as a few simple pieces for a tighter fit.`),
      // Rules this one carries itself, because a fixture the tool is meant
      // to touch and a fragile probe are both exceptions to the same rule.
      row([
        checkbox('Ignore in the crash model', !!m.ignore, (v) => {
          m.ignore = v;
          app.refreshFixtures();
          app.rerunIfFinished();
          this.refresh();
        }),
        field('Clearance', Number.isFinite(m.clearance) ? m.clearance : '', {
          type: 'number', min: 0, step: 0.5, unit: 'mm',
          title: 'How much room this one wants; blank follows Setup › Checks',
          onChange: (v) => {
            m.clearance = v === null || v === '' ? null : Math.max(0, Number(v) || 0);
            app.refreshFixtures();
            app.rerunIfFinished();
            this.refresh();
          },
        }),
      ]),
      el('div.hint', {}, m.ignore
        ? 'Ignored: the assembly passes through this one without a word.'
        : Number.isFinite(m.clearance)
          ? `Asks for ${units.lenU(m.clearance, 2)} of its own, whatever Setup › Checks says.`
          : 'Follows the near-miss distance on Setup › Checks. Leave the clearance blank unless this one is special.'),
      row([
        button('Drop onto table', () => {
          app.dropModelToTable(m);
          app.refreshFixtures();
          this.refresh();
        }),
        button('Export STL', () => app.exportModelStl(m)),
        button('Deselect', () => app.clearSelection()),
      ]),
    ]);
  }

}
