// Reading a Fusion / HSMWorks tool library.
//
// Fusion 360, HSMWorks and Autodesk CAM all write the same JSON: an object
// with a `data` array, one entry per tool, each carrying a `geometry` block
// keyed by the ISO 13399 short names — DC for cutting diameter, RE for
// corner radius, LCF for the flute length, and so on. It is the format a
// shop's library actually arrives in, so it is worth reading directly
// rather than asking anyone to retype forty tools.
//
// The mapping is lossy in one direction only: Fusion describes more than
// this simulator models (coolant, tool life, per-material presets), and
// what is dropped is metadata rather than geometry. Everything that decides
// where metal is removed — diameter, corner radius, flute and overall
// length, the point or taper angle, the shank — comes across.

import { makeTool } from './toolDefs.js';
import { makeHolder, TAPERS } from './holderDefs.js';
import { makeAssembly } from './assembly.js';
import { MM_PER_INCH, num } from '../core/util.js';

/** Kill the float noise of an inch conversion without losing the value. */
const mm = (v) => Math.round(v * 1e6) / 1e6;

/**
 * Fusion's type strings, in the order they have to be tested.
 *
 * "bull nose end mill" and "ball end mill" both contain "end mill", and a
 * "spot drill" is a chamfer tool rather than a drill, so the specific
 * patterns come first and the general ones last.
 */
const TYPES = [
  [/ball/, 'ball'],
  [/bull|torus|toroid|radius mill|corner radius/, 'bull'],
  [/chamfer|spot|cent(er|re)|countersink|counter sink|engrav|v-?bit|dovetail cham/, 'chamfer'],
  [/taper/, 'taper'],
  [/lollipop|undercut|dovetail|t-?slot/, 'lollipop'],
  [/face|shell/, 'face'],
  [/drill|reamer|\btap\b|bore|boring|counterbore|counter bore/, 'drill'],
  [/slot|thread|flat|square|end ?mill|mill/, 'flat'],
];

/** The entries of a Fusion library, whatever wrapper it arrived in. */
export function fusionEntries(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.tools) && data.tools.some((t) => t && t.geometry)) return data.tools;
  return null;
}

/** Does this look like a Fusion library rather than one of ours? */
export function isFusionLibrary(data) {
  const entries = fusionEntries(data);
  return !!(entries && entries.length && entries.some((e) => e && typeof e === 'object' && (e.geometry || e['post-process'])));
}

const toolType = (type) => {
  const s = String(type || '').toLowerCase();
  for (const [re, kind] of TYPES) if (re.test(s)) return kind;
  return 'flat';
};

/** Fusion writes whole libraries in one unit; entries carry their own. */
const scaleOf = (entry) => (/inch/i.test(entry.unit || '') ? MM_PER_INCH : 1);

/**
 * Turn one Fusion entry into a cutter, a holder and the assembly pairing
 * them.
 *
 * @param {object} entry
 * @returns {{tool:object, holder:object|null, assembly:object}|null}
 */
function convertTool(entry) {
  const g = entry.geometry || {};
  const k = scaleOf(entry);
  const len = (v, fallback) => (Number.isFinite(v) ? mm(v * k) : fallback);

  const type = toolType(entry.type);
  const diameter = len(g.DC, len(g.SFDM, 6));
  if (!(diameter > 0)) return null;

  const flute = len(g.LCF, len(g['shoulder-length'], diameter * 2));
  const overall = Math.max(len(g.OAL, flute * 3), flute + 1);
  const taper = num(g.TA, 0);

  const number = Math.max(1, Math.round(num((entry['post-process'] || {}).number, 1)));
  const tool = makeTool({
    name: toolName(entry, diameter, type),
    type,
    number,
    diameter,
    cornerRadius: len(g.RE, 0),
    tipDiameter: len(g['tip-diameter'], 0),
    // A drill carries its point angle as SIG; a chamfer mill carries the
    // angle of one flank as TA, which is half of the included angle.
    tipAngle: Number.isFinite(g.SIG) ? g.SIG : (taper > 0 ? Math.max(180 - 2 * taper, 1) : 90),
    taperAngle: taper,
    fluteLength: flute,
    fluteCount: Math.max(1, Math.round(num(g.NOF, 2))),
    shankDiameter: len(g.SFDM, diameter),
    neckDiameter: len(g['neck-diameter'], 0),
    neckLength: len(g['neck-length'], 0),
    overallLength: overall,
    material: /hss|high speed/i.test(entry.BMC || '') ? 'hss' : 'carbide',
    notes: [entry.vendor, entry['product-id'], entry.description].filter(Boolean).join(' · '),
    cutting: cuttingFrom(entry, k),
  });

  const holder = convertHolder(entry, k);
  const assembly = makeAssembly({
    name: `T${number} · ${tool.name}`,
    number,
    toolId: tool.id,
    holderId: holder ? holder.id : '',
    // Fusion's body length is the tool below the holder, which is exactly
    // what stickout means here.
    stickout: len(g.LB, len(g.assemblyGaugeLength, flute * 1.4)),
  });

  return { tool, holder, assembly };
}

/** The name to show: what the library says, or what the geometry is. */
function toolName(entry, diameter, type) {
  const given = [entry.description, entry.vendor && entry['product-id'] ? `${entry.vendor} ${entry['product-id']}` : entry['product-id']]
    .map((s) => String(s || '').trim())
    .find(Boolean);
  if (given) return given;
  const d = diameter >= 10 ? diameter.toFixed(1) : diameter.toFixed(2);
  const label = String(entry.type || type).replace(/\bend mill\b/i, '').trim() || type;
  return `Ø${d} ${label}`;
}

/** Speeds and feeds from the first preset, converted to mm/min. */
function cuttingFrom(entry, k) {
  const preset = ((entry['start-values'] || {}).presets || [])[0];
  if (!preset) return undefined;
  const out = {};
  if (Number.isFinite(preset.n)) out.rpm = Math.round(preset.n);
  if (Number.isFinite(preset.v_f)) out.feed = Math.round(preset.v_f * k);
  if (Number.isFinite(preset.v_f_plunge)) out.plunge = Math.round(preset.v_f_plunge * k);
  if (Number.isFinite(preset.stepdown)) out.doc = mm(preset.stepdown * k);
  if (Number.isFinite(preset.stepover)) out.woc = mm(preset.stepover * k);
  return Object.keys(out).length ? out : undefined;
}

/**
 * The holder, when the entry carries one.
 *
 * Fusion describes a holder as a stack of truncated cones, which is the
 * same model used here — only the order is not guaranteed, so the stack is
 * turned nose-first by looking at which end is wider. Holders taper
 * outwards away from the tool, so the narrow end is the nose.
 */
function convertHolder(entry, k) {
  const segments = (entry.holder && entry.holder.segments)
    || (entry['tool-block'] && entry['tool-block'].segments)
    || (entry.geometry && entry.geometry.segments);
  if (!Array.isArray(segments) || !segments.length) return null;

  let stages = segments.map((s) => ({
    dia: mm(num(s['lower-diameter'], num(s.diameter, 20)) * k),
    topDia: mm(num(s['upper-diameter'], num(s['lower-diameter'], num(s.diameter, 20))) * k),
    length: Math.max(mm(num(s.height, num(s.length, 10)) * k), 0.1),
  }));
  const first = Math.max(stages[0].dia, stages[0].topDia);
  const last = Math.max(stages[stages.length - 1].dia, stages[stages.length - 1].topDia);
  if (first > last) {
    stages = stages.reverse().map((s) => ({ dia: s.topDia, topDia: s.dia, length: s.length }));
  }

  const text = `${entry.holder && entry.holder.description || ''} ${entry.description || ''}`;
  const taper = Object.keys(TAPERS).find((t) => t !== 'none' && new RegExp(t.replace(/(\d+)/, '[- ]?$1'), 'i').test(text)) || 'none';

  return makeHolder({
    name: (entry.holder && entry.holder.description) || `Holder for ${entry.description || 'imported tool'}`,
    type: 'custom',
    taper,
    stages,
  });
}

/** A standalone holder entry, as a Fusion holder library writes them. */
function convertHolderEntry(entry, k) {
  const segments = (entry.geometry && entry.geometry.segments) || entry.segments;
  if (!Array.isArray(segments) || !segments.length) return null;
  return convertHolder({ holder: { segments, description: entry.description }, description: entry.description }, k);
}

/**
 * Read a Fusion library.
 *
 * @param {object|Array} data parsed JSON
 * @returns {{tools:object[], holders:object[], assemblies:object[]}|null}
 *   null when the file is not a Fusion library at all.
 */
export function fromFusion(data) {
  const entries = fusionEntries(data);
  if (!entries) return null;

  const tools = [];
  const holders = [];
  const assemblies = [];
  const seen = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const k = scaleOf(entry);

    if (/^holder/i.test(entry.type || '') || (!entry.geometry?.DC && !entry.geometry?.SFDM && (entry.geometry?.segments || entry.segments))) {
      const h = convertHolderEntry(entry, k);
      if (h) holders.push(h);
      continue;
    }

    const converted = convertTool(entry);
    if (!converted) continue;
    tools.push(converted.tool);
    if (converted.holder) holders.push(converted.holder);
    // Two tools sharing a T number is normal in a library that was never
    // meant as a tool table; the second one keeps its cutter and gets the
    // next free number rather than silently shadowing the first.
    while (seen.has(converted.assembly.number)) converted.assembly.number += 1;
    seen.add(converted.assembly.number);
    assemblies.push(converted.assembly);
  }

  if (!tools.length && !holders.length) return null;
  return { tools, holders, assemblies };
}
