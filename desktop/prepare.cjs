// Put the page the desktop program shows next to it.
//
// The desktop runs the same single file the browser build makes, so this
// builds it (scripts/build-standalone.mjs, which needs esbuild) and copies
// it into app/, which is what gets packaged.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
execSync('node scripts/build-standalone.mjs', { cwd: root, stdio: 'inherit' });

const from = path.join(root, 'dist', 'mill-sim.html');
const to = path.join(__dirname, 'app', 'mill-sim.html');
fs.mkdirSync(path.dirname(to), { recursive: true });
fs.copyFileSync(from, to);
console.log(`Copied the page to ${path.relative(root, to)}`);
