// A small G-code editor: line numbers, current-line highlight, error
// markers and coloured words, backed by a plain textarea so editing
// behaves the way people expect (undo, selection, IME, paste).
//
// The colours are a second copy of the text laid exactly under the
// textarea, whose own letters are made clear: what is seen is the copy,
// what is typed into is the textarea. Only the lines in view are coloured,
// so a program of fifty thousand lines costs what a screenful does.

import { el, clear } from './dom.js';
import { highlightLine } from './gcodeTokens.js';

/** Lines coloured beyond the top and bottom of the view, for a smooth scroll. */
const SPARE = 15;

export class GcodeEditor {
  constructor(container, opts = {}) {
    this.onInput = opts.onInput || (() => {});
    this.onSeekLine = opts.onSeekLine || (() => {});

    this.gutter = el('div.editor-gutter');
    this.textarea = el('textarea.editor-area', {
      spellcheck: false,
      wrap: 'off',
      placeholder: 'Paste or open a G-code program…',
    });
    this.highlight = el('div.editor-highlight');
    this.code = el('pre.editor-code', { 'aria-hidden': 'true' });
    this.wrap = el('div.editor', {}, [this.gutter, el('div.editor-main', {}, [this.highlight, this.code, this.textarea])]);
    container.appendChild(this.wrap);

    this.lineCount = 0;
    this.markers = new Map();
    this.activeLine = 0;

    this.lines = [''];
    this.shown = null;
    /**
     * Where the view was scrolled to, the last time it was on screen. A
     * textarea taken out of the page — another step chosen, the panel
     * drawn again — comes back scrolled to the top, and the line that is
     * running with it out of sight.
     */
    this.view = { top: 0, left: 0 };
    this.hidden = true;
    this.textarea.addEventListener('input', () => {
      this.splitLines();
      this.refreshGutter();
      this.onInput(this.textarea.value);
    });
    // The view changes size with the panel and the window.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resized()).observe(this.textarea);
    this.textarea.addEventListener('scroll', () => {
      if (this.onScreen()) this.view = { top: this.textarea.scrollTop, left: this.textarea.scrollLeft };
      this.syncScroll();
    });
    this.textarea.addEventListener('keyup', () => this.reportCaretLine());
    this.textarea.addEventListener('click', () => this.reportCaretLine());
    this.gutter.addEventListener('click', (e) => {
      const n = e.target && e.target.dataset ? Number(e.target.dataset.line) : 0;
      if (n) this.onSeekLine(n, { search: e.shiftKey });
    });
    this.gutter.title = 'Click a line number: simulate to that line · Shift+click: search to it, nothing cut or checked on the way';

    this.refreshGutter();
  }

  get value() { return this.textarea.value; }

  /** Is the editor laid out on the page, so that it can scroll? */
  onScreen() {
    return this.textarea.isConnected && this.textarea.clientHeight > 0;
  }

  /**
   * The view has changed size — or has gone, or come back. Back on the
   * page, it is put where it was, and the running line brought into view
   * if the run moved on while it was away.
   */
  resized() {
    this.shown = null;
    if (!this.onScreen()) {
      this.hidden = true;
      return;
    }
    if (this.hidden) {
      this.hidden = false;
      this.textarea.scrollTop = this.view.top;
      this.textarea.scrollLeft = this.view.left;
      if (this.activeLine) this.revealPending = true;
    }
    if (this.revealPending && this.activeLine) this.reveal(this.activeLine);
    this.syncScroll();
  }

  /**
   * Lock the text.
   *
   * A machine's macro is shown here when the run is inside one, and it is
   * the machine's, not the job's: it can be read where it is running and
   * changed where it lives.
   */
  setReadOnly(on) {
    this.textarea.readOnly = !!on;
    this.wrap.classList.toggle('editor-locked', !!on);
  }

  setValue(text) {
    this.textarea.value = text || '';
    this.splitLines();
    this.refreshGutter();
  }

  /** The text as lines, for colouring; read again whenever it changes. */
  splitLines() {
    this.lines = this.textarea.value.split('\n');
    this.shown = null;
  }

  /**
   * Colour the lines in view, and a few either side. Drawn again only when
   * the text or the lines in view have changed; scrolling within them only
   * moves the layer.
   */
  paint() {
    const ta = this.textarea;
    const lh = this.lineHeight();
    const first = Math.max(0, Math.floor(ta.scrollTop / lh) - SPARE);
    const last = Math.min(this.lines.length, Math.ceil((ta.scrollTop + ta.clientHeight) / lh) + SPARE);
    if (!this.shown || first < this.shown[0] || last > this.shown[1]) {
      // Room either side, so a short scroll does not draw again.
      const a = Math.max(0, first - SPARE);
      const b = Math.min(this.lines.length, last + SPARE);
      let html = '';
      for (let i = a; i < b; i++) html += `${highlightLine(this.lines[i])}\n`;
      this.code.innerHTML = html;
      this.shown = [a, b];
    }
    this.code.style.transform = `translate(${-ta.scrollLeft}px, ${this.shown[0] * lh - ta.scrollTop}px)`;
  }

  reportCaretLine() {
    const upto = this.textarea.value.slice(0, this.textarea.selectionStart);
    this.caretLine = upto.split('\n').length;
  }

  /** @param {Array<{line:number, severity:string, message:string}>} list */
  setMarkers(list) {
    this.markers = new Map();
    for (const w of list || []) {
      const cur = this.markers.get(w.line);
      if (!cur || (cur.severity !== 'error' && w.severity === 'error')) this.markers.set(w.line, w);
    }
    this.refreshGutter();
  }

  refreshGutter() {
    const lines = this.textarea.value.split('\n').length;
    this.lineCount = lines;
    clear(this.gutter);
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= lines; i++) {
      const marker = this.markers.get(i);
      const node = el('div.gutter-line', {
        dataset: { line: String(i) },
        title: marker ? marker.message : '',
        class: marker ? `marker-${marker.severity}` : '',
      }, String(i));
      if (i === this.activeLine) node.classList.add('active');
      frag.appendChild(node);
    }
    this.gutter.appendChild(frag);
    this.syncScroll();
  }

  /** Highlight the line the simulator is executing and keep it in view. */
  setActiveLine(line, { scroll = true } = {}) {
    const changed = line !== this.activeLine;
    if (changed) {
      const prev = this.gutter.querySelector('.gutter-line.active');
      if (prev) prev.classList.remove('active');
      this.activeLine = line;
      if (!line) {
        this.highlight.style.display = 'none';
        return;
      }
      const node = this.gutter.children[line - 1];
      if (node) node.classList.add('active');

      const lh = this.lineHeight();
      this.highlight.style.display = 'block';
      this.highlight.style.transform = `translateY(${(line - 1) * lh}px)`;
      this.highlight.style.height = `${lh}px`;
    }
    if (scroll && line && (changed || this.revealPending)) this.reveal(line);
  }

  /**
   * Scroll a line into view, unless it is in view already. Off the page
   * there is nothing to scroll, so it is done when the editor is back.
   */
  reveal(line) {
    if (!this.onScreen()) {
      this.revealPending = true;
      return;
    }
    this.revealPending = false;
    const lh = this.lineHeight();
    const top = (line - 1) * lh;
    const view = this.textarea.clientHeight;
    const st = this.textarea.scrollTop;
    if (top < st + lh * 2 || top > st + view - lh * 3) {
      this.textarea.scrollTop = Math.max(0, top - view / 2);
      this.syncScroll();
    }
  }

  lineHeight() {
    if (!this._lh) {
      const cs = getComputedStyle(this.textarea);
      const parsed = parseFloat(cs.lineHeight);
      this._lh = Number.isFinite(parsed) ? parsed : 18;
    }
    return this._lh;
  }

  syncScroll() {
    this.gutter.scrollTop = this.textarea.scrollTop;
    this.highlight.style.top = `${-this.textarea.scrollTop}px`;
    this.paint();
  }

  focusLine(line) {
    const lh = this.lineHeight();
    this.textarea.scrollTop = Math.max(0, (line - 1) * lh - this.textarea.clientHeight / 2);
    this.syncScroll();
  }
}
