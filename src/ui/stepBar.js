// The job, in the order it is done: the machine, the setup, the tools, the
// program, the results.
//
// Each step is one button across the top, numbered, and under its name a
// line saying where that step stands — which machine, what stock, which
// program, how many findings — so the bar is both the way round the job
// and a summary of it. A step is never locked: the order is the order
// things are usually done in, not a wizard that has to be obeyed.

import { el, clear } from './dom.js';
import { icon } from './icons.js';

export class StepBar {
  constructor() {
    this.root = el('nav.stepbar', { 'aria-label': 'Job steps' });
    this.steps = [];
    this.nodes = new Map();
    this.active = null;
  }

  /** @param {(id:string) => void} fn */
  onStep(fn) { this.handler = fn; }

  /**
   * @param {Array<{id:string, label:string, status?:() => {text:string, state?:'ok'|'warn'|'error'|'idle'}}>} steps
   */
  setSteps(steps) {
    this.steps = steps;
    clear(this.root);
    this.nodes = new Map();
    steps.forEach((s, i) => {
      if (i) this.root.appendChild(el('span.step-link', { 'aria-hidden': 'true' }));
      const mark = el('span.step-num', {}, String(i + 1));
      const sub = el('span.step-status');
      const node = el('button.step', {
        type: 'button',
        dataset: { step: s.id },
        onclick: () => this.handler && this.handler(s.id),
      }, [
        mark,
        el('span.step-text', {}, [el('span.step-label', {}, s.label), sub]),
      ]);
      this.nodes.set(s.id, { node, mark, sub, index: i });
      this.root.appendChild(node);
    });
    this.update();
  }

  setActive(id) {
    this.active = id;
    for (const [k, n] of this.nodes) {
      n.node.classList.toggle('active', k === id);
      n.node.setAttribute('aria-current', k === id ? 'step' : 'false');
    }
  }

  /** Read every step's status again; cheap, and only touches what changed. */
  update() {
    for (const s of this.steps) {
      const n = this.nodes.get(s.id);
      if (!n) continue;
      let st = { text: '', state: 'idle' };
      try { st = (s.status && s.status()) || st; } catch { /* a step half set up says nothing */ }
      if (n.sub.textContent !== st.text) {
        n.sub.textContent = st.text;
        n.node.title = `${s.label}${st.text ? ` — ${st.text}` : ''}`;
      }
      const state = st.state || 'idle';
      if (n.state !== state) {
        n.state = state;
        n.node.dataset.state = state;
        n.mark.replaceChildren(state === 'ok' ? icon('check', 13) : String(n.index + 1));
      }
    }
  }
}
