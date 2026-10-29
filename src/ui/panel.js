// The shape every side panel has.
//
// A panel is one step of the job — the machine, the setup, the tools, the
// program, the results — and it holds that step's groups: Stock, Work
// offsets, Fixtures and so on, each a card with a header that opens and
// shuts it. Everything a step needs is on one scrolling column, so working
// on a fixture and then nudging the work offset is a scroll, not a trip
// through two menus. Which cards are open is remembered.
//
// A panel made `single` draws one group at a time with no headers, for the
// viewport's own pop-out panels.

import { el, clear, button, row, section } from './dom.js';
import { icon } from './icons.js';

const OPEN_KEY = 'millsim.groups';

function readOpen() {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') || {}; } catch { return {}; }
}

export class Panel {
  /**
   * @param {object} app
   * @param {Array<{id:string, label:string|Function, icon?:string, hint?:string,
   *                badge?:Function, summary?:Function, open?:boolean, when?:Function,
   *                fill?:boolean, render:() => (HTMLElement|Array|null)}>} groups
   * @param {{key?:string, single?:boolean}} [opts]
   */
  constructor(app, groups, opts = {}) {
    this.app = app;
    this.key = opts.key || this.constructor.name;
    this.single = !!opts.single;
    this.root = el(`div.panel${this.single ? '.panel-single' : ''}`);
    this.pageDefs = groups;
    /**
     * The group last worked in. Code that acts on "this page" — the tool
     * lists' selection, say — reads it, and it is set by drawing a group
     * and by any click inside one.
     */
    this.page = groups.length ? groups[0].id : null;
    const saved = readOpen()[this.key] || {};
    this.open = new Set(groups.filter((g) => (g.id in saved ? saved[g.id] : g.open !== false)).map((g) => g.id));
    this.groupNodes = new Map();
  }

  /** What the step bar needs: one line per group. */
  get pages() {
    return this.pageDefs.map((p) => ({
      id: p.id,
      label: typeof p.label === 'function' ? p.label() : p.label,
      icon: p.icon,
      hint: p.hint,
      badge: typeof p.badge === 'function' ? p.badge() : p.badge,
    }));
  }

  current() {
    return this.pageDefs.find((p) => p.id === this.page) || this.pageDefs[0] || null;
  }

  isOpen(id) {
    return this.single ? this.page === id : this.open.has(id);
  }

  /** Open or shut one group. */
  setOpen(id, on) {
    if (on) this.open.add(id);
    else this.open.delete(id);
    try {
      const all = readOpen();
      all[this.key] = Object.fromEntries(this.pageDefs.map((g) => [g.id, this.open.has(g.id)]));
      localStorage.setItem(OPEN_KEY, JSON.stringify(all));
    } catch { /* kept until reload */ }
    if (this.onToggle) this.onToggle(id, on);
  }

  /** Go to a group: open it, make it current and bring it into view. */
  setPage(id) {
    if (id && this.pageDefs.some((p) => p.id === id)) {
      this.page = id;
      if (!this.single && !this.open.has(id)) this.setOpen(id, true);
    }
    this.render();
    if (!this.single && id) {
      const node = this.groupNodes.get(id);
      if (node && node.scrollIntoView) requestAnimationFrame(() => node.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  }

  refresh() { this.render(); }

  /**
   * Draw the panel. Re-entrant calls are collapsed into one repaint: a
   * field's change handler can end up asking for a redraw while the panel
   * is still building, and removing nodes underneath the code that is
   * adding them is how you get a half-drawn panel.
   */
  render() {
    if (this.rendering) { this.queued = true; return; }
    this.rendering = true;
    const scroller = this.scroller || this.root;
    const scrollTop = scroller.scrollTop;
    const was = this.page;
    try {
      clear(this.root);
      this.groupNodes = new Map();
      if (this.single) {
        const page = this.current();
        if (page) for (const node of this.body(page)) this.root.appendChild(node);
      } else {
        if (this.header) { const h = this.header(); if (h) this.root.appendChild(h); }
        for (const g of this.pageDefs) {
          if (g.when && !g.when.call(this)) continue;
          const node = this.groupNode(g);
          this.groupNodes.set(g.id, node);
          this.root.appendChild(node);
        }
        if (this.footer) { const f = this.footer(); if (f) this.root.appendChild(f); }
      }
    } finally {
      this.page = was;
      scroller.scrollTop = scrollTop;
      this.rendering = false;
    }
    if (this.queued) { this.queued = false; this.render(); }
  }

  /** Draw one group again, leaving the rest alone. */
  renderGroup(id) {
    if (this.single) { if (this.page === id) this.render(); return; }
    const old = this.groupNodes.get(id);
    const g = this.pageDefs.find((p) => p.id === id);
    if (!old || !g || this.rendering) { this.render(); return; }
    this.rendering = true;
    const was = this.page;
    try {
      const node = this.groupNode(g);
      old.replaceWith(node);
      this.groupNodes.set(id, node);
    } finally {
      this.page = was;
      this.rendering = false;
    }
    if (this.queued) { this.queued = false; this.render(); }
  }

  /** A group's contents, drawn as the current page. */
  body(g) {
    this.page = g.id;
    // A group may return one node, a list, or a list of lists — a section
    // builder that grew a second section should not have to care.
    return [g.render.call(this)].flat(4).filter(Boolean);
  }

  groupNode(g) {
    const open = this.open.has(g.id);
    const label = typeof g.label === 'function' ? g.label() : g.label;
    const badge = typeof g.badge === 'function' ? g.badge() : g.badge;
    const summary = typeof g.summary === 'function' ? g.summary.call(this) : g.summary;
    const toggle = () => {
      this.setOpen(g.id, !this.open.has(g.id));
      if (this.open.has(g.id)) this.page = g.id;
      this.renderGroup(g.id);
    };
    // Not a <button>: the card's help button sits in it.
    const head = el('div.group-head', {
      role: 'button',
      tabindex: '0',
      'aria-expanded': open ? 'true' : 'false',
      title: g.hint || '',
      onclick: (e) => { if (!e.target.closest('button, input, select, label')) toggle(); },
      onkeydown: (e) => {
        if (e.target !== head || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        toggle();
      },
    }, [
      el('span.group-chevron', {}, icon('chevron', 14)),
      el('span.group-icon', {}, icon(g.icon || 'point', 16)),
      el('span.group-label', {}, label),
      badge != null && badge !== '' ? el('span.group-badge', {}, String(badge)) : null,
      el('span.group-summary', {}, open ? '' : (summary || '')),
    ]);
    const node = el(`section.group${open ? '.open' : ''}${g.fill ? '.group-fill' : ''}`, { dataset: { group: g.id } }, [head]);
    if (!open) return node;

    const body = el('div.group-body', {}, this.body(g));
    // Whatever is clicked in, that is the page now.
    body.addEventListener('pointerdown', () => { this.page = g.id; }, true);
    body.addEventListener('focusin', () => { this.page = g.id; });

    // A group holding one section of the same name needs no second title:
    // the section's heading goes, and its help button moves up to the card.
    const sections = [...body.children].filter((n) => n.classList.contains('section'));
    for (const s of sections) {
      const h = s.querySelector(':scope > .section-head');
      const title = h && h.children[1] ? h.children[1].textContent : '';
      if (sections.length === 1 && (title === label || title.startsWith(`${label} (`) || title.startsWith(`${label} ·`))) {
        s.classList.add('section-solo');
        const help = h.querySelector('.help-toggle');
        const aside = [...h.children].slice(2).filter((n) => n !== help);
        if (help) head.insertBefore(help, head.lastChild);
        for (const a of aside) head.insertBefore(a, head.lastChild);
      }
    }
    node.appendChild(body);
    return node;
  }
}

/**
 * The bar that opens a group's "new thing" window.
 *
 * Every group that holds a list of things the user can create gets one of
 * these at the top, and it always behaves the same way: one primary button
 * whose label names what will be created, and a window to fill in.
 */
export function addBar(label, onClick, opts = {}) {
  return el('div.add-bar', {}, [
    el('button.btn.btn-primary.add-btn', {
      type: 'button',
      onclick: onClick,
      disabled: !!opts.disabled,
      title: opts.hint || label,
    }, [icon('plus', 16), el('span', {}, label)]),
    opts.aside || null,
  ]);
}

/** A row of buttons that act on whatever the group has selected. */
export function actionRow(buttons) {
  const nodes = buttons.filter(Boolean).map((b) => button(b.label, b.onClick, {
    title: b.hint || b.label,
    disabled: b.disabled,
    variant: b.variant,
  }));
  return nodes.length ? row(nodes, 'action-row') : null;
}

export { section, row };
