// Setup: the job. The block, where zero is, and what is clamped around it.
//
// Step 2. The stock and the work offsets, then one card for each kind of
// model on the table — fixtures and clamps, the reference part, decoration
// — because the three are different things: what the tool must miss, what
// the job must become, and what is only there to look at. Each card has
// its own Add button, list and drop zone.

import { el, field, select, checkbox, button, row, section } from './dom.js';
import { Panel, addBar, actionRow } from './panel.js';
import { icon } from './icons.js';
import { openFixtureDialog, openStockDialog } from './setupDialogs.js';
import { MODEL_ROLES } from '../scene/modelsView.js';
import { describeShape } from '../sim/stockShape.js';
import { homeOf } from '../machine/config.js';
import { RESOLUTIONS } from '../app.js';
import * as units from '../core/units.js';

const AXES = ['X', 'Y', 'Z'];
const GIZMOS = [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale']];

/** Which group of the Setup step lists a model of this role. */
export function groupForRole(role) {
  return role === 'reference' ? 'reference' : role === 'decor' ? 'decor' : 'fixtures';
}

const GROUP_ROLES = {
  fixtures: ['fixture', 'clamp'],
  reference: ['reference'],
  decor: ['decor'],
};

export class SetupPanel extends Panel {
  constructor(app) {
    const count = (roles) => () => app.models.models.filter((m) => roles.includes(m.role)).length || null;
    super(app, [
      { id: 'stock', label: 'Stock', icon: 'cube', hint: 'The block, where it sits and how finely it is simulated', summary: () => describeShape(app.state.stock), render: SetupPanel.prototype.stockPage },
      { id: 'origin', label: 'Work offsets', icon: 'target', hint: 'Where X0 Y0 Z0 is for each offset', summary: () => app.state.wcsEdit, open: false, render: SetupPanel.prototype.originPage },
      { id: 'fixtures', label: 'Fixtures & clamps', icon: 'vice', hint: 'Vices, parallels and clamps: checked against the whole tool assembly', badge: count(GROUP_ROLES.fixtures), render() { return this.modelsGroup('fixtures'); } },
      { id: 'reference', label: 'Reference part', icon: 'reference', hint: 'The finished part: gouge checks, the deviation map and Compare', badge: count(GROUP_ROLES.reference), render() { return this.modelsGroup('reference'); } },
      { id: 'decor', label: 'Decoration', icon: 'decor', hint: 'Models that are drawn and never checked', badge: count(GROUP_ROLES.decor), open: false, render() { return this.modelsGroup('decor'); } },
    ], { key: 'setup' });
    this.gizmoMode = 'translate';
    /** Which handles the block gets: Move or Turn. */
    this.stockGizmoMode = 'translate';
    this.importOpts = { units: 'mm', role: 'fixture', recentre: false };
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

  stockPage() {
    return [this.stockSection()];
  }

  originPage() {
    return [this.originSection()];
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
      // Only worth saying when it is not what was asked for.
      info.innerHTML = st.cell > asked * 1.05
        ? `Too many lines for the memory budget: simulated at <b>${units.lenU(st.cell, 3)}</b>.`
        : '';
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
      const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1000).toFixed(0)}k`);
      detail.replaceChildren(
        stat('Shape', describeShape(s)),
        stat('Grid', st.n3.join(' × ')),
        stat('Lines', `${count(st.rayCount)} · ${(st.memoryBytes() / 1e6).toFixed(0)} MB`),
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
   * the simulation's lines run along X, Y and Z, so a block turned in the
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
    // A five-axis machine's offsets turn its rotaries too: G54 C12.5 puts
    // the part's C0 at 12.5 on the dial.
    const turns = app.rotaryLetters();
    const rot = app.state.wcsRotary || {};

    // One header of axis labels, then a tight row per offset — six copies
    // of "X Y Z" is noise.
    // Six copies of "X Y Z" is noise, so the unit is said once here too
    // rather than on all eighteen boxes.
    const header = el('div.row.wcs-row', {}, [
      el('span.wcs-name', {}),
      ...AXES.map((a) => el('span.field-label', {}, [a, el('span.unit', {}, ` ${units.lengthLabel()}`)])),
      ...turns.map((a) => el('span.field-label', {}, [a, el('span.unit', {}, ' °')])),
    ]);

    const rows = Object.keys(wcs).map((key) => {
      const isActive = key === editing;
      return el(`div.row.wcs-row${isActive ? '.active' : ''}`, {}, [
        el(`button.btn.wcs-name${isActive ? '.active' : ''}`, {
          type: 'button',
          title: `Make ${key} the offset the placement tools act on`,
          onclick: () => app.setWcsEdit(key),
        }, key),
        // A work offset is a length like any other. It reads in whatever
        // the panels are set to, and is held in millimetres like
        // everything else — the rounding is the field's to do, so the raw
        // number goes in rather than one already cut to four places.
        ...AXES.map((a, i) => field('', wcs[key][i], {
          step: 1,
          unit: 'mm',
          title: `${key} ${a}`,
          onChange: (v) => {
            const next = { ...app.state.wcs, [key]: [...app.state.wcs[key]] };
            next[key][i] = v || 0;
            app.setWcs(next);
          },
        })),
        ...turns.map((a) => field('', (rot[key] && rot[key][a]) || 0, {
          step: 1,
          unit: '°',
          title: `${key} ${a}: added to every ${a} the program gives in ${key}`,
          onChange: (v) => app.setWcsRotary(key, a, v || 0),
        })),
      ]);
    });

    return section('Work offsets', [
      el('div.hint', { html: `Scene position of each work origin. <b>${editing}</b> is the one the placement tools act on — click another name to switch.${turns.length ? ` ${turns.join(' and ')} are the offset\u2019s turn of the rotaries: added to every ${turns.join(' or ')} the program gives in that offset, as the control does — not to a move by an amount, or one in machine coordinates.` : ''}` }),
      header,
      ...rows,
      actionRow([
        { label: `Set ${editing} by clicking…`, variant: 'primary', hint: 'Click the point that should read X0 Y0 Z0', onClick: () => app.setOriginByPoint() },
        { label: 'Move by two points…', onClick: () => app.moveOriginByPoints() },
      ]),
      actionRow([
        { label: 'Set by bore centre…', hint: 'Three points on the bore wall: X and Y go to its centre, Z stays', onClick: () => app.setOriginByBore() },
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

  /** Reached from elsewhere in the app: show the group that lists this model, or the fixtures. */
  openFixtures(model = null) {
    this.app.setPage('setup', groupForRole(model ? model.role : 'fixture'));
  }

  /**
   * One kind of model: its list, the way to add one, and the placement of
   * the one selected. Each kind has its own card, because they are three
   * different things — what the tool must miss, what the job must become,
   * and what is only there to look at.
   */
  modelsGroup(group) {
    const app = this.app;
    const roles = GROUP_ROLES[group];
    const models = app.models.models.filter((m) => roles.includes(m.role));
    const role = roles[0];

    const list = el('div.list');
    const empty = {
      fixtures: ['No fixtures', 'Add a vice, parallels or a toe clamp, or import your own STL. Fixtures are collision-checked against the cutter, holder and spindle.'],
      reference: ['No reference part', 'Import the finished part as STL. The holder, shank and spindle are checked against its real shape, the cutter going past it is a gouge, and Results › Compare measures the cut against it.'],
      decor: ['Nothing here', 'Models for show only: a table plate, a fixture you do not want checked, a sub-plate. They are drawn and never checked.'],
    }[group];
    if (!models.length) {
      list.appendChild(el('div.empty', {}, [
        el('div.empty-title', {}, empty[0]),
        el('div.hint', {}, empty[1]),
      ]));
    }
    for (const m of models) {
      list.appendChild(el(`div.list-item${app.models.selected === m ? '.selected' : ''}`, {
        onclick: () => app.selectModel(m),
      }, [
        el('div.swatch', { style: { background: `#${MODEL_ROLES[m.role].color.toString(16).padStart(6, '0')}` } }),
        el('div.list-main', {}, [
          el('div.list-title', {}, m.name),
          el('div.list-sub', {}, [
            group === 'fixtures' ? MODEL_ROLES[m.role].label.replace(/ \(.*\)$/, '') : null,
            `${m.triangles.toLocaleString()} triangles`,
            m.ignore ? 'ignored' : null,
            m.visible ? null : 'hidden',
          ].filter(Boolean).join(' · ')),
        ]),
        el('div.list-actions', {}, [
          el(`button.icon-btn${m.visible ? '' : '.off'}`, {
            type: 'button',
            title: m.visible ? 'Hide' : 'Show',
            onclick: (e) => {
              e.stopPropagation();
              app.models.setVisible(m, !m.visible);
              app.refreshFixtures();
              this.refresh();
            },
          }, icon('eye', 15)),
          el('button.icon-btn.danger', {
            type: 'button',
            title: 'Remove',
            onclick: (e) => {
              e.stopPropagation();
              app.models.remove(m);
              app.refreshFixtures();
            },
          }, icon('trash', 15)),
        ]),
      ]));
    }

    // Dropping a file is the same act as pressing Add, so it stays on the
    // card rather than hiding inside the window — and lands as this card's kind.
    const drop = el('div.dropzone', {
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        this.importFiles([...e.dataTransfer.files].filter((f) => /\.stl$/i.test(f.name)), { role, recentre: false });
      },
    }, 'Drop STL files here');

    const label = { fixtures: 'Add fixture…', reference: 'Import reference part…', decor: 'Import model…' }[group];
    const sel = app.models.selected;
    return [
      addBar(label, () => openFixtureDialog(app, this, { role }), { hint: empty[1] }),
      list,
      drop,
      sel && roles.includes(sel.role) ? this.placementSection(sel) : null,
    ];
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
    // The turn as three angles about the machine's X, Y and Z, applied in
    // that order through the model's origin; a typed one is set as typed.
    const setRot = (i, deg) => {
      const r = [o.rotation.x, o.rotation.y, o.rotation.z];
      r[i] = ((deg || 0) * Math.PI) / 180;
      app.models.setTransform(m, { rotation: r });
      app.refreshFixtures();
      this.refresh();
    };
    // A turn about the machine's X, Y or Z, through the model's origin.
    const turn = (i, sign) => {
      app.models.turnAbout(m, i, sign * (this.turnStep || 90));
      app.refreshFixtures();
      this.refresh();
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
      el('div.place-label', {}, 'Origin'),
      row(AXES.map((a, i) => field(a, Number(o.position.toArray()[i].toFixed(3)), {
        step: 1, unit: 'mm', onChange: (v) => setPos(i, v),
      }))),
      el('div.place-label', {}, 'Rotate about the origin'),
      row(['RX', 'RY', 'RZ'].map((a, i) => field(a, Number((([o.rotation.x, o.rotation.y, o.rotation.z][i] * 180) / Math.PI).toFixed(3)), {
        step: 15, unit: '°',
        title: `About the machine's ${a.slice(1)} axis through the origin; the three are applied X, then Y, then Z`,
        onChange: (v) => setRot(i, v),
      }))),
      el('div.turn-grid', {}, [
        field('Angle', this.turnStep || 90, {
          min: 0, step: 15, unit: '°',
          onChange: (v) => { this.turnStep = Math.abs(Number(v)) || 90; },
        }),
        ...['X', 'Y', 'Z'].map((a, i) => el('div.turn-axis', {}, [-1, 1].map((sign) => button(`${a} ${sign < 0 ? '−' : '+'}`, () => turn(i, sign), {
          title: `Turn about the machine's ${a} axis through the model's origin, ${sign < 0 ? 'clockwise' : 'anticlockwise'} seen from the + end of ${a}`,
        })))),
      ]),
      row([button('Reset rotation', () => { app.models.resetTurns(m); app.refreshFixtures(); this.refresh(); }, {
        title: 'Back to the way the file was drawn; the origin stays where it is',
      })]),
      el('div.hint', {}, 'Everything is done about the model\u2019s origin — the point X, Y and Z give, drawn as its own small axes — so turning never moves it. RX, RY and RZ are turns about the machine\u2019s X, Y and Z through the origin, applied in that order: X first, then Y, then Z. The buttons turn it by the angle about the machine\u2019s axis, however it is already turned, and the three boxes then show where it ended up.'),
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
          // It belongs to another card now: follow it there.
          app.setPage('setup', groupForRole(v));
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
          title: 'How much room this one wants; blank follows Results › Collision rules',
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
          ? `Asks for ${units.lenU(m.clearance, 2)} of its own, whatever Results › Collision rules says.`
          : 'Follows the near-miss distance in Results › Collision rules. Leave the clearance blank unless this one is special.'),
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
