// Cutting forces on a milling cutter, from the material actually in its way.
//
// A port of Shop-Ref's force model (core/calc: MillingForceModel, Mechanics,
// Deflection), so the two apps agree on the physics:
//
//   - Kienzle: dFt = kc1.1 · b · h^(1−mc) · Kγ · Kwear   (Kienzle 1952)
//   - chip thickness h = fz · sin φ · sin κ               (Martellotti 1941)
//   - helix lag φ(z) = θ + j·2π/N − 2·tan β·z / D          (Tlusty & MacNeil 1975)
//   - radial and axial ratios from the oblique transformation of Budak,
//     Altintas & Armarego (1996) with Stabler's chip-flow rule
//   - deflection of a stepped cantilever, the fluted length taken as a
//     cylinder of 0.8·D (Kops & Vo 1990)
//
// The one thing that is different is where the engagement comes from.
// Shop-Ref is a calculator: it is told one radial depth and assumes a
// straight cut, so every slice of the cutter is in the same arc, from φst
// to φex. Here the arc is measured off the stock for every slice
// separately — a pocket corner, a ramp, a ball nose on a slope each engage
// a different set of angles at each height — and the time-domain sum is
// taken over whatever is engaged. Given the straight-cut engagement it
// reduces to Shop-Ref's model exactly, which is what the tests check.
//
// Conventions (Altintas 2012, ch. 2): feed along +x, the immersion angle φ
// measured clockwise from +y, the spindle turning clockwise seen from above
// (M03). A tooth takes a chip only on the leading half, φ in (0, π); climb
// milling engages the end of it, conventional the start.

const DEG = Math.PI / 180;

/** Kγ: the rake correction to kc (Sandvik Coromant), held to a sane range. */
export const rakeFactor = (rakeDeg) => Math.min(1.4, Math.max(0.6, 1 - rakeDeg / 100));

/**
 * Radial and axial force as fractions of the tangential, for a sharp edge
 * with normal rake αn and inclination (helix) i. See Shop-Ref ForceRatios.
 */
export function forceRatios(frictionAngleDeg, normalRakeDeg, inclinationDeg) {
  const i = inclinationDeg * DEG;
  const eta = i;
  const alpha = normalRakeDeg * DEG;
  const betaN = Math.atan(Math.tan(frictionAngleDeg * DEG) * Math.cos(eta));
  const denom = Math.cos(betaN - alpha) + Math.tan(i) * Math.tan(eta) * Math.sin(betaN);
  const radial = Math.sin(betaN - alpha) / (Math.cos(i) * denom);
  const axial = (Math.cos(betaN - alpha) * Math.tan(i) - Math.tan(eta) * Math.sin(betaN)) / denom;
  // A real edge always ploughs a little.
  return { radial: Math.max(radial, 0.1), axial };
}

/** Engagement angle for radial depth ae on diameter d, rad. */
export const engagementAngle = (ae, d) => Math.acos(1 - 2 * Math.min(1, Math.max(0, ae / d)));

/**
 * Forces over one revolution of a cutter in a given engagement.
 *
 * @param {object} input
 * @param {{kc11:number, mc:number, frictionAngle:number}} input.material
 * @param {number} input.diameter   nominal diameter, for the helix lag, mm
 * @param {number} input.flutes
 * @param {number} input.helixDeg
 * @param {number} input.rakeDeg
 * @param {number} input.fz         feed per tooth, mm
 * @param {Array<{z:number, dz:number, radius:number, kappa:number,
 *   engaged:(phi:number)=>boolean}>} input.slices  each axial slice of the
 *   flutes: its height above the tip, thickness, cutting radius, lead angle
 *   (rad, π/2 for a straight flank) and which immersion angles have metal
 * @param {number} [input.wearFactor]
 * @param {number} [input.steps] rotation steps per revolution
 * @returns {{peakFxy:number, meanFxy:number, peakFz:number, meanFz:number,
 *   meanTorque:number, peakTorque:number, maxChip:number, teethInCut:number}}
 *   forces in N, torque in N·m, chip thickness in mm
 */
export function simulateEngaged(input) {
  const m = input.material;
  const n = Math.max(1, Math.round(input.flutes || 1));
  const steps = Math.max(36, input.steps || 72);
  const ratios = forceRatios(m.frictionAngle, input.rakeDeg || 0, input.helixDeg || 0);
  const kFactor = m.kc11 * rakeFactor(input.rakeDeg || 0) * (input.wearFactor || 1);
  const exponent = 1 - m.mc;
  const lagPerMm = (2 * Math.tan((input.helixDeg || 0) * DEG)) / Math.max(input.diameter, 1e-6);
  const pitch = (2 * Math.PI) / n;
  const fz = Math.max(input.fz, 0);
  const slices = input.slices;
  const TWO_PI = 2 * Math.PI;

  let sumFxy = 0, peakFxy = 0, sumFz = 0, peakFz = 0, sumT = 0, peakT = 0;
  let maxChip = 0, engagedElements = 0;
  for (let s = 0; s < steps; s++) {
    const theta = (TWO_PI * s) / steps;
    let fx = 0, fy = 0, fzAx = 0, torque = 0;
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < slices.length; k++) {
        const sl = slices[k];
        let phi = (theta + j * pitch - lagPerMm * sl.z) % TWO_PI;
        if (phi < 0) phi += TWO_PI;
        if (phi <= 0 || phi >= Math.PI || !sl.engaged(phi)) continue;
        const sinK = Math.sin(sl.kappa);
        const cosK = Math.cos(sl.kappa);
        const h = fz * Math.sin(phi) * sinK;
        if (h <= 0) continue;
        const width = sl.dz / Math.max(sinK, 1e-3);
        const dFt = kFactor * width * h ** exponent;
        const dFn = ratios.radial * dFt;
        const dFr = dFn * sinK;
        const dFa = dFn * cosK + ratios.axial * dFt;
        fx += -dFt * Math.cos(phi) - dFr * Math.sin(phi);
        fy += dFt * Math.sin(phi) - dFr * Math.cos(phi);
        fzAx += dFa;
        torque += (dFt * sl.radius) / 1000;
        if (h > maxChip) maxChip = h;
        engagedElements++;
      }
    }
    const fxy = Math.hypot(fx, fy);
    sumFxy += fxy;
    if (fxy > peakFxy) peakFxy = fxy;
    sumFz += fzAx;
    if (Math.abs(fzAx) > peakFz) peakFz = Math.abs(fzAx);
    sumT += torque;
    if (torque > peakT) peakT = torque;
  }
  return {
    peakFxy,
    meanFxy: sumFxy / steps,
    peakFz,
    meanFz: sumFz / steps,
    meanTorque: sumT / steps,
    peakTorque: peakT,
    maxChip,
    teethInCut: slices.length ? engagedElements / (steps * slices.length) : 0,
  };
}

/**
 * The straight-cut case, as Shop-Ref computes it: one radial depth, the
 * same arc on every slice, a straight flank. Kept for the cross-check.
 */
export function simulateStraight({ material, diameter, flutes, helixDeg, rakeDeg, leadAngleDeg = 90, ap, ae, fz, climb = true, axialSlices = 40, steps = 360 }) {
  const phiE = engagementAngle(ae, diameter);
  const [st, ex] = climb ? [Math.PI - phiE, Math.PI] : [0, phiE];
  const dz = ap / axialSlices;
  const kappa = Math.min(90, Math.max(5, leadAngleDeg)) * DEG;
  const slices = [];
  for (let k = 0; k < axialSlices; k++) {
    slices.push({ z: (k + 0.5) * dz, dz, radius: diameter / 2, kappa, engaged: (phi) => phi >= st && phi <= ex });
  }
  return simulateEngaged({ material, diameter, flutes, helixDeg, rakeDeg, fz, slices, steps });
}

/**
 * Tip deflection of an end mill as a stepped cantilever clamped in the
 * holder (Shop-Ref Deflection.compute).
 *
 * @returns {{tipDeflection:number, maxBendingStress:number}} mm and MPa
 */
export function deflection({ diameter, shankDiameter, stickout, fluteLength, youngsModulus, force, loadFromTip }, steps = 200) {
  const l = Math.max(stickout, 1e-3);
  const lf = Math.min(Math.max(fluteLength, 0), l);
  const fluteStart = l - lf;
  const de = diameter * 0.8;
  const ds = shankDiameter || diameter;
  const a = Math.min(Math.max(l - loadFromTip, 0), l);
  const inertia = (d) => (Math.PI * d ** 4) / 64;
  const dAt = (x) => (x >= fluteStart ? de : ds);
  const dx = a / steps;
  let tip = 0;
  for (let i = 0; i < steps; i++) {
    const x = (i + 0.5) * dx;
    tip += ((a - x) * (l - x)) / (youngsModulus * inertia(dAt(x))) * dx;
  }
  const stressHolder = (32 * force * a) / (Math.PI * dAt(0) ** 3);
  const stressFlute = (32 * force * Math.max(0, a - fluteStart)) / (Math.PI * de ** 3);
  return { tipDeflection: force * tip, maxBendingStress: Math.max(stressHolder, stressFlute) };
}

/** Young's modulus of a cutter's substrate, MPa (Shop-Ref ToolMaterial). */
export function youngsModulus(toolMaterial) {
  return /hss|high.?speed|cobalt|m42/i.test(String(toolMaterial || '')) ? 210000 : 600000;
}

/** Spindle power for a torque at a speed, kW. */
export const powerKw = (torqueNm, rpm) => (torqueNm * 2 * Math.PI * rpm) / 60 / 1000;
