// The desktop's few calls, handed to the page as window.millsimDesktop.
//
// The page is the same one the browser runs; it checks for this object and
// keeps its machines in the machines folder when it finds it, and goes on
// downloading zips when it does not.

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('millsimDesktop', {
  platform: process.platform,
  version: call('app:version'),
  machines: {
    folder: call('machines:folder'),
    chooseFolder: call('machines:chooseFolder'),
    reveal: call('machines:reveal'),
    list: call('machines:list'),
    fileName: call('machines:fileName'),
    exists: call('machines:exists'),
    save: call('machines:save'),
    read: call('machines:read'),
    remove: call('machines:remove'),
    last: call('machines:last'),
    setLast: call('machines:setLast'),
  },
});
