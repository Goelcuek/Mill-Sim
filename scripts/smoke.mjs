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
