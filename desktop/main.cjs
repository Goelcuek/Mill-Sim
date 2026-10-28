// Mill-Sim as a desktop program.
//
// The page is the same single file the browser build makes; what the
// desktop adds is a place on disk. A browser can only hand a machine out as
// a download and take it back through a file picker, so every machine lived
// wherever the downloads went. Here they go to one folder — Documents\
// Mill-Sim\Machines unless somebody picks another — and the program lists
// that folder when asked to load, and opens the last one used on start.
//
// The page never touches the file system itself. It asks through the few
// calls in preload.cjs, and every name it passes is cut back to a file name
// inside the machines folder before anything is read or written.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MACHINE_EXT = /\.(zip|json)$/i;

// ---- settings ---------------------------------------------------------------
//
// One small JSON file in the program's own data folder: where the machines
// go, which one was open last, and how big the window was.

let settings = {};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {};
  } catch {
    settings = {};
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not write settings:', err);
  }
}

const defaultMachinesDir = () => path.join(app.getPath('documents'), 'Mill-Sim', 'Machines');
const machinesDir = () => settings.machinesDir || defaultMachinesDir();

/** A name from the page, as a file inside the machines folder — never a path. */
function inFolder(name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..' || !MACHINE_EXT.test(base)) {
    throw new Error(`"${name}" is not a machine file name.`);
  }
  return path.join(machinesDir(), base);
}

/** What somebody typed, made into a file name Windows will take. */
function fileNameFor(name) {
  const stem = String(name || '')
    .replace(/\.zip$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!stem) throw new Error('The machine needs a name.');
  // CON, PRN, AUX, NUL, COM1… are devices on Windows, not files.
  const safe = /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `${stem}-machine` : stem;
  return `${safe}.zip`;
}

// ---- what the page can ask for ----------------------------------------------

ipcMain.handle('machines:folder', () => machinesDir());

ipcMain.handle('machines:list', async () => {
  const dir = machinesDir();
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names.filter((n) => MACHINE_EXT.test(n))) {
    try {
      const st = await fsp.stat(path.join(dir, file));
      if (st.isFile()) out.push({ file, name: file.replace(MACHINE_EXT, ''), modified: st.mtimeMs, size: st.size });
    } catch { /* gone between the listing and the look */ }
  }
  return out.sort((a, b) => b.modified - a.modified);
});

ipcMain.handle('machines:fileName', (_e, name) => fileNameFor(name));

ipcMain.handle('machines:exists', (_e, file) => fs.existsSync(inFolder(file)));

ipcMain.handle('machines:save', async (_e, name, bytes) => {
  const file = fileNameFor(name);
  const full = inFolder(file);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  // Written beside and renamed over, so a crash half way leaves the old
  // machine rather than half of the new one.
  const temp = `${full}.saving`;
  await fsp.writeFile(temp, Buffer.from(bytes));
  await fsp.rename(temp, full);
  return { file, path: full };
});

ipcMain.handle('machines:read', async (_e, file) => {
  const data = await fsp.readFile(inFolder(file));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
});

ipcMain.handle('machines:remove', async (_e, file) => {
  await shell.trashItem(inFolder(file));
  return true;
});

ipcMain.handle('machines:reveal', async () => {
  await fsp.mkdir(machinesDir(), { recursive: true });
  const err = await shell.openPath(machinesDir());
  if (err) throw new Error(err);
  return true;
});

ipcMain.handle('machines:chooseFolder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Where Mill-Sim keeps its machines',
    defaultPath: machinesDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  settings.machinesDir = res.filePaths[0];
  // The last machine was a file in the old folder.
  settings.lastMachine = null;
  saveSettings();
  return settings.machinesDir;
});

ipcMain.handle('machines:last', () => {
  const file = settings.lastMachine;
  if (!file) return null;
  try {
    return fs.existsSync(inFolder(file)) ? file : null;
  } catch {
    return null;
  }
});

ipcMain.handle('machines:setLast', (_e, file) => {
  settings.lastMachine = file ? path.basename(String(file)) : null;
  saveSettings();
  return true;
});

ipcMain.handle('app:version', () => app.getVersion());

// ---- the window ---------------------------------------------------------------

function pagePath() {
  // Packaged, the page sits next to this file; run from the repository,
  // it is whatever `npm run build` last wrote.
  const packaged = path.join(__dirname, 'app', 'mill-sim.html');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'dist', 'mill-sim.html');
}

let win = null;

function createWindow() {
  const bounds = settings.window || {};
  win = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#171b24',
    title: 'Mill-Sim',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // Links out of the page go to the browser, not to a second Mill-Sim.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('close', () => {
    settings.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    saveSettings();
  });
  win.on('closed', () => { win = null; });

  win.loadFile(pagePath());
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open machines folder', click: () => { fs.mkdirSync(machinesDir(), { recursive: true }); shell.openPath(machinesDir()); } },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Mill-Sim',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'About Mill-Sim',
            message: `Mill-Sim ${app.getVersion()}`,
            detail: `CNC mill simulator.\n\nMachines are kept in:\n${machinesDir()}\n\nSettings:\n${settingsFile()}`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One Mill-Sim at a time: a second start brings the first one forward
// rather than racing it for the settings file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    loadSettings();
    buildMenu();
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
