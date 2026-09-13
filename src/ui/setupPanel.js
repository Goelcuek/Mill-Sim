// Setup: the job. The block, where zero is, and what is clamped around it.
//
// Three pages, and everything that acts on them lives here rather than in
// the ribbon: the ribbon says which page you are on, this says what is on
// it. Fixtures are the one thing on these pages that gets created from
// nothing, so that is the one thing behind an Add button and a window.

import { el, field, select, button, row, section } from './dom.js';
import { Panel, addBar, actionRow } from './panel.js';
import { openFixtureDialog, openStockDialog } from './setupDialogs.js';
import { MODEL_ROLES } from '../scene/modelsView.js';
import { fmt } from '../core/util.js';
import { describeShape } from '../sim/stockShape.js';
import { RESOLUTIONS } from '../app.js';

const AXES = ['X', 'Y', 'Z'];
const GIZMOS = [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale']];

export class SetupPanel extends Panel {
  constructor(app) {
    super(app, [
      { id: 'project', label: 'Project', icon: 'save', hint: 'The whole job in one file: program, machine, stock, tools and fixtures', render: SetupPanel.prototype.projectPage },
      { id: 'stock', label: 'Stock', icon: 'cube', hint: 'The block, where it sits and how finely it is simulated', render: SetupPanel.prototype.stockPage },
      { id: 'origin', label: 'Work offsets', icon: 'target', hint: 'Where X0 Y0 Z0 is for each offset', render: SetupPanel.prototype.originPage },
      { id: 'fixtures', label: 'Fixtures', icon: 'vice', hint: 'Vices, clamps, parallels and reference parts', badge: () => app.models.models.length || null, render: SetupPanel.prototype.fixturesPage },
    ]);
    this.gizmoMode = 'translate';
    this.importOpts = { units: 'mm', role: 'fixture', recentre: true };
    app.models.onChange = () => this.refresh();
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
        ? `Asked for <b>${asked} mm</b> cells; this block needs more columns than the memory budget allows, so it is simulated at <b>${fmt(st.cell, 3)} mm</b>.`
        : `Simulated at <b>${fmt(st.cell, 3)} mm</b> per column.`;
    };
    updateInfo();

    // Discrete steps rather than a linear sweep: the useful range spans two
    // orders of magnitude and the fine end is where the interesting choices
    // are. Committing only on release keeps a 12M-column rebuild off every
    // drag frame.
    const nearest = RESOLUTIONS.reduce((best, v) => (Math.abs(v - s.resolution) < Math.abs(best - s.resolution) ? v : best), RESOLUTIONS[0]);
    const resLabel = el('span.value', {}, `${nearest} mm`);
    const res = el('input', {
      type: 'range', min: 0, max: RESOLUTIONS.length - 1, step: 1,
      value: RESOLUTIONS.indexOf(nearest),
      oninput: (e) => { resLabel.textContent = `${RESOLUTIONS[Number(e.target.value)]} mm`; },
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
        stat('Cell', `${fmt(st.dx, 3)} × ${fmt(st.dy, 3)} mm`, true),
        stat('Stock', `${fmt(st.stockVolume / 1000, 2)} cm³`),
        stat('Removed', `${fmt(cut / 1000, 2)} cm³ · ${st.stockVolume > 0 ? ((cut / st.stockVolume) * 100).toFixed(1) : '0'}%`),
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
          el('div.hint', {}, `${s.model ? s.model.name : 'A model'} — ${s.model ? s.model.triangles.toLocaleString() : '0'} triangles, ${s.size.map((v) => fmt(v, 1)).join(' × ')} mm. Its top surface is the starting surface; the size comes from the model and is not typed in.`),
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
      el('div.hint', {}, 'Finer cells give sharper corners and scallops but cost memory. 0.2–0.4 mm suits most parts; 0.025 mm is for inspecting a finish.'),
    ]);
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
      row([
        field('Home / G28 Z', app.state.machineZero[2], {
          step: 10, unit: 'mm',
          onChange: (v) => app.setMachineZero([app.state.machineZero[0], app.state.machineZero[1], v || 0]),
        }),
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
        app.models.select(model);
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
        onclick: () => app.models.select(m),
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
    }, 'or drop STL files here');

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
      el('div.hint', {}, `Local size ${fmt(size.x, 1)} × ${fmt(size.y, 1)} × ${fmt(size.z, 1)} mm. Collision uses each model's oriented bounding box — import an awkward fixture as a few simple pieces for a tighter fit.`),
      row([
        button('Drop onto table', () => {
          app.dropModelToTable(m);
          app.refreshFixtures();
          this.refresh();
        }),
        button('Export STL', () => app.exportModelStl(m)),
        button('Deselect', () => app.models.select(null)),
      ]),
    ]);
  }

}
