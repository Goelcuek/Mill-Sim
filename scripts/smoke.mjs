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
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
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

  // ---- and the editor is showing the program it just ran ----------------
  await page.click('.ribbon-tab[data-tab="program"]');
  await page.click('.ribbon-page[data-page="editor"]');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.querySelector('.editor-area').value === window.millsim.state.source),
    'the editor is not showing the loaded program');

  // ---- a hole drilled to size is not a gouge ----------------------------
  //
  // The comparison against a reference part looks straight down, and the
  // hole in a reference model is a polygon inscribed in the circle it
  // stands for. Drill it with the drill it was drawn for and the two
  // disagree sideways by a fraction of a grid column — which, measured
  // vertically, used to read as a gouge the whole depth of the hole. What
  // must still be reported is a cut that is actually too deep.
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
    check(cmp.skipped > 0 && cmp.compared > cmp.skipped, `walls: ${cmp.skipped} skipped of ${cmp.compared + cmp.skipped}`);
    check(Math.abs(cmp.lateral - 0.25) < 1e-6, `the lateral resolving power should be one column, and reads ${cmp.lateral}`);
    check(/Walls skipped/.test(said), `the results panel does not say what it left out: ${said.slice(0, 200)}`);

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
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
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
    const close = await page.evaluate(() => {
      const v = window.millsim.viewer;
      return {
        dist: v.camera.position.distanceTo(v.controls.target),
        near: v.camera.near,
        far: v.camera.far,
      };
    });
    console.log('zoomed in:', JSON.stringify({ dist: +close.dist.toFixed(2), near: +close.near.toFixed(4) }));
    check(close.dist < 10, `the wheel stopped ${close.dist.toFixed(1)} mm out on a 2 m part`);
    check(close.near < close.dist * 0.6, `the near plane (${close.near.toFixed(3)}) would cut away what the camera is looking at`);
    check(close.far / close.near < 2e5, 'the depth buffer is spread too thin');

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
    const step = await page.evaluate(() => {
      const app = window.millsim;
      app.reset();
      const lineNow = () => {
        const mv = app.state.program.moves[app.simulator.moveIndex];
        return mv ? `${mv.source || 'main'}:${mv.line}` : 'none';
      };
      const before = lineNow();
      document.querySelector('.transport button[title^="Single block"]').click();
      return { before, after: lineNow() };
    });
    console.log('single block:', JSON.stringify(step));
    check(step.before !== step.after, `single block stayed on ${step.before}`);
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
      app.setJog('X', 400);
      const outside = app.jogLimit();
      app.setJog('X', 0);
      return { spans, inside, outside };
    });
    console.log('jog travels:', JSON.stringify({ spans: jog.spans, outside: jog.outside }));
    check(jog.spans[0] === '-100..100' && jog.spans[2] === '-200..50',
      `the sliders span ${jog.spans.join(', ')} rather than the machine's travels`);
    check(jog.inside === null, 'inside the envelope and alarming');
    check(jog.outside && jog.outside.axis === 'X', 'jogging past the envelope raised nothing');
    await page.evaluate(() => { window.millsim.stopJog(); window.millsim.setHome([0, 0, 250]); });
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
