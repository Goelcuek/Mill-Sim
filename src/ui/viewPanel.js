// What the viewport draws.
//
// Every display setting lives here and only here. A toggle that also
// appeared beside the thing it affects would be the same control in two
// places, which is the one thing this layout is built to avoid — so Setup
// talks about the stock and View decides what colour it is.

import { el, select, checkbox, row, section, clear } from './dom.js';
import { Panel, actionRow } from './panel.js';
import { BACKGROUNDS, DEFAULT_BACKGROUND } from '../scene/backgrounds.js';
import { fmt } from '../core/util.js';

export class ViewPanel extends Panel {
  constructor(app) {
    super(app, [
      { id: 'camera', label: 'Camera', icon: 'view', hint: 'Where you are looking from', render: ViewPanel.prototype.cameraPage },
      { id: 'show', label: 'Show', icon: 'eye', hint: 'What is drawn', render: ViewPanel.prototype.showPage },
      { id: 'inspect', label: 'Inspect', icon: 'ruler', hint: 'Section plane, opacity, backplot', render: ViewPanel.prototype.inspectPage },
    ]);
    this.render();
  }

  /** A labelled range whose readout follows the thumb as it drags. */
  slider(label, value, opts, onInput) {
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
  }

  cameraPage() {
    const app = this.app;
    return section('Camera', [
      el('div.hint', {}, 'Drag to orbit, right-drag or two fingers to pan, wheel to zoom.'),
      actionRow([
        { label: 'Isometric', variant: 'primary', onClick: () => app.viewer.setView('iso') },
        { label: 'Fit the job', onClick: () => app.fitToScene(), hint: 'F' },
      ]),
      actionRow([
        { label: 'Top', onClick: () => app.viewer.setView('top') },
        { label: 'Front', onClick: () => app.viewer.setView('front') },
        { label: 'Right', onClick: () => app.viewer.setView('right') },
      ]),
      actionRow([
        { label: 'Fit the view to the path', disabled: !app.state.program, onClick: () => app.fitToProgram() },
      ]),
    ]);
  }

  showPage() {
    const app = this.app;
    const d = app.state.display;
    const t = (label, key) => checkbox(label, d[key], (v) => app.setDisplay({ [key]: v }));

    return [
      section('Show', [
        row([t('Stock', 'stock'), t('Tool', 'tool')]),
        row([t('Holder', 'holder'), t('Toolpath', 'toolpath')]),
        row([t('Rapid moves', 'rapids'), t('Work origins', 'origins')]),
        row([t('Grid', 'grid'), t('Axes', 'axes')]),
        row([t('Travel envelope', 'showLimits')]),
      ]),
      section('Background', [
        el('div.hint', {}, 'A light part on a light ground has no silhouette, and a machined face reads by its silhouette first. Pick whatever gives the part an edge.'),
        el('div.swatch-grid', {}, Object.entries(BACKGROUNDS).map(([key, bg]) => el(`button.swatch-tile${d.background === key ? '.active' : ''}`, {
          type: 'button',
          title: bg.label,
          onclick: () => { app.setDisplay({ background: key }); this.render(); },
        }, [
          el('span.swatch-chip', { style: { background: bg.css } }),
          el('span.swatch-name', {}, bg.label),
        ]))),
        row([
          el('label.field', {}, [
            el('span.field-label', {}, 'Custom'),
            el('input', {
              type: 'color',
              value: d.backgroundCustom,
              oninput: (e) => app.setDisplay({ background: 'custom', backgroundCustom: e.target.value }),
            }),
          ]),
          checkbox('Use the custom colour', d.background === 'custom', (v) => {
            app.setDisplay({ background: v ? 'custom' : DEFAULT_BACKGROUND });
            this.render();
          }),
        ]),
      ]),
      section('Colour', [
        row([
          el('label.field', {}, [
            el('span.field-label', {}, 'Raw stock'),
            el('input', { type: 'color', value: d.stockColor, oninput: (e) => app.setDisplay({ stockColor: e.target.value }) }),
          ]),
          checkbox('Cuts by tool', d.toolColors, (v) => app.setDisplay({ toolColors: v })),
        ]),
        el('div.hint', {}, 'With cuts coloured by tool, each cutter leaves its own shade so you can see which one made which face.'),
      ]),
    ];
  }

  inspectPage() {
    const app = this.app;
    const d = app.state.display;
    const out = [section('Inspect', [
      this.slider('Section view', d.sectionPct, {
        min: 0, max: 100, step: 0.5, format: (v) => (v >= 100 ? 'off' : `${v.toFixed(0)}%`),
      }, (v) => app.setDisplay({ sectionPct: v })),
      el('div.hint', {}, 'Clips the stock above a height so you can see into deep pockets.'),
      this.slider('Tool opacity', d.toolOpacity, {
        min: 0.1, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`,
      }, (v) => app.setDisplay({ toolOpacity: v })),
      row([
        select('Backplot', [
          { value: 'all', label: 'Whole program' },
          { value: 'remaining', label: 'Still to cut' },
          { value: 'done', label: 'Already cut' },
        ], d.backplot, (v) => app.setDisplay({ backplot: v })),
      ]),
    ])];

    const st = app.stock;
    if (st) {
      out.push(section('Simulation grid', [
        el('div.hint', { html: `<b>${st.nx} × ${st.ny}</b> = ${(st.cellCount / 1e6).toFixed(2)} M columns · cell ${fmt(st.dx, 3)} mm` }),
        el('div.hint', { html: `Display mesh reduced ${app.stockView.renderStep}× to ${app.stockView.gridSize ? app.stockView.gridSize.join(' × ') : '–'} texels.` }),
        el('div.hint', {}, 'Resolution is set on Setup › Stock, because it is a property of the block rather than of the view.'),
      ]));
    }
    return out;
  }
}
