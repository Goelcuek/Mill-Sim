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
  const before = await page.evaluate(() => ({
    source: window.millsim.state.source.length,
    blocks: window.millsim.state.program.stats.blockCount,
    subs: window.millsim.state.subprograms.length,
    names: window.millsim.state.subprograms.map((s) => s.name).join('|'),
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
    shown: document.querySelector('.editor-area').value.length,
  }));
  console.log('project round trip:', JSON.stringify(after));
  check(after.source === before.source && after.blocks === before.blocks,
    'the project did not come back with its program');
  check(after.subs === before.subs, 'the project did not come back with its subprograms');
  check(after.names === before.names, `the subprogram names changed: ${before.names} became ${after.names}`);

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
