// A very small DOM helper. Not a framework — just enough to keep the panel
// code readable.

import * as units from '../core/units.js';

/**
 * @param {string} tag  'div.class#id' style selector
 * @param {object|null} props
 * @param {Array|string} [children]
 */
export function el(tag, props = null, children = []) {
  const [, name = 'div', rest = ''] = /^([a-zA-Z0-9-]*)(.*)$/.exec(tag) || [];
  const node = document.createElement(name || 'div');

  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) {
    if (m[1] === '.') node.classList.add(m[2]);
    else node.id = m[2];
  }

  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className += (node.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v);
  }

  append(node, children);
  return node;
}

export function append(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  // replaceChildren detaches everything in one step. removeChild in a loop
  // can throw when a blur handler fires mid-removal and re-renders the same
  // subtree, which is exactly what an edited number field does.
  if (node.replaceChildren) node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Which field units are lengths, and so follow the display unit.
 *
 * A caller says what the number *is* — millimetres, or millimetres a
 * minute — and this decides what to show. Everything above this line keeps
 * working in millimetres whichever way the switch is set, which is the
 * point: there is one set of numbers in the program, not two.
 */
const LENGTH_UNITS = new Set(['mm', 'mm/min']);

export function field(label, value, opts = {}) {
  /* eslint-disable-next-line no-param-reassign -- setValue keeps this in step */
  const lengthy = opts.type !== 'text' && LENGTH_UNITS.has(opts.unit);
  // Millimetres are shown exactly as they are held — rounding a number on
  // its way into the box it came out of is how precision is lost. Inches
  // are rounded to four places, which is a tenth of a thou and as fine as
  // anybody sets a machine.
  const shown = opts.unit === 'mm/min' ? 3 : 4;
  const show = (v) => {
    if (!lengthy || !Number.isFinite(v)) return v;
    const d = units.toDisplay(v);
    return units.isInch() || opts.unit === 'mm/min' ? Number(d.toFixed(shown)) : d;
  };
  /**
   * What was typed, as millimetres.
   *
   * A rounded inch turned back into millimetres is not the millimetre it
   * came from, so a box that is submitted without being edited hands back
   * exactly what it was given rather than a value two microns away from
   * it. Only a number somebody actually changed is converted.
   */
  let asShown = show(value);
  const store = (v) => {
    if (!lengthy || !Number.isFinite(v)) return v;
    if (Number.isFinite(asShown) && v === asShown) return value;
    return units.fromDisplay(v);
  };
  const unitText = !lengthy ? opts.unit
    : (opts.unit === 'mm/min' ? units.feedLabel() : units.lengthLabel());

  const input = el('input', {
    type: opts.type || 'number',
    value: show(value) ?? '',
    step: lengthy && Number.isFinite(opts.step) ? units.toStep(opts.step) : (opts.step ?? 'any'),
    min: Number.isFinite(opts.min) ? show(opts.min) : opts.min,
    max: Number.isFinite(opts.max) ? show(opts.max) : opts.max,
    disabled: opts.disabled,
    title: opts.title || '',
    oninput: (e) => {
      if (!opts.onInput) return;
      const raw = e.target.value;
      opts.onInput(opts.type === 'text' ? raw : raw === '' ? null : store(parseFloat(raw)), e);
    },
    onchange: (e) => opts.onChange && opts.onChange(opts.type === 'text' ? e.target.value : store(parseFloat(e.target.value)), e),
  });
  const wrap = el('label.field', { title: opts.title || '' }, [
    label ? el('span.field-label', {}, [label, unitText ? el('span.unit', {}, ` ${unitText}`) : null]) : null,
    input,
  ]);
  wrap.input = input;
  /**
   * Put a value in from outside, in millimetres like everything else.
   *
   * Panels that write straight to `field.input.value` are handing the box
   * a raw number, which in inch mode is the wrong one. This is the way in.
   */
  wrap.setValue = (v) => {
    value = v;
    asShown = show(v);
    input.value = asShown ?? '';
  };
  return wrap;
}

export function select(label, options, value, onChange, opts = {}) {
  const sel = el('select', {
    disabled: opts.disabled,
    onchange: (e) => onChange(e.target.value, e),
  });
  for (const o of options) {
    const option = el('option', { value: o.value, selected: String(o.value) === String(value) }, o.label);
    sel.appendChild(option);
  }
  const wrap = el('label.field', { title: opts.title || '' }, [
    label ? el('span.field-label', {}, label) : null,
    sel,
  ]);
  wrap.input = sel;
  return wrap;
}

export function checkbox(label, checked, onChange, opts = {}) {
  const input = el('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onChange(e.target.checked, e) });
  const wrap = el('label.checkbox', { title: opts.title || '' }, [input, el('span', {}, label)]);
  wrap.input = input;
  return wrap;
}

export function button(label, onClick, opts = {}) {
  return el(`button.btn${opts.variant ? `.btn-${opts.variant}` : ''}`, {
    onclick: onClick,
    title: opts.title || '',
    disabled: opts.disabled,
    type: 'button',
  }, label);
}

export function row(children, cls = '') {
  return el(`div.row${cls ? `.${cls}` : ''}`, {}, children);
}

export function section(title, children, opts = {}) {
  const body = el('div.section-body', {}, children);
  const head = el('div.section-head', {
    onclick: () => {
      body.classList.toggle('collapsed');
      head.classList.toggle('collapsed');
    },
  }, [el('span.caret', {}, '▾'), el('span', {}, title), opts.aside || null]);
  if (opts.collapsed) {
    body.classList.add('collapsed');
    head.classList.add('collapsed');
  }
  const node = el('div.section', {}, [head, body]);
  node.body = body;
  return node;
}

/** Trigger a browser download for a Blob or string. */
export function download(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Open a file picker and resolve with the chosen files. */
export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
