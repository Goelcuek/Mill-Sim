// The desktop program end to end, on whatever OS this runs on: save a
// machine into the machines folder, see it listed, load it back through
// the Load window, and find it open again after a restart.
//
//   npm i --no-save playwright   (or have it installed globally)
//   xvfb-run node test/desktop.smoke.cjs     (Linux, no display)

const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const here = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'millsim-desktop-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

async function launch() {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [here, '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    env,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (err) => failures.push(`page error: ${err.message}`));
  await page.waitForFunction(() => window.millsim && window.millsim.machineView, null, { timeout: 60000 });
  return { app, page };
}

(async () => {
  let { app, page } = await launch();
  check(await page.evaluate(() => !!window.millsimDesktop && !!window.millsim.desktop), 'the page sees the desktop calls');
  const folder = await page.evaluate(() => window.millsimDesktop.machines.folder());
  // Documents on Windows; a Linux box without one falls back to home.
  check(folder.startsWith(home) && folder.endsWith(path.join('Mill-Sim', 'Machines')), `machines folder is …/Mill-Sim/Machines in the user's documents: ${folder}`);

  // A trunnion, saved under a name through the Save window.
  await page.evaluate(() => window.millsim.newMachine('Shop trunnion', 'siemens', 'tableTable'));
  await page.evaluate(() => window.millsim.exportMachine());
  const nameBox = page.locator('.dialog input[type=text]').first();
  await nameBox.waitFor();
  await nameBox.fill('Shop trunnion');
  await nameBox.dispatchEvent('change');
  await page.locator('.dialog-footer .btn-primary').click();
  const saved = path.join(folder, 'Shop trunnion.zip');
  await page.waitForFunction(() => window.millsim.machineFile === 'Shop trunnion.zip', null, { timeout: 15000 }).catch(() => {});
  check(fs.existsSync(saved), `Save machine wrote ${saved}`);

  // Something else on screen, then the Load window brings it back.
  await page.evaluate(() => window.millsim.newMachine('Other', 'fanuc', 'headTable'));
  check(await page.evaluate(() => window.millsim.machineFile) === null, 'a new machine is not the saved file');
  await page.evaluate(() => window.millsim.importMachine());
  const row = page.locator('.machine-library .list-item', { hasText: 'Shop trunnion' });
  await row.waitFor({ timeout: 10000 });
  check(await row.count() === 1, 'the Load window lists the saved machine');
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'load-window.png') });
  await row.locator('button', { hasText: 'Load' }).click({ force: true });
  await page.waitForFunction(() => window.millsim.machineFile === 'Shop trunnion.zip', null, { timeout: 15000 }).catch(() => {});
  const back = await page.evaluate(() => ({ name: window.millsim.machineView.kinematics.name, rot: window.millsim.machineView.kinematics.rotaries().map((n) => n.letter).join('') }));
  check(back.rot === 'AC', `loading it put the A/C trunnion back: ${JSON.stringify(back)}`);
  await app.close();

  // Start again: the same machine, without asking.
  ({ app, page } = await launch());
  await page.waitForFunction(() => window.millsim.machineFile === 'Shop trunnion.zip', null, { timeout: 20000 }).catch(() => {});
  const again = await page.evaluate(() => ({ file: window.millsim.machineFile, rot: window.millsim.machineView.kinematics.rotaries().map((n) => n.letter).join('') }));
  check(again.file === 'Shop trunnion.zip' && again.rot === 'AC', `after a restart the last machine is open: ${JSON.stringify(again)}`);

  // Names cannot reach outside the folder.
  const escape = await page.evaluate(() => window.millsimDesktop.machines.read('../../settings.json').then(() => 'read', (e) => e.message));
  check(escape !== 'read', 'a path out of the folder is refused');
  await app.close();

  fs.rmSync(home, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  console.log('\nDesktop smoke passed.');
})().catch((err) => { console.error(err); process.exit(1); });
