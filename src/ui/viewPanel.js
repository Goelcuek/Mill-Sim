// What the viewport draws.
//
// The ribbon's View tab carries the toggles you flip constantly; this panel
// holds the continuous controls — the section plane, opacities, colours —
// which want a slider rather than a button.

import { el, select, checkbox, row, section, clear } from './dom.js';
import { fmt } from '../core/util.js';

export class ViewPanel {
  constructor(app) {
    this.app = app;
    this.root = el('div.panel');
    this.render();
  }

  refresh() { this.render(); }

  render() {
    const scrollTop = this.root.scrollTop;
    clear(this.root);
    const app = this.app;
    const d = app.state.display;

    const slider = (label, value, opts, onInput) => {
      const out = el('span.value', {}, opts.format(value));
      return el('label.field', {}, [
        el('span.field-label', {}, [label, ' ', out]),
        el('input', {
          type: 'range', min: opts.min, max: opts.max, step: opts.step, value,
          oninput: (e) => {
            const v = parseFloat(e.target.value);
            out.textContent = opts.format(v);
            onInput(v);
          },
        }),
      ]);
    };

    this.root.appendChild(section('Inspect', [
      slider('Section view', d.sectionPct, {
        min: 0, max: 100, step: 0.5, format: (v) => (v >= 100 ? 'off' : `${v.toFixed(0)}%`),
      }, (v) => app.setDisplay({ sectionPct: v })),
      el('div.hint', {}, 'Clips the stock above a height so you can see into deep pockets.'),
      slider('Tool opacity', d.toolOpacity, {
        min: 0.1, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`,
      }, (v) => app.setDisplay({ toolOpacity: v })),
      row([
        select('Backplot', [
          { value: 'all', label: 'Whole program' },
          { value: 'remaining', label: 'Still to cut' },
          { value: 'done', label: 'Already cut' },
        ], d.backplot, (v) => app.setDisplay({ backplot: v })),
      ]),
    ]));

    this.root.appendChild(section('Show', [
      row([
        checkbox('Stock', d.stock, (v) => { app.setDisplay({ stock: v }); app.buildRibbon(); }),
        checkbox('Tool', d.tool, (v) => { app.setDisplay({ tool: v }); app.buildRibbon(); }),
      ]),
      row([
        checkbox('Holder', d.holder, (v) => { app.setDisplay({ holder: v }); app.buildRibbon(); }),
        checkbox('Toolpath', d.toolpath, (v) => { app.setDisplay({ toolpath: v }); app.buildRibbon(); }),
      ]),
      row([
        checkbox('Rapid moves', d.rapids, (v) => { app.setDisplay({ rapids: v }); app.buildRibbon(); }),
        checkbox('Work origins', d.origins, (v) => { app.setDisplay({ origins: v }); app.buildRibbon(); }),
      ]),
      row([
        checkbox('Grid', d.grid, (v) => { app.setDisplay({ grid: v }); app.buildRibbon(); }),
        checkbox('Axes', d.axes, (v) => { app.setDisplay({ axes: v }); app.buildRibbon(); }),
      ]),
    ]));

    this.root.appendChild(section('Colour', [
      row([
        el('label.field', {}, [
          el('span.field-label', {}, 'Raw stock'),
          el('input', { type: 'color', value: d.stockColor, oninput: (e) => app.setDisplay({ stockColor: e.target.value }) }),
        ]),
        checkbox('Cuts by tool', d.toolColors, (v) => { app.setDisplay({ toolColors: v }); app.buildRibbon(); }),
      ]),
      el('div.hint', {}, 'With cuts coloured by tool, each cutter leaves its own shade so you can see which one made which face.'),
    ]));

    const st = app.stock;
    if (st) {
      this.root.appendChild(section('Simulation grid', [
        el('div.hint', { html: `<b>${st.nx} × ${st.ny}</b> = ${(st.cellCount / 1e6).toFixed(2)} M columns · cell ${fmt(st.dx, 3)} mm` }),
        el('div.hint', { html: `Display mesh reduced ${app.stockView.renderStep}× to ${app.stockView.gridSize ? app.stockView.gridSize.join(' × ') : '–'} texels.` }),
      ], { collapsed: true }));
    }

    this.root.scrollTop = scrollTop;
  }
}
