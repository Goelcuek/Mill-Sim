// Results panel: what the run found, and how to get the part out.

import { el, button, row, section, clear, download } from './dom.js';
import { COLLISION_TYPES } from '../sim/simulator.js';
import { fmt, fmtDuration } from '../core/util.js';

export class ResultsPanel {
  constructor(app) {
    this.app = app;
    this.root = el('div.panel');
    this.render();
  }

  refresh() { this.render(); }

  render() {
    const scrollTop = this.root.scrollTop;
    clear(this.root);
    this.root.appendChild(this.statsSection());
    const compare = this.compareSection();
    if (compare) this.root.appendChild(compare);
    this.root.appendChild(this.collisionSection());
    this.root.appendChild(this.exportSection());
    this.root.scrollTop = scrollTop;
  }

  statsSection() {
    const app = this.app;
    const sim = app.simulator;
    const stock = app.stock;
    const program = app.state.program;

    const removed = sim.removedVolume;
    const stockVol = stock ? stock.stockVolume : 0;
    const remaining = stockVol - removed;
    const pct = stockVol > 0 ? (removed / stockVol) * 100 : 0;

    const stats = [
      ['Progress', `${(sim.progress * 100).toFixed(1)} %`],
      ['Simulated', fmtDuration(sim.time)],
      ['Cycle time', program ? fmtDuration(program.stats.cycleTime) : '–'],
      ['Removed', `${fmt(removed / 1000, 2)} cm³`],
      ['Remaining', `${fmt(Math.max(remaining, 0) / 1000, 2)} cm³`],
      ['Of stock', `${pct.toFixed(1)} %`],
    ];

    return section('Run', [
      el('div.stat-grid', {}, stats.map(([k, v]) => el('div.stat', {}, [
        el('div.stat-label', {}, k),
        el('div.stat-value', {}, v),
      ]))),
      el('div.hint', {}, sim.finished ? 'Program finished.' : 'Run the program to the end for the final part.'),
      row([
        button('Run to end', () => app.runToEnd(), { variant: 'primary' }),
        button('Reset', () => app.reset()),
      ]),
    ]);
  }

  /** Stock versus the reference part, when one is loaded. */
  compareSection() {
    const app = this.app;
    const cmp = app.compareToReference();
    if (!cmp) return null;

    const tol = app.state.gougeTolerance;
    const pct = (n) => (cmp.comparedCells ? ((n / cmp.comparedCells) * 100).toFixed(2) : '0.00');
    const clean = cmp.gougeCells === 0;

    return section('Against the reference part', [
      el(`div.verdict.${clean ? 'ok' : 'bad'}`, {}, clean
        ? `No cut passes the reference surface by more than ${fmt(tol, 3)} mm.`
        : `Gouged in ${cmp.gougeCells.toLocaleString()} places — up to ${fmt(cmp.maxGouge, 3)} mm past the surface.`),
      el('div.stat-grid', {}, [
        ['Max gouge', `${fmt(cmp.maxGouge, 3)} mm`],
        ['Gouged area', `${pct(cmp.gougeCells)} %`],
        ['Stock left', `${fmt(cmp.maxExcess, 2)} mm`],
      ].map(([k, v]) => el('div.stat', {}, [
        el('div.stat-label', {}, k),
        el('div.stat-value', {}, v),
      ]))),
      el('label.field', {}, [
        el('span.field-label', {}, ['Gouge tolerance ', el('span.value', {}, `${fmt(tol, 3)} mm`)]),
        el('input', {
          type: 'range', min: 0, max: 0.2, step: 0.005, value: tol,
          onchange: (e) => {
            app.setGougeTolerance(parseFloat(e.target.value));
            this.refresh();
          },
        }),
      ]),
      el('div.hint', {}, 'Cutting deeper than the reference surface by more than this counts as a gouge and is listed with the collisions. "Stock left" is the thickest material still standing above the part.'),
    ]);
  }

  collisionSection() {
    const app = this.app;
    const list = app.simulator.collisions;
    const errors = list.filter((c) => c.severity === 'error');

    const body = [];
    if (!list.length) {
      body.push(el('div.verdict.ok', {}, app.simulator.finished
        ? 'No collisions found in the whole program.'
        : 'Nothing found so far.'));
    } else {
      body.push(el('div.verdict.bad', {}, `${errors.length} problem${errors.length === 1 ? '' : 's'} found${list.length !== errors.length ? `, plus ${list.length - errors.length} warning${list.length - errors.length === 1 ? '' : 's'}` : ''}.`));
      const items = list.slice(0, 200).map((c) => el(`div.collision.sev-${c.severity}`, {
        onclick: () => app.seekToLine(c.line, c.time),
        title: 'Jump to this point in the program',
      }, [
        el('div.collision-head', {}, [
          el('span.collision-type', {}, COLLISION_TYPES[c.type] ? COLLISION_TYPES[c.type].label : c.type),
          el('span.collision-line', {}, `line ${c.line}`),
        ]),
        el('div.collision-msg', {}, c.message),
        el('div.collision-meta', {}, [
          c.count > 1 ? `${c.count} occurrences · ` : '',
          c.position ? `at X${fmt(c.position[0], 2)} Y${fmt(c.position[1], 2)} Z${fmt(c.position[2], 2)}` : '',
        ].join('')),
      ]));
      body.push(el('div.collision-list', {}, items));
    }

    return section(`Collisions (${list.length})`, body);
  }

  exportSection() {
    const app = this.app;
    return section('Export', [
      el('div.hint', {}, 'The machined stock is written as a closed solid built from the simulation heightmap.'),
      row([
        button('Part as STL', () => app.exportStockStl(), { variant: 'primary' }),
        button('Part as OBJ', () => app.exportStockObj()),
      ]),
      row([
        button('Collision report', () => {
          download('mill-sim-report.md', app.buildReport(), 'text/markdown');
        }),
        button('Screenshot', () => {
          const url = app.viewer.screenshot();
          const a = el('a', { href: url, download: 'mill-sim.png' });
          document.body.appendChild(a);
          a.click();
          a.remove();
        }),
      ]),
      el('label.field', {}, [
        el('span.field-label', {}, 'Export detail'),
        el('select', {
          onchange: (e) => { app.state.exportDecimate = Number(e.target.value); },
        }, [
          el('option', { value: '1', selected: true }, 'Full simulation grid'),
          el('option', { value: '2' }, 'Half (smaller file)'),
          el('option', { value: '4' }, 'Quarter (much smaller)'),
        ]),
      ]),
    ]);
  }
}
