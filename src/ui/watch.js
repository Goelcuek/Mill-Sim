// The variables someone has asked to keep an eye on.
//
// Pinned on Program › Variables, shown on the readout over the viewport.
// They are kept by name in this browser, so R1 and DEPTH stay pinned from
// one program to the next — a shop's programs use the same few names, and
// pinning them again on every file is a chore nobody does twice.

const KEY = 'millsim.watch';

export function loadWatch() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return new Set(Array.isArray(list) ? list.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveWatch(keys) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...keys]));
  } catch {
    // A private window or blocked storage: the pins last until the page goes.
  }
}
