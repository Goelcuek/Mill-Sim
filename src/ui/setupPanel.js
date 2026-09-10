// Setup: the job. Stock, where zero is, what is clamped around it, and the
// machine it all sits in.
//
// Models used to live in their own tab, which was wrong — a vice and a set
// of parallels are part of setting up a job, not a separate activity.

import { el, field, select, checkbox, button, row, section, clear, pickFile } from './dom.js';
import { MODEL_ROLES } from '../scene/modelsView.js';
import { fmt } from '../core/util.js';

const AXES = ['X', 'Y', 'Z'];
const RESOLUTIONS = [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.075, 0.05, 0.035, 0.025];
const GIZMOS = [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale']];

export class SetupPanel {
  constructor(app) {
    this.app = app;
    this.root = el('div.panel');
    this.gizmoMode = 'translate';
    this.importOpts = { units: 'mm', role: 'fixture', recentre: true };
    app.models.onChange = () => this.refresh();
    this.render();
  }

  refresh() { this.render(); }

  render() {
    if (this.rendering) { this.queued = true; return; }
    this.rendering = true;
    const scrollTop = this.root.scrollTop;
    clear(this.root);
    this.root.appendChild(this.stockSection());
    this.root.appendChild(this.originSection());
    this.root.appendChild(this.modelsSection());
    const sel = this.app.models.selected;
    if (sel) this.root.appendChild(this.placementSection(sel));
    this.root.appendChild(this.machineSection());
    this.root.appendChild(this.displaySection());
    this.root.scrollTop = scrollTop;
    this.rendering = false;
    if (this.queued) { this.queued = false; this.render(); }
  }

  /** Buttons for the contextual ribbon row. */
  actions() {
    const app = this.app;
    const picking = app.pick && app.pick.active;
    const sel = app.models.selected;
    const armed = (label, fn, title, on) => {
      const b = button(label, fn, { title });
      if (on) b.classList.add('armed');
      return b;
    };
    const active = picking ? app.pick.request.title : '';

    return [
      el('span.actions-label', {}, 'Place'),
      el('div.actions-group', {}, [
        armed('Move stock…', () => app.moveStockByPoints(), 'Click a point on the stock, then click where it should go', active === 'Move stock'),
        armed(`Set ${app.state.wcsEdit} zero…`, () => app.setOriginByPoint(), 'Click the point that should read X0 Y0 Z0', active.startsWith('Set ')),
        armed(`Move ${app.state.wcsEdit}…`, () => app.moveOriginByPoints(), 'Shift the work offset from one point to another', active === `Move ${app.state.wcsEdit}`),
        armed(sel ? `Move ${sel.name}…` : 'Move model…', () => app.moveModelByPoints(),
          sel ? 'Click a point on the model, then click where it should go' : 'Select a model first', sel && active === `Move ${sel.name}`),
      ]),
      el('div.actions-sep'),
      el('span.actions-label', {}, 'Stock'),
      el('div.actions-group', {}, [
        button('Fit to program', () => { app.fitStockToProgram(); this.refresh(); }, { title: 'Size the block around the toolpath' }),
        button('Centre on zero', () => {
          const size = app.state.stock.size;
          app.setStock({ origin: [-size[0] / 2, -size[1] / 2, -size[2]] });
          this.refresh();
        }, { title: 'Work zero at the centre of the top face' }),
        button('Reset cut', () => app.resetStock(), { title: 'Put the material back' }),
      ]),
      el('div.actions-sep'),
      el('span.actions-label', {}, 'Fixtures'),
      el('div.actions-group', {}, [
        button('Import STL…', async () => this.importFiles(await pickFile('.stl', true))),
        button('Vice', () => { app.addPrimitiveFixture('vice'); app.refreshFixtures(); }),
        button('Parallels', () => { app.addPrimitiveFixture('parallels'); app.refreshFixtures(); }),
        button('Clamp', () => { app.addPrimitiveFixture('clamp'); app.refreshFixtures(); }),
      ]),
    ];
  }

  // ---- stock -------------------------------------------------------------

  stockSection() {
    const app = this.app;
    const s = app.state.stock;

    const info = el('div.hint');
    const updateInfo = () => {
      const st = app.stock;
      if (!st) { info.textContent = ''; return; }
      info.innerHTML = `Grid <b>${st.nx} × ${st.ny}</b> = ${(st.cellCount / 1000).toFixed(0)}k columns · cell ${fmt(st.dx, 3)} × ${fmt(st.dy, 3)} mm`;
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

    return section('Stock', [
      row(AXES.map((a, i) => field(`Size ${a}`, s.size[i], {
        min: 1, step: 1, unit: 'mm',
        onChange: (v) => {
          const size = [...app.state.stock.size];
          size[i] = Math.max(1, v || 1);
          app.setStock({ size });
          this.refresh();
        },
      }))),
      row(AXES.map((a, i) => field(`Min ${a}`, s.origin[i], {
        step: 1, unit: 'mm',
        onChange: (v) => {
          const origin = [...app.state.stock.origin];
          origin[i] = v || 0;
          app.setStock({ origin });
          this.refresh();
        },
      }))),
      row([button('Move by two points…', () => app.moveStockByPoints(), { title: 'Click a point on the stock, then click its destination' })]),
      el('label.field', {}, [
        el('span.field-label', {}, ['Simulation resolution ', resLabel]),
        res,
      ]),
      info,
      el('div.hint', {}, 'Finer cells give sharper corners and scallops but cost memory. 0.2–0.4 mm suits most parts; 0.025 mm is for inspecting a finish.'),
      row([
        el('label.field', {}, [
          el('span.field-label', {}, 'Material colour'),
          el('input', { type: 'color', value: app.state.display.stockColor, oninput: (e) => app.setDisplay({ stockColor: e.target.value }) }),
        ]),
        checkbox('Colour cuts by tool', app.state.display.toolColors, (v) => app.setDisplay({ toolColors: v })),
      ]),
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
      row([
        button(`Set ${editing} by clicking…`, () => app.setOriginByPoint(), { variant: 'primary', title: 'Click the point that should read X0 Y0 Z0' }),
        button('Move by two points…', () => app.moveOriginByPoints()),
      ]),
      row([
        button('Zero to stock corner', () => {
          const st = app.stock;
          app.applyWcs(editing, [st.origin[0], st.origin[1], st.top]);
        }, { title: 'Minimum X/Y corner of the top face' }),
        button('Zero to stock centre', () => {
          const st = app.stock;
          app.applyWcs(editing, [st.origin[0] + st.size[0] / 2, st.origin[1] + st.size[1] / 2, st.top]);
        }, { title: 'Centre of the top face' }),
      ]),
      checkbox('Show origin markers', app.state.display.origins, (v) => app.setDisplay({ origins: v })),
      row([
        field('Home / G28 Z', app.state.machineZero[2], {
          step: 10, unit: 'mm',
          onChange: (v) => app.setMachineZero([app.state.machineZero[0], app.state.machineZero[1], v || 0]),
        }),
      ]),
    ]);
  }

  // ---- fixtures and models -----------------------------------------------

  async importFiles(files) {
    const app = this.app;
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

  /** Open the file picker and import whatever comes back. */
  async importDialog() {
    this.app.setTab('setup');
    await this.importFiles(await pickFile('.stl', true));
  }

  modelsSection() {
    const app = this.app;
    const opts = this.importOpts;

    const drop = el('div.dropzone', {
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        this.importFiles([...e.dataTransfer.files].filter((f) => /\.stl$/i.test(f.name)));
      },
      onclick: async () => this.importFiles(await pickFile('.stl', true)),
    }, 'Drop STL files here, or click to browse');

    const list = el('div.list');
    if (!app.models.models.length) {
      list.appendChild(el('div.hint', {}, 'Nothing in the fixture list yet. Add a vice, some parallels or a clamp from the ribbon.'));
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

    return section(`Fixtures & models (${app.models.models.length})`, [
      drop,
      row([
        select('Units in file', [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }], opts.units, (v) => { opts.units = v; }),
        select('Role', Object.entries(MODEL_ROLES).map(([k, v]) => ({ value: k, label: v.label })), opts.role, (v) => { opts.role = v; }),
      ]),
      checkbox('Sit on Z0 and centre in XY', opts.recentre, (v) => { opts.recentre = v; }),
      el('div.hint', {}, 'STL carries no units, so pick the right one here. Fixtures and clamps are collision-checked against the whole tool assembly; reference parts are not.'),
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

  // ---- machine -----------------------------------------------------------

  machineSection() {
    const app = this.app;
    const m = app.state.machine;

    return section('Machine', [
      row([
        select('View', [
          { value: 'part', label: 'Part only' },
          { value: 'machine', label: 'Full machine' },
        ], m.mode, (v) => {
          app.setMachine({ mode: v });
          this.refresh();
        }, { title: 'In full-machine view the table carries the work in X and Y, as it does on a real VMC.' }),
        field('Table top Z', m.tableZ, {
          step: 5, unit: 'mm',
          onChange: (v) => app.setMachine({ tableZ: v || 0, table: { ...m.table, z: v || 0 } }),
        }),
      ]),
      row([
        field('Spindle nose Ø', m.spindleDiameter, { min: 0, step: 5, unit: 'mm', onChange: (v) => app.setMachine({ spindleDiameter: Math.max(0, v || 0) }) }),
        field('Nose length', m.spindleLength, { min: 0, step: 5, unit: 'mm', onChange: (v) => app.setMachine({ spindleLength: Math.max(0, v || 0) }) }),
      ]),
      el('div.hint', {}, 'The spindle nose is part of the crash model, so a plunge that buries the spindle is caught even when the holder clears.'),
      row([field('Rapid rate', m.rapidRate, { min: 100, step: 500, unit: 'mm/min', onChange: (v) => app.setMachine({ rapidRate: Math.max(100, v || 1000) }) })]),
      checkbox('Check the table surface', m.table.enabled, (v) => app.setMachine({ table: { ...m.table, enabled: v } })),
      checkbox('Check travel limits', m.limits.enabled, (v) => {
        app.setMachine({ limits: { ...m.limits, enabled: v } });
        this.refresh();
      }),
      m.limits.enabled ? row(AXES.map((a, i) => field(`${a} min`, m.limits.min[i], {
        step: 10, unit: 'mm',
        onChange: (v) => {
          const min = [...m.limits.min];
          min[i] = v || 0;
          app.setMachine({ limits: { ...m.limits, min } });
        },
      }))) : null,
      m.limits.enabled ? row(AXES.map((a, i) => field(`${a} max`, m.limits.max[i], {
        step: 10, unit: 'mm',
        onChange: (v) => {
          const max = [...m.limits.max];
          max[i] = v || 0;
          app.setMachine({ limits: { ...m.limits, max } });
        },
      }))) : null,
      m.limits.enabled ? checkbox('Show travel envelope', app.state.display.showLimits, (v) => app.setDisplay({ showLimits: v })) : null,
    ], { collapsed: true });
  }

  // ---- display -----------------------------------------------------------

  displaySection() {
    const app = this.app;
    const d = app.state.display;

    const sectionSlider = el('input', {
      type: 'range', min: 0, max: 100, step: 0.5, value: d.sectionPct,
      oninput: (e) => {
        const pct = parseFloat(e.target.value);
        app.setDisplay({ sectionPct: pct });
        secLabel.textContent = pct >= 100 ? 'off' : `${pct.toFixed(0)}%`;
      },
    });
    const secLabel = el('span.value', {}, d.sectionPct >= 100 ? 'off' : `${d.sectionPct.toFixed(0)}%`);

    return section('Display', [
      row([
        checkbox('Grid', d.grid, (v) => app.setDisplay({ grid: v })),
        checkbox('Axes', d.axes, (v) => app.setDisplay({ axes: v })),
      ]),
      row([
        checkbox('Stock', d.stock, (v) => app.setDisplay({ stock: v })),
        checkbox('Tool', d.tool, (v) => app.setDisplay({ tool: v })),
      ]),
      row([
        checkbox('Holder', d.holder, (v) => app.setDisplay({ holder: v })),
        checkbox('Toolpath', d.toolpath, (v) => app.setDisplay({ toolpath: v })),
      ]),
      row([
        checkbox('Rapids', d.rapids, (v) => app.setDisplay({ rapids: v })),
        select('Backplot', [
          { value: 'all', label: 'Whole program' },
          { value: 'remaining', label: 'Still to cut' },
          { value: 'done', label: 'Already cut' },
        ], d.backplot, (v) => app.setDisplay({ backplot: v })),
      ]),
      el('label.field', {}, [
        el('span.field-label', {}, 'Tool opacity'),
        el('input', {
          type: 'range', min: 0.1, max: 1, step: 0.05, value: d.toolOpacity,
          oninput: (e) => app.setDisplay({ toolOpacity: parseFloat(e.target.value) }),
        }),
      ]),
      el('label.field', {}, [
        el('span.field-label', {}, ['Section view ', secLabel]),
        sectionSlider,
      ]),
      el('div.hint', {}, 'Section view clips the stock above a height so you can see into deep pockets.'),
    ], { collapsed: true });
  }
}
