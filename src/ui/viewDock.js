// The viewport's own toolbar: how the job is looked at, from every step.
//
// Looking is not a step of the job. A section through the part is as
// useful while placing a clamp as it is while reading the findings, so the
// views, the display switches, the section plane and the measuring tools
// sit on the viewport itself — a column of buttons down its right-hand
// edge, each opening a small panel beside it — rather than on a tab that
// takes the side panel away from whatever was being done.

import { el } from './dom.js';
import { icon } from './icons.js';

const TOOLS = [
  { id: 'fit', icon: 'fit', title: 'Fit the job in the view (F)' },
  { id: 'camera', icon: 'view', title: 'Views' },
  { id: 'show', icon: 'eye', title: 'Display' },
  { id: 'inspect', icon: 'section', title: 'Section and backplot' },
  { id: 'measure', icon: 'ruler', title: 'Measure' },
  { id: 'shot', icon: 'camera', title: 'Save a screenshot' },
];

export class ViewDock {
  /**
   * @param {object} app
   * @param {HTMLElement} host the viewport
   * @param {import('./viewPanel.js').ViewPanel} panel
   */
  constructor(app, host, panel) {
    this.app = app;
    this.panel = panel;
    this.openId = null;
    this.buttons = new Map();
    this.strip = el('div.view-dock', { role: 'toolbar', 'aria-label': 'View' });
    for (const t of TOOLS) {
      const b = el('button.dock-btn', {
        type: 'button',
        title: t.title,
        'aria-label': t.title,
        dataset: { tool: t.id },
        onclick: () => this.press(t.id),
      }, icon(t.icon, 18));
      this.buttons.set(t.id, b);
      this.strip.appendChild(b);
      if (t.id === 'fit' || t.id === 'measure') this.strip.appendChild(el('div.dock-sep'));
    }
    this.title = el('div.pop-title');
    this.pop = el('div.view-pop', { role: 'dialog' }, [
      el('div.pop-head', {}, [
        this.title,
        el('button.icon-btn', { type: 'button', title: 'Close', onclick: () => this.close() }, icon('close', 15)),
      ]),
      el('div.pop-body', {}, [panel.root]),
    ]);
    this.pop.hidden = true;
    // Clicks in the pop-out stay in it: the viewport behind is not picked.
    this.pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.strip.addEventListener('pointerdown', (e) => e.stopPropagation());
    host.appendChild(this.strip);
    host.appendChild(this.pop);
  }

  press(id) {
    if (id === 'fit') { this.app.fitToScene(); return; }
    if (id === 'shot') { this.app.saveScreenshot(); return; }
    if (this.openId === id) this.close();
    else this.open(id);
  }

  /** Show one of the view panel's pages beside the toolbar. */
  open(id) {
    const page = this.panel.pageDefs.find((p) => p.id === id);
    if (!page) return;
    this.openId = id;
    this.title.textContent = page.label;
    this.panel.setPage(id);
    this.pop.hidden = false;
    for (const [k, b] of this.buttons) b.classList.toggle('active', k === id);
  }

  close() {
    this.openId = null;
    this.pop.hidden = true;
    for (const b of this.buttons.values()) b.classList.remove('active');
  }

  get isOpen() { return this.openId !== null; }

  refresh() {
    if (this.openId) this.panel.render();
  }
}
