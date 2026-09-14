// Tool assemblies: cutter + holder + stickout, resolved into the two
// envelopes the simulator actually consumes.
//
//   cutEnvelope  – the flutes. Anything below it gets removed from stock.
//   bodyEnvelope – shank, neck, holder and spindle nose. Anything that
//                  reaches this is a crash, not a cut.

import { buildEnvelope, dedupe } from './envelope.js';
import { silhouetteSpheres } from '../sim/collision.js';
import { buildTool } from './toolDefs.js';
import { buildHolder } from './holderDefs.js';
import { num, uid } from '../core/util.js';

export const DEFAULT_ASSEMBLY = {
  id: '',
  name: 'New assembly',
  toolId: '',
  holderId: '',
  stickout: 35,
  number: 1,
  lengthOffset: null, // machine H-offset; null = derived from geometry
  notes: '',
};

export function makeAssembly(patch = {}) {
  return { ...DEFAULT_ASSEMBLY, ...patch, id: patch.id || uid('asm') };
}

/** Truncate a silhouette polyline at `zMax`, interpolating the crossing. */
export function clipSilhouette(points, zMax) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.z <= zMax) {
      out.push({ r: p.r, z: p.z });
      continue;
    }
    const prev = points[i - 1];
    if (prev && prev.z < zMax) {
      const t = (zMax - prev.z) / (p.z - prev.z);
      out.push({ r: prev.r + (p.r - prev.r) * t, z: zMax });
    }
    break;
  }
  return out;
}

function shift(points, dz) {
  return points.map((p) => ({ r: p.r, z: p.z + dz }));
}

/**
 * Resolve an assembly definition into geometry and envelopes.
 *
 * @param {object} asmDef
 * @param {object} toolDef
 * @param {object} holderDef  may be null for a bare cutter
 * @param {{spindleDiameter?:number, spindleLength?:number}} [machine]
 */
export function buildAssembly(asmDef, toolDef, holderDef, machine = {}) {
  const asm = { ...DEFAULT_ASSEMBLY, ...asmDef };
  const warnings = [];
  const tool = buildTool(toolDef || {});
  warnings.push(...tool.warnings.map((w) => `Tool: ${w}`));

  let stickout = num(asm.stickout, tool.fluteLength * 1.4);
  const minStickout = tool.fluteLength + 0.5;
  if (stickout < minStickout) {
    stickout = minStickout;
    warnings.push('Stickout is shorter than the flute length; the holder would sit on the flutes. Clamped.');
  }
  const maxStickout = tool.length - 5;
  if (holderDef && stickout > maxStickout) {
    stickout = Math.max(maxStickout, minStickout);
    warnings.push('Stickout exceeds the tool length minus a 5 mm grip; clamped.');
  }

  // Visible part of the cutter: everything below the holder nose.
  const toolVisible = dedupe(clipSilhouette(tool.silhouette, stickout));

  let holderPoints = [];
  let holder = null;
  let holderNoseZ = stickout;
  let totalLength = tool.length;

  if (holderDef) {
    holder = buildHolder(holderDef);
    warnings.push(...holder.warnings.map((w) => `Holder: ${w}`));
    holderPoints = shift(holder.points, stickout);
    totalLength = stickout + holder.length;
    const noseR = holder.noseDia / 2;
    const shankR = num(tool.def.shankDiameter, tool.def.diameter) / 2;
    if (noseR < shankR - 1e-6) {
      warnings.push(`Holder bore (Ø${holder.noseDia}) is smaller than the tool shank (Ø${(shankR * 2).toFixed(2)}).`);
    }
  }

  // The spindle nose starts exactly at the gauge line — the holder's top
  // face — so the two mate with no gap. Everything above the gauge line on
  // a real holder is inside this cylinder, which is why it is not drawn.
  // The nose is part of the crash model so a plunge that buries the spindle
  // still gets caught.
  const spindleDia = num(machine.spindleDiameter, 0);
  const spindleLen = num(machine.spindleLength, 0);
  let spindlePoints = [];
  if (spindleDia > 0 && spindleLen > 0) {
    const sr = spindleDia / 2;
    const gauge = totalLength;
    spindlePoints = [
      { r: 0, z: gauge },          // nose face, closed so it exports as a solid
      { r: sr, z: gauge },
      { r: sr, z: gauge + spindleLen },
      { r: 0, z: gauge + spindleLen },
    ];
    totalLength += spindleLen;
  }

  // Body = everything that must never touch material. It is kept as two
  // envelopes because "the shank is rubbing" and "the holder is buried"
  // are different problems with different fixes.
  // The shank envelope is extended by a thin disc at the top of the flutes
  // spanning the cutter's own footprint. Without it a plain end mill — whose
  // shank is exactly the cutting diameter — can bury itself in a slot far
  // deeper than its flutes and nothing geometric ever intersects. Material
  // standing above that disc is material the flutes cannot reach.
  const engageR = Math.max(tool.radius * 1.02, 0.02);
  const shankPoints = dedupe([
    { r: 0, z: tool.fluteLength },
    { r: engageR, z: tool.fluteLength },
    ...clipSilhouette(tool.bodyPoints, stickout),
  ]);
  const abovePoints = dedupe([...holderPoints, ...spindlePoints]);
  const bodyOnly = dedupe([...shankPoints, ...abovePoints]);

  return {
    def: { ...asm, stickout },
    tool,
    holder,
    stickout,
    holderNoseZ,
    totalLength,
    toolPoints: toolVisible,
    holderPoints,
    spindlePoints,
    cutEnvelope: tool.cutEnvelope,
    // A wide body (spindle nose) stretches the r^2 table, so sample it finer.
    bodyEnvelope: buildEnvelope(bodyOnly, 2048),
    shankEnvelope: buildEnvelope(shankPoints),
    holderEnvelope: buildEnvelope(abovePoints, 2048),
    // The same two solids as sphere chains. An envelope is a profile
    // measured up the tool axis, which is only a shape in space while that
    // axis is vertical; once the head leans, the body has to be carried
    // along the axis it actually stands on, and a chain of spheres is what
    // can be moved like that.
    shankSpheres: silhouetteSpheres(shankPoints),
    holderSpheres: silhouetteSpheres(abovePoints),
    shankPoints,
    cutRadius: tool.radius,
    bodyRadius: bodyOnly.reduce((m, p) => Math.max(m, p.r), 0),
    fluteLength: tool.fluteLength,
    /**
     * Tip to gauge line: the holder's mating face with the spindle nose,
     * and the length a control would hold as the tool-length offset.
     */
    gaugeLength: holder ? stickout + holder.length : tool.length,
    warnings,
  };
}

/** Human-readable one-line description, used in lists and the HUD. */
export function describeAssembly(built) {
  const t = built.tool.def;
  const dia = (built.cutRadius * 2).toFixed(built.cutRadius * 2 < 10 ? 2 : 1);
  const kind = t.type === 'ball' ? 'ball' : t.type === 'bull' ? `R${t.cornerRadius}` : t.type;
  return `Ø${dia} ${kind} · ${t.fluteCount}F · ${built.stickout.toFixed(0)}mm out`;
}
