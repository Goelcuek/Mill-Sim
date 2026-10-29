// Browser smoke test: boots the app, drives it the way a person does, and
// fails on any console error.
//
// What it covers is what unit tests cannot: that the pieces are wired to
// each other. A program can interpret perfectly and still never reach the
// editor; a project can save every field and still open into an empty
// screen. Both have happened, so both are checked here.
//
// Playwright is not a dependency of this project. Install it first if you
// want to run this:
//
//   npm i -D playwright && npx playwright install chromium
//   npm run smoke

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. See the comment at the top of this file.');
  process.exit(2);
}

const PORT = 8231;
const serverPath = fileURLToPath(new URL('./serve.mjs', import.meta.url));
const server = spawn(process.execPath, [serverPath, String(PORT)], { stdio: 'ignore' });
const scratch = await mkdtemp(join(tmpdir(), 'millsim-smoke-'));
const stop = async (code) => {
  server.kill();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
};
await new Promise((r) => setTimeout(r, 800));

const errors = [];
// Whatever Chromium this machine has. A pre-installed browser under
// PLAYWRIGHT_BROWSERS_PATH is not always the build this Playwright expects,
// and "close enough" beats "run the installer" on a machine with no network.
const findChromium = () => {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => d.startsWith('chromium')).sort().reverse();
  for (const dir of dirs) {
    for (const exe of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const path = join(root, dir, exe);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
};

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const watch = (page) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack || ''}`));
  return page;
};
const open = async () => {
  const page = watch(await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true }));
  // The browser here draws on the CPU, and a desktop's two and a half
  // million triangles a frame is what made a run of this take a quarter of
  // an hour. A phone's budget draws the same surfaces, a few lines coarser.
  await page.goto(`http://127.0.0.1:${PORT}/index.html?tris=300000`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.millsim, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  return page;
};
const check = (ok, message) => { if (!ok) throw new Error(message); };

/** Load one of the shipped examples and wait for it to be read. */
async function loadExample(page, index, name) {
  await page.evaluate((i) => window.millsim.panels.program.loadExampleAt(i), index);
  await page.waitForFunction((n) => new RegExp(n, 'i').test(window.millsim.state.programName), name, { timeout: 30000 });
  await page.waitForTimeout(400);
}

async function runToEnd(page) {
  await page.evaluate(() => window.millsim.runToEnd());
  await page.waitForFunction(() => window.millsim.simulator.finished && window.millsim.state.seekTarget === null,
    null, { timeout: 180000 });
}

let page = await open();

try {
  // ---- a clean program cuts metal and finds nothing wrong ---------------
  await loadExample(page, 0, 'Demo bracket');
  await runToEnd(page);
  const bracket = await page.evaluate(() => ({
    removed: window.millsim.simulator.removedVolume,
    collisions: window.millsim.simulator.collisions.length,
  }));
  console.log('bracket example:', JSON.stringify(bracket));
  check(bracket.removed > 20000, `expected material to be removed, got ${bracket.removed} mm3`);
  check(bracket.collisions === 0, `clean program reported ${bracket.collisions} collisions`);

  // Every stock is held along X, Y and Z now: there is no model to pick.
  const model = await page.evaluate(() => ({
    kind: window.millsim.stock.kind,
    picker: [...document.querySelectorAll('.field-label')].some((l) => /Stock model/.test(l.textContent)),
  }));
  check(model.kind === 'tridexel' && !model.picker, `the stock should be tri-dexel with no model picker: ${JSON.stringify(model)}`);

  // A section square to X: both sides drawn, the plane at the middle of
  // the 120 wide block.
  const xSection = await page.evaluate(() => {
    const app = window.millsim;
    app.setDisplay({ sectionAxis: 'x', sectionPct: 50, sectionAt: 0 });
    const u = app.stockView.surface.uniforms;
    const out = { n: u.uSectionN.value.toArray(), d: u.uSectionD.value, side: app.stockView.surface.material.side };
    // And across everything else: the renderer's own plane, on the part's X.
    out.clipped = app.viewer.renderer.clippingPlanes.length;
    app.setDisplay({ sectionAxis: 'z', sectionPct: 100, sectionAt: null });
    out.after = app.stockView.surface.material.side;
    out.unclipped = app.viewer.renderer.clippingPlanes.length;
    return out;
  });
  check(xSection.clipped === 1 && xSection.unclipped === 0, `the section should cut the whole scene, and stop when it is off: ${JSON.stringify(xSection)}`);
  check(xSection.n[0] === 1 && Math.abs(xSection.d) < 1e-9 && xSection.side === 2 && xSection.after === 0,
    `an X section should cut at x = 0 and draw both sides: ${JSON.stringify(xSection)}`);

  // ---- and it measured how hard each tool worked ------------------------
  const loads = await page.evaluate(() => window.millsim.analyzer.summary(window.millsim.state.program)
    .map((r) => ({ tool: r.tool, moves: r.moves, force: Math.round(r.force.value), kW: +r.power.value.toFixed(2) })));
  console.log('loads:', JSON.stringify(loads));
  for (const t of [1, 2, 7]) {
    const r = loads.find((x) => x.tool === t);
    check(r && r.force > 0 && r.kW > 0, `T${t} cut metal and no load was measured`);
  }
  // T6 chamfers at Z-0.6 over a top already faced to Z-1: it cuts air.
  check(!loads.some((x) => x.tool === 6), 'the chamfer pass cuts air and was given a load');

  // ---- and the editor is showing the program it just ran ----------------
  await page.click('.ribbon-tab[data-tab="program"]');
  await page.click('.ribbon-page[data-page="editor"]');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.querySelector('.editor-area').value === window.millsim.state.source),
    'the editor is not showing the loaded program');

  // ---- a hole drilled to size is not a gouge ----------------------------
  //
  // The hole in a reference model is a polygon inscribed in the circle it
  // stands for. Drill it with the drill it was drawn for and the two
  // disagree sideways by a fraction of a grid column — which, measured
  // vertically, used to read as a gouge the whole depth of the hole. The
  // comparison measures along the surface normal now, walls included, and
  // what must still be reported is a cut that is actually too deep.
  {
    const ref = await page.evaluate(async () => {
      const app = window.millsim;
      const { latheToTriangles } = await import('/src/io/mesh.js');
      app.setStock({ shape: 'box', size: [120, 80, 25], origin: [-60, -40, -25], resolution: 0.25, rotation: 0 });
      // A plate 5 mm down from the top of the block, with the 5 mm hole
      // the 5 mm drill in pot 7 is there to make.
      const plate = latheToTriangles([{ r: 2.5, z: -5 }, { r: 40, z: -5 }], { segments: 64 });
      const model = app.models.add({ name: 'holed-plate', positions: plate.positions, role: 'reference' });
      app.refreshTarget();
      return { id: model.id, edges: app.target ? app.target.edgeCells : 0, lateral: app.target ? app.target.lateral : 0 };
    });
    check(ref.edges > 0, 'the reference part is all walls and none were marked');

    await page.evaluate((text) => window.millsim.loadProgram(text, 'REFERENCE-CHECK.nc'), [
      'G21 G17 G40 G49 G80 G90', 'G54',
      'T7 M06', 'S3000 M03', 'G43 H7',
      'G00 X0 Y0 Z10',
      'G01 Z-25 F300',          // the hole, cut to the size it is drawn
      'G00 Z10',
      'G00 X20 Y0',
      'G01 Z-6 F300',           // and a plunge 1 mm into the plate itself
      'G00 Z10', 'M30',
    ].join('\n'));
    await page.waitForTimeout(700);
    await runToEnd(page);

    const cmp = await page.evaluate(() => {
      const c = window.millsim.compareToReference();
      return {
        max: c.maxGouge, cells: c.gougeCells,
        skipped: c.skippedCells, compared: c.comparedCells, lateral: c.lateral,
      };
    });
    await page.click('.ribbon-tab[data-tab="results"]');
    await page.click('.ribbon-page[data-page="compare"]');
    await page.waitForTimeout(400);
    const said = await page.evaluate(() => [...document.querySelectorAll('.panel')].map((p) => p.textContent).join(' '));
    console.log('reference check:', JSON.stringify({
      maxGouge: +cmp.max.toFixed(3), gouged: cmp.cells, walls: cmp.skipped, judged: cmp.compared,
    }));
    check(cmp.max > 0.9 && cmp.max < 1.2, `the deepest gouge should be the 1 mm plunge, and reads ${cmp.max.toFixed(3)} mm`);
    check(cmp.cells > 0, 'a 1 mm plunge into the reference part went unreported');
    check(cmp.skipped === 0 && cmp.compared > 0, `walls should be measured, not skipped: ${cmp.skipped} skipped of ${cmp.compared + cmp.skipped}`);
    check(Math.abs(cmp.lateral - 0.25) < 1e-6, `the lateral resolving power should be one column, and reads ${cmp.lateral}`);
    check(/surface normal/.test(said), `the results panel does not say how it measures: ${said.slice(0, 200)}`);

    // A probe on the bracket: down into the 1 mm plunge — a drill,
    // so off its centre the point of it is shallower than the full 1 mm —
    // and on the untouched top 5 mm over the plate.
    const hmProbe = await page.evaluate(() => {
      const app = window.millsim;
      app.setDisplay({ deviation: true });
      app.addProbe(null, [20.3, 0.3, 30], [0, 0, -1]);
      app.addProbe(null, [-30.3, 20.3, 30], [0, 0, -1]);
      const out = app.state.devProbes.map((p) => (p.dev ? +p.dev.deviation.toFixed(3) : null));
      const listed = [...document.querySelectorAll('.dev-probe')].map((n) => n.textContent);
      app.clearProbes();
      app.setDisplay({ deviation: false });
      return { out, listed };
    });
    console.log('bracket probes:', JSON.stringify(hmProbe));
    check(hmProbe.out[0] !== null && hmProbe.out[0] < -0.7 && hmProbe.out[0] > -1.05, `a probe in the 1 mm plunge should read a gouge of most of a millimetre: ${hmProbe.out[0]}`);
    check(hmProbe.out[1] !== null && Math.abs(hmProbe.out[1] - 5) < 0.05, `a probe on the top should read +5 over the plate: ${hmProbe.out[1]}`);
    check(hmProbe.listed.length === 2 && /gouged/.test(hmProbe.listed[0]) && /stock left/.test(hmProbe.listed[1]), `the probes should be listed with what they mean: ${JSON.stringify(hmProbe.listed)}`);

    // Put the bench back: later checks expect nothing but the block.
    await page.evaluate((id) => {
      const app = window.millsim;
      app.models.remove(app.models.models.find((m) => m.id === id));
      app.refreshTarget();
    }, ref.id);
    await page.waitForTimeout(300);
  }

  // ---- the bad program reports every mistake in it ----------------------
  await loadExample(page, 3, 'Crash');
  await runToEnd(page);
  const kinds = await page.evaluate(() => [...new Set(window.millsim.simulator.collisions.map((c) => c.type))].sort());
  console.log('crash example detected:', kinds.join(', '));
  for (const expected of ['deep', 'rapid', 'spindle']) {
    check(kinds.includes(expected), `crash example did not report "${expected}"`);
  }

  // ---- macros and dialects both run to completion -----------------------
  await loadExample(page, 5, 'Macro family');
  await runToEnd(page);
  const macro = await page.evaluate(() => ({
    removed: window.millsim.simulator.removedVolume,
    vars: window.millsim.state.program.variables.length,
    errors: window.millsim.state.program.warnings.filter((w) => w.severity === 'error').length,
  }));
  console.log('macro example:', JSON.stringify(macro));
  check(macro.errors === 0, 'the macro example did not read cleanly');
  check(macro.vars > 0 && macro.removed > 1000, 'the macro example did not compute or did not cut');

  await loadExample(page, 6, 'Siemens');
  await runToEnd(page);
  const siemens = await page.evaluate(() => ({
    dialect: window.millsim.state.machine.controller.dialect,
    removed: window.millsim.simulator.removedVolume,
    errors: window.millsim.state.program.warnings.filter((w) => w.severity === 'error').length,
  }));
  console.log('siemens example:', JSON.stringify(siemens));
  check(siemens.dialect === 'siemens', 'loading the Siemens example did not set the dialect');
  check(siemens.errors === 0 && siemens.removed > 1000, 'the Siemens program did not read as Siemens');

  // ---- Program › Variables follows the run -----------------------------
  //
  // The example declares its own with DEF. The page has to list them, show
  // the value in force on the move the machine is on, take the run to the
  // line that set one, and put a pinned one on the readout.
  {
    await page.evaluate(() => window.millsim.setPage('program', 'variables'));
    await page.waitForTimeout(200);
    const listed = await page.evaluate(() => [...document.querySelectorAll('.var-row')].map((r) => r.dataset.key));
    console.log('variables listed:', listed.join(' '));
    for (const key of ['LENGTH', 'HOLES', 'RINGS', 'R1']) check(listed.includes(key), `Program › Variables does not list ${key}`);
    const value = (key) => page.evaluate((k) => {
      const row = [...document.querySelectorAll('.var-row')].find((r) => r.dataset.key === k);
      return row ? row.querySelector('.var-value').textContent : null;
    }, key);
    check(await value('RINGS') === '6', `RINGS should end at 6, reads ${await value('RINGS')}`);
    // Back to the first move: the rings have not been counted yet.
    await page.evaluate(() => window.millsim.seekToMove(0));
    await page.waitForFunction(() => window.millsim.state.seekTarget === null, null, { timeout: 60000 });
    await page.evaluate(() => window.millsim.panels.program.updateVariables());
    check(await value('RINGS') === '0', `at the first move RINGS should be 0, reads ${await value('RINGS')}`);
    // Open its history and go to the third change: the run follows.
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.var-row')].find((r) => r.dataset.key === 'RINGS');
      row.querySelector('.var-name').click();
    });
    await page.evaluate(() => document.querySelectorAll('.var-change')[3].click());
    await page.waitForFunction(() => window.millsim.state.seekTarget === null, null, { timeout: 60000 });
    await page.evaluate(() => window.millsim.panels.program.updateVariables());
    check(await value('RINGS') === '3', `going to the third ring should show RINGS 3, reads ${await value('RINGS')}`);
    await page.evaluate(() => window.millsim.toggleWatch('RINGS'));
    await page.evaluate(() => window.millsim.updateHud());
    const hud = await page.evaluate(() => (document.querySelector('.hud-watch-row') || {}).textContent || '');
    check(/RINGS\s*3/.test(hud), `the pinned variable is not on the readout: "${hud}"`);
    await page.evaluate(() => window.millsim.toggleWatch('RINGS'));
  }

  // ---- M00 and M01 stop the run, when their switches say so --------------
  {
    const stopped = await page.evaluate(async () => {
      const app = window.millsim;
      app.loadProgram(['G90 G21', 'G0 X0 Y0 Z5', 'G1 X10 F3000', 'M00 (CHECK)', 'G1 X20', 'M01', 'G1 X30', 'M30'].join('\n'), 'stops.nc');
      app.state.stops.m0 = true;
      app.state.stops.m1 = false;
      app.state.speed = 'max';
      app.reset();
      const wait = () => new Promise((resolve) => {
        const t0 = performance.now();
        const tick = () => (!app.state.playing || performance.now() - t0 > 20000 ? resolve() : setTimeout(tick, 20));
        tick();
      });
      const out = [];
      app.play(); await wait(); out.push(Number(app.simulator.pos[0].toFixed(3)));
      app.play(); await wait(); out.push(Number(app.simulator.pos[0].toFixed(3)));
      return { at: out, finished: app.simulator.finished };
    });
    console.log('stops:', JSON.stringify(stopped));
    check(stopped.at[0] === 10, `M00 should hold the run at X10, it stopped at X${stopped.at[0]}`);
    check(stopped.at[1] === 30 && stopped.finished, 'with M01 off the run should go on to the end');
  }

  // ---- single block: one press, one line ---------------------------------
  {
    const stepped = await page.evaluate(() => {
      const app = window.millsim;
      app.setControl('fanuc');
      app.loadProgram(['G90 G21', 'G0 X0 Y0 Z5', 'S6000 M3', '#100 = 7', 'G1 X10 F3000', 'G1 X20', 'M30'].join('\n'), 'step.nc');
      app.reset();
      const out = [];
      for (let i = 0; i < 6; i++) {
        app.stepLine();
        out.push(`${app.currentBlock().line}:${app.simulator.pos[0].toFixed(1)}`);
      }
      return out;
    });
    console.log('single block:', stepped.join(' '));
    check(stepped.join(' ') === '1:0.0 2:0.0 3:0.0 4:0.0 5:10.0 6:20.0',
      `each press should run exactly the next line, got ${stepped.join(' ')}`);
  }

  // ---- the stock can be dragged where it belongs ------------------------
  //
  // The handles are only useful if a plain click puts them on the block and
  // a drag actually moves it, which is three separate pieces of wiring: the
  // hit test, the gizmo, and the rebuild on release.
  {
    await page.click('.ribbon-tab[data-tab="setup"]');
    await page.click('.ribbon-page[data-page="stock"]');
    await page.waitForTimeout(300);
    const canvas = await page.$('canvas');
    const box = await canvas.boundingBox();
    // The middle of the stock's top, wherever the view has put it — with
    // the whole machine drawn, that is not the middle of the window.
    const onStock = await page.evaluate(() => {
      const app = window.millsim;
      const bb = app.stockView.boundingBox();
      const c = bb.getCenter(bb.min.clone());
      c.z = bb.max.z;
      c.project(app.viewer.camera);
      return [c.x, c.y];
    });
    await page.mouse.click(box.x + ((onStock[0] + 1) / 2) * box.width, box.y + ((1 - onStock[1]) / 2) * box.height);
    await page.waitForTimeout(400);
    check(await page.evaluate(() => window.millsim.stockGizmo.attached),
      'clicking the stock did not put the handles on it');
    check(await page.evaluate(() => window.millsim.panels.setup.page === 'stock'),
      'clicking the stock did not open the Stock page');

    const at = await page.evaluate(() => {
      const app = window.millsim;
      const v = app.stockGizmo.proxy.getWorldPosition(app.viewer.camera.position.clone());
      v.project(app.viewer.camera);
      const r = app.viewer.renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    });
    // Walk out from the middle until a handle lights up under the pointer.
    let handle = null;
    for (let d = 12; d < 220 && !handle; d += 4) {
      await page.mouse.move(at.x + d, at.y);
      if (await page.evaluate(() => window.millsim.stockGizmo.gizmo.axis)) handle = { x: at.x + d, y: at.y };
    }
    check(!!handle, 'no transform handle was found on the stock');

    const before = await page.evaluate(() => [...window.millsim.state.stock.origin]);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 60, handle.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => ({
      origin: [...window.millsim.state.stock.origin],
      grid: [...window.millsim.stock.origin],
    }));
    const moved = Math.hypot(after.origin[0] - before[0], after.origin[1] - before[1], after.origin[2] - before[2]);
    console.log('stock drag:', JSON.stringify({ before, after: after.origin }));
    check(moved > 1, `dragging the handle moved the stock ${moved.toFixed(3)} mm`);
    check(Math.abs(after.grid[0] - after.origin[0]) < 1e-6, 'the simulated grid did not follow the block');

    // And turned in the vice: the billet keeps its size, the grid grows to
    // hold its corners, and the metal in it is the same metal.
    await page.evaluate(() => window.millsim.setStock({ rotation: 25 }));
    await page.waitForTimeout(700);
    const turned = await page.evaluate(() => ({
      size: [...window.millsim.state.stock.size],
      grid: [...window.millsim.stock.size],
      volume: window.millsim.stock.stockVolume,
      rings: { x: window.millsim.stockGizmo.gizmo.showX, z: window.millsim.stockGizmo.gizmo.showZ },
    }));
    console.log('stock turned:', JSON.stringify({ grid: turned.grid.map((v) => +v.toFixed(2)), volume: +turned.volume.toFixed(0) }));
    check(turned.grid[0] > turned.size[0] && turned.grid[1] > turned.size[1], 'a turned block needs a bigger grid');
    check(Math.abs(turned.volume - turned.size[0] * turned.size[1] * turned.size[2]) < turned.volume * 0.01,
      'a turned block holds different metal from the block it is');
    await page.evaluate(() => window.millsim.setStock({ rotation: 0 }));

    // And they are a setup affordance: leaving the tab puts them away
    // rather than leaving something standing in front of the part.
    await page.click('.ribbon-tab[data-tab="program"]');
    await page.waitForTimeout(400);
    check(!(await page.evaluate(() => window.millsim.stockGizmo.attached)),
      'the handles stayed up after leaving the Setup tab');
  }

  // ---- and in the other idiom entirely ----------------------------------
  //
  // A Fidia: > in front of a line, ORIGIN instead of G54, RTCP instead of
  // G43.4, rapid lasting one block, a negative arc radius, and a tool
  // vector the control turns into angles.
  await loadExample(page, 7, 'Fidia');
  await runToEnd(page);
  const fidia = await page.evaluate(() => ({
    dialect: window.millsim.state.machine.controller.dialect,
    removed: window.millsim.simulator.removedVolume,
    errors: window.millsim.state.program.warnings.filter((w) => w.severity === 'error').length,
    tipped: window.millsim.state.program.moves.some((m) => Math.abs((m.rotTo || {}).A || 0) > 20),
    tcp: window.millsim.state.program.moves.some((m) => m.tcp),
  }));
  console.log('fidia example:', JSON.stringify(fidia));
  check(fidia.dialect === 'fidia', 'loading the Fidia example did not set the dialect');
  check(fidia.errors === 0, 'the Fidia example did not read cleanly');
  check(fidia.removed > 1000, 'the Fidia example did not cut');
  check(fidia.tipped, 'the tool vector did not turn the rotaries');
  check(fidia.tcp, 'RTCP ON did not reach the moves');

  // ---- the stock holds a hole drilled from the side ---------------------
  //
  // The example drills two holes into the right face through a tilted
  // plane and one from the top into the first, and the stock keeps all of
  // them.
  {
    await loadExample(page, 8, 'Side holes');
    await runToEnd(page);
    // The surface catches up on idle frames after the run.
    await page.waitForFunction(() => !window.millsim.stockView.pending, null, { timeout: 30000 }).catch(() => {});
    const side = await page.evaluate(() => {
      const app = window.millsim;
      const st = app.stock;
      return {
        kind: st.kind,
        dialect: app.state.machine.controller.dialect,
        removed: app.simulator.removedVolume,
        findings: app.simulator.collisions.length,
        errors: app.state.program.warnings.filter((w) => w.severity === 'error').length,
        overHole: st.stretchesAt(2, [152.1, 20.1, 0]).map((r) => r.map((v) => +v.toFixed(2))),
        drawn: app.stockView.surface ? app.stockView.surface.triangleCount() : 0,
        pending: app.stockView.pending,
        // Pointing at the right face, level with the first hole: the ray
        // goes down it and stops at its bottom, 15 in from the face.
        pick: (() => { const h = st.raycast([220, 0.05, -15.05], [-1, 0, 0]); return h ? +h.point[0].toFixed(2) : null; })(),
      };
    });
    console.log('side holes:', JSON.stringify(side));
    check(side.dialect === 'fanuc', `a Fanuc example after the Fidia one should be read on a Fanuc: ${side.dialect}`);
    check(side.errors === 0 && side.findings === 0, 'the side-hole example should run clean');
    check(side.overHole.length === 2 && Math.abs(side.overHole[0][1] + 20) < 0.05 && Math.abs(side.overHole[1][0] + 10) < 0.05,
      `the Z line over the second side hole should have metal under and over it: ${JSON.stringify(side.overHole)}`);
    check(side.drawn > 1000, 'the stock drew nothing');
    check(!side.pending, 'the stock surface was still being made after the run');
    check(side.pick !== null && Math.abs(side.pick - 145) < 0.05, `a ray down the side hole should stop at its bottom (x 145): ${side.pick}`);
    // A section through the holes draws the inside as the cut face.
    const caps = await page.evaluate(() => {
      const app = window.millsim;
      app.state.display.sectionPct = 60;
      app.applyDisplay();
      const side = app.stockView.surface.material.side;
      app.state.display.sectionPct = 100;
      app.applyDisplay();
      return { cut: side, whole: app.stockView.surface.material.side };
    });
    check(caps.cut === 2 && caps.whole === 0, `a section should draw both sides, and none only the outside: ${JSON.stringify(caps)}`);
    // Square to Y through the middle of the 90 deep block, then flipped.
    const planeY = await page.evaluate(() => {
      const app = window.millsim;
      app.setDisplay({ sectionAxis: 'y', sectionPct: 50, sectionFlip: false, sectionAt: 0 });
      const u = app.stockView.surface.uniforms;
      const a = { n: u.uSectionN.value.toArray(), d: u.uSectionD.value };
      app.setDisplay({ sectionFlip: true, sectionPct: 25, sectionAt: 22.5 });
      const b = { n: u.uSectionN.value.toArray(), d: u.uSectionD.value };
      app.setDisplay({ sectionAxis: 'z', sectionPct: 100, sectionFlip: false, sectionAt: null });
      return { a, b };
    });
    check(planeY.a.n[1] === 1 && Math.abs(planeY.a.d) < 1e-9, `a Y section at 50% should be the plane y = 0: ${JSON.stringify(planeY.a)}`);
    check(planeY.b.n[1] === -1 && Math.abs(planeY.b.d - -22.5) < 1e-9, `flipped at 25% it should keep y ≥ 22.5: ${JSON.stringify(planeY.b)}`);

    // The deviation map in 3D, and a probe pinned on it. The reference
    // part has the first side hole at Ø10.6 where the program drills Ø10,
    // so the wall of the hole that was cut is 0.3 short of the part — stock
    // left, on a face no top-down map can see.
    const probe = await page.evaluate(async () => {
      const app = window.millsim;
      const { TriDexelStock } = await import('/src/sim/triDexel.js');
      const { dexelTriangles } = await import('/src/sim/dexelMesh.js');
      const { buildTool, makeTool } = await import('/src/tools/toolDefs.js');
      const st = app.stock;
      const ref = new TriDexelStock({ origin: st.origin.slice(), size: st.size.slice(), resolution: st.cell });
      const big = buildTool(makeTool({ type: 'flat', diameter: 10.6, fluteLength: 40 })).cutEnvelope;
      const flat16 = buildTool(makeTool({ type: 'flat', diameter: 16, fluteLength: 40 })).cutEnvelope;
      // The faced top, then the hole.
      for (let y = -40; y <= 40; y += 8) ref.carveLinear(flat16, [30, y, -1], [170, y, -1], [0, 0, 1], 0);
      ref.carveLinear(big, [170, 0, -15], [145, 0, -15], [1, 0, 0], 1);
      const model = app.models.add({ name: 'side-hole part', positions: dexelTriangles(ref).positions, role: 'reference' });
      app.refreshTarget();
      app.setDisplay({ deviation: true, devRange: 0.5 });
      // Straight down inside the first hole, onto the bottom of its wall.
      app.addProbe(null, [158, 0.05, -15], [0, 0, -1]);
      const p = app.state.devProbes[0];
      return {
        id: model.id,
        closed: app.target ? app.target.closed : null,
        point: p.point ? p.point.map((v) => +v.toFixed(2)) : null,
        reading: p.dev ? +p.dev.deviation.toFixed(3) : null,
        label: document.querySelector('.probe-label') ? document.querySelector('.probe-label').textContent : null,
        listed: document.querySelectorAll('.dev-probe').length,
        mapOn: app.stockView.surface.uniforms.uDevMode.value,
      };
    });
    const judged = await page.evaluate(() => {
      // The map is redone a few blocks a frame; this browser draws a frame
      // in software, so the rest is done here rather than waited for.
      const t0 = performance.now();
      window.millsim.stockView.surface.sync(false, Infinity);
      const ms = Math.round(performance.now() - t0);
      let on = 0;
      let left = 0;
      for (const m of window.millsim.stockView.surface.blocks) {
        if (!m) continue;
        const a = m.geometry.attributes;
        for (let v = 0; v < m.userData.vCap; v++) {
          if (!a.aDevOn.array[v]) continue;
          on++;
          if (Math.abs(a.aDev.array[v] - 0.3) < 0.05) left++;
        }
      }
      return { on, left, finishMs: ms };
    });
    console.log('3D deviation probe:', JSON.stringify({ ...probe, ...judged }));
    check(probe.closed === true, 'the side-hole reference should be a closed solid');
    check(probe.point && Math.abs(probe.point[2] + 20) < 0.05, `the probe should land on the bottom of the hole wall: ${JSON.stringify(probe.point)}`);
    check(probe.reading !== null && Math.abs(probe.reading - 0.3) < 0.04, `the probe should read 0.3 left on the hole wall: ${probe.reading}`);
    check(probe.label && /P1/.test(probe.label) && probe.listed === 1, `the probe should be labelled and listed: ${probe.label} / ${probe.listed}`);
    check(probe.mapOn === 1 && judged.on > 1000 && judged.left > 50, `the 3D surface should be coloured by deviation, the hole wall at +0.3: ${JSON.stringify(judged)}`);
    await page.evaluate((id) => {
      const app = window.millsim;
      app.clearProbes();
      app.setDisplay({ deviation: false });
      app.models.remove(app.models.models.find((m) => m.id === id));
      app.refreshTarget();
    }, probe.id);

    // A gouge in the wall of a side hole, found while the program runs.
    // The part this time has every hole the program makes, the first one
    // Ø9.4: the Ø10 cutter takes 0.3 out of its wall, under a top nothing
    // touched — the one place a look from above cannot see.
    const gouge = await page.evaluate(async () => {
      const app = window.millsim;
      const { TriDexelStock } = await import('/src/sim/triDexel.js');
      const { dexelTriangles } = await import('/src/sim/dexelMesh.js');
      const { buildTool, makeTool } = await import('/src/tools/toolDefs.js');
      const st = app.stock;
      const ref = new TriDexelStock({ origin: st.origin.slice(), size: st.size.slice(), resolution: st.cell });
      const env = (d) => buildTool(makeTool({ type: 'flat', diameter: d, fluteLength: 40 })).cutEnvelope;
      for (let y = -40; y <= 40; y += 8) ref.carveLinear(env(16), [30, y, -1], [170, y, -1], [0, 0, 1], 0);
      ref.carveLinear(env(9.4), [170, 0, -15], [145, 0, -15], [1, 0, 0], 1);
      ref.carveLinear(env(10), [170, 20, -15], [145, 20, -15], [1, 0, 0], 1);
      ref.carveLinear(env(10), [150, 0, 5], [150, 0, -20], [0, 0, 1], 1);
      const model = app.models.add({ name: 'tight side hole', positions: dexelTriangles(ref).positions, role: 'reference' });
      app.refreshTarget();
      // The reference is itself on the lattice, so a looser tolerance than
      // a CAD model would need keeps its own facets from reading as gouges.
      app.setGougeTolerance(0.1);
      app.reset();
      const sim = app.simulator;
      let n = 0;
      while (!sim.finished && n++ < 100000) sim.run(Infinity, 50);
      const firstHole = app.state.source.split('\n').findIndex((l) => /^G01 Z-15 F300/.test(l)) + 1;
      const found = sim.collisions.filter((c) => c.type === 'gouge').map((c) => ({ line: c.line, depth: +c.depth.toFixed(3), at: c.position.map((v) => +v.toFixed(1)) }));
      app.setGougeTolerance(0.02);
      app.models.remove(model);
      app.refreshTarget();
      return { firstHole, found };
    });
    console.log('3D gouge:', JSON.stringify(gouge));
    const wall = gouge.found.find((g) => g.line === gouge.firstHole);
    check(wall && wall.depth > 0.2 && wall.depth < 0.45, `the Ø10 cutter in the Ø9.4 hole should be a 0.3 gouge on line ${gouge.firstHole}: ${JSON.stringify(gouge.found)}`);
    check(gouge.found.every((g) => g.depth < 0.45), `nothing else should gouge: ${JSON.stringify(gouge.found)}`);
  }

  // ---- Siemens 840D sl: the swivel cycle, the drilling cycles, names -----
  //
  // The side-hole job written as a Siemens writes it: T="NAME" before M6,
  // a labelled section run again with REPEAT, CYCLE800 to swing the head,
  // MCALL CYCLE83 at two positions and CYCLE81 from the top. It has to read
  // without a word of complaint and cut the same holes.
  {
    await loadExample(page, 9, 'Siemens swivel');
    await runToEnd(page);
    const sw = await page.evaluate(() => {
      const app = window.millsim;
      const st = app.stock;
      return {
        dialect: app.state.machine.controller.dialect,
        warnings: app.state.program.warnings.map((w) => w.message),
        tools: app.state.program.toolChanges.map((t) => t.tool),
        findings: app.simulator.collisions.map((c) => c.message),
        side: st.stretchesAt(0, [150, 0.05, -15.05]).map((r) => r.map((v) => +v.toFixed(2))),
        top: st.stretchesAt(2, [150.05, 0.05, 0]).map((r) => r.map((v) => +v.toFixed(2))),
      };
    });
    console.log('siemens cycles:', JSON.stringify(sw));
    check(sw.dialect === 'siemens', `the Siemens example should set the machine to read Siemens: ${sw.dialect}`);
    check(sw.warnings.length === 0 && sw.findings.length === 0, `the Siemens example should run clean: ${JSON.stringify(sw)}`);
    check(sw.tools.join('|') === '50 face mill|10 flat', `tools chosen by name: ${sw.tools}`);
    check(sw.side.length === 1 && Math.abs(sw.side[0][1] - 145) < 0.05, `CYCLE83 through the swivelled plane should leave the side hole 15 deep: ${JSON.stringify(sw.side)}`);
    check(sw.top.length === 1 && Math.abs(sw.top[0][1] + 20) < 0.05, `CYCLE81 should leave the top hole 20 deep: ${JSON.stringify(sw.top)}`);
  }

  // ---- turning on the table: mill-turn -----------------------------------
  //
  // A Ø80 bar on the trunnion, the C table spinning it under CYCLE800
  // "DREHEN": faced, turned to Ø68 with a chamfer, grooved, threaded. It
  // runs clean and leaves the diameters the program asked for.
  {
    await loadExample(page, 10, 'mill-turn');
    await runToEnd(page);
    const mt = await page.evaluate(() => {
      const app = window.millsim;
      const st = app.stock;
      const r = (z) => { const s = st.stretchesAt(0, [0, 0.125, z]); return s.length ? +s[s.length - 1][1].toFixed(2) : null; };
      return {
        warnings: app.state.program.warnings.map((w) => w.message),
        findings: app.simulator.collisions.map((c) => c.message),
        turning: app.state.program.moves.filter((m) => m.turning).length,
        faced: st.stretchesAt(0, [0, 0.125, -0.125]).length,
        thread: r(-6.125),
        groove: r(-16.125),
        diameter: r(-20.125),
        bar: r(-40.125),
      };
    });
    console.log('mill-turn:', JSON.stringify(mt));
    check(mt.warnings.length === 0 && mt.findings.length === 0, `the mill-turn example should run clean: ${JSON.stringify(mt)}`);
    check(mt.turning > 20, `its moves should be turning moves: ${mt.turning}`);
    check(mt.faced === 0, 'the top millimetre should be faced off');
    check(Math.abs(mt.thread - 33.1) < 0.05, `thread core Ø66.2: r ${mt.thread}`);
    check(Math.abs(mt.groove - 30) < 0.05, `groove Ø60: r ${mt.groove}`);
    check(Math.abs(mt.diameter - 34) < 0.05, `finished Ø68: r ${mt.diameter}`);
    check(Math.abs(mt.bar - 40) < 0.05, `the bar below untouched, Ø80: r ${mt.bar}`);
  }

  // ---- a program written for another control says so --------------------
  //
  // Read against the wrong one, a Fidia program is a page of errors and no
  // toolpath. That is one mistake, not a hundred and fifty, and the answer
  // to it is one button.
  {
    const main = [
      'TP5:',
      '; *********** DEFINE TOOLS ***********',
      'TTYP 7 10',
      'TDIAM__1 7 0.1969',
      'TMAXSP 7 20000',
      'RG 50 1.00',
      'ORIGIN 1',
      'RTCP ON',
      '>M321',
      '>G21',
      '>G90 G40 G80',
      'CQAHDW ON',
      '>X-10.59 Y0.00 A0. C90. F8000',
      '>U0.0000(ITEM BASLANGIC ACISI)',
      '>M03 S1000',
      '>Z14.173 F8000',
      // $REP counts: three rounds of one move each, so five moves in all.
      '$REP 3',
      '>G91',
      'Z-2.0',
      '>G90',
      '$END',
      'M30',
    ].join('\n');
    await page.evaluate(() => window.millsim.setControl('fanuc'));
    await page.waitForTimeout(400);
    await page.evaluate((text) => window.millsim.loadProgram(text, 'FIDIA-MAIN.txt'), main);
    await page.waitForTimeout(700);
    const wrong = await page.evaluate(() => ({
      suggested: window.millsim.state.program.suggested,
      errors: window.millsim.state.program.warnings.filter((w) => w.severity === 'error').length,
    }));
    check(wrong.suggested === 'fidia', 'a Fidia program was not recognised as one');
    check(wrong.errors > 0, 'the Fidia program read cleanly as a Fanuc, which it should not');

    await page.click('.ribbon-tab[data-tab="program"]');
    await page.click('.ribbon-page[data-page="summary"]');
    await page.waitForTimeout(400);
    await page.click('.panel button:has-text("Read it as a Fidia")');
    await page.waitForTimeout(1200);
    const right = await page.evaluate(() => ({
      dialect: window.millsim.state.machine.controller.dialect,
      errors: window.millsim.state.program.warnings.filter((w) => w.severity === 'error').length,
      moves: window.millsim.state.program.moves.length,
      table: window.millsim.state.program.settings.length,
      said: [...document.querySelectorAll('.panel')].map((p) => p.textContent).join(' '),
    }));
    console.log('wrong control:', JSON.stringify({ before: wrong.errors, after: right.errors, moves: right.moves, table: right.table }));
    check(right.dialect === 'fidia', 'the offer did not change the control');
    check(right.errors === 0, `still ${right.errors} errors after taking the offer`);
    // Two, three rounds of $REP, and the U0 that sets the item's starting
    // angle — which is an index move on this control, not a nothing.
    check(right.moves === 6, `expected 6 moves — two, three rounds of $REP and the index — and got ${right.moves}`);
    // The tool-table header is skipped rather than read as coordinates,
    // and the summary says so rather than passing over it quietly.
    check(right.table === 3, `${right.table} tool-table lines accounted for, expected 3`);
    check(/Machine table/.test(right.said), 'the summary does not say what it skipped');
  }

  // ---- a big part can be looked at closely ------------------------------
  //
  // The clip planes follow the camera rather than being picked once from
  // the size of the job. Picked once they are a wall: on a two metre frame
  // everything within a centimetre of the lens was cut away, so pushing in
  // to look at a corner dissolved it.
  {
    await page.evaluate(() => {
      window.millsim.setStock({ shape: 'box', size: [2000, 1200, 400], origin: [-1000, -600, -400], resolution: 2 });
      window.millsim.fitToScene();
    });
    await page.waitForTimeout(900);
    const canvas = await page.$('canvas');
    const area = await canvas.boundingBox();
    await page.mouse.move(area.x + area.width * 0.5, area.y + area.height * 0.45);
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -240);
    await page.waitForTimeout(400);
    // No perspective: the wheel is the zoom, and how close in it got is
    // how little of the part one pixel covers. The clip planes take in the
    // whole scene in front of the camera and behind it, so nothing pushed
    // in on is cut away.
    const close = await page.evaluate(() => {
      const v = window.millsim.viewer;
      return {
        mmpp: v.mmPerPixel(),
        dist: v.camera.position.distanceTo(v.controls.target),
        near: v.camera.near,
        far: v.camera.far,
      };
    });
    console.log('zoomed in:', JSON.stringify({ mmPerPixel: +close.mmpp.toFixed(4), near: +close.near.toFixed(1), far: +close.far.toFixed(1) }));
    check(close.mmpp < 0.05, `the wheel stopped at ${close.mmpp.toFixed(3)} mm a pixel on a 2 m part`);
    check(close.near < -close.dist && close.far > close.dist, `the clip planes (${close.near.toFixed(1)}, ${close.far.toFixed(1)}) would cut away what the camera is looking at ${close.dist.toFixed(1)} mm off`);

    // Double-click puts the turning point on what was clicked.
    await page.evaluate(() => window.millsim.fitToScene());
    await page.waitForTimeout(600);
    const was = await page.evaluate(() => window.millsim.viewer.controls.target.toArray());
    await page.mouse.dblclick(area.x + area.width * 0.32, area.y + area.height * 0.6);
    await page.waitForTimeout(400);
    const now = await page.evaluate(() => window.millsim.viewer.controls.target.toArray());
    const moved = Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2]);
    console.log('focus moved:', +moved.toFixed(1), 'mm');
    check(moved > 1, 'a double-click did not move the turning point');
  }

  // ---- the axes can be wound by hand ------------------------------------
  await page.click('.ribbon-tab[data-tab="machine"]');
  await page.click('.ribbon-page[data-page="jog"]');
  await page.waitForTimeout(500);
  const sliders = await page.$$('.jog-slider');
  check(sliders.length > 0, 'the jog page has no axes');
  await sliders[0].fill('80');
  await page.waitForTimeout(400);
  const jogged = await page.evaluate(() => ({
    jog: { ...window.millsim.jog },
    hud: document.querySelector('.hud').textContent,
  }));
  const moved = Object.values(jogged.jog).some((v) => Math.abs(v - 80) < 1e-6);
  console.log('jog:', JSON.stringify(jogged.jog));
  check(moved, 'the jog slider did not move an axis');
  check(/80/.test(jogged.hud), 'the readout did not follow the jog');
  await page.click('.ribbon-tab[data-tab="program"]');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.millsim.jog === null), 'jogging did not stop when the page was left');

  // ---- a project saves and opens into a working session -----------------
  await loadExample(page, 0, 'Demo bracket');
  await page.evaluate(() => {
    // One called by its number, one by its name: both are how a shop's
    // files arrive, and a name that comes back changed is a broken call.
    window.millsim.state.subprograms.push(
      { id: 'smoke', name: 'O1000-smoke.nc', text: 'O1000\nG1 X5 F300\nM99\n' },
      { id: 'smoke2', name: 'finishing pass.nc', text: 'G91 G1 X1 F300\nG90\nM99\n' },
    );
    window.millsim.reinterpret();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.millsim.setHome([-12, 7, 305]));
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => ({
    source: window.millsim.state.source.length,
    blocks: window.millsim.state.program.stats.blockCount,
    subs: window.millsim.state.subprograms.length,
    names: window.millsim.state.subprograms.map((s) => s.name).join('|'),
    home: [...window.millsim.state.machine.home],
    limits: [...window.millsim.state.machine.limits.min],
  }));

  await page.click('.ribbon-tab[data-tab="setup"]');
  await page.click('.ribbon-page[data-page="project"]');
  await page.waitForTimeout(300);
  const saved = page.waitForEvent('download');
  await page.click('.panel .action-row button:has-text("Save project")');
  const file = join(scratch, 'smoke-project.zip');
  await (await saved).saveAs(file);
  await page.close();

  page = await open();
  // Visit the editor first: it is the page that used to come back empty.
  await page.click('.ribbon-tab[data-tab="program"]');
  await page.click('.ribbon-page[data-page="editor"]');
  await page.waitForTimeout(300);
  await page.click('.ribbon-tab[data-tab="setup"]');
  await page.click('.ribbon-page[data-page="project"]');
  await page.waitForTimeout(300);
  const chooser = page.waitForEvent('filechooser');
  await page.click('.panel .action-row button:has-text("Open project")');
  (await chooser).setFiles(file);
  await page.waitForFunction(() => /Demo bracket/.test(window.millsim.state.programName), null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  await page.click('.ribbon-tab[data-tab="program"]');
  await page.click('.ribbon-page[data-page="editor"]');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    source: window.millsim.state.source.length,
    blocks: window.millsim.state.program.stats.blockCount,
    subs: window.millsim.state.subprograms.length,
    names: window.millsim.state.subprograms.map((s) => s.name).join('|'),
    home: [...window.millsim.state.machine.home],
    limits: [...window.millsim.state.machine.limits.min],
    shown: document.querySelector('.editor-area').value.length,
  }));
  console.log('project round trip:', JSON.stringify(after));
  check(after.source === before.source && after.blocks === before.blocks,
    'the project did not come back with its program');
  check(after.subs === before.subs, 'the project did not come back with its subprograms');
  check(after.names === before.names, `the subprogram names changed: ${before.names} became ${after.names}`);
  check(JSON.stringify(after.home) === JSON.stringify(before.home)
    && JSON.stringify(after.limits) === JSON.stringify(before.limits),
    `home or the envelope did not survive the project: ${JSON.stringify(before.home)}/${JSON.stringify(before.limits)} became ${JSON.stringify(after.home)}/${JSON.stringify(after.limits)}`);

  // ---- and a file is found by the name it is saved under ----------------
  const named = await page.evaluate(() => {
    window.millsim.loadProgram('G21 G90 G54\nG1 X0 Y0 F400\nM98 <finishing pass>\nM30\n', 'named.nc');
    return {
      errors: window.millsim.state.program.warnings.filter((w) => w.severity === 'error').length,
      ran: window.millsim.state.program.moves.some((m) => m.source === 'finishing pass.nc'),
    };
  });
  console.log('call by name:', JSON.stringify(named));
  check(named.errors === 0 && named.ran, 'a subprogram called by its name was not found');

  // ---- the page shows the file that is running --------------------------
  //
  // A job is several files. "Main" was a tab label that was wrong as soon
  // as the run stepped into one of the others, and the highlighted line
  // was a line of the main program that happened to share a number with
  // the line running inside the called file.
  {
    await page.click('.ribbon-tab[data-tab="program"]');
    await page.click('.ribbon-page[data-page="editor"]');
    await page.waitForTimeout(400);
    const named = () => page.evaluate(() => ({
      tab: [...document.querySelectorAll('.ribbon-page')].find((b) => b.dataset.page === 'editor').textContent.trim(),
      showing: document.querySelector('.editor-showing .name').textContent,
      text: document.querySelector('.editor-area').value.length,
      source: (() => {
        const mv = window.millsim.state.program.moves[window.millsim.simulator.moveIndex];
        return (mv && mv.source) || null;
      })(),
    }));
    const atStart = await named();
    check(/named\.nc/.test(atStart.tab), `the tab should name the running file and says "${atStart.tab}"`);

    // Seek into the called file and the page goes with it.
    await page.evaluate(() => {
      const app = window.millsim;
      const i = app.state.program.moves.findIndex((m) => m.source === 'finishing pass.nc');
      const sim = app.simulator;
      let guard = 0;
      while (!sim.finished && sim.moveIndex < i && guard++ < 20000) sim.run(Infinity, 8);
      app.updateTransport();
      app.panels.program.refresh();
    });
    await page.waitForTimeout(500);
    const inside = await named();
    console.log('follows the run:', JSON.stringify({ from: atStart.showing, to: inside.showing, source: inside.source }));
    check(inside.source === 'finishing pass.nc', `the run is in ${inside.source}, so this proves nothing`);
    check(inside.showing === 'finishing pass.nc', `the page is showing ${inside.showing}`);
    check(/finishing pass/.test(inside.tab), `the tab says "${inside.tab}"`);
    check(inside.text !== atStart.text, 'the editor is still showing the same text');
  }

  // ---- single block ------------------------------------------------------
  {
    // The button on the bar, on a job with a called file: each press is
    // the next line, wherever it is.
    const step = await page.evaluate(() => {
      const app = window.millsim;
      app.reset();
      const lineNow = () => {
        const b = app.currentBlock();
        return b ? `${b.source || 'main'}:${b.line}` : 'none';
      };
      const seen = [];
      for (let i = 0; i < 4; i++) {
        document.querySelector('.transport button[title^="Next line"]').click();
        seen.push(lineNow());
      }
      return seen;
    });
    console.log('next line button:', JSON.stringify(step));
    check(new Set(step).size === step.length, `the step button should land on a new line each press: ${step.join(' ')}`);
  }

  // ---- a small part inside a big machine is not clipped ------------------
  //
  // The far plane used to be measured from whatever was last framed, so
  // framing the part cut the machine standing round it in half.
  {
    await page.evaluate(() => {
      window.millsim.setMachine({ preset: 'headHead', mode: 'machine' });
      window.millsim.setStock({ shape: 'box', size: [60, 40, 20], origin: [-30, -20, -20], resolution: 0.5 });
    });
    await page.waitForTimeout(900);
    await page.evaluate(() => window.millsim.viewer.fit(window.millsim.stockView.boundingBox()));
    await page.waitForTimeout(500);
    const clip = await page.evaluate(() => {
      const v = window.millsim.viewer;
      const box = window.millsim.machineView.boundingBox();
      // The farthest corner of the machine from where the camera stands.
      const c = v.camera.position;
      let worst = 0;
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            worst = Math.max(worst, Math.hypot(x - c.x, y - c.y, z - c.z));
          }
        }
      }
      return { far: v.camera.far, near: v.camera.near, worst, radius: v.sceneRadius };
    });
    console.log('clipping:', JSON.stringify({ far: +clip.far.toFixed(0), needs: +clip.worst.toFixed(0), radius: +clip.radius.toFixed(0) }));
    check(clip.far >= clip.worst, `the far plane is ${clip.far.toFixed(0)} and the machine reaches ${clip.worst.toFixed(0)}`);
    check(clip.far / clip.near < 2e5, 'the depth buffer is spread too thin');
  }


  // ---- G53 and the envelope both measure from home ----------------------
  await page.click('.ribbon-tab[data-tab="machine"]');
  await page.click('.ribbon-page[data-page="limits"]');
  await page.waitForTimeout(300);
  const labels = await page.$$eval('.panel .field-label', (n) => n.map((x) => x.textContent.trim()));
  check(labels.some((t) => t.startsWith('Home X')), 'the Travels page has no home position');

  const g53At = async (home) => page.evaluate((h) => {
    const app = window.millsim;
    app.setHome(h);
    app.loadProgram('G21 G90 G54\nG0 X0 Y0 Z0\nG53 G0 Z-50\nM30\n', 'g53.nc');
    const moves = app.state.program.moves;
    return {
      tip: moves[moves.length - 1].to[2],
      gauge: app.state.program.config.gaugeLength || 0,
      ceiling: app.machineView.config.limits.max[2],
      stored: app.state.machine.limits.max[2],
    };
  }, home);
  const low = await g53At([0, 0, 250]);
  const high = await g53At([0, 0, 400]);
  console.log('home:', JSON.stringify({ low: low.tip, high: high.tip, gauge: low.gauge, stored: high.stored }));
  // A machine coordinate is read at the gauge line, so the tip lands a
  // gauge length below the number in the block — and moves with home.
  check(Math.abs(low.tip - (250 - 50 - low.gauge)) < 1e-6 && Math.abs(high.tip - (400 - 50 - high.gauge)) < 1e-6,
    `G53 Z-50 with a ${low.gauge} mm assembly did not follow home: ${low.tip} then ${high.tip}`);
  check(low.gauge > 0, 'nothing in the spindle, so this proves nothing about the gauge line');
  check(low.stored === high.stored, 'the stored envelope should not change when home moves');
  await page.evaluate(() => window.millsim.setHome([0, 0, 250]));
  await page.waitForTimeout(300);

  // ---- moving a pivot does not move the machine -------------------------
  //
  // The centre a trunnion turns about is a number you correct on a machine
  // that is already assembled, so correcting it must not take it apart.
  const pivot = await page.evaluate(() => {
    const app = window.millsim;
    app.setMachine({ preset: 'tableTable', mode: 'machine' });
    const kin = app.machineView.kinematics;
    const a = kin.axes().find((n) => n.letter === 'A');
    const where = () => {
      const out = {};
      for (const child of kin.children(a.id)) {
        const g = app.machineView.nodeGroups.get(child.id);
        g.updateWorldMatrix(true, false);
        const e = g.matrixWorld.elements;
        out[child.id] = [e[12], e[13], e[14]];
      }
      return out;
    };
    const before = where();
    app.setAxisPivot(a.id, [0, 25, -85], true);
    const held = where();
    app.setAxisPivot(a.id, [0, 60, -150], false);
    const moved = where();
    const dist = (x, y) => Math.max(...Object.keys(x).map((k) => Math.hypot(...x[k].map((v, i) => v - y[k][i]))));
    return { pivot: a.origin, held: dist(before, held), moved: dist(held, moved) };
  });
  await page.waitForTimeout(600);
  console.log('pivot:', JSON.stringify({ held: +pivot.held.toFixed(4), moved: +pivot.moved.toFixed(1) }));
  check(pivot.held < 1e-6, `moving the pivot shifted what hangs on it by ${pivot.held.toFixed(3)} mm`);
  check(pivot.moved > 1, 'with the hold off the branch should move with the pivot, and did not');

  // ---- the machine can be painted ---------------------------------------
  {
    await page.click('.ribbon-tab[data-tab="machine"]');
    await page.click('.ribbon-page[data-page="layout"]');
    await page.waitForTimeout(300);
    const has = await page.$$eval('.panel input[type="color"]', (n) => n.length);
    check(has > 0, 'the Layout page has no colour picker on it');
    const painted = await page.evaluate(() => {
      const app = window.millsim;
      const input = [...document.querySelectorAll('.panel input[type="color"]')][0];
      input.value = '#ff8800';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { shown: app.machineView.accentColor(), stored: app.state.machine.accent };
    });
    console.log('machine colour:', JSON.stringify(painted));
    check(painted.shown === '#ff8800', `the castings are ${painted.shown}`);
    check(painted.stored === '#ff8800', 'the colour was not kept on the machine');
    await page.evaluate(() => window.millsim.setMachine({ accent: null }));
  }

  // ---- a body's colour is part of the machine ---------------------------
  {
    const kept = await page.evaluate(() => {
      const app = window.millsim;
      const part = app.machineParts.add({
        name: 'probe-body',
        positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      });
      app.machineParts.paint(part, '#123456');
      const { def } = app.machineFiles();
      const saved = def.bodies.find((b) => b.name === 'probe-body');
      // Lose it, then put the file back over the top.
      app.machineParts.paint(part, '#ffffff');
      app.machineParts.restorePlacements(def.bodies);
      const out = { inFile: saved ? saved.color : null, after: part.color, painted: `#${part.material.color.getHexString()}` };
      app.machineParts.remove(part);
      return out;
    });
    console.log('body colour:', JSON.stringify(kept));
    check(kept.inFile === '#123456', `the saved machine says the body is ${kept.inFile}`);
    check(kept.after === '#123456' && kept.painted === '#123456', 'the colour did not come back with the machine');
  }

  // ---- a ray lands where the cursor is ----------------------------------
  //
  // Picking is done by carrying the pointer ray into the frame the
  // geometry is in and testing it there, so it is only ever as right as
  // that frame is. Two things can put it out: the part sitting somewhere
  // other than where the coordinate system says it does, and the table
  // turning under a ray that was carried into the frame that did not turn.
  // Both are checked by clicking points whose answer is known.
  {
    const rays = await page.evaluate(async () => {
      const THREE = await import('/vendor/three/three.module.min.js');
      const app = window.millsim;
      const out = [];

      const clickAt = (truth) => {
        const mv = app.machineView;
        mv.partGroup.updateWorldMatrix(true, false);
        const world = new THREE.Vector3(...truth).applyMatrix4(mv.partGroup.matrixWorld);
        const ndc = world.clone().project(app.viewer.camera);
        const rect = app.viewer.renderer.domElement.getBoundingClientRect();
        const ev = {
          clientX: rect.left + ((ndc.x + 1) / 2) * rect.width,
          clientY: rect.top + ((1 - ndc.y) / 2) * rect.height,
        };
        const hit = app.pick.objectAt(ev);
        if (!hit || hit.kind !== 'stock') return { miss: hit ? hit.kind : 'nothing' };
        return { err: +Math.hypot(...hit.point.map((v, i) => v - truth[i])).toFixed(3) };
      };

      // Looked at from an angle: straight down would hide an error in Z.
      const oblique = () => {
        const c = app.viewer.camera;
        const t = app.viewer.controls.target;
        c.position.set(t.x + 420, t.y - 520, t.z + 380);
        c.lookAt(t);
        c.updateMatrixWorld(true);
      };

      for (const mode of ['part', 'machine']) {
        app.setMachine({ preset: 'vmc3', mode });
        app.setStock({ shape: 'box', size: [100, 100, 20], origin: [-50, -50, -20], resolution: 0.5, rotation: 0 });
        app.resetStock();
        app.fitToScene();
        await new Promise((r) => setTimeout(r, 500));
        oblique();
        const mv = app.machineView;
        mv.partGroup.updateWorldMatrix(true, false);
        mv.workGroup.updateWorldMatrix(true, false);
        const gap = new THREE.Vector3().setFromMatrixPosition(mv.partGroup.matrixWorld)
          .distanceTo(new THREE.Vector3().setFromMatrixPosition(mv.workGroup.matrixWorld));
        out.push({
          where: mode,
          gap: +gap.toFixed(3),
          hits: [[0, 0, 0], [40, 40, 0], [-40, 25, 0]].map(clickAt),
        });
      }

      // ...and with the table indexed a quarter turn, which moves the part
      // out from under the frame the coordinate system lives in.
      app.machineView.partGroup.rotation.z = Math.PI / 2;
      app.machineView.partGroup.updateWorldMatrix(true, false);
      out.push({ where: 'indexed 90', gap: null, hits: [[40, 20, 0], [-30, 45, 0]].map(clickAt) });
      app.machineView.partGroup.rotation.z = 0;
      return out;
    });
    console.log('picking:', JSON.stringify(rays));
    for (const r of rays) {
      check(r.gap === null || r.gap < 1e-6,
        `in ${r.where} view the part sits ${r.gap} mm from the coordinate frame it is measured in`);
      for (const h of r.hits) {
        check(!h.miss, `clicking the stock in ${r.where} view hit ${h.miss}`);
        check(h.err !== undefined && h.err < 0.6, `a pick in ${r.where} view came back ${h.err} mm out`);
      }
    }
  }

  // ---- U turns the work, and nothing else --------------------------------
  //
  // Twice over: on a machine that has no such axis, and on one where the
  // indexer is modelled and the part is bolted to it. Either way the part
  // goes round and the coordinate system it is measured in does not.
  {
    const indexed = await page.evaluate(async () => {
      const app = window.millsim;
      app.setStock({ shape: 'box', size: [100, 100, 20], origin: [-50, -50, -20], resolution: 0.5, rotation: 0 });
      app.setControl('fidia');
      app.loadProgram([
        '>G90 G21', 'F500', '>G0 X0 Y0 Z20',
        '$REP 4',
        '>G0 X30 Y0 Z2', 'Z-5', '>G0 Z2',
        '>G91', '>G0 U-90.', '>G90',
        '$END',
        '>G0 Z20', 'M30',
      ].join('\n'), 'indexed.nc');
      return { letter: app.state.program.indexer && app.state.program.indexer.letter };
    });
    check(indexed.letter === 'U', 'U was not read as the indexer');
    await runToEnd(page);
    const cut = await page.evaluate(() => {
      const app = window.millsim;
      const at = (x, y) => +app.stock.heightAt(x, y).toFixed(2);
      return {
        holes: [at(30, 0), at(0, -30), at(-30, 0), at(0, 30)],
        middle: at(0, 0),
        // The part turns; the coordinate frame it is measured in does not.
        turned: +app.machineView.partGroup.rotation.z.toFixed(3),
        coord: +app.machineView.workGroup.rotation.z.toFixed(3),
      };
    });
    console.log('indexed:', JSON.stringify(cut));
    check(cut.holes.every((z) => Math.abs(z + 5) < 0.01), `the four holes came out at ${cut.holes.join(', ')}`);
    check(Math.abs(cut.middle) < 0.01, 'something was cut in the middle');
    // Four rounds, four quarter turns: the work ends up back where it
    // started, which is the point of indexing between them.
    check(Math.abs(Math.abs(cut.turned) - Math.PI * 2) < 0.01, `the work is turned ${cut.turned} rad, not a full turn`);
    check(cut.coord === 0, `the coordinate frame turned to ${cut.coord} rad`);
  }

  // ---- ...and on a machine that has the indexer modelled -----------------
  {
    const built = await page.evaluate(async () => {
      const app = window.millsim;
      // A plain mill with a U rotary carrying the table, which is where
      // the part is bolted.
      app.setMachine({ preset: 'vmc3', mode: 'machine' });
      const def = JSON.parse(JSON.stringify(app.machineView.kinematics.toJSON()));
      const table = def.nodes.find((n) => n.id === 'table');
      def.nodes.splice(def.nodes.indexOf(table), 0, {
        id: 'u', name: 'U indexer', letter: 'U', kind: 'rotary', parent: table.parent,
        axis: [0, 0, 1], origin: [0, 0, 0],
      });
      table.parent = 'u';
      await app.applyMachineDefinition(def, null, 'u-machine');
      app.setStock({ shape: 'box', size: [100, 100, 20], origin: [-50, -50, -20], resolution: 0.5, rotation: 0 });
      return { axis: app.machineView.kinematics.extras().map((n) => `${n.letter}:${n.kind}`).join(',') };
    });
    // Let the machine settle: changing one re-rigs the tool table on a
    // timer, and that reload would cancel the run started under it.
    await page.waitForTimeout(1200);
    const loaded = await page.evaluate(() => {
      const app = window.millsim;
      app.loadProgram([
        '>G90 G21', 'F500', '>G0 X0 Y0 Z20',
        '$REP 3',
        '>G0 X30 Y0 Z2', 'Z-5', '>G0 Z2',
        '>G91', '>G0 U-90.', '>G90',
        '$END',
        '>G0 Z20', 'M30',
      ].join('\n'), 'indexed-machine.nc');
      // The chain answers for it now; the angle is still reported, and
      // says so.
      return { standIn: app.state.program.indexer };
    });
    await page.waitForTimeout(400);
    check(/U:rotary/.test(built.axis), `the machine's extras are ${built.axis}`);
    check(loaded.standIn && loaded.standIn.inChain === true,
      `the indexer reads ${JSON.stringify(loaded.standIn)} on a machine that has the axis`);

    await runToEnd(page);
    const framed = await page.evaluate(() => {
      const app = window.millsim;
      const spin = (o) => {
        o.updateWorldMatrix(true, false);
        const e = o.matrixWorld.elements;
        return Math.round((Math.atan2(e[1], e[0]) * 180) / Math.PI);
      };
      const at = (x, y) => +app.stock.heightAt(x, y).toFixed(2);
      return {
        coord: spin(app.machineView.workGroup),
        part: spin(app.machineView.partGroup),
        path: spin(app.toolpathView.group),
        holes: [at(30, 0), at(0, 30), at(-30, 0), at(0, -30)],
        middle: at(0, 0),
      };
    });
    console.log('modelled indexer:', JSON.stringify(framed));
    // Three quarter turns of the part; the coordinate system has not moved.
    check(Math.abs(framed.part) === 90 || Math.abs(framed.part) === 270, `the part is at ${framed.part} degrees`);
    check(framed.coord === 0, `the coordinate frame turned to ${framed.coord} degrees`);
    check(framed.path === 0, `the backplot turned to ${framed.path} degrees`);
    // Three rounds, so three of the four quarters are drilled and the
    // fourth — the one the part never came round to — is not.
    check(framed.holes.filter((z) => Math.abs(z + 5) < 0.01).length === 3,
      `the holes came out at ${framed.holes.join(', ')}`);
    check(Math.abs(framed.middle) < 0.01, 'something was cut in the middle');
  }

  // ---- the reference part is checked in the frame the part is in --------
  //
  // The stock grid is in part coordinates. In full-machine view the
  // scene's coordinates are a whole kinematic chain away from those, and
  // comparing the two put the reference surface off the side of the block
  // where nothing could ever reach it: the cutter went straight through a
  // reference part and nothing was reported.
  for (const mode of ['part', 'machine']) {
    await page.evaluate(async (m) => {
      const app = window.millsim;
      app.setMachine({ preset: 'vmc3', mode: m });
      app.setStock({ shape: 'box', size: [80, 60, 20], origin: [-40, -30, -20], resolution: 0.4, rotation: 0 });
      for (const model of [...app.models.models]) app.models.remove(model);
      const { boxToTriangles } = await import('/src/io/mesh.js');
      // The finished part: this block with its top 5 mm taken off.
      const part = boxToTriangles([-40, -30, -20], [40, 30, -5]);
      app.models.add({ name: 'reference', positions: part.positions, role: 'reference' });
      app.refreshTarget();
      app.loadProgram(['G21 G90 G54', 'G0 X-30 Y0 Z5', 'G1 Z-10 F300', 'G1 X30', 'G0 Z20', 'M30'].join('\n'), 'gouge.nc');
    }, mode);
    await page.waitForTimeout(900);
    await runToEnd(page);
    const cut = await page.evaluate(() => {
      const app = window.millsim;
      const cmp = app.compareToReference();
      return {
        reported: app.simulator.collisions.filter((c) => c.type === 'gouge').length,
        maxGouge: cmp ? +cmp.maxGouge.toFixed(2) : null,
      };
    });
    console.log(`reference in ${mode} view:`, JSON.stringify(cut));
    check(cut.reported > 0, `cutting 5 mm through the reference part in ${mode} view reported nothing`);
    check(Math.abs(cut.maxGouge - 5) < 0.05, `the gouge measured ${cut.maxGouge} mm, not 5`);
  }
  await page.evaluate(() => {
    const app = window.millsim;
    for (const model of [...app.models.models]) app.models.remove(model);
    app.refreshTarget();
  });

  // ---- the jog sliders span the travels, and say when they are past -----
  {
    const jog = await page.evaluate(() => {
      const app = window.millsim;
      app.setHome([0, 0, 300]);
      app.setMachine({ limits: { enabled: true, frame: 'home', min: [-100, -100, -200], max: [100, 100, 50] } });
      app.setPage('machine', 'jog');
      const spans = [...document.querySelectorAll('.jog-slider')].map((sl) => `${sl.min}..${sl.max}`);
      app.startJog();
      app.setJog('X', 90);
      const inside = app.jogLimit();
      // Asking for 400 on a machine with 100 of travel does not get 400:
      // the pendant stops at the stop, which is why nothing alarms here.
      const refused = app.setJog('X', 400);
      const outside = app.jogLimit();
      // The end of a slider has to be the last place the machine can stand:
      // a hair inside is clear, a hair outside alarms. The envelope is
      // stated about the gauge line and the slider is the joint, so this is
      // the thing that proves the one was solved back onto the other.
      const range = app.jogRange('X');
      app.setJog('X', range.max - 0.01);
      const atEnd = app.jogLimit();
      app.jog.X = range.max + 0.5;          // past what the slider allows
      const pastEnd = app.jogLimit();
      app.setJog('X', 0);
      // The travels change, and the sliders follow them.
      app.setMachine({ limits: { enabled: true, frame: 'home', min: [-1300, -100, -200], max: [500, 100, 50] } });
      app.setPage('machine', 'limits');
      app.setPage('machine', 'jog');
      const wider = app.jogRange('X');
      const hard = [app.setJog('X', -99999), app.setJog('X', 99999)];
      app.setJog('X', 0);
      return { spans, inside, refused, outside, range, atEnd, pastEnd, wider, hard };
    });
    console.log('jog travels:', JSON.stringify(jog));
    check(jog.spans.length >= 3, `the jog page drew ${jog.spans.length} sliders`);
    check(jog.inside === null, 'inside the envelope and alarming');
    check(Math.abs(jog.refused - 100) < 1e-6 && jog.outside === null,
      `winding X to 400 on 100 mm of travel reached ${jog.refused}`);
    check(jog.range && jog.range.source === 'envelope', 'a linear jog slider is not governed by the envelope');
    check(jog.atEnd === null, 'the last millimetre of the slider already alarms');
    check(jog.pastEnd && jog.pastEnd.axis === 'X', 'past the end of the slider and no alarm');
    check(Math.abs(jog.wider.max - jog.wider.min - 1800) < 1e-3,
      `after widening X to 1800 mm of travel the slider spans ${jog.wider.min}..${jog.wider.max}`);
    check(Math.abs(jog.hard[0] - jog.wider.min) < 1e-3 && Math.abs(jog.hard[1] - jog.wider.max) < 1e-3,
      `winding hard over stopped at ${jog.hard.join('/')} rather than the ends of travel`);
    await page.evaluate(() => { window.millsim.stopJog(); window.millsim.setHome([0, 0, 250]); });
  }

  // ---- a pile of cutters goes in one go ---------------------------------
  //
  // A library arrives forty tools at a time and is tidied the same way, so
  // the lists take a selection rather than a row: a tick per row, Ctrl to
  // add and drop, Shift for a run, and one confirmation for the lot.
  {
    await page.click('.ribbon-tab[data-tab="tools"]');
    await page.click('.ribbon-page[data-page="tools"]');
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => window.millsim.library.tools.length);
    check(before >= 6, `only ${before} cutters to pick from`);

    // Rows are redrawn on every click, so they are addressed by position
    // rather than held on to.
    const nth = (i) => `.list-item:nth-of-type(${i + 1})`;
    await page.click(nth(1));
    await page.click(nth(4), { modifiers: ['Shift'] });
    await page.waitForTimeout(250);
    const run = await page.evaluate(() => ({
      marked: window.millsim.panels.tools.marked.tool.size,
      ticks: document.querySelectorAll('.list-tick.on').length,
      labels: [...document.querySelectorAll('.btn')].map((b) => b.textContent).filter((t) => /^(Delete|Duplicate)/.test(t)),
    }));
    console.log('bulk select:', JSON.stringify(run));
    check(run.marked === 4 && run.ticks === 4, `a shift-click run took ${run.marked} rows, not 4`);
    check(run.labels.includes('Delete 4'), `the buttons read ${run.labels.join(', ')}`);

    // Ctrl adds one and takes one away; the tick box does the same thing
    // without the keyboard.
    await page.click(nth(5), { modifiers: ['Control'] });
    await page.click(nth(2), { modifiers: ['Control'] });
    await page.click(`${nth(0)} .list-tick`);
    await page.waitForTimeout(250);
    const picked = await page.evaluate(() => window.millsim.panels.tools.selectedIds().length);
    check(picked === 5, `after adding, dropping and ticking there are ${picked} rows, not 5`);

    await page.evaluate(() => [...document.querySelectorAll('.btn')].find((x) => /^Delete \d+$/.test(x.textContent)).click());
    await page.waitForTimeout(300);
    const asked = await page.evaluate(() => {
      const d = document.querySelector('.dialog');
      return d ? d.textContent : '';
    });
    check(/Delete 5 cutters\?/.test(asked), `the confirmation said "${asked.slice(0, 60)}"`);
    await page.evaluate(() => [...document.querySelectorAll('.dialog .btn')].find((x) => /^Delete/.test(x.textContent)).click());
    await page.waitForTimeout(450);

    const after = await page.evaluate(() => ({
      tools: window.millsim.library.tools.length,
      marked: window.millsim.panels.tools.marked.tool.size,
      rows: document.querySelectorAll('.list-item').length,
      // Nothing may be left pointing at a cutter that is gone.
      dangling: window.millsim.library.assemblies.filter((a) => a.toolId && !window.millsim.library.tool(a.toolId)).length,
    }));
    console.log('bulk delete:', JSON.stringify({ before, ...after }));
    check(after.tools === before - 5, `${before} cutters less five left ${after.tools}`);
    check(after.rows === after.tools, 'the list did not redraw after the delete');
    check(after.marked === 0, 'the ticks survived the delete');
    check(after.dangling === 0, `${after.dangling} assemblies point at a cutter that is gone`);

    // One row on its own still reads as one row.
    await page.click(nth(0));
    await page.waitForTimeout(200);
    const single = await page.evaluate(() => [...document.querySelectorAll('.btn')].map((b) => b.textContent).filter((t) => /^(Delete|Duplicate)/.test(t)));
    check(single.includes('Delete') && !single.some((t) => /^Delete \d/.test(t)), `one row selected and the buttons read ${single.join(', ')}`);

    // The library is kept without anyone being asked to tick a box about
    // browser storage — that question goes away with the browser.
    await page.click('.ribbon-page[data-page="library"]');
    await page.waitForTimeout(300);
    const libPage = await page.evaluate(() => document.body.innerText);
    check(!/Keep the library in this browser/.test(libPage), 'the browser-storage toggle is still on the Library page');

    await page.evaluate(() => { window.millsim.library.mergeDefaults(); window.millsim.refreshSlots(); });
    await page.waitForTimeout(300);
  }

  // ---- inches are a reading, not a second set of numbers ----------------
  //
  // The switch has one job and one rule. The job: every length on every
  // page, the boxes as well as the prose. The rule: nothing but the
  // reading changes — the library, the machine and the cut stay in
  // millimetres, so a file written in inch mode is the file that would
  // have been written in metric.
  {
    const unitCheck = await page.evaluate(async () => {
      const app = window.millsim;
      app.setMachine({ preset: 'vmc3', mode: 'machine' });
      app.setUnits('mm');
      const tool = app.library.addTool({
        name: 'unit check', type: 'flat', number: 61,
        diameter: 25.4, fluteLength: 50.8, overallLength: 101.6, shankDiameter: 25.4, fluteCount: 4,
      });
      const limitsBefore = JSON.parse(JSON.stringify(app.state.machine.limits));
      const libBefore = JSON.stringify(app.library.toJSON().tools);

      app.setPage('tools', 'tools');
      await new Promise((r) => setTimeout(r, 250));
      const metricRow = [...document.querySelectorAll('.list-sub')]
        .find((n) => /unit check/.test(n.parentElement.textContent) || /25\.4/.test(n.textContent));

      app.setUnits('in');
      await new Promise((r) => setTimeout(r, 300));
      const inchRow = [...document.querySelectorAll('.list-item')]
        .find((n) => /unit check/.test(n.textContent));

      // Every page, in inches, with nothing still claiming millimetres and
      // nothing throwing on the way.
      const saidMm = [];
      for (const tab of ['setup', 'machine', 'tools', 'program', 'results', 'view']) {
        app.setTab ? app.setTab(tab) : app.setPage(tab, null);
        const pages = [...document.querySelectorAll('.ribbon-page')].map((p) => p.dataset.page);
        for (const pg of pages) {
          app.setPage(tab, pg);
          await new Promise((r) => setTimeout(r, 40));
          const host = document.querySelector('.panel-body') || document.body;
          if (/\bmm\b|cm³/.test(host.innerText)) saidMm.push(`${tab}/${pg}`);
        }
      }

      // The travel boxes, submitted as drawn, ten times over. A rounded
      // inch turned back into millimetres would walk the envelope.
      app.setPage('machine', 'limits');
      await new Promise((r) => setTimeout(r, 250));
      for (let i = 0; i < 10; i++) {
        for (const input of document.querySelectorAll('input[type=number]')) {
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const limitsAfter = JSON.parse(JSON.stringify(app.state.machine.limits));

      // ...and a real edit still means what it says: -10 in is -254 mm.
      const box = [...document.querySelectorAll('.field')].find((x) => /X min/.test(x.textContent));
      const input = box && box.querySelector('input');
      if (input) {
        input.value = '-10';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 150));
      const edited = app.state.machine.limits.min[0];

      const libAfter = JSON.stringify(app.library.toJSON().tools);
      app.library.removeMany('tools', [tool.id]);
      app.setUnits('mm');
      return {
        metric: metricRow ? metricRow.textContent : '',
        inch: inchRow ? inchRow.textContent : '',
        saidMm,
        drift: [0, 1, 2].map((i) => Math.abs(limitsAfter.min[i] - limitsBefore.min[i])),
        edited,
        libUnchanged: libBefore === libAfter,
        hud: document.querySelector('.hud').textContent,
      };
    });
    console.log('units:', JSON.stringify({ ...unitCheck, hud: undefined }));
    check(/25\.4\s*mm/.test(unitCheck.metric), `the metric row read "${unitCheck.metric}"`);
    check(/\b1 in\b/.test(unitCheck.inch), `the inch row read "${unitCheck.inch}"`);
    check(unitCheck.saidMm.length === 0, `these pages still say mm in inch mode: ${unitCheck.saidMm.join(', ')}`);
    check(unitCheck.drift.every((d) => d === 0), `the envelope drifted ${unitCheck.drift.join(', ')} mm from being redrawn in inches`);
    check(Math.abs(unitCheck.edited + 254) < 1e-6, `typing -10 in stored ${unitCheck.edited}, not -254 mm`);
    check(unitCheck.libUnchanged, 'the library changed when the unit did');

    // Reading the prose is not enough. A box with no unit on it converts
    // nothing and says nothing about it, which is how the work offsets
    // stayed in millimetres while every page around them had changed. So
    // every numeric box on every page is read in both units and has to
    // account for itself: one labelled as a length must be the metric
    // value over 25.4, and one that is not a length must not have moved.
    const boxes = await page.evaluate(async () => {
      const app = window.millsim;
      const sweep = async (u) => {
        app.setUnits(u);
        await new Promise((r) => setTimeout(r, 250));
        const found = {};
        for (const tab of ['setup', 'machine', 'tools', 'program', 'results', 'view']) {
          if (app.setTab) app.setTab(tab);
          const pages = [...document.querySelectorAll('.ribbon-page')].map((p) => p.dataset.page);
          for (const pg of pages) {
            app.setPage(tab, pg);
            await new Promise((r) => setTimeout(r, 50));
            let n = 0;
            for (const f of document.querySelectorAll('.field')) {
              const input = f.querySelector('input[type=number]');
              if (!input) continue;
              const label = ((f.querySelector('.field-label') || {}).textContent || '').trim();
              found[`${tab}/${pg}#${n++}`] = { label, value: input.value };
            }
          }
        }
        return found;
      };
      // Something non-zero in the offsets, or there is nothing to convert.
      app.setWcs({ ...app.state.wcs, G54: [25.4, 50.8, -12.7] });
      const mm = await sweep('mm');
      const inch = await sweep('in');
      app.setUnits('mm');

      const bad = [];
      let counted = 0;
      for (const key of Object.keys(mm)) {
        const a = mm[key];
        const b = inch[key];
        if (!b) continue;
        counted++;
        const va = parseFloat(a.value);
        const vb = parseFloat(b.value);
        const moved = Number.isFinite(va) && Number.isFinite(vb) && Math.abs(va - vb) > 1e-9;
        // A box with no label of its own says its unit somewhere else —
        // the work-offset table in its column header, the jog box in the
        // readout beside it — so it is judged by whether it converted.
        const isLength = /\bin$/.test(b.label) || /\bin\/min$/.test(b.label) || (b.label === '' && moved);
        if (isLength) {
          const want = va / 25.4;
          if (Number.isFinite(va) && va !== 0 && Math.abs(vb - want) > Math.max(1e-4, Math.abs(want) * 1e-4)) {
            bad.push(`${key} "${b.label}" ${a.value} → ${b.value}, wanted ${want.toFixed(4)}`);
          }
        } else if (moved) {
          bad.push(`${key} "${b.label}" is not a length but moved ${a.value} → ${b.value}`);
        } else if (Number.isFinite(va) && va !== 0 && !/°|rpm|flutes|ratio|scale|number|%/i.test(b.label)) {
          // Unitless, unchanged and not one of the things that genuinely
          // has no unit: most likely a length nobody told about the switch.
          bad.push(`${key} "${b.label}" has no unit and did not convert (${a.value})`);
        }
      }
      return { bad, counted };
    });
    console.log('unit boxes:', JSON.stringify({ counted: boxes.counted, bad: boxes.bad.length }));
    check(boxes.counted > 30, `only ${boxes.counted} numeric boxes were found to check`);
    check(boxes.bad.length === 0, `boxes that do not follow the unit switch:\n   ${boxes.bad.join('\n   ')}`);
  }

  // ---- the machine's own castings are in the crash model ----------------
  //
  // On the trunnion the cradle's side plates stand 60 over the table face,
  // which is 20 under the part's zero: a cutter at Z-30 fed out to X260 is
  // in the right-hand one. Reported with the part and the axis it rides
  // on, and not reported once the check is off.
  {
    const crash = async (on) => page.evaluate(async (on) => {
      const app = window.millsim;
      app.setMachine({ preset: 'tableTable', castingsCheck: on });
      await new Promise((r) => setTimeout(r, 300));
      app.loadProgram('G90 G0 X0 Y0 Z150\nG0 Z-30\nG1 X260 F1000\nG0 Z150\nM30', 'cradle.nc');
      await new Promise((r) => setTimeout(r, 300));
      const sim = app.simulator;
      let n = 0;
      while (!sim.finished && n++ < 100000) sim.run(Infinity, 50);
      return {
        bodies: sim.castings.length,
        hits: sim.collisions.filter((c) => c.type === 'casting').map((c) => `${c.line}: ${c.message}`),
      };
    }, on);
    const on = await crash(true);
    const off = await crash(false);
    console.log('castings:', JSON.stringify({ on, off: off.hits }));
    check(on.bodies >= 2 && on.hits.some((h) => /^3: .*Cradle side \(A axis\)/.test(h)),
      `feeding into the cradle side should be a machine collision: ${JSON.stringify(on)}`);
    check(off.hits.length === 0, `with the check off nothing should be said about the castings: ${off.hits}`);
    // The head against the table. Swung to A90 with the head brought
    // down, the head is in the table face — which nothing reported, since
    // only the tool assembly was ever checked against the machine.
    const clash = await page.evaluate(async () => {
      const app = window.millsim;
      app.setMachine({ preset: 'tableTable', castingsCheck: true });
      await new Promise((r) => setTimeout(r, 300));
      app.loadProgram('A90 Y-110 Z-110', 'ram.nc');
      await new Promise((r) => setTimeout(r, 300));
      const sim = app.simulator;
      let n = 0;
      while (!sim.finished && n++ < 100000) sim.run(Infinity, 50);
      return sim.collisions.map((c) => ({ type: c.type, depth: +(c.depth || 0).toFixed(2), message: c.message }));
    });
    console.log('machine against itself:', JSON.stringify(clash.filter((c) => c.type === 'machine' || c.type === 'holder')));
    // Which casting gets there first depends on the tool and the work
    // offset an earlier step left; that the head is reported in the table
    // face is what matters. The sphere bulge is pinned exactly in
    // test/tridexel.test.js.
    check(clash.some((c) => c.type === 'machine' && /hits the Table face/.test(c.message)),
      `the head should be reported in the table face: ${JSON.stringify(clash)}`);
    await page.evaluate(() => window.millsim.setMachine({ preset: 'vmc3', castingsCheck: true }));
  }

  // ---- Travels: home is where the spindle face stands --------------------
  //
  // The page parks the machine at home with nothing in the spindle, so the
  // point typed in as home is where the spindle face is drawn; and machine
  // coordinates — the HUD's MCS line, the jog sliders — read the spindle
  // face from there, whatever tool is loaded.
  {
    const tv = await page.evaluate(async () => {
      const app = window.millsim;
      app.setMachine({ preset: 'tableTable' });
      await new Promise((r) => setTimeout(r, 300));
      app.setHome([10, -20, 300]);
      app.setPage('machine', 'limits');
      await new Promise((r) => setTimeout(r, 300));
      const kin = app.machineView.kinematics;
      const face = kin.toolInWork(app.homePose().values, 0).tip;
      const out = {
        face: face.map((v) => +v.toFixed(3)),
        tool: app.toolView.group.visible,
        mark: !!app.machineView.homeMarker,
        box: !!(app.machineView.limitBox && app.machineView.limitBox.visible),
      };
      app.setPage('machine', 'jog');
      for (const L of ['X', 'Y', 'Z']) app.setJogReading(L, 0);
      out.home = app.machinePosition().map((v) => +v.toFixed(3));
      app.setJogReading('Z', -50);
      out.down = app.machinePosition().map((v) => +v.toFixed(3));
      app.setPage('machine', 'layout');
      out.back = app.toolView.group.visible;
      app.setHome([0, 0, 250]);
      app.setMachine({ preset: 'vmc3' });
      return out;
    });
    console.log('travels:', JSON.stringify(tv));
    check(tv.face.join() === '10,-20,300', `the spindle face should stand on home: ${tv.face}`);
    check(!tv.tool && tv.mark && tv.box, `Travels should show an empty spindle, the home mark and the envelope: ${JSON.stringify(tv)}`);
    check(tv.home.join() === '0,0,0' && tv.down.join() === '0,0,-50', `machine coordinates should be the spindle face from home: ${JSON.stringify(tv)}`);
    check(tv.back, 'leaving Travels should put the tool back');
  }

  // ---- every Add… button opens its window --------------------------------
  //
  // A window that throws while it is being built never appears, and nothing
  // else says so: Add fixture… did exactly that while dropping a file on
  // the same page worked.
  {
    const pages = [
      ['setup', 'stock'], ['setup', 'fixtures'],
      ['machine', 'layout'], ['machine', 'axes'], ['machine', 'assembly'], ['machine', 'macros'],
      ['tools', 'assemblies'], ['tools', 'tools'], ['tools', 'holders'],
    ];
    // Buttons that go straight to the file explorer or need a body chosen.
    const skip = /Open files|Mate by two points/;
    const silent = [];
    let opened = 0;
    for (const [tab, id] of pages) {
      await page.click(`.ribbon-tab[data-tab="${tab}"]`);
      await page.click(`.ribbon-page[data-page="${id}"]`);
      await page.waitForTimeout(200);
      const labels = await page.$$eval('.panel .add-bar .add-btn:not([disabled])', (bs) => bs.map((b) => b.textContent.trim()));
      for (const label of labels) {
        if (skip.test(label)) continue;
        const before = errors.length;
        await page.click(`.panel .add-bar .add-btn:has-text("${label}")`);
        const shown = await page.waitForSelector('.dialog', { timeout: 1500 }).then(() => true, () => false);
        if (!shown || errors.length > before) silent.push(`${tab}/${id} ${label}`);
        else opened++;
        if (shown) {
          await page.keyboard.press('Escape');
          const gone = await page.waitForSelector('.dialog', { state: 'detached', timeout: 1500 }).then(() => true, () => false);
          // A window whose editor keeps Escape for itself closes by its ✕.
          if (!gone) await page.click('.dialog .dialog-close');
        }
      }
    }
    console.log('add windows:', JSON.stringify({ opened, silent }));
    check(!silent.length, `these Add buttons opened no window: ${silent.join(', ')}`);
    check(opened >= 9, `only ${opened} Add windows were tried`);

    // And the fixture window adds a fixture.
    await page.click('.ribbon-tab[data-tab="setup"]');
    await page.click('.ribbon-page[data-page="fixtures"]');
    const count = () => page.evaluate(() => window.millsim.models.models.length);
    const was = await count();
    await page.click('.panel .add-bar .add-btn:has-text("Add fixture")');
    await page.waitForSelector('.dialog');
    await page.click('.dialog .dialog-footer .btn-primary');
    await page.waitForTimeout(300);
    const now = await count();
    check(now === was + 2, `Add fixture… with Vice jaws chosen should add two jaws: ${was} → ${now}`);
    await page.evaluate((n) => {
      const app = window.millsim;
      for (const m of app.models.models.slice(n)) app.models.remove(m);
      app.refreshFixtures();
    }, was);
  }

  // ---- no perspective, turns about the machine's axes, zero on a bore ----
  {
    await page.click('.ribbon-tab[data-tab="setup"]');
    await page.click('.ribbon-page[data-page="origin"]');
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const app = window.millsim;
      const out = { ortho: !!app.viewer.camera.isOrthographicCamera };
      // Three points round a Ø8 bore at X37 Y-12, part frame, on Z5.
      const key = app.state.wcsEdit;
      const z0 = app.state.wcs[key][2];
      const pts = [0, 2, 4].map((k) => [37 + 4 * Math.cos(k), -12 + 4 * Math.sin(k), 5]);
      const want = app.coordFromPart([37, -12, 5]);
      app.setOriginByBore();
      for (const p of pts) { app.pick.hover = { point: p }; app.pick.commit(); }
      const got = app.state.wcs[key];
      out.bore = { got, want: [want[0], want[1], z0] };
      // A vice jaw turned about machine X, then about machine Z: the same
      // as those two turns about fixed axes, Z's last.
      app.addPrimitiveFixture('clamp');
      const m = app.models.models[app.models.models.length - 1];
      const at = m.object.position.toArray();
      // Its origin is the middle of its own base, not the table's middle.
      m.object.updateMatrixWorld(true);
      const bb = m.mesh.geometry.boundingBox;
      out.base = [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.min.z].map((v) => Math.round(v * 1e6) / 1e6);
      // About machine X through the origin, then about machine Z: each turn
      // about the machine's axis, however the one before left the model.
      app.models.turnAbout(m, 0, 90);
      app.models.turnAbout(m, 2, 90);
      out.still = m.object.position.toArray().every((v, i) => Math.abs(v - at[i]) < 1e-9);
      m.object.updateMatrixWorld(true);
      const q = m.object.quaternion;
      // Its own X axis should now point along machine Y, its own Y along machine Z.
      const ax = (v) => { const x = v.clone().applyQuaternion(q); return [x.x, x.y, x.z].map((n) => Math.round(n)); };
      const V = m.object.position.constructor;
      out.turn = { x: ax(new V(1, 0, 0)), y: ax(new V(0, 1, 0)) };
      out.marker = app.models.marker.visible === (app.models.selected === m);
      app.models.resetTurns(m);
      out.reset = Math.abs(m.object.quaternion.w) === 1;
      app.models.remove(m);
      app.refreshFixtures();
      return out;
    });
    console.log('ortho, bore, turns:', JSON.stringify(r));
    check(r.ortho, 'the viewport camera should be orthographic');
    check(r.bore.got.every((v, i) => Math.abs(v - r.bore.want[i]) < 1e-6), `zero on a bore: ${JSON.stringify(r.bore)}`);
    check(r.turn.x.join() === '0,1,0' && r.turn.y.join() === '0,0,1', `a turn about machine X and then one about machine Z: ${JSON.stringify(r.turn)}`);
    check(r.still, 'turning a fixture moved its origin');
    check(r.base.join() === '0,0,0', `a built-in clamp's origin should be the middle of its base: ${r.base}`);
    check(r.reset, 'Reset rotation should put the model back as drawn');
  }

  // ---- a machine built from nothing looks like nothing ------------------
  //
  // Stand-in castings are how a preset describes itself; on a machine you
  // are modelling yourself they are geometry nobody owns.
  await page.click('.ribbon-tab[data-tab="machine"]');
  await page.click('.ribbon-page[data-page="layout"]');
  await page.waitForTimeout(300);
  const drawn = () => page.evaluate(() => {
    let n = 0;
    for (const parts of window.millsim.machineView.proxies.values()) n += parts.length;
    return { proxies: n, flag: window.millsim.state.machine.proxies };
  });
  const preset = await drawn();
  await page.click('.panel button:has-text("New machine…")');
  await page.waitForSelector('.dialog');
  await page.click('.dialog button:has-text("Create")');
  await page.waitForTimeout(1200);
  const bare = await drawn();
  console.log('stand-ins:', JSON.stringify({ preset: preset.proxies, bare: bare.proxies }));
  check(preset.proxies > 0, 'a preset machine drew no castings at all');
  check(bare.proxies === 0 && bare.flag === false, `a new machine drew ${bare.proxies} stand-in parts`);
  check(after.shown === after.source, 'the program came back but the editor is empty');

  // ---- the view cube: a click on it is a view --------------------------
  {
    const cube = await page.$('canvas.view-cube');
    check(!!cube, 'there is no view cube in the viewport');
    const box = await cube.boundingBox();
    const dir = () => page.evaluate(() => {
      const v = window.millsim.viewer;
      const d = v.camera.position.clone().sub(v.controls.target).normalize();
      return [d.x, d.y, d.z].map((x) => +x.toFixed(3));
    });
    await page.evaluate(() => window.millsim.viewer.lookFrom([0, -1, 0]));
    await page.waitForTimeout(300);
    // Face on, the FRONT face fills the middle; its right-hand band is the
    // edge with RIGHT.
    await page.mouse.click(box.x + box.width * 0.76, box.y + box.height * 0.5);
    await page.waitForFunction(() => !window.millsim.viewer.swing, null, { timeout: 20000 });
    const edge = await dir();
    console.log('view cube:', JSON.stringify(edge));
    check(Math.abs(edge[0] - 0.707) < 0.01 && Math.abs(edge[1] + 0.707) < 0.01 && Math.abs(edge[2]) < 0.01,
      `clicking the front-right edge of the cube should look from there: ${edge}`);
  }
} catch (err) {
  console.error('SMOKE FAILED:', err.message);
  errors.push(err.message);
} finally {
  await browser.close();
}

if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors.slice(0, 10)) console.error(' -', e.split('\n')[0]);
  await stop(1);
}
console.log('\nSmoke test passed.');
await stop(0);
