// The shape every side panel has.
//
// A panel owns a set of pages; the ribbon shows their names and the panel
// draws one at a time. Keeping that in one place is what makes the rule
// enforceable rather than a convention people drift away from: a panel that
// declares a page has to draw it, and a control that is not on a page is
// not reachable, so nothing can quietly grow a second home in the ribbon.

import { el, clear, button, row, section } from './dom.js';
import { icon } from './icons.js';

export class Panel {
  /**
   * @param {object} app
   * @param {Array<{id:string, label:string, icon?:string, hint?:string,
   *                render:() => (HTMLElement|Array|null)}>} pages
   */
  constructor(app, pages) {
    this.app = app;
    this.root = el('div.panel');
    this.pageDefs = pages;
    this.page = pages.length ? pages[0].id : null;
  }

  /** What the ribbon needs to draw its page row. */
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

  setPage(id) {
    if (id && this.pageDefs.some((p) => p.id === id)) this.page = id;
    this.render();
  }

  refresh() { this.render(); }

  /**
   * Draw the current page. Re-entrant calls are collapsed into one repaint:
   * a field's change handler can end up asking for a redraw while the panel
   * is still building, and removing nodes underneath the code that is
   * adding them is how you get a half-drawn panel.
   */
  render() {
    if (this.rendering) { this.queued = true; return; }
    this.rendering = true;
    const scrollTop = this.root.scrollTop;
    const page = this.current();
    clear(this.root);
    if (page) {
      // A page may return one node, a list, or a list of lists — a section
      // builder that grew a second section should not have to care.
      const body = [page.render.call(this)].flat(4);
      for (const node of body) if (node) this.root.appendChild(node);
    }
    this.root.scrollTop = scrollTop;
    this.rendering = false;
    if (this.queued) { this.queued = false; this.render(); }
  }
}

/**
 * The bar that opens a page's "new thing" window.
 *
 * Every page that holds a list of things the user can create gets one of
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

/** A row of buttons that act on whatever the page has selected. */
export function actionRow(buttons) {
  const nodes = buttons.filter(Boolean).map((b) => button(b.label, b.onClick, {
    title: b.hint || b.label,
    disabled: b.disabled,
    variant: b.variant,
  }));
  return nodes.length ? row(nodes, 'action-row') : null;
}

export { section, row };
