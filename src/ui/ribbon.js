// An Office-style ribbon.
//
// Tabs across the top, and under the active tab a band of groups: each
// group is a cluster of controls with its name printed underneath, big
// buttons for the things you reach for most and stacked small ones for the
// rest. Everything the app can do is visible and one click away rather than
// hidden behind a menu.
//
// A group is `{ label, items }`. An item is one of:
//   { kind:'big',    icon, label, onClick, disabled, hint, active }
//   { kind:'small',  icon, label, onClick, disabled, hint, active }
//   { kind:'toggle', icon, label, checked, onChange, hint }
//   { kind:'select', label, options, value, onChange, width }
//   { kind:'number', label, value, onChange, unit, step, min, max, width }
//   { kind:'stack',  items }   up to three smalls in a column
//   { kind:'text',   label, value }

import { el, clear } from './dom.js';
import { icon } from './icons.js';

export class Ribbon {
  constructor() {
    this.tabsRow = el('div.ribbon-tabs', { role: 'tablist' });
    this.band = el('div.ribbon-band');
    this.root = el('div.ribbon-root', {}, [this.tabsRow, this.band]);
    this.tabs = [];
    this.active = null;
    this.collapsed = false;
  }

  /** @param {Array<{id:string, label:string, groups:() => Array}>} tabs */
  setTabs(tabs) {
    this.tabs = tabs;
    if (!this.active || !tabs.some((t) => t.id === this.active)) {
      this.active = tabs.length ? tabs[0].id : null;
    }
    this.renderTabs();
    this.renderBand();
  }

  onSelect(fn) { this.selectHandler = fn; }

  renderTabs() {
    clear(this.tabsRow);
    for (const tab of this.tabs) {
      const node = el(`button.ribbon-tab${tab.id === this.active ? '.active' : ''}`, {
        type: 'button',
        role: 'tab',
        dataset: { tab: tab.id },
        onclick: () => this.select(tab.id),
        ondblclick: () => this.setCollapsed(!this.collapsed),
      }, tab.label);
      this.tabsRow.appendChild(node);
    }
    this.tabsRow.appendChild(el('div.spacer'));
    this.tabsRow.appendChild(el('button.ribbon-collapse', {
      type: 'button',
      title: this.collapsed ? 'Show the ribbon' : 'Collapse the ribbon',
      onclick: () => this.setCollapsed(!this.collapsed),
    }, this.collapsed ? '⌄' : '⌃'));
  }

  select(id) {
    if (this.active === id && !this.collapsed) {
      this.renderBand();
      return;
    }
    this.active = id;
    if (this.collapsed) this.setCollapsed(false);
    this.renderTabs();
    this.renderBand();
    if (this.selectHandler) this.selectHandler(id);
  }

  setCollapsed(on) {
    this.collapsed = on;
    this.band.classList.toggle('collapsed', on);
    this.renderTabs();
  }

  /** Rebuild the band from the active tab's group factory. */
  renderBand() {
    clear(this.band);
    const tab = this.tabs.find((t) => t.id === this.active);
    if (!tab) return;
    const groups = tab.groups();
    groups.forEach((group, i) => {
      if (i > 0) this.band.appendChild(el('div.ribbon-divider'));
      this.band.appendChild(this.renderGroup(group));
    });
  }

  renderGroup(group) {
    const items = el('div.ribbon-items');
    for (const item of group.items) items.appendChild(this.renderItem(item));
    return el('div.ribbon-group', {}, [items, el('div.ribbon-group-label', {}, group.label)]);
  }

  renderItem(item) {
    switch (item.kind) {
      case 'stack':
        return el('div.ribbon-stack', {}, item.items.map((i) => this.renderItem({ ...i, kind: 'small' })));

      case 'small':
        return el(`button.ribbon-small${item.active ? '.active' : ''}`, {
          type: 'button',
          title: item.hint || item.label,
          disabled: !!item.disabled,
          onclick: item.onClick,
        }, [icon(item.icon || 'point', 16), el('span', {}, item.label)]);

      case 'toggle': {
        const node = el(`button.ribbon-small.toggle${item.checked ? '.on' : ''}`, {
          type: 'button',
          title: item.hint || item.label,
          'aria-pressed': item.checked ? 'true' : 'false',
          onclick: () => item.onChange(!item.checked),
        }, [icon(item.icon || 'eye', 16), el('span', {}, item.label)]);
        return node;
      }

      case 'select': {
        const sel = el('select', {
          style: item.width ? { width: `${item.width}px` } : null,
          onchange: (e) => item.onChange(e.target.value, e),
        }, item.options.map((o) => el('option', { value: o.value, selected: String(o.value) === String(item.value) }, o.label)));
        return el('label.ribbon-field', { title: item.hint || '' }, [
          el('span', {}, item.label),
          sel,
        ]);
      }

      case 'number': {
        const input = el('input', {
          type: 'number',
          value: item.value,
          step: item.step ?? 'any',
          min: item.min,
          max: item.max,
          style: { width: `${item.width || 68}px` },
          onchange: (e) => item.onChange(parseFloat(e.target.value), e),
        });
        return el('label.ribbon-field', { title: item.hint || '' }, [
          el('span', {}, item.label + (item.unit ? ` (${item.unit})` : '')),
          input,
        ]);
      }

      case 'text':
        return el('div.ribbon-readout', {}, [
          el('span.ribbon-readout-label', {}, item.label),
          el('span.ribbon-readout-value', {}, item.value),
        ]);

      case 'big':
      default:
        return el(`button.ribbon-big${item.active ? '.active' : ''}`, {
          type: 'button',
          title: item.hint || item.label,
          disabled: !!item.disabled,
          onclick: item.onClick,
        }, [icon(item.icon || 'point', 24), el('span', {}, item.label)]);
    }
  }
}
