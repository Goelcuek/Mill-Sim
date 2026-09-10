// A very small DOM helper. Not a framework — just enough to keep the panel
// code readable.

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

/** Labelled number input that reports changes as numbers. */
export function field(label, value, opts = {}) {
  const input = el('input', {
    type: opts.type || 'number',
    value: value ?? '',
    step: opts.step ?? 'any',
    min: opts.min,
    max: opts.max,
    disabled: opts.disabled,
    title: opts.title || '',
    oninput: (e) => {
      if (!opts.onInput) return;
      const raw = e.target.value;
      opts.onInput(opts.type === 'text' ? raw : raw === '' ? null : parseFloat(raw), e);
    },
    onchange: (e) => opts.onChange && opts.onChange(opts.type === 'text' ? e.target.value : parseFloat(e.target.value), e),
  });
  const wrap = el('label.field', { title: opts.title || '' }, [
    el('span.field-label', {}, [label, opts.unit ? el('span.unit', {}, ` ${opts.unit}`) : null]),
    input,
  ]);
  wrap.input = input;
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
