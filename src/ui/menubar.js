// A real menu bar.
//
// Behaves the way a desktop menu bar does: click a title to open it, then
// slide sideways to open its neighbours without clicking again, click
// anywhere else or press Escape to dismiss. Items can carry a shortcut
// hint, a checkmark for a toggle, a dot for the selected option in a group,
// and can be disabled with a reason.

import { el, clear } from './dom.js';

export class MenuBar {
  constructor() {
    this.root = el('nav.menubar', { role: 'menubar' });
    this.menus = [];
    this.open = null;
    this.armed = false;      // a menu is open, so hovering a title switches

    this.onDocPointerDown = (e) => {
      if (!this.root.contains(e.target) && !(this.panel && this.panel.contains(e.target))) this.close();
    };
    this.onKey = (e) => {
      if (e.key === 'Escape' && this.open) {
        e.preventDefault();
        this.close();
      }
    };
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('keydown', this.onKey);
  }

  /**
   * @param {Array<{label:string, items:() => Array}>} menus
   *   Each item is `{ label, onSelect, shortcut, checked, dot, disabled,
   *   hint }`, or `{ separator: true }`, or `{ heading: 'text' }`.
   */
  setMenus(menus) {
    this.menus = menus;
    this.render();
  }

  render() {
    const wasOpen = this.open;
    clear(this.root);
    this.titles = [];
    this.menus.forEach((menu, i) => {
      const title = el('button.menu-title', {
        type: 'button',
        'aria-haspopup': 'true',
        onclick: (e) => {
          e.stopPropagation();
          if (this.open === i) this.close();
          else this.openMenu(i);
        },
        onpointerenter: () => {
          if (this.armed && this.open !== null && this.open !== i) this.openMenu(i);
        },
      }, menu.label);
      this.titles.push(title);
      this.root.appendChild(title);
    });
    if (wasOpen !== null && wasOpen < this.menus.length) this.openMenu(wasOpen);
  }

  openMenu(index) {
    this.closePanel();
    this.open = index;
    this.armed = true;
    this.titles.forEach((t, i) => t.classList.toggle('open', i === index));

    const menu = this.menus[index];
    const panel = el('div.menu-panel', { role: 'menu' });
    for (const item of menu.items()) {
      if (item.separator) {
        panel.appendChild(el('div.menu-sep'));
        continue;
      }
      if (item.heading) {
        panel.appendChild(el('div.menu-heading', {}, item.heading));
        continue;
      }
      const row = el(`button.menu-item${item.disabled ? '.disabled' : ''}`, {
        type: 'button',
        role: 'menuitem',
        disabled: !!item.disabled,
        title: item.hint || '',
        onclick: () => {
          if (item.disabled) return;
          this.close();
          item.onSelect();
        },
      }, [
        el('span.menu-mark', {}, item.checked ? '✓' : item.dot ? '•' : ''),
        el('span.menu-label', {}, item.label),
        item.shortcut ? el('span.menu-shortcut', {}, item.shortcut) : null,
      ]);
      panel.appendChild(row);
    }

    const rect = this.titles[index].getBoundingClientRect();
    panel.style.left = `${Math.round(rect.left)}px`;
    panel.style.top = `${Math.round(rect.bottom + 4)}px`;
    document.body.appendChild(panel);
    this.panel = panel;

    // Keep the panel on screen when a menu sits near the right edge.
    const pr = panel.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) {
      panel.style.left = `${Math.round(window.innerWidth - pr.width - 8)}px`;
    }
  }

  closePanel() {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
  }

  close() {
    this.closePanel();
    this.open = null;
    this.armed = false;
    if (this.titles) this.titles.forEach((t) => t.classList.remove('open'));
  }

  dispose() {
    this.close();
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('keydown', this.onKey);
  }
}
