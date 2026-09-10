// Browser smoke test: boots the app, runs an example program end to end and
// fails on any console error.
//
// Playwright is not a dependency of this project. Install it first if you
// want to run this:
//
//   npm i -D playwright && npx playwright install chromium
//   npm run smoke

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
const stop = (code) => {
  server.kill();
  process.exit(code);
};
await new Promise((r) => setTimeout(r, 800));

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack || ''}`));

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.millsim, null, { timeout: 20000 });

  // Example 0 is the demo bracket: four tools, a pocket, a chamfer and holes.
  // The example picker lives in the Program section's ribbon row.
  await page.click('.ribbon .segmented button:has-text("Program")');
  await page.waitForSelector('.actions select');
  await page.selectOption('.actions select', '0');
  await page.waitForFunction(() => window.millsim.state.program?.stats.moveCount > 100, null, { timeout: 20000 });
  await page.evaluate(() => window.millsim.runToEnd());
  await page.waitForFunction(() => window.millsim.state.seekTarget === null, null, { timeout: 180000 });

  const result = await page.evaluate(() => ({
    finished: window.millsim.simulator.finished,
    removed: window.millsim.simulator.removedVolume,
    collisions: window.millsim.simulator.collisions.length,
  }));

  console.log('bracket example:', JSON.stringify(result));
  if (!result.finished) throw new Error('program did not finish');
  if (!(result.removed > 20000)) throw new Error(`expected material to be removed, got ${result.removed} mm3`);
  if (result.collisions !== 0) throw new Error(`clean program reported ${result.collisions} collisions`);

  // The crash example must report every mistake it contains.
  await page.selectOption('.actions select', '3');
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.millsim.runToEnd());
  await page.waitForFunction(() => window.millsim.state.seekTarget === null, null, { timeout: 120000 });
  const kinds = await page.evaluate(() => [...new Set(window.millsim.simulator.collisions.map((c) => c.type))].sort());
  console.log('crash example detected:', kinds.join(', '));
  for (const expected of ['deep', 'rapid', 'spindle']) {
    if (!kinds.includes(expected)) throw new Error(`crash example did not report "${expected}"`);
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
  stop(1);
}
console.log('\nSmoke test passed.');
stop(0);
