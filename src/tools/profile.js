// A cutter as radius against height, in pieces a line can be solved against.
//
// The envelope tables in envelope.js answer one question very fast: looking
// straight up the tool, how low does it reach at this radius? That is all a
// heightmap ever asks. A model that looks along X and Y as well asks a
// different one — where does this line, at whatever angle to the tool, go
// into the cutter and come out again — and a table indexed by radius cannot
// answer it.
//
// So the silhouette is kept as what it is: radius as a function of height
// above the tip, R(s), for s from 0 to the top of the flutes. Every cutter
// here is a stack of straight pieces (a cylinder, a cone, a flat end) and
// spheres centred on the axis (a ball nose, a lollipop). Along any line the
// squared radius of a point and the squared radius of the tool at that
// point's height are both quadratic in the line parameter, so each piece is
// a quadratic to solve — exact, with no faceting of the cutter at all.
//
// A corner radius that is not centred on the axis — a bull nose, the corner
// of a face mill — is a torus, which is a quartic. It stays as the fine
// polyline the tool definition already draws it with, which is within a few
// tenths of a micron.

/** Piece kinds. */
export const LINE = 0;
export const SPHERE = 1;

/** Five numbers a piece: s0, s1, kind, a, b. */
const STRIDE = 5;

export class Profile {
  /**
   * @param {Float64Array} pieces  [s0, s1, kind, a, b] per piece, s ascending
   *   LINE:   R(s) = a + b s
   *   SPHERE: R(s)² = a − (s − b)²   (a ball of radius √a centred at s = b)
   * @param {number} top   height of the top of the cutting part
   * @param {number} rMax  its largest radius
   */
  constructor(pieces, top, rMax) {
    this.pieces = pieces;
    this.count = pieces.length / STRIDE;
    this.top = top;
    this.rMax = rMax;
    this.rMax2 = rMax * rMax;
    this.convex = this.checkConvex();
    // The highest point at each radius is the top of the flutes for almost
    // every cutter; only a ball that closes over at the top (a lollipop)
    // comes back in. When it is constant, a sweep along the axis needs no
    // search for it.
    this.upperConstant = this.radiusAt(top) >= rMax - 1e-9;
    this.buildTables(768);
    // A flat end reaches its lowest at every radius: an end mill, a face
    // mill. Swept along its own axis it then needs no search for the floor.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= this.n; i++) {
      if (this.lower[i] < lo) lo = this.lower[i];
      if (this.lower[i] > hi) hi = this.lower[i];
    }
    this.lowerConstant = hi - lo < 1e-12;
    // Where the radius is widest: a plunge reaches that far sideways if it
    // passes through those heights at all.
    this.peakLo = this.lower[this.n];
    this.peakHi = this.upper[this.n];
    // Can a straight move be swept piece by piece in closed form? A sphere
    // swept along a line is a capsule, but only the whole sphere is: the
    // piece has to start at the sphere's bottom, and the rest of the ball
    // above it has to be inside the tool anyway — the shank of a ball nose
    // covers the top half, unless the flutes are shorter than the ball.
    this.closedForm = this.checkClosedForm();
    // Looking along the axis, every straight piece also has to be a plain
    // cylinder: a cone's reach along the axis changes with the radius.
    let flatSides = true;
    for (let k = 0; k < this.pieces.length; k += STRIDE) {
      if (this.pieces[k + 2] === LINE && Math.abs(this.pieces[k + 4]) > 1e-12) flatSides = false;
    }
    this.parallelClosed = this.closedForm && flatSides;
  }

  checkClosedForm() {
    const p = this.pieces;
    for (let k = 0; k < p.length; k += STRIDE) {
      if (p[k + 2] !== SPHERE) continue;
      const rad = Math.sqrt(p[k + 3]);
      const centre = p[k + 4];
      if (p[k] > centre - rad + 1e-9) return false;          // not from its bottom
      if (centre + rad > this.top + 1e-9) return false;      // pokes out of the top
      for (let i = 0; i <= 32; i++) {
        const sAt = p[k + 1] + ((centre + rad - p[k + 1]) * i) / 32;
        const ball = Math.sqrt(Math.max(0, p[k + 3] - (sAt - centre) * (sAt - centre)));
        if (this.radiusAt(sAt) < ball - 1e-9) return false;
      }
    }
    return true;
  }

  /** The widest the solid gets between heights sa and sb. */
  maxRadiusIn(sa, sb) {
    if (sa > sb) { const t = sa; sa = sb; sb = t; }
    if (sb < 0 || sa > this.top) return 0;
    if (sa <= this.peakHi && sb >= this.peakLo) return this.rMax;
    // R is concave, so off the peak the widest is at the near end.
    return Math.max(this.radiusAt(Math.max(sa, 0)), this.radiusAt(Math.min(sb, this.top)));
  }

  /** Radius at height s, 0 outside the cutting part. */
  radiusAt(s) {
    if (!(s >= 0) || s > this.top) return 0;
    const p = this.pieces;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p[mid * STRIDE] <= s) lo = mid; else hi = mid - 1;
    }
    const k = lo * STRIDE;
    if (p[k + 2] === LINE) return Math.max(0, p[k + 3] + p[k + 4] * s);
    const d = s - p[k + 4];
    const r2 = p[k + 3] - d * d;
    return r2 > 0 ? Math.sqrt(r2) : 0;
  }

  /**
   * Is the solid convex? Every cutter defined here is — a radius that never
   * bulges inwards — and the sweep kernels lean on it: a line through a
   * convex body goes in once and comes out once.
   */
  checkConvex() {
    const n = 256;
    let prev = this.radiusAt(0);
    let cur = this.radiusAt(this.top / n);
    for (let i = 2; i <= n; i++) {
      const next = this.radiusAt((i * this.top) / n);
      if (cur < (prev + next) / 2 - 1e-6 * Math.max(1, this.rMax)) return false;
      prev = cur;
      cur = next;
    }
    return true;
  }

  /**
   * Lowest and highest height the solid reaches at each radius, tabulated
   * against r² like an envelope. Looking along the tool's own axis these
   * are the whole answer.
   */
  buildTables(n) {
    this.n = n;
    this.invStep = n / (this.rMax2 || 1);
    this.lower = new Float64Array(n + 1);
    this.upper = new Float64Array(n + 1);
    const p = this.pieces;
    for (let i = 0; i <= n; i++) {
      const r = Math.sqrt((i / n) * this.rMax2) - 1e-12;
      let lo = Infinity;
      let hi = -Infinity;
      // Each piece says where in its own heights the radius is at least r;
      // the solid is the union of those.
      for (let k = 0; k < p.length; k += STRIDE) {
        let a = p[k];
        let b = p[k + 1];
        if (p[k + 2] === LINE) {
          const c0 = p[k + 3];
          const sl = p[k + 4];
          if (Math.abs(sl) < 1e-15) {
            if (c0 < r) continue;
          } else {
            const at = (r - c0) / sl;
            if (sl > 0) { if (at > a) a = at; } else if (at < b) b = at;
          }
        } else {
          const room = p[k + 3] - r * r;
          if (room < 0) continue;
          const w = Math.sqrt(room);
          if (p[k + 4] - w > a) a = p[k + 4] - w;
          if (p[k + 4] + w < b) b = p[k + 4] + w;
        }
        if (a > b) continue;
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
      this.lower[i] = lo;
      this.upper[i] = hi;
    }
  }

  /** Lowest height of the solid at squared radius r2; Infinity outside it. */
  lowAt(r2) { return this.table(this.lower, r2, Infinity); }

  /** Highest height of the solid at squared radius r2; −Infinity outside it. */
  highAt(r2) { return this.table(this.upper, r2, -Infinity); }

  table(t, r2, outside) {
    if (r2 > this.rMax2) return outside;
    const x = r2 * this.invStep;
    const i = x | 0;
    if (i >= this.n) return t[this.n];
    const a = t[i];
    const b = t[i + 1];
    if (!Number.isFinite(b)) return a;
    return a + (b - a) * (x - i);
  }

  /**
   * Where a line goes into the solid and comes out, for the tool standing
   * at `tip` pointing up `dir` — or null when it misses.
   *
   * The line is o + t·e. Writing q = o − tip, a point on it is
   *
   *     s(t)  = s0 + c t                     height along the tool axis
   *     ρ²(t) = P0 + P1 t + P2 t²            squared distance from the axis
   *
   * and inside a piece the tool's own squared radius at s(t) is quadratic
   * in t too, so "inside" is a quadratic inequality per piece. The solid is
   * convex, so the pieces' answers are one interval: the first entry and
   * the last exit.
   *
   * @param {number[]} out  receives [tIn, tOut]
   * @returns {boolean} whether the line meets the solid
   */
  hit(ox, oy, oz, ex, ey, ez, tx, ty, tz, dx, dy, dz, out) {
    const qx = ox - tx, qy = oy - ty, qz = oz - tz;
    const s0 = qx * dx + qy * dy + qz * dz;
    const c = ex * dx + ey * dy + ez * dz;
    const qe = qx * ex + qy * ey + qz * ez;
    const Q = qx * qx + qy * qy + qz * qz;
    const P0 = Q - s0 * s0;
    const P1 = 2 * (qe - s0 * c);
    const P2 = 1 - c * c;
    const top = this.top;

    // First the bounding cylinder: within rMax of the axis and between the
    // tip and the top. Most lines that reach here stop here.
    let lo = -Infinity;
    let hi = Infinity;
    if (P2 > 1e-14) {
      const disc = P1 * P1 - 4 * P2 * (P0 - this.rMax2);
      if (disc < 0) return false;
      const sq = Math.sqrt(disc);
      lo = (-P1 - sq) / (2 * P2);
      hi = (-P1 + sq) / (2 * P2);
    } else if (P0 > this.rMax2) {
      return false;
    }
    if (Math.abs(c) > 1e-14) {
      let a = -s0 / c;
      let b = (top - s0) / c;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > lo) lo = a;
      if (b < hi) hi = b;
    } else if (s0 < 0 || s0 > top) {
      return false;
    }
    if (lo > hi) return false;

    // The heights the line spends inside the bounding cylinder: only the
    // pieces that cover them are asked.
    let sLo = s0 + c * lo;
    let sHi = s0 + c * hi;
    if (sLo > sHi) { const t = sLo; sLo = sHi; sHi = t; }

    const p = this.pieces;
    let tIn = Infinity;
    let tOut = -Infinity;
    for (let k = 0; k < p.length; k += STRIDE) {
      const ps0 = p[k];
      const ps1 = p[k + 1];
      if (ps1 < sLo || ps0 > sHi) continue;
      // The stretch of the line whose height is inside this piece.
      let a = lo;
      let b = hi;
      if (Math.abs(c) > 1e-14) {
        let u = (ps0 - s0) / c;
        let v = (ps1 - s0) / c;
        if (u > v) { const t = u; u = v; v = t; }
        if (u > a) a = u;
        if (v < b) b = v;
        if (a > b) continue;
      }
      // R(s(t))² − ρ²(t) = F0 + F1 t + F2 t² ≥ 0
      let F0, F1, F2;
      if (p[k + 2] === LINE) {
        const al = p[k + 3] + p[k + 4] * s0;
        const be = p[k + 4] * c;
        F0 = al * al - P0;
        F1 = 2 * al * be - P1;
        F2 = be * be - P2;
      } else {
        const g = s0 - p[k + 4];
        F0 = p[k + 3] - g * g - P0;
        F1 = -2 * g * c - P1;
        F2 = -c * c - P2;
      }
      if (quadNonNeg(F0, F1, F2, a, b, span)) {
        if (span[0] < tIn) tIn = span[0];
        if (span[1] > tOut) tOut = span[1];
      }
    }
    if (tIn > tOut) return false;
    out[0] = tIn;
    out[1] = tOut;
    return true;
  }
}

const span = [0, 0];

/**
 * Where F0 + F1 t + F2 t² ≥ 0 on [a, b], as the smallest interval holding
 * all of it (for a convex solid it is one interval anyway).
 */
function quadNonNeg(F0, F1, F2, a, b, out) {
  const f = (t) => F0 + t * (F1 + t * F2);
  const scale = Math.abs(F0) + Math.abs(F1) * Math.max(Math.abs(a), Math.abs(b), 1) + 1e-30;
  if (Math.abs(F2) < 1e-14 * scale) {
    // Linear.
    if (Math.abs(F1) < 1e-300) {
      if (F0 < 0) return false;
      out[0] = a; out[1] = b;
      return true;
    }
    const r = -F0 / F1;
    let lo = a, hi = b;
    if (F1 > 0) { if (r > lo) lo = r; } else if (r < hi) hi = r;
    if (lo > hi) return false;
    out[0] = lo; out[1] = hi;
    return true;
  }
  const disc = F1 * F1 - 4 * F2 * F0;
  if (F2 < 0) {
    // A cap: non-negative between the roots.
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    // Stable roots.
    const qq = -0.5 * (F1 + (F1 >= 0 ? sq : -sq));
    let r1 = qq / F2;
    let r2 = qq !== 0 ? F0 / qq : r1;
    if (r1 > r2) { const t = r1; r1 = r2; r2 = t; }
    const lo = Math.max(a, r1);
    const hi = Math.min(b, r2);
    if (lo > hi) return false;
    out[0] = lo; out[1] = hi;
    return true;
  }
  // A cup: non-negative outside the roots.
  if (disc <= 0) { out[0] = a; out[1] = b; return true; }
  const sq = Math.sqrt(disc);
  const qq = -0.5 * (F1 + (F1 >= 0 ? sq : -sq));
  let r1 = qq / F2;
  let r2 = qq !== 0 ? F0 / qq : r1;
  if (r1 > r2) { const t = r1; r1 = r2; r2 = t; }
  let lo = Infinity, hi = -Infinity;
  if (a <= Math.min(b, r1)) { lo = a; hi = Math.min(b, r1); }
  if (Math.max(a, r2) <= b) { if (Math.max(a, r2) < lo) lo = Math.max(a, r2); hi = b; }
  if (lo > hi) {
    // Roundoff right at a tangent: take the better end if it is inside.
    if (f(a) >= 0) { out[0] = a; out[1] = a; return true; }
    if (f(b) >= 0) { out[0] = b; out[1] = b; return true; }
    return false;
  }
  out[0] = lo; out[1] = hi;
  return true;
}

/**
 * Pieces from a silhouette polyline: {r, z} from the tip upwards.
 *
 * Runs of points on one circle centred on the axis become a sphere; the
 * rest are straight pieces. A step in radius at one height (the flat end of
 * an end mill) is not a piece at all — it is where one piece starts.
 */
export function buildProfile(points) {
  const pts = [];
  for (const p of points || []) {
    if (!Number.isFinite(p.r) || !Number.isFinite(p.z)) continue;
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.r - p.r) < 1e-12 && Math.abs(last.z - p.z) < 1e-12) continue;
    pts.push({ r: Math.max(0, p.r), z: p.z });
  }
  if (pts.length < 2) return null;
  // Heights only ever go up the tool; a point that comes back down would
  // make R(s) two-valued, which no cutter here is.
  for (let i = 1; i < pts.length; i++) if (pts[i].z < pts[i - 1].z - 1e-9) return null;

  const pieces = [];
  let rMax = 0;
  for (const p of pts) rMax = Math.max(rMax, p.r);
  const top = pts[pts.length - 1].z;
  if (!(top > 0) || !(rMax > 0)) return null;

  let i = 0;
  while (i < pts.length - 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (b.z - a.z < 1e-12) { i++; continue; }        // a step, not a piece
    // A sphere centred on the axis through a and b, if the next point
    // agrees with it.
    const c = (a.r * a.r + a.z * a.z - b.r * b.r - b.z * b.z) / (2 * (a.z - b.z));
    const rad2 = a.r * a.r + (a.z - c) * (a.z - c);
    let j = i + 1;
    const tol = 1e-7 * Math.max(1, rad2);
    while (j + 1 < pts.length && pts[j + 1].z > pts[j].z + 1e-12) {
      const q = pts[j + 1];
      if (Math.abs(q.r * q.r + (q.z - c) * (q.z - c) - rad2) > tol) break;
      j++;
    }
    if (j - i >= 2) {
      pieces.push(a.z, pts[j].z, SPHERE, rad2, c);
      i = j;
      continue;
    }
    const slope = (b.r - a.r) / (b.z - a.z);
    pieces.push(a.z, b.z, LINE, a.r - slope * a.z, slope);
    i++;
  }
  if (!pieces.length) return null;
  return new Profile(Float64Array.from(pieces), top, rMax);
}

/** The profile of an envelope's silhouette, built once and kept on it. */
export function profileOf(env) {
  if (!env) return null;
  if (env._profile === undefined) env._profile = env.points ? buildProfile(env.points) : null;
  return env._profile;
}
