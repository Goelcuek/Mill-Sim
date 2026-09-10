// Models panel: bring geometry into the scene, place it, and decide
// whether the simulator should crash into it.

import { el, field, select, button, row, section, clear, checkbox, pickFile } from './dom.js';
import { MODEL_ROLES } from '../scene/modelsView.js';
import { fmt } from '../core/util.js';

const GIZMOS = [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale']];

export class ModelsPanel {
  constructor(app) {
    this.app = app;
    this.root = el('div.panel');
    this.gizmoMode = 'translate';
    this.render();
    app.models.onChange = () => this.render();
  }

  refresh() { this.render(); }

  render() {
    clear(this.root);
    this.root.appendChild(this.importSection());
    this.root.appendChild(this.listSection());
    const sel = this.app.models.selected;
    if (sel) this.root.appendChild(this.transformSection(sel));
    this.root.appendChild(this.exportSection());
  }

  importSection() {
    const app = this.app;
    const opts = { units: 'mm', role: 'fixture', recentre: true };

    const importFiles = async (files) => {
      for (const file of files) {
        try {
          const model = await app.models.addFromFile(file, opts);
          app.models.select(model);
          app.notify(`Imported ${model.name} — ${model.triangles.toLocaleString()} triangles.`, 'ok');
        } catch (err) {
          app.notify(err.message, 'error');
        }
      }
      app.refreshFixtures();
      app.fitToScene();
    };

    const drop = el('div.dropzone', {
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        importFiles([...e.dataTransfer.files].filter((f) => /\.stl$/i.test(f.name)));
      },
      onclick: async () => importFiles(await pickFile('.stl', true)),
    }, 'Drop STL files here, or click to browse');

    return section('Import geometry', [
      drop,
      row([
        select('Units in file', [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }], opts.units, (v) => { opts.units = v; }),
        select('Role', Object.entries(MODEL_ROLES).map(([k, v]) => ({ value: k, label: v.label })), opts.role, (v) => { opts.role = v; }),
      ]),
      checkbox('Sit on Z0 and centre in XY', true, (v) => { opts.recentre = v; }),
      el('div.hint', {}, 'STL carries no units, so pick the right one here. Fixtures and clamps are collision-checked against the whole tool assembly; reference parts are not.'),
      row([
        button('Add vice jaws', () => { app.addPrimitiveFixture('vice'); app.refreshFixtures(); }),
        button('Add parallels', () => { app.addPrimitiveFixture('parallels'); app.refreshFixtures(); }),
        button('Add clamp', () => { app.addPrimitiveFixture('clamp'); app.refreshFixtures(); }),
      ]),
    ]);
  }

  listSection() {
    const app = this.app;
    const list = el('div.list');
    if (!app.models.models.length) {
      list.appendChild(el('div.hint', {}, 'Nothing imported yet.'));
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
          button(m.visible ? '👁' : '⃠', (e) => {
            e.stopPropagation();
            app.models.setVisible(m, !m.visible);
            app.refreshFixtures();
            this.render();
          }, { title: 'Show / hide' }),
          button('✕', (e) => {
            e.stopPropagation();
            app.models.remove(m);
            app.refreshFixtures();
          }, { title: 'Remove', variant: 'warn' }),
        ]),
      ]));
    }
    return section(`Scene models (${app.models.models.length})`, [list]);
  }

  transformSection(m) {
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
      el('div.btn-group', {}, GIZMOS.map(([mode, label]) => el(`button.btn${this.gizmoMode === mode ? '.active' : ''}`, {
        type: 'button',
        onclick: () => {
          this.gizmoMode = mode;
          app.models.setGizmoMode(mode);
          this.render();
        },
      }, label))),
      row(['X', 'Y', 'Z'].map((a, i) => field(a, Number(o.position.toArray()[i].toFixed(3)), {
        step: 1, unit: 'mm', onChange: (v) => setPos(i, v),
      }))),
      row(['RX', 'RY', 'RZ'].map((a, i) => field(a, Number((([o.rotation.x, o.rotation.y, o.rotation.z][i] * 180) / Math.PI).toFixed(2)), {
        step: 15, unit: '°', onChange: (v) => setRot(i, v),
      }))),
      row([
        field('Scale', Number(o.scale.x.toFixed(4)), {
          min: 0.001, step: 0.1,
          onChange: (v) => {
            const s = Math.max(0.001, v || 1);
            app.models.setTransform(m, { scale: [s, s, s] });
            app.refreshFixtures();
          },
        }),
        select('Role', Object.entries(MODEL_ROLES).map(([k, v]) => ({ value: k, label: v.label })), m.role, (v) => {
          app.models.setRole(m, v);
          app.refreshFixtures();
          this.render();
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
          this.render();
        }),
        button('Deselect', () => app.models.select(null)),
      ]),
    ]);
  }

  exportSection() {
    const app = this.app;
    return section('Export', [
      row([
        button('Selected as STL', () => app.exportModelStl(app.models.selected)),
        button('Machined stock as STL', () => app.exportStockStl()),
      ]),
    ], { collapsed: true });
  }
}
