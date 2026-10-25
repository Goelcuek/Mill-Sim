// Results panel: what the run found, and how to get the part out.
//
// Four pages. Playback is not one of them: the transport bar under the
// viewport is always visible and already owns play, step, run-to-end and
// the scrubber, so putting the same buttons here would be the duplication
// this layout exists to avoid.

import { el, section, field, select, download } from './dom.js';
import { MATERIALS, materialById } from '../cutting/materials.js';
import { chipTarget } from '../cutting/analyzer.js';
import { Panel, actionRow } from './panel.js';
import { COLLISION_TYPES } from '../sim/simulator.js';
import { fmtDuration } from '../core/util.js';
import * as units from '../core/units.js';

export class ResultsPanel extends Panel {
  constructor(app) {
    super(app, [
      { id: 'findings', label: 'Findings', icon: 'report', hint: 'Collisions and gouges the run turned up', badge: () => app.simulator.collisions.length || null, render: ResultsPanel.prototype.findingsPage },
      { id: 'loads', label: 'Loads', icon: 'gauge', hint: 'Forces, power and deflection along the run, from the metal each move meets', render: ResultsPanel.prototype.loadsPage },
      { id: 'compare', label: 'Compare', icon: 'target', hint: 'The cut against the reference part', render: ResultsPanel.prototype.comparePage },
      { id: 'export', label: 'Export', icon: 'export', hint: 'The machined part, the report, a screenshot', render: ResultsPanel.prototype.exportPage },
    ]);
    this.render();
  }

  findingsPage() {
    return [this.statsSection(), this.collisionSection()];
  }

  comparePage() {
    const compare = this.compareSection();
    return [compare || section('Compare against a reference part', [
      el('div.empty', {}, [
        el('div.empty-title', {}, 'No reference part loaded'),
        el('div.hint', {}, 'Import the finished part on Setup › Fixtures with the role Reference part.'),
      ]),
      actionRow([{ label: 'Go to fixtures', variant: 'primary', onClick: () => this.app.setPage('setup', 'fixtures') }]),
    ])];
  }

  exportPage() {
    return [this.exportSection()];
  }

  /**
   * How hard each tool works, and where it works hardest.
   *
   * Read, not acted on: nothing here changes a feed. It is the measured
   * half of feed optimisation — the engagement each move really meets and
   * what the force model makes of it — shown first so the numbers can be
   * checked against what the machinist knows before anything is allowed
   * to rewrite a program on the strength of them.
   */
  loadsPage() {
    const app = this.app;
    const c = app.state.cutting;
    const m = materialById(c.material);
    const groups = { P: 'Steel', M: 'Stainless', K: 'Cast iron', N: 'Non-ferrous', S: 'Superalloys & titanium', H: 'Hardened' };
    const settings = section('Cutting against', [
      select('Stock material', MATERIALS.map((x) => ({ value: x.id, label: `${groups[x.group] || x.group} · ${x.name}` })), c.material,
        (v) => app.setCutting({ material: v })),
      el('div.hint', {}, `${m.examples} · ${m.hardness} · kc1.1 ${m.kc11} MPa, mc ${m.mc}.`),
      el('div.row', {}, [
        field('Spindle power (kW)', c.spindleKw, { min: 0, step: 0.5, onChange: (v) => app.setCutting({ spindleKw: Math.max(0, Number(v) || 0) }) }),
        field('Spindle torque (N·m)', c.spindleNm, { min: 0, step: 1, onChange: (v) => app.setCutting({ spindleNm: Math.max(0, Number(v) || 0) }) }),
      ]),
      field('Deflection limit', c.maxDeflection, { min: 0, step: 0.005, unit: 'mm', onChange: (v) => app.setCutting({ maxDeflection: Math.max(0, Number(v) || 0) }) }),
    ]);

    const rows = app.analyzer.summary(app.state.program);
    if (!rows.length) {
      return [settings, section('Loads', [
        el('div.empty', {}, [
          el('div.empty-title', {}, app.state.program ? 'Nothing measured yet' : 'No program loaded'),
          el('div.hint', {}, 'Run the program and every cutting move is measured.'),
        ]),
      ])];
    }

    const toolName = (n) => {
      const slot = app.simulator.slots.get(n) || app.simulator.fallbackSlot;
      return slot ? slot.built.tool.def.name : 'no tool';
    };
    const targetOf = (n) => {
      const slot = app.simulator.slots.get(n) || app.simulator.fallbackSlot;
      if (!slot) return null;
      const def = slot.built.tool.def;
      return chipTarget(def.type, m, 2 * slot.built.cutRadius, def.material);
    };
    const go = (w) => () => this.seekToMove(w.move);
    const stat = (label, text, w, level = '') => el(`div.stat.clickable${level ? `.${level}` : ''}`, {
      onclick: w && w.move >= 0 ? go(w) : null,
      title: w && w.move >= 0 ? `Line ${w.line}: jump there` : '',
    }, [el('div.stat-label', {}, label), el('div.stat-value', {}, text)]);

    const cards = rows.map((r) => {
      // The catalogue chip for this cutter in this material, which is what
      // "light" and "heavy" are measured against.
      const target = targetOf(r.tool);
      const chipRatio = target > 0 ? r.chip.value / target : 0;
      const chipNote = !target ? '' : chipRatio > 1.4 ? 'heavy for the material' : chipRatio < 0.4 ? 'light — rubbing more than cutting' : 'in the usual range';
      const overPower = c.spindleKw > 0 && r.power.value > c.spindleKw;
      const overTorque = c.spindleNm > 0 && r.torque.value > c.spindleNm;
      const overBend = c.maxDeflection > 0 && r.deflection.value > c.maxDeflection;
      return section(`T${r.tool} · ${toolName(r.tool)}`, [
        el('div.stat-grid', {}, [
          stat('Peak force', `${Math.round(r.force.value)} N`, r.force),
          stat('Spindle power', `${r.power.value.toFixed(2)} kW${c.spindleKw > 0 ? ` · ${Math.round((r.power.value / c.spindleKw) * 100)} %` : ''}`, r.power, overPower ? 'bad' : ''),
          stat('Peak torque', `${r.torque.value.toFixed(2)} N·m`, r.torque, overTorque ? 'bad' : ''),
          stat('Deflection', units.lenU(r.deflection.value, 3), r.deflection, overBend ? 'bad' : ''),
          stat('Max chip', units.lenU(r.chip.value, 4), r.chip),
          stat('Deepest cut', units.lenU(r.ap.value, 2), r.ap),
        ]),
        el('div.hint', {}, [
          `${r.moves.toLocaleString()} cutting move${r.moves === 1 ? '' : 's'}; widest contact ${Math.round(r.arc.value)}°, feed ${units.len(r.fz.value, 4)} ${units.lengthLabel()} a tooth at most.`,
          target ? ` The thickest chip is ${chipNote} (catalogue ${units.len(target, 3)} ${units.lengthLabel()} for this cutter).` : '',
          overPower ? ' Asks for more power than the spindle has.' : '',
          overTorque ? ' Asks for more torque than the spindle has.' : '',
          overBend ? ' Bends further than the limit set above.' : '',
          r.force.plunge ? ' Its peak is a plunge, read as drilling — an approximation.' : '',
        ].join('')),
      ]);
    });

    return [settings, ...cards];
  }

  /** Where in the run a move is, so a card can jump to it. */
  seekToMove(i) {
    const app = this.app;
    const moves = app.state.program ? app.state.program.moves : [];
    let t = 0;
    for (let k = 0; k < i && k < moves.length; k++) t += moves[k].time;
    if (moves[i]) t += moves[i].time * 0.5;
    app.seekTo(t);
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
      ['Removed', units.volumeU(removed, 2)],
      ['Remaining', units.volumeU(Math.max(remaining, 0), 2)],
      ['Of stock', `${pct.toFixed(1)} %`],
    ];

    return section('Run', [
      el('div.stat-grid', {}, stats.map(([k, v]) => el('div.stat', {}, [
        el('div.stat-label', {}, k),
        el('div.stat-value', {}, v),
      ]))),
      // Playback lives in the transport bar under the viewport, where it is
      // always reachable; repeating it here would be the same two buttons
      // twice on one screen.
      el('div.hint', {}, sim.finished
        ? 'Program finished.'
        : 'Press ⏭⏭ in the bar under the viewport to run it to the end.'),
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
        ? `No cut passes the reference surface by more than ${units.lenU(tol, 3)}.`
        : `Gouged in ${cmp.gougeCells.toLocaleString()} places — up to ${units.lenU(cmp.maxGouge, 3)} past the surface.`),
      el('div.stat-grid', {}, [
        ['Max gouge', units.lenU(cmp.maxGouge, 3)],
        ['Gouged area', `${pct(cmp.gougeCells)} %`],
        ['Stock left', `${cmp.excessCapped ? '> ' : ''}${units.lenU(cmp.maxExcess, 2)}`],
      ].map(([k, v]) => el('div.stat', {}, [
        el('div.stat-label', {}, k),
        el('div.stat-value', {}, v),
      ]))),
      el('label.field', {}, [
        el('span.field-label', {}, ['Gouge tolerance ', el('span.value', {}, units.lenU(tol, 3))]),
        el('input', {
          type: 'range', min: 0, max: 0.2, step: 0.005, value: tol,
          onchange: (e) => {
            app.setGougeTolerance(parseFloat(e.target.value));
            this.refresh();
          },
        }),
      ]),
      el('div.hint', {}, `Cutting into the part by more than this counts as a gouge and is listed with the collisions. "Stock left" is the thickest material still standing outside the part.`),
      el('div.hint', {}, `Everything is measured along the surface normal — the shortest distance from the cut to the part — so walls, bores and slopes are judged like floors: a wall left thick reads its thickness, and an oversize drill in a bore reads the oversize, not the depth of the hole. The cut is sampled at the centre of each grid column, so where it stands is known to within half a column, about ${units.lenU(cmp.lateral / 2, 3)} here; finer stock resolution narrows it.`),
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
          c.position ? `at X${units.len(c.position[0], 2)} Y${units.len(c.position[1], 2)} Z${units.len(c.position[2], 2)}` : '',
        ].join('')),
      ]));
      body.push(el('div.collision-list', {}, items));
    }

    body.push(field('Gouge tolerance', app.state.gougeTolerance, {
      unit: 'mm', step: 0.005, min: 0,
      title: 'How far a cut may pass the reference surface before it counts as a gouge',
      onChange: (v) => { app.setGougeTolerance(v); this.render(); },
    }));
    body.push(el('div.hint', {}, 'Changing this takes effect on the next run.'));

    return section(`Collisions (${list.length})`, body);
  }

  exportSection() {
    const app = this.app;
    return section('Export', [
      el('div.hint', {}, 'The machined stock is written as the closed surface the simulation holds — side holes and undercuts included.'),
      actionRow([
        { label: 'Part as STL', variant: 'primary', onClick: () => app.exportStockStl() },
        { label: 'Part as OBJ', onClick: () => app.exportStockObj() },
      ]),
      actionRow([
        { label: 'Collision report', onClick: () => download('mill-sim-report.md', app.buildReport(), 'text/markdown') },
        {
          label: 'Screenshot',
          onClick: () => {
            const url = app.viewer.screenshot();
            const a = el('a', { href: url, download: 'mill-sim.png' });
            document.body.appendChild(a);
            a.click();
            a.remove();
          },
        },
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
