// The machines folder, on the desktop.
//
// In a browser a machine leaves as a download and comes back through a
// file picker, and where it went is the browser's business. The desktop
// program keeps them in one folder instead, so saving asks only for a name
// and loading is a list of what is there. Everything here goes through
// window.millsimDesktop; none of it is shown in a browser.

import { el, field, button } from './dom.js';
import { Dialog, confirmDialog } from './dialog.js';

const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Name the machine and put it in the folder, asking before replacing one. */
export async function openMachineSaveDialog(app) {
  const desk = app.desktop.machines;
  const folder = await desk.folder();
  const kin = app.machineView.kinematics;
  let name = app.machineFile ? app.machineFile.replace(/\.(zip|json)$/i, '') : (kin.name || 'Machine');
  const error = el('div.inline-warning', { style: { display: 'none' } });

  const save = async () => {
    error.style.display = 'none';
    let file;
    try {
      file = await desk.fileName(name);
    } catch (err) {
      error.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      error.style.display = '';
      return;
    }
    const write = async () => {
      if (await app.saveMachineToFolder(name)) dlg.close(true);
    };
    if (await desk.exists(file)) {
      confirmDialog({
        title: `Replace ${file}?`,
        message: `There is already a machine called ${file} in the machines folder. Saving puts this one in its place; the old one is gone.`,
        confirm: 'Replace',
        danger: true,
        onConfirm: () => { write(); },
      });
      return;
    }
    await write();
  };

  const dlg = new Dialog({
    title: 'Save machine',
    subtitle: 'Into the machines folder, where Load machine finds it',
    width: 460,
    body: [
      field('Name', name, { type: 'text', onChange: (v) => { name = v; } }),
      el('div.hint', {}, ['Saved to ', el('b', {}, folder), '. The file is the same zip a browser downloads: machine.json, the macros and every body as STL.']),
      error,
    ],
    confirm: 'Save',
    onConfirm: () => { save(); return false; },
  });
  dlg.open();
  return dlg;
}

/** What is in the folder, to load one, throw one away, or go elsewhere. */
export async function openMachineLibrary(app) {
  const desk = app.desktop.machines;
  const list = el('div.list.machine-library');
  const where = el('div.hint');

  const draw = async () => {
    const [folder, machines] = await Promise.all([desk.folder(), desk.list()]);
    where.replaceChildren('Machines are kept in ', el('b', {}, folder), '.');
    list.replaceChildren();
    if (!machines.length) {
      list.appendChild(el('div.hint', {}, 'Nothing saved here yet. Save machine puts the machine you have now in this folder, and it is listed here from then on.'));
      return;
    }
    for (const m of machines) {
      const current = app.machineFile === m.file;
      list.appendChild(el(`div.list-item${current ? '.selected' : ''}`, {
        title: m.file,
        ondblclick: () => load(m.file),
      }, [
        el('div.list-main', {}, [
          el('div.list-title', {}, [m.name, current ? el('span.hint', {}, 'open now') : null]),
          el('div.list-sub', {}, `${when(m.modified)} · ${size(m.size)}`),
        ]),
        el('div.list-actions', {}, [
          button('Load', () => load(m.file), { variant: 'primary' }),
          button('Delete', () => confirmDialog({
            title: `Delete ${m.file}?`,
            message: 'It goes to the Recycle Bin, so it can be got back from there.',
            confirm: 'Delete',
            danger: true,
            onConfirm: () => {
              desk.remove(m.file)
                .then(() => { if (app.machineFile === m.file) app.setMachineFile(null); return draw(); })
                .catch((err) => app.notify(`Could not delete ${m.file}: ${err.message}`, 'error'));
            },
          })),
        ]),
      ]));
    }
  };

  const load = async (file) => {
    if (await app.loadMachineFromFolder(file)) dlg.close(true);
  };

  const dlg = new Dialog({
    title: 'Load machine',
    subtitle: 'From the machines folder',
    width: 560,
    body: [where, list],
    cancel: 'Close',
    extra: [
      button('Other file…', () => { dlg.close(); app.importMachineFile(); }),
      button('Open folder', () => desk.reveal().catch((err) => app.notify(`Could not open the folder: ${err.message}`, 'error'))),
      button('Change folder…', async () => {
        if (await desk.chooseFolder()) {
          app.setMachineFile(null);
          await draw();
        }
      }),
    ],
  });
  dlg.open();
  await draw();
  return dlg;
}
