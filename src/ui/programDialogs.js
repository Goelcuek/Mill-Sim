// The window that names a subprogram.
//
// A subprogram is a file, and a file has a name. Fanuc happens to count its
// programs — O1000, called with M98 P1000 — and a shop that works that way
// can carry on doing so, but that is one control's convention rather than
// what a subprogram *is*: on most others the file is called by the name it
// is saved under. So the name is asked for first and the number is optional.

import { el, field, select, row } from './dom.js';
import { Dialog } from './dialog.js';
import { resolveDialect, FLAVOUR_DIALECT } from '../gcode/dialects.js';

/** The dialect the machine in front of us reads. */
export function machineDialect(app) {
  const c = (app.state.machine && app.state.machine.controller) || {};
  return resolveDialect(c.dialect || FLAVOUR_DIALECT[c.flavour] || 'fanuc', c.syntax);
}

/** How a program on this control calls a file with this name and number. */
export function callLine(dialect, { name, number }) {
  if (number) return `M98 P${number}`;
  const word = dialect.call && dialect.call.program && dialect.call.program.length > 1
    ? dialect.call.program : null;
  return word ? `${word} "${name}"` : `M98 <${name}>`;
}

/** An empty file, written the way this control writes one. */
function seed(dialect, { name, number }) {
  const remark = dialect.parenComments ? `(${name})` : `${(dialect.lineComments || [';'])[0]} ${name}`;
  const ret = (dialect.call && dialect.call.ret) || 'M99';
  return `${number ? `O${number}\n` : ''}${remark}\n\n${ret}\n`;
}

/** A name nothing else in the list has. */
function freeName(taken, base) {
  const used = new Set(taken.map((n) => String(n).toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  const stem = base.replace(/\.[^.]+$/, '');
  const ext = base.slice(stem.length);
  let n = 2;
  while (used.has(`${stem}-${n}${ext}`.toLowerCase())) n += 1;
  return `${stem}-${n}${ext}`;
}

/** A number nothing else in the list has declared. */
function freeNumber(taken, from) {
  const used = new Set(taken.filter((n) => Number.isFinite(n)));
  let n = from;
  while (used.has(n)) n += 1;
  return n;
}

/**
 * Ask for a new subprogram: what it is called, and how a program calls it.
 *
 * @param {object} app
 * @param {object} opts
 * @param {string} opts.subtitle          what this list is
 * @param {string[]} opts.names           the names already in it
 * @param {number[]} opts.numbers         the O numbers already in it
 * @param {number} opts.from              where to start looking for a free number
 * @param {(file:{name:string, text:string}) => void} opts.onCreate
 */
export function openNewSubprogramDialog(app, opts) {
  const dialect = machineDialect(app);
  const state = {
    name: freeName(opts.names || [], opts.defaultName || 'subprogram.nc'),
    by: 'name',
    number: freeNumber(opts.numbers || [], opts.from || 1000),
  };

  const numberField = field('O number', state.number, {
    step: 1,
    min: 1,
    onChange: (v) => { state.number = Math.max(1, Math.round(v) || 1); draw(); },
    title: 'The number written at the top of the file, which is what M98 P asks for',
  });
  const preview = el('div.chain-preview');
  const form = el('div.dialog-form');

  const draw = () => {
    numberField.hidden = state.by !== 'number';
    preview.replaceChildren(
      el('span', {}, 'Called with '),
      el('b', {}, callLine(dialect, { name: state.name, number: state.by === 'number' ? state.number : 0 })),
    );
  };

  form.append(
    field('Name', state.name, {
      type: 'text',
      onInput: (v) => { state.name = v; draw(); },
      title: 'Whatever you would call the file on the control',
    }),
    row([
      select('Called by', [
        { value: 'name', label: 'Its name' },
        { value: 'number', label: 'Its O number' },
      ], state.by, (v) => { state.by = v; draw(); },
        { title: 'How the main program asks for it' }),
      numberField,
    ]),
    preview,
    el('div.hint', {}, `A file answers to both, so this only decides what is written into it to start with. ${dialect.name} is what this machine reads; a file called by name is found by that name whether or not it also carries a number.`),
  );

  const dialog = new Dialog({
    title: opts.title || 'New subprogram',
    subtitle: opts.subtitle || 'A file this program can call',
    width: 460,
    body: form,
    confirm: 'Create',
    onConfirm: () => {
      const name = (state.name || '').trim() || freeName(opts.names || [], 'subprogram.nc');
      const number = state.by === 'number' ? state.number : 0;
      opts.onCreate({ name, text: seed(dialect, { name, number }) });
      return true;
    },
  });
  draw();
  dialog.open();
  return dialog;
}
