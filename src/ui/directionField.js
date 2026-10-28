// Which way an axis slides or turns, as a vector.
//
// Most axes lie along X, Y or Z and the six choices cover them. Some do
// not: a nutating head's B turns about a line 45° between Y and Z, a
// trunnion can be bolted on at an angle. So the direction is three numbers,
// the components of a vector in the frame of whatever carries the axis,
// with the six as quick picks. It is kept as typed — 1, 0, 1 for 45° in XZ
// — and made a unit vector wherever it is used, which is shown underneath.

import { el, field, select, row } from './dom.js';

const PICKS = [
  { value: '1,0,0', label: '+X' },
  { value: '-1,0,0', label: '−X' },
  { value: '0,1,0', label: '+Y' },
  { value: '0,-1,0', label: '−Y' },
  { value: '0,0,1', label: '+Z' },
  { value: '0,0,-1', label: '−Z' },
];

const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? v.map((x) => x / l) : null;
};

/** The pick a vector is, or null when it is none of the six. */
function pickOf(v) {
  const u = unit(v);
  if (!u) return null;
  const hit = PICKS.find((p) => p.value.split(',').map(Number).every((x, i) => Math.abs(x - u[i]) < 1e-9));
  return hit ? hit.value : null;
}

/** "+X", or the unit vector to four places. */
export function directionLabel(v) {
  const p = pickOf(v);
  if (p) return PICKS.find((d) => d.value === p).label;
  const u = unit(v);
  return u ? `(${u.map((x) => Number(x.toFixed(4))).join(', ')})` : '(0, 0, 0)';
}

/**
 * @param {number[]} axis the direction now
 * @param {(axis:number[]) => void} onChange with the new vector, as typed;
 *   never called with a zero vector
 * @returns {HTMLElement}
 */
export function directionField(axis, onChange) {
  let v = axis.slice();
  const note = el('div.hint');
  const comps = ['X', 'Y', 'Z'].map((L, i) => field(L, v[i], {
    step: 0.1,
    title: `The ${L} part of the direction`,
    onChange: (x) => {
      const next = v.slice();
      next[i] = Number.isFinite(x) ? x : 0;
      put(next, false);
    },
  }));
  const pick = select('Direction', [...PICKS, { value: 'custom', label: 'Custom vector' }], pickOf(v) || 'custom', (val) => {
    if (val === 'custom') return;
    put(val.split(',').map(Number), true);
  }, { title: 'Along a machine axis, or any direction as a vector' });

  const show = () => {
    const u = unit(v);
    pick.querySelector('select').value = pickOf(v) || 'custom';
    note.textContent = u
      ? `Unit vector ${u.map((x) => Number(x.toFixed(4))).join(', ')} — in the frame of what carries this axis.`
      : 'A direction needs at least one component that is not zero.';
    note.classList.toggle('inline-warning', !u);
  };
  const put = (next, fill) => {
    if (fill) next.forEach((x, i) => comps[i].setValue(x));
    if (!unit(next)) {
      // Kept on screen so it can be finished, but not handed on.
      v = next;
      show();
      return;
    }
    v = next;
    show();
    onChange(v.slice());
  };
  show();
  return el('div.direction-field', {}, [pick, row(comps), note]);
}
