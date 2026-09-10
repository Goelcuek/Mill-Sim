// Lower-envelope lookup tables for solids of revolution.
//
// Every cutter, neck, shank and holder in the simulator is a solid of
// revolution described by a silhouette polyline: an ordered list of
// {r, z} points where `r` is the radius and `z` the height above the
// tool tip (tip = 0, growing towards the spindle).
//
// For both material removal and collision testing we need the same
// question answered very fast, millions of times per second:
//
//     "for a point at radial distance r from the tool axis, what is the
//      lowest height at which this solid occupies that radius?"
//
// That function LE(r) is the *lower envelope* of the solid. Carving a
// heightmap with a cutter is `h = min(h, tipZ + LE_cut(r))`, and a
// collision with the non-cutting body is `h > tipZ + LE_body(r)`.
//
// LE is tabulated against r^2 rather than r so the hot loop never needs a
// square root, and because r^2 sampling concentrates resolution near the
// outer edge of the tool where profile curvature matters most.

export const NO_CONTACT = Infinity;

export class Envelope {
  /**
   * @param {Float32Array} lut   LE sampled at r_i = sqrt(i/N) * rMax
   * @param {number} rMax        outer radius of the solid
   * @param {number} zMin        smallest finite value in the table
   */
  constructor(lut, rMax, zMin) {
    this.lut = lut;
    this.n = lut.length - 1;
    this.rMax = rMax;
    this.rMax2 = rMax * rMax;
    this.zMin = zMin;
    this.invStep = this.n / (this.rMax2 || 1);
  }

  /** Lower envelope height for a point at squared radius `r2`. */
  at(r2) {
    if (r2 >= this.rMax2) return r2 === this.rMax2 ? this.lut[this.n] : NO_CONTACT;
    const x = r2 * this.invStep;
    const i = x | 0;
    const f = x - i;
    const a = this.lut[i];
    const b = this.lut[i + 1];
    if (b === NO_CONTACT) return a;
    return a + (b - a) * f;
  }

  /** True when the solid has no material at all. */
  get isEmpty() {
    return !(this.rMax > 0) || !Number.isFinite(this.zMin);
  }
}

/** An envelope that never touches anything. */
export function emptyEnvelope() {
  return new Envelope(Float32Array.from([NO_CONTACT, NO_CONTACT]), 0, NO_CONTACT);
}

/**
 * Build an {@link Envelope} from a silhouette polyline.
 *
 * Consecutive points form truncated cones. Vertical steps (equal z) are
 * allowed and behave like a flat disc face.
 *
 * @param {Array<{r:number,z:number}>} points
 * @param {number} [samples]
 */
export function buildEnvelope(points, samples = 768) {
  const pts = (points || []).filter((p) => Number.isFinite(p.r) && Number.isFinite(p.z) && p.r >= 0);
  if (pts.length < 2) return emptyEnvelope();

  let rMax = 0;
  for (const p of pts) rMax = Math.max(rMax, p.r);
  if (rMax <= 0) return emptyEnvelope();

  const n = samples;
  const lut = new Float32Array(n + 1).fill(NO_CONTACT);
  const rMax2 = rMax * rMax;

  for (let i = 0; i <= n; i++) {
    const r = Math.sqrt((i / n) * rMax2);
    let best = NO_CONTACT;

    for (let s = 0; s + 1 < pts.length; s++) {
      let a = pts[s];
      let b = pts[s + 1];
      if (b.z < a.z) {
        const t = a;
        a = b;
        b = t;
      }
      // Radius as a linear function of z across the section.
      if (a.r >= r) {
        // Already covered at the bottom of this section.
        if (a.z < best) best = a.z;
      } else if (b.r >= r) {
        if (b.z === a.z) {
          if (a.z < best) best = a.z;
        } else {
          const t = (r - a.r) / (b.r - a.r);
          const z = a.z + t * (b.z - a.z);
          if (z < best) best = z;
        }
      }
    }
    lut[i] = best;
  }

  // Interior gaps (possible with re-entrant silhouettes) are filled with the
  // nearest finite sample so the hot loop never sees a hole.
  let lastFinite = -1;
  for (let i = 0; i <= n; i++) {
    if (lut[i] !== NO_CONTACT) {
      if (lastFinite >= 0 && i - lastFinite > 1) {
        for (let k = lastFinite + 1; k < i; k++) lut[k] = Math.min(lut[lastFinite], lut[i]);
      }
      lastFinite = i;
    }
  }

  let zMin = NO_CONTACT;
  for (let i = 0; i <= n; i++) if (lut[i] < zMin) zMin = lut[i];

  return new Envelope(lut, rMax, zMin);
}

/**
 * Sample a circular arc into silhouette points.
 *
 * @param {number} cr  centre radius
 * @param {number} cz  centre height
 * @param {number} radius
 * @param {number} a0  start angle (radians, 0 = +r direction)
 * @param {number} a1  end angle
 * @param {number} [steps]
 */
export function arcPoints(cr, cz, radius, a0, a1, steps = 16) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push({ r: cr + radius * Math.cos(a), z: cz + radius * Math.sin(a) });
  }
  return out;
}

/** Remove duplicate/near-duplicate consecutive points. */
export function dedupe(points, eps = 1e-6) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.r - p.r) < eps && Math.abs(last.z - p.z) < eps) continue;
    out.push({ r: p.r, z: p.z });
  }
  return out;
}
