// The Settings window: preferences that are kept between starts.
//
// Everything takes effect as it is changed — there is nothing to apply and
// nothing to cancel — and everything is remembered on this computer. The
// same switches are on the viewport's Display panel; this is where all of
// them are together, with the defaults a new job starts from.

import { el, select, checkbox, field, clear } from './dom.js';
import { Dialog, confirmDialog } from './dialog.js';
import { icon } from './icons.js';
import { BACKGROUNDS } from '../scene/backgrounds.js';
import { settings, DEFAULTS } from './settings.js';
import { RESOLUTIONS, SPEEDS } from '../app.js';
import * as units from '../core/units.js';

/* global __BUILD_STAMP__ */

const CATEGORIES = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'viewport', label: 'Viewport', icon: 'eye' },
  { id: 'simulation', label: 'Simulation', icon: 'play' },
  { id: 'checks', label: 'Collision checks', icon: 'shield' },
];

/** A row of mutually exclusive buttons. */
function segmented(label, options, value, onChange) {
  const group = el('div.segmented', { role: 'radiogroup' }, options.map((o) => el(`button${String(o.value) === String(value) ? '.on' : ''}`, {
    type: 'button',
    role: 'radio',
    'aria-checked': String(o.value) === String(value) ? 'true' : 'false',
    onclick: () => onChange(o.value),
  }, o.label)));
  return settingRow(label, group);
}

function settingRow(label, control, hint) {
  return el('div.setting', {}, [
    el('div.setting-text', {}, [el('div.setting-label', {}, label), hint ? el('div.setting-hint', {}, hint) : null]),
    el('div.setting-control', {}, [control]),
  ]);
}

function toggle(label, value, onChange, hint) {
  const input = el('input', { type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked) });
  return settingRow(label, el('label.switch', {}, [input, el('span.switch-track')]), hint);
}

export function openSettings(app, start = 'general') {
  let current = start;
  const nav = el('nav.settings-nav');
  const pane = el('div.settings-pane');

  const change = (patch) => {
    app.applySettings(patch);
    draw();
  };

  const pages = {
    general() {
      const s = settings();
      return [
        el('h3', {}, 'Appearance'),
        segmented('Theme', [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }], s.theme, (v) => change({ theme: v })),
        el('h3', {}, 'Units'),
        segmented('Show lengths in', [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }], s.units, (v) => change({ units: v })),
        el('div.setting-note', {}, 'How numbers are shown, nothing more. The job is held in millimetres either way, and a program’s own G20/G21 still decides what its numbers mean.'),
        el('h3', {}, 'Starting up'),
        segmented('Open on', [{ value: 'machine', label: 'Step 1 · Machine' }, { value: 'last', label: 'Where I left off' }], s.startStep, (v) => change({ startStep: v })),
        app.desktop ? toggle('Reopen the last machine', s.reopenMachine, (v) => change({ reopenMachine: v }), 'The machine from the machines folder that was in use when the program was closed') : null,
        toggle('Step guidance', s.stepHints, (v) => change({ stepHints: v }), 'A line under each step’s title saying what it is for'),
      ];
    },

    viewport() {
      const s = settings();
      const d = s.display;
      const set = (patch) => change({ display: patch });
      return [
        el('h3', {}, 'Background'),
        el('div.swatch-grid', {}, Object.entries(BACKGROUNDS).map(([key, bg]) => el(`button.swatch-tile${d.background === key ? '.active' : ''}`, {
          type: 'button',
          title: bg.label,
          onclick: () => set({ background: key }),
        }, [el('span.swatch-chip', { style: { background: bg.css } }), el('span.swatch-name', {}, bg.label)]))),
        settingRow('Custom colour', el('input', {
          type: 'color',
          value: d.backgroundCustom,
          onchange: (e) => set({ background: 'custom', backgroundCustom: e.target.value }),
        })),
        el('h3', {}, 'Stock'),
        settingRow('Raw stock colour', el('input', { type: 'color', value: d.stockColor, onchange: (e) => set({ stockColor: e.target.value }) })),
        toggle('Colour cuts by tool', d.toolColors, (v) => set({ toolColors: v }), 'Each cutter leaves its own colour on the faces it made'),
        el('h3', {}, 'Shown'),
        toggle('Toolpath', d.toolpath, (v) => set({ toolpath: v })),
        toggle('Rapid moves', d.rapids, (v) => set({ rapids: v })),
        toggle('Tool holder', d.holder, (v) => set({ holder: v })),
        toggle('Edge outlines', d.edges, (v) => set({ edges: v }), 'On the machine, fixtures, parts and tool'),
        toggle('Work origins', d.origins, (v) => set({ origins: v })),
        toggle('Grid', d.grid, (v) => set({ grid: v })),
        toggle('Axes', d.axes, (v) => set({ axes: v })),
        toggle('Travel envelope', d.showLimits, (v) => set({ showLimits: v })),
        settingRow('Backplot', select('', [
          { value: 'all', label: 'Whole program' },
          { value: 'remaining', label: 'Still to cut' },
          { value: 'done', label: 'Already cut' },
        ], d.backplot, (v) => set({ backplot: v }))),
      ];
    },

    simulation() {
      const s = settings();
      const near = RESOLUTIONS.reduce((b, v) => (Math.abs(v - s.resolution) < Math.abs(b - s.resolution) ? v : b), RESOLUTIONS[0]);
      return [
        el('h3', {}, 'Material removal'),
        settingRow('Resolution for new stock', select('', RESOLUTIONS.map((r) => ({ value: String(r), label: units.lenU(r, 3) })), String(near),
          (v) => change({ resolution: Number(v) })), 'Finer is sharper and slower. 0.2–0.4 mm suits most parts.'),
        el('h3', {}, 'Playback'),
        settingRow('Speed', select('', SPEEDS, s.speed, (v) => change({ speed: v }))),
        toggle('Stop at a collision', s.checks.stopOnCollision, (v) => change({ checks: { stopOnCollision: v } }), 'Playing halts at the first crash, gouge or travel limit'),
      ];
    },

    checks() {
      const c = settings().checks;
      return [
        el('h3', {}, 'Clearance'),
        settingRow('Near miss', field('', c.nearMiss, {
          min: 0, step: 0.25, unit: 'mm',
          onChange: (v) => change({ checks: { nearMiss: Math.max(0, Number(v) || 0) } }),
        }), 'Passing closer than this to a fixture or the table is a warning. 0 reports metal in metal only.'),
        settingRow('Gouge tolerance', field('', settings().gougeTolerance, {
          min: 0, step: 0.01, unit: 'mm',
          onChange: (v) => change({ gougeTolerance: Math.max(0, Number(v) || 0) }),
        }), 'How far the cutter may pass the reference surface before it gouges'),
        toggle('Report rapids that touch material', c.rapidIntoStock, (v) => change({ checks: { rapidIntoStock: v } })),
        el('h3', {}, 'Checked against fixtures, table and travels'),
        toggle('Cutter and shank', c.parts.tool !== false, (v) => change({ checks: { parts: { tool: v, shank: v } } })),
        toggle('Holder', c.parts.holder !== false, (v) => change({ checks: { parts: { holder: v } } })),
        toggle('Spindle nose', c.parts.spindle !== false, (v) => change({ checks: { parts: { spindle: v } } })),
        toggle('Holder, shank and spindle against the reference part', c.reference !== false, (v) => change({ checks: { reference: v } })),
      ];
    },
  };

  function draw() {
    clear(nav);
    for (const c of CATEGORIES) {
      nav.appendChild(el(`button.settings-tab${c.id === current ? '.on' : ''}`, {
        type: 'button',
        dataset: { category: c.id },
        onclick: () => { current = c.id; draw(); },
      }, [icon(c.icon, 16), el('span', {}, c.label)]));
    }
    const scroll = pane.scrollTop;
    clear(pane);
    for (const n of pages[current]()) if (n) pane.appendChild(n);
    pane.scrollTop = scroll;
  }
  draw();

  const reset = el('button.btn', {
    type: 'button',
    onclick: () => confirmDialog({
      title: 'Reset all settings?',
      message: 'Theme, units, viewport and check defaults go back to how they came. Your machines, tools and projects are not touched.',
      confirm: 'Reset',
      danger: true,
      onConfirm: () => { app.applySettings(null); draw(); },
    }),
  }, 'Reset to defaults');

  const dlg = new Dialog({
    title: 'Settings',
    subtitle: `Kept on this computer between starts · ${typeof __BUILD_STAMP__ === 'string' ? `built ${__BUILD_STAMP__}` : 'development copy'}`,
    width: 720,
    body: el('div.settings', {}, [nav, pane]),
    cancel: 'Done',
    extra: [reset],
  });
  dlg.window.classList.add('dialog-settings');
  dlg.open();
  return dlg;
}

export { DEFAULTS };
