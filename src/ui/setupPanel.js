// Setup panel: the stock, the machine and what the viewport shows.

import { el, field, select, checkbox, button, row, section, clear } from './dom.js';
import { fmt } from '../core/util.js';

const AXES = ['X', 'Y', 'Z'];

export class SetupPanel {
  constructor(app) {
    this.app = app;
    this.root = el('div.panel');
    this.render();
  }

  render() {
    clear(this.root);
    this.root.appendChild(this.stockSection());
    this.root.appendChild(this.machineSection());
    this.root.appendChild(this.offsetsSection());
    this.root.appendChild(this.displaySection());
  }

  refresh() {
    this.render();
  }

  // ---- stock -------------------------------------------------------------

  stockSection() {
    const app = this.app;
    const s = app.state.stock;
    const stock = app.stock;

    const info = el('div.hint');
    const updateInfo = () => {
      const st = app.stock;
      if (!st) { info.textContent = ''; return; }
      info.innerHTML = `Grid <b>${st.nx} × ${st.ny}</b> = ${(st.cellCount / 1000).toFixed(0)}k columns · cell ${fmt(st.dx, 3)} × ${fmt(st.dy, 3)} mm`;
    };
    updateInfo();

    const sizeRow = row(AXES.map((a, i) => field(`Size ${a}`, s.size[i], {
      min: 1, step: 1, unit: 'mm',
      onChange: (v) => {
        const size = [...app.state.stock.size];
        size[i] = Math.max(1, v || 1);
        app.setStock({ size });
        this.refresh();
      },
    })));

    const originRow = row(AXES.map((a, i) => field(`Min ${a}`, s.origin[i], {
      step: 1, unit: 'mm',
      onChange: (v) => {
        const origin = [...app.state.stock.origin];
        origin[i] = v || 0;
        app.setStock({ origin });
        this.refresh();
      },
    })));

    const res = el('input', {
      type: 'range', min: 0.05, max: 2, step: 0.05, value: s.resolution,
      oninput: (e) => {
        const v = parseFloat(e.target.value);
        resLabel.textContent = `${v.toFixed(2)} mm`;
        app.setStock({ resolution: v });
        updateInfo();
      },
    });
    const resLabel = el('span.value', {}, `${Number(s.resolution).toFixed(2)} mm`);

    return section('Stock', [
      sizeRow,
      originRow,
      el('label.field', {}, [
        el('span.field-label', {}, ['Simulation resolution ', resLabel]),
        res,
      ]),
      info,
      el('div.hint', {}, 'Finer cells give sharper corners and scallops but cost memory and speed. 0.2–0.4 mm suits most parts.'),
      row([
        button('Centre on origin', () => {
          const size = app.state.stock.size;
          app.setStock({ origin: [-size[0] / 2, -size[1] / 2, -size[2]] });
          this.refresh();
        }, { title: 'Put the work zero at the centre of the top face.' }),
        button('Fit to program', () => {
          app.fitStockToProgram();
          this.refresh();
        }, { title: 'Size the block around the programmed toolpath with a small margin.' }),
        button('Reset stock', () => app.resetStock(), { variant: 'warn' }),
      ]),
      row([
        el('label.field', {}, [
          el('span.field-label', {}, 'Material colour'),
          el('input', {
            type: 'color', value: app.state.display.stockColor,
            oninput: (e) => app.setDisplay({ stockColor: e.target.value }),
          }),
        ]),
        checkbox('Colour machined faces by tool', app.state.display.toolColors, (v) => app.setDisplay({ toolColors: v })),
      ]),
    ]);
  }

  // ---- machine -----------------------------------------------------------

  machineSection() {
    const app = this.app;
    const m = app.state.machine;

    const limitFields = () => row([
      ...AXES.map((a, i) => field(`${a} min`, m.limits.min[i], {
        step: 10, unit: 'mm', disabled: !m.limits.enabled,
        onChange: (v) => {
          const min = [...m.limits.min];
          min[i] = v || 0;
          app.setMachine({ limits: { ...m.limits, min } });
        },
      })),
    ]);

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
        field('Spindle nose length', m.spindleLength, { min: 0, step: 5, unit: 'mm', onChange: (v) => app.setMachine({ spindleLength: Math.max(0, v || 0) }) }),
      ]),
      el('div.hint', {}, 'The spindle nose is included in the crash model, so a plunge that buries the spindle is caught even when the holder clears.'),
      row([
        field('Rapid rate', m.rapidRate, { min: 100, step: 500, unit: 'mm/min', onChange: (v) => app.setMachine({ rapidRate: Math.max(100, v || 1000) }) }),
      ]),
      checkbox('Check the table surface', m.table.enabled, (v) => app.setMachine({ table: { ...m.table, enabled: v } })),
      checkbox('Check travel limits', m.limits.enabled, (v) => {
        app.setMachine({ limits: { ...m.limits, enabled: v } });
        this.refresh();
      }),
      m.limits.enabled ? limitFields() : null,
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

  // ---- work offsets ------------------------------------------------------

  offsetsSection() {
    const app = this.app;
    const wcs = app.state.wcs;
    const rows = Object.keys(wcs).map((key) => row([
      el('span.wcs-name', {}, key),
      ...AXES.map((a, i) => field(a, wcs[key][i], {
        step: 1, unit: '',
        onChange: (v) => {
          const next = { ...app.state.wcs, [key]: [...app.state.wcs[key]] };
          next[key][i] = v || 0;
          app.setWcs(next);
        },
      })),
    ], 'wcs-row'));

    return section('Work offsets', [
      el('div.hint', {}, 'Scene coordinates of each work origin. G54 at 0,0,0 means the program zero is the scene origin.'),
      ...rows,
      row([
        field('Home / G28 Z', app.state.machineZero[2], {
          step: 10, unit: 'mm',
          onChange: (v) => app.setMachineZero([app.state.machineZero[0], app.state.machineZero[1], v || 0]),
        }),
      ]),
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
        checkbox('Stock', d.stock, (v) => app.setDisplay({ stock: v })),
      ]),
      row([
        checkbox('Tool', d.tool, (v) => app.setDisplay({ tool: v })),
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
        el('span.field-label', {}, ['Tool opacity']),
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
