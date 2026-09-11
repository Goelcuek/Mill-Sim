// Small modal windows.
//
// Creating a cutter is a task with a beginning and an end, so it gets a
// window rather than a slice of a scrolling panel: a titled overlay you
// fill in and either commit or discard. Escape and the backdrop cancel,
// Enter commits from any single-line field, and focus lands on the first
// control so the keyboard works without reaching for the mouse.

import { el, clear, button } from './dom.js';

let openCount = 0;

export class Dialog {
  /**
   * @param {{title:string, subtitle?:string, width?:number,
   *          body:HTMLElement|HTMLElement[],
   *          confirm?:string, onConfirm?:() => boolean|void,
   *          cancel?:string, onCancel?:() => void,
   *          extra?:HTMLElement[]}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.backdrop = el('div.dialog-backdrop', {
      onpointerdown: (e) => { if (e.target === this.backdrop) this.close(); },
    });

    const body = el('div.dialog-body', {}, Array.isArray(opts.body) ? opts.body : [opts.body]);
    const footer = el('div.dialog-footer', {}, [
      ...(opts.extra || []),
      el('div.spacer'),
      button(opts.cancel || 'Cancel', () => this.close()),
      opts.confirm
        ? (this.confirmBtn = button(opts.confirm, () => this.confirm(), { variant: 'primary' }))
        : null,
    ]);

    this.window = el('div.dialog', {
      role: 'dialog',
      'aria-modal': 'true',
      style: opts.width ? { width: `${opts.width}px` } : null,
    }, [
      el('header.dialog-head', {}, [
        el('div.dialog-titles', {}, [
          el('div.dialog-title', {}, opts.title),
          opts.subtitle ? el('div.dialog-subtitle', {}, opts.subtitle) : null,
        ]),
        el('button.dialog-close', { type: 'button', title: 'Close', onclick: () => this.close() }, '✕'),
      ]),
      body,
      footer,
    ]);
    this.backdrop.appendChild(this.window);

    this.onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        this.close();
      } else if (e.key === 'Enter' && opts.confirm) {
        const t = e.target;
        if (t && t.tagName === 'INPUT' && t.type !== 'range') {
          e.preventDefault();
          t.blur();
          this.confirm();
        }
      }
    };
  }

  open() {
    document.body.appendChild(this.backdrop);
    this.window.addEventListener('keydown', this.onKey);
    openCount++;
    requestAnimationFrame(() => {
      this.backdrop.classList.add('show');
      const first = this.window.querySelector('input, select, textarea, button.btn');
      if (first) first.focus();
    });
    return this;
  }

  confirm() {
    if (this.confirmBtn && this.confirmBtn.disabled) return;
    if (this.opts.onConfirm && this.opts.onConfirm() === false) return;
    this.close(true);
  }

  /** Grey out Commit while the window is not yet answerable. */
  setConfirmEnabled(on) {
    if (this.confirmBtn) this.confirmBtn.disabled = !on;
  }

  close(committed = false) {
    if (!this.backdrop.isConnected) return;
    if (!committed && this.opts.onCancel) this.opts.onCancel();
    this.window.removeEventListener('keydown', this.onKey);
    this.backdrop.classList.remove('show');
    openCount = Math.max(0, openCount - 1);
    const node = this.backdrop;
    setTimeout(() => node.remove(), 140);
    if (this.opts.onClosed) this.opts.onClosed(committed);
  }

  /** Replace the body, for dialogs whose contents depend on a choice. */
  setBody(content) {
    const body = this.window.querySelector('.dialog-body');
    clear(body);
    for (const n of Array.isArray(content) ? content : [content]) if (n) body.appendChild(n);
  }

  static get openCount() { return openCount; }
}

/** A yes/no confirmation, for anything destructive. */
export function confirmDialog({ title, message, confirm = 'OK', danger = false, onConfirm }) {
  const dlg = new Dialog({
    title,
    width: 420,
    body: el('p.dialog-message', {}, message),
    confirm,
    onConfirm,
  });
  dlg.open();
  if (danger) {
    const btn = dlg.window.querySelector('.dialog-footer .btn-primary');
    if (btn) {
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-danger');
    }
  }
  return dlg;
}
