// The performance recorder: where a frame's time goes, on the computer the
// program is actually running on.
//
// Ten seconds of playing are timed piece by piece — the simulation, check
// by check; the stock's picture; posing the machine; and the drawing, on
// the processor and, where the browser will say, on the graphics card —
// and written up as a report that can be copied and sent. It listens only
// while it records: the rest of the time every hook it uses is off, and
// costs the run nothing.

import { el, button } from './dom.js';

/** How long one recording lasts, seconds. */
const LENGTH = 10;

/** Simulation headings, in the order the report gives them. */
const SIM_PARTS = [
  ['skip', 'Skipping moves through air'],
  ['poses', 'Tool positions along each chunk'],
  ['cut', 'Cutting, with the gouge check'],
  ['holder', 'Shank and holder in the stock'],
  ['fixtures', 'Fixtures'],
  ['reference', 'Holder and spindle against the reference part'],
  ['table', 'Table'],
  ['castings', 'Tool against the machine castings'],
  ['machine', 'Machine against itself, the stock and the part'],
  ['limits', 'Travel limits'],
  ['other', 'Bookkeeping between checks'],
];

const ms = (v) => `${v.toFixed(1)} ms`;
const pct = (v, total) => (total > 0 ? `${((100 * v) / total).toFixed(0)}%` : '–');
const pad = (s, n) => String(s).padEnd(n);

export class PerfRecorder {
  constructor(app) {
    this.app = app;
    this.panel = null;
    this.report = '';
  }

  // ---- the panel ---------------------------------------------------------

  open() {
    if (this.panel) return;
    this.status = el('div.perf-status', {}, `Play the part of the program that is slow, then press Record. It records ${LENGTH} seconds and writes a report to copy and send.`);
    this.output = el('pre.perf-report');
    this.output.style.display = 'none';
    this.recordBtn = button('Record', () => this.start(), { variant: 'primary', title: `Time ${LENGTH} seconds of playing` });
    this.stopBtn = button('Stop', () => this.stop(), { title: 'Stop now and write the report' });
    this.stopBtn.disabled = true;
    this.copyBtn = button('Copy report', () => this.copy(), { title: 'Copy the report to paste into a message' });
    this.copyBtn.disabled = true;
    this.panel = el('div.perf-panel', { role: 'dialog', 'aria-label': 'Performance recorder' }, [
      el('div.perf-head', {}, [
        el('span.perf-title', {}, 'Performance recorder'),
        el('button.dialog-close', { type: 'button', title: 'Close', onclick: () => this.close() }, '✕'),
      ]),
      this.status,
      el('div.perf-actions', {}, [this.recordBtn, this.stopBtn, this.copyBtn]),
      this.output,
    ]);
    document.body.appendChild(this.panel);
  }

  close() {
    if (this.recording) this.stop(false);
    if (this.panel) this.panel.remove();
    this.panel = null;
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(this.report);
      this.status.textContent = 'Copied. Paste it into a message.';
    } catch {
      // Clipboard refused (an insecure page, an old browser): select it.
      const range = document.createRange();
      range.selectNodeContents(this.output);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      this.status.textContent = 'Selected — press Ctrl+C to copy.';
    }
  }

  // ---- recording -----------------------------------------------------------

  start() {
    const app = this.app;
    if (this.recording) return;
    if (!app.state.program) {
      this.status.textContent = 'Load a program first.';
      return;
    }
    this.recording = true;
    this.recordBtn.disabled = true;
    this.stopBtn.disabled = false;
    this.copyBtn.disabled = true;
    this.output.style.display = 'none';
    // Playing is what is measured: start it if it is not going.
    this.startedPlay = !app.state.playing && !app.simulator.finished;
    if (this.startedPlay) app.togglePlay();

    const viewer = app.viewer;
    const sim = app.simulator;
    const totals = { app: 0, bounds: 0, outlines: 0, draw: 0, simulation: 0, stock: 0, pose: 0, readout: 0 };
    const frames = [];
    const busy = [];
    const gpu = [];
    this.data = { totals, frames, busy, gpu, simStart: sim.time, wall: performance.now(), drawn: 0, idle: 0 };
    sim.prof = {};

    // The graphics card's own time, where the browser lets it be asked.
    const gl = viewer.renderer.getContext();
    const ext = gl && gl.getExtension && gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pending = [];
    let lastStart = 0;
    let frameAt = 0;
    viewer.perf = {
      begin: () => {
        const now = performance.now();
        if (lastStart) frames.push(now - lastStart);
        lastStart = now;
        frameAt = now;
        // Queries finished since: read, and let go.
        while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
          const q = pending.shift();
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(q);
        }
        return now;
      },
      lap: (key, at) => {
        const now = performance.now();
        totals[key] += now - at;
        return now;
      },
      gpuBegin: () => {
        if (!ext || pending.length > 8) return;
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        this.query = q;
      },
      gpuEnd: () => {
        if (!this.query) return;
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push(this.query);
        this.query = null;
      },
      end: (at, drew) => {
        busy.push(at - frameAt);
        if (drew) this.data.drawn++;
        else this.data.idle++;
      },
    };
    this.data.gpuTimer = !!ext;
    this.pending = pending;
    this.gl = gl;

    // The frame's own parts: wrapped for the recording, put back after.
    const wrap = (obj, name, key) => {
      const fn = obj[name];
      obj[name] = (...args) => {
        const t = performance.now();
        try { return fn.apply(obj, args); } finally { totals[key] += performance.now() - t; }
      };
      return () => { obj[name] = fn; };
    };
    this.unwrap = [
      wrap(app.stockView, 'sync', 'stock'),
      wrap(app.machineView, 'update', 'pose'),
      wrap(app, 'updateHud', 'readout'),
    ];
    app.perf = { add: (key, v) => { totals[key] += v; } };

    this.status.textContent = `Recording… ${LENGTH} s`;
    const until = performance.now() + LENGTH * 1000;
    this.timer = setInterval(() => {
      const left = Math.max(0, (until - performance.now()) / 1000);
      this.status.textContent = `Recording… ${left.toFixed(0)} s`;
      // Over when the time is up, or when the run has stopped by itself.
      if (left <= 0 || (!app.state.playing && app.state.seekTarget === null)) this.stop();
    }, 250);
  }

  stop(write = true) {
    if (!this.recording) return;
    const app = this.app;
    clearInterval(this.timer);
    this.recording = false;
    for (const undo of this.unwrap) undo();
    app.perf = null;
    app.viewer.perf = null;
    const sim = app.simulator;
    const prof = sim.prof || {};
    sim.prof = null;
    for (const q of this.pending || []) this.gl.deleteQuery(q);
    if (this.startedPlay && app.state.playing) app.togglePlay();
    this.recordBtn.disabled = false;
    this.stopBtn.disabled = true;
    if (!write) return;
    this.report = this.write(prof);
    this.output.textContent = this.report;
    this.output.style.display = '';
    this.copyBtn.disabled = false;
    this.status.textContent = 'Done. Copy the report and send it.';
  }

  // ---- the report ------------------------------------------------------------

  write(prof) {
    const app = this.app;
    const d = this.data;
    const sim = app.simulator;
    const wall = (performance.now() - d.wall) / 1000;
    const simulated = sim.time - d.simStart;
    const n = Math.max(d.frames.length, 1);
    const sorted = d.frames.slice().sort((a, b) => a - b);
    const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
    const per = (v) => v / Math.max(d.busy.length, 1);
    const busyAvg = d.busy.reduce((a, b) => a + b, 0) / Math.max(d.busy.length, 1);
    const frameAvg = d.frames.reduce((a, b) => a + b, 0) / n;
    const gpuAvg = d.gpu.length ? d.gpu.reduce((a, b) => a + b, 0) / d.gpu.length : null;
    const t = d.totals;
    // The app's own callback holds the simulation, the stock's picture,
    // posing the machine and the readout; what is left of it is the rest.
    const appRest = Math.max(t.app - t.simulation - t.stock - t.pose - t.readout, 0);

    const lines = [];
    const out = (s = '') => lines.push(s);
    const stamp = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'development copy'; // eslint-disable-line no-undef
    out(`Mill-Sim performance report — built ${stamp}`);
    out(`Recorded ${wall.toFixed(1)} s, speed setting ${app.state.speed}, simulated ${simulated.toFixed(1)} s of the program (${(simulated / Math.max(wall, 1e-9)).toFixed(2)}× real time)`);
    out();
    out('Frames');
    out(`  ${n} frames, ${(n / Math.max(wall, 1e-9)).toFixed(1)} a second; ${d.drawn} drawn, ${d.idle} with nothing to draw`);
    out(`  frame interval: average ${ms(frameAvg)}, median ${ms(at(0.5))}, 90% under ${ms(at(0.9))}, worst ${ms(at(1))}`);
    out(`  JavaScript per frame: ${ms(busyAvg)}; the rest of the interval is the graphics card, the browser and waiting for the screen`);
    out(`  graphics card per drawn frame: ${gpuAvg !== null ? ms(gpuAvg) : 'not available in this browser'}`);
    out();
    out('Per frame (averages)');
    const row = (label, v) => out(`  ${pad(label, 46)} ${ms(per(v)).padStart(10)}  ${pct(v, busyAvg * d.busy.length).padStart(4)}`);
    row('Simulation', t.simulation);
    row('Stock picture (meshing, uploading)', t.stock);
    row('Posing the machine', t.pose);
    row('Readout', t.readout);
    row('Rest of the app’s frame', appRest);
    row('Scene bounds', t.bounds);
    row('Edge outlines', t.outlines);
    row('Drawing (processor side)', t.draw);
    out();
    const simTotal = SIM_PARTS.reduce((a, [k]) => a + (prof[k] || 0), 0);
    out(`Simulation, by part (${ms(simTotal)} measured inside it, of ${ms(t.simulation)})`);
    for (const [k, label] of SIM_PARTS) {
      if (!prof[k]) continue;
      out(`  ${pad(label, 46)} ${ms(prof[k]).padStart(10)}  ${pct(prof[k], simTotal).padStart(4)}`);
    }
    out(`  ${prof.chunks || 0} chunks, ${prof.probes || 0} tool positions checked`);
    out();
    out('Scene');
    const info = app.viewer.renderer.info;
    out(`  last frame: ${info.render.triangles.toLocaleString('en-US')} triangles, ${info.render.lines.toLocaleString('en-US')} line segments, ${info.render.calls} draw calls`);
    const canvas = app.viewer.renderer.domElement;
    out(`  canvas ${canvas.width} × ${canvas.height} pixels, device pixel ratio ${window.devicePixelRatio}`);
    let refTris = 0;
    let fixtureTris = 0;
    for (const m of app.models.models || []) {
      const tris = m.triangles || 0;
      if (m.role === 'reference') refTris += tris;
      else fixtureTris += tris;
    }
    out(`  reference parts: ${refTris.toLocaleString('en-US')} triangles; other models: ${fixtureTris.toLocaleString('en-US')} triangles`);
    let castTris = 0;
    let castSolids = 0;
    for (const b of sim.castings || []) for (const s of b.solids) { castSolids++; if (s.tris) castTris += s.tris.length / 9; }
    for (const { s } of sim.headSolids || []) { castSolids++; if (s.tris) castTris += s.tris.length / 9; }
    out(`  machine for collisions: ${castSolids} solids, ${castTris.toLocaleString('en-US')} triangles`);
    const st = app.stock;
    out(st && app.state.stock.enabled !== false
      ? `  stock: ${st.n3.join(' × ')} grid, ${(st.rayCount / 1e6).toFixed(2)}M lines, ${(st.memoryBytes() / 1e6).toFixed(0)} MB, cell ${st.cell.toFixed(3)} mm`
      : '  stock: none (collision check only)');
    const prog = app.state.program;
    out(`  program: ${prog ? prog.moves.length.toLocaleString('en-US') : 0} moves`);
    const disp = app.state.display;
    const on = Object.entries({
      toolpath: disp.toolpath, rapids: disp.rapids, holder: disp.holder, edges: disp.edges,
      deviation: disp.deviation, grid: disp.grid, origins: disp.origins, envelope: disp.showLimits,
    }).filter(([, v]) => v).map(([k]) => k);
    out(`  shown: ${on.join(', ') || 'nothing extra'}; section ${disp.sectionPct ?? 100}%; machine ${app.state.machine.mode}`);
    out();
    out('Computer');
    let gpuName = 'unknown';
    try {
      const gl = app.viewer.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) gpuName = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } catch { /* not told */ }
    out(`  graphics: ${gpuName}`);
    out(`  processors: ${navigator.hardwareConcurrency || '?'}; ${navigator.userAgent}`);
    return lines.join('\n');
  }
}
