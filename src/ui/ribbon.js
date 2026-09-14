// The ribbon: navigation, and nothing else.
//
// Tabs across the top, and under the active tab a row of pages. Clicking a
// page changes what the side panel shows — it never *does* anything. That
// is the whole rule, and it is what makes the window easy to read: the top
// says where you are, the side panel says what is there and lets you change
// it, and anything that has to be created from scratch opens its own
// window. A control that acts belongs in the panel next to the thing it
// acts on, so nothing is ever in two places.
//
// A tab is `{ id, label, pages }`; a page is `{ id, label, icon, hint }`.

import { el, clear } from './dom.js';
import { icon } from './icons.js';

export class Ribbon {
  constructor() {
    this.tabsRow = el('div.ribbon-tabs', { role: 'tablist' });
    this.band = el('div.ribbon-band', { role: 'tablist' });
    this.root = el('div.ribbon-root', {}, [this.tabsRow, this.band]);
    this.tabs = [];
    this.active = null;
    this.activePage = null;
    this.collapsed = false;
  }

  /** @param {Array<{id:string, label:string, pages:Array}>} tabs */
  setTabs(tabs) {
    this.tabs = tabs;
    if (!this.active || !tabs.some((t) => t.id === this.active)) {
      this.active = tabs.length ? tabs[0].id : null;
    }
    this.renderTabs();
    this.renderBand();
  }

  /** @param {(tabId:string, pageId:string) => void} fn */
  onNavigate(fn) { this.navigateHandler = fn; }

  /** Show a tab and one of its pages as current. */
  setActive(tabId, pageId) {
    this.active = tabId;
    this.activePage = pageId;
    this.renderTabs();
    this.renderBand();
  }

  currentTab() {
    return this.tabs.find((t) => t.id === this.active) || null;
  }

  /**
   * Tabs are built once and then only re-marked. Rebuilding them on every
   * click destroys the button the click landed on, which loses focus, makes
   * the row flicker, and leaves anything driving the UI chasing a node that
   * no longer exists.
   */
  renderTabs() {
    const ids = this.tabs.map((t) => t.id).join('|');
    if (this.tabIds !== ids) {
      this.tabIds = ids;
      clear(this.tabsRow);
      this.tabNodes = new Map();
      for (const tab of this.tabs) {
        const node = el('button.ribbon-tab', {
          type: 'button',
          role: 'tab',
          dataset: { tab: tab.id },
          onclick: () => this.go(tab.id, null),
          ondblclick: () => this.setCollapsed(!this.collapsed),
        }, tab.label);
        this.tabNodes.set(tab.id, node);
        this.tabsRow.appendChild(node);
      }
      this.tabsRow.appendChild(el('div.spacer'));
      this.collapseBtn = el('button.ribbon-collapse', {
        type: 'button',
        onclick: () => this.setCollapsed(!this.collapsed),
      });
      this.tabsRow.appendChild(this.collapseBtn);
    }

    for (const [id, node] of this.tabNodes) {
      const on = id === this.active;
      node.classList.toggle('active', on);
      node.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (this.collapseBtn) {
      this.collapseBtn.textContent = this.collapsed ? '⌄' : '⌃';
      this.collapseBtn.title = this.collapsed ? 'Show the pages' : 'Collapse the pages';
    }
  }

  /** The same, for the page row: rebuilt only when the pages themselves change. */
  renderBand() {
    const tab = this.currentTab();
    const pages = (tab && tab.pages) || [];
    // The label is part of the key, not just the id: a page that names
    // what it is showing changes its label without changing its identity,
    // and a row rebuilt only on identity would keep the old name.
    const key = `${this.active}#${pages.map((p) => `${p.id}:${p.label}:${p.badge ?? ''}`).join('|')}`;
    if (this.bandKey !== key) {
      this.bandKey = key;
      clear(this.band);
      this.pageNodes = new Map();
      for (const page of pages) {
        const node = el('button.ribbon-page', {
          type: 'button',
          role: 'tab',
          dataset: { page: page.id },
          title: page.hint || page.label,
          onclick: () => this.go(tab.id, page.id),
        }, [
          icon(page.icon || 'point', 22),
          el('span.ribbon-page-label', {}, page.label),
          // A count belongs on the page that holds the things it counts, so
          // the ribbon can say how many without offering to change anything.
          page.badge ? el('span.ribbon-page-badge', {}, String(page.badge)) : null,
        ]);
        this.pageNodes.set(page.id, node);
        this.band.appendChild(node);
      }
    }

    for (const [id, node] of this.pageNodes || []) {
      const on = id === this.activePage;
      node.classList.toggle('active', on);
      node.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  go(tabId, pageId) {
    if (this.collapsed) this.setCollapsed(false);
    if (this.navigateHandler) this.navigateHandler(tabId, pageId);
  }

  setCollapsed(on) {
    this.collapsed = on;
    this.band.classList.toggle('collapsed', on);
    this.renderTabs();
  }
}
