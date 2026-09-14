// A small G-code editor: line numbers, current-line highlight and error
// markers, backed by a plain textarea so editing behaves the way people
// expect (undo, selection, IME, paste).

import { el, clear } from './dom.js';

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
    this.wrap = el('div.editor', {}, [this.gutter, el('div.editor-main', {}, [this.highlight, this.textarea])]);
    container.appendChild(this.wrap);

    this.lineCount = 0;
    this.markers = new Map();
    this.activeLine = 0;

    this.textarea.addEventListener('input', () => {
      this.refreshGutter();
      this.onInput(this.textarea.value);
    });
    this.textarea.addEventListener('scroll', () => this.syncScroll());
    this.textarea.addEventListener('keyup', () => this.reportCaretLine());
    this.textarea.addEventListener('click', () => this.reportCaretLine());
    this.gutter.addEventListener('click', (e) => {
      const n = e.target && e.target.dataset ? Number(e.target.dataset.line) : 0;
      if (n) this.onSeekLine(n);
    });

    this.refreshGutter();
  }

  get value() { return this.textarea.value; }

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
    this.refreshGutter();
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
    if (line === this.activeLine) return;
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

    if (scroll) {
      const top = (line - 1) * lh;
      const view = this.textarea.clientHeight;
      const st = this.textarea.scrollTop;
      if (top < st + lh * 2 || top > st + view - lh * 3) {
        this.textarea.scrollTop = Math.max(0, top - view / 2);
        this.syncScroll();
      }
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
  }

  focusLine(line) {
    const lh = this.lineHeight();
    this.textarea.scrollTop = Math.max(0, (line - 1) * lh - this.textarea.clientHeight / 2);
    this.syncScroll();
  }
}
