// Reading a tool library out of Siemens NX.
//
// NX keeps its tools as plain text, which is the whole reason this is
// possible without asking anyone to retype forty cutters. Two shapes of
// text arrive:
//
//   * The ASCII tool library itself — `tool_database.dat` and its
//     neighbours under MACH/resource/library/tool/metric. Records are
//     pipe-delimited and begin with a keyword: CLASS names the family that
//     follows, FORMAT names the columns, DATA is a tool. NX ships more
//     keywords than that (VERSION, LIBRF, END) and they are skipped rather
//     than argued with.
//
//   * A spreadsheet. Whatever route a shop uses to get a tool list out —
//     Shop Documentation, a journal, copy and paste — it lands as CSV or
//     tab-separated text with a header row, and that is the same problem
//     once the delimiter is known.
//
// Both reduce to a list of records keyed by column name, so there is one
// mapping from a record to a cutter rather than one per file format. The
// column names are matched loosely: NX writes FLUTE_LN where ISO 13399
// writes LCF and a spreadsheet writes "Flute Length", and all three mean
// the same length.
//
// What cannot be read from text is the unit. An NX library is metric or
// english by which directory it lives in, and a spreadsheet says nothing
// at all, so the caller states it.

import { makeTool } from './toolDefs.js';
import { makeAssembly } from './assembly.js';
import { MM_PER_INCH } from '../core/util.js';

/** Kill the float noise of an inch conversion without losing the value. */
const mm = (v) => Math.round(v * 1e6) / 1e6;

/** Column names are matched on letters and digits only. */
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What each cutter parameter can be called.
 *
 * First match wins, so the specific names come before the vague ones:
 * "length" on its own is the overall length, but "fluteLength" has already
 * taken FLUTE_LN by then.
 */
const COLUMNS = {
  number: ['toolnumber', 'tnumber', 'toolnum', 'tlnum', 'tnum', 'tool', 'tno', 'number', 'pot', 'adjustregister', 't'],
  name: ['descr', 'description', 'toolname', 'name', 'librf', 'libraryreference', 'tllibrf', 'label'],
  type: ['ugtype', 'tooltype', 'subtype', 'type', 'class', 'tlclass'],
  diameter: ['tldiameter', 'diameter', 'cuttingdiameter', 'cutterdia', 'tooldia', 'tooldiameter', 'dia', 'dc', 'd'],
  cornerRadius: ['tlcor1rad', 'cor1rad', 'corrad', 'cornerradius', 'cornerrad', 'cornerr', 're', 'radius'],
  tipDiameter: ['tltipdia', 'tipdia', 'tipdiameter', 'lowerdia', 'pointdia'],
  tipAngle: ['tltipangle', 'tipangle', 'pointangle', 'includedangle', 'sig'],
  taperAngle: ['tltaperang', 'taperang', 'taperangle', 'ta'],
  fluteLength: ['tlflutel', 'tlflutelen', 'flutel', 'fluteln', 'flutelength', 'cuttinglength', 'lcf', 'loc'],
  fluteCount: ['tlnumflutes', 'numflutes', 'flutes', 'numteeth', 'teeth', 'nof', 'z'],
  shankDiameter: ['tlshankdia', 'shankdia', 'shankdiameter', 'shank', 'sfdm'],
  neckDiameter: ['tlneckdia', 'neckdia', 'neckdiameter'],
  neckLength: ['tlneckln', 'neckln', 'necklength'],
  overallLength: ['tlheight', 'height', 'overalllength', 'toollength', 'oal', 'length', 'tllength'],
  material: ['matref', 'material', 'toolmaterial', 'bmc'],
  holder: ['holderlibrf', 'holderlibref', 'holder', 'hldlibrf', 'holderref'],
  stickout: ['stickout', 'gaugelength', 'projection', 'zoffset'],
  rpm: ['spindlespeed', 'speed', 'rpm', 'surfacespeed'],
  feed: ['feedrate', 'cutfeed', 'feed', 'feedpertooth'],
};

/**
 * NX type strings, in the order they have to be tested.
 *
 * NX names a family both in words ("Ball Mill", "Spot Drill") and as a
 * subtype code in the UGTYPE column — 01 is milling, 02 drilling — so both
 * are recognised. The specific patterns come first: a spot drill is a
 * chamfer tool rather than a drill, and "bull" and "ball" both contain
 * "mill".
 */
const TYPES = [
  [/ball|sphere|sphericalmill/, 'ball'],
  [/bull|torus|toroid|cornerrad|radiusmill/, 'bull'],
  [/chamfer|spot|cent(er|re)|countersink|engrav|v-?bit/, 'chamfer'],
  [/barrel|taper/, 'taper'],
  [/t-?cutter|t-?slot|lollipop|undercut|dovetail/, 'lollipop'],
  [/face|shell/, 'face'],
  [/drill|reamer|\btap\b|\bbore\b|boring|counterbore/, 'drill'],
  [/mill|\bend\b|flat/, 'flat'],
];

/**
 * One tool's family, from whatever the file says about it.
 *
 * @param {string} text the type, subtype and description run together
 * @param {{diameter:number, cornerRadius:number}} geom what it measures,
 *   which decides between a flat, a bull and a ball when the words do not
 */
export function nxToolType(text, geom) {
  const s = String(text || '').toLowerCase().replace(/[\s_]/g, '');
  let word = null;
  for (const [re, kind] of TYPES) {
    if (re.test(s)) { word = kind; break; }
  }
  if (!word && /^0?2[_-]?\d*$/.test(s)) return 'drill';  // UGTYPE 02: drilling
  if (word && word !== 'flat') return word;

  // "MILL" is what NX calls every cutter in the milling class, so on its
  // own it says nothing about the end. The corner radius does: half the
  // diameter is a ball nose, anything less is a bull nose, none is flat.
  const { diameter = 0, cornerRadius = 0 } = geom || {};
  if (cornerRadius > 0 && cornerRadius >= diameter / 2 - 1e-6) return 'ball';
  if (cornerRadius > 0) return 'bull';
  return 'flat';
}

/**
 * Split a line of a spreadsheet, honouring quotes.
 *
 * A description with a comma in it — "6mm, 3 flute" — is one field, and a
 * library that has been round-tripped through Excel will have quoted it.
 */
function splitRow(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** The separator a spreadsheet used, decided by which one lines up. */
function delimiterOf(lines) {
  let best = null;
  for (const sep of ['\t', ',', ';', '|']) {
    const counts = lines.slice(0, 8).map((l) => splitRow(l, sep).length);
    const n = counts[0];
    if (n < 3) continue;
    const steady = counts.filter((c) => c === n).length;
    if (!best || steady > best.steady || (steady === best.steady && n > best.n)) best = { sep, n, steady };
  }
  return best ? best.sep : null;
}

/**
 * Every tool in the text, as records keyed by column name.
 *
 * @param {string} text
 * @returns {object[]}
 */
export function nxRecords(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  // An NX ASCII library: keyword-led, pipe-delimited records. FORMAT names
  // the columns for every DATA line after it, and CLASS names the family
  // those tools belong to — which is often the only place the word "DRILL"
  // appears, so it is carried onto each record.
  if (lines.some((l) => /^DATA\s*\|/i.test(l))) {
    const out = [];
    let columns = null;
    let family = '';
    for (const line of lines) {
      if (/^[#!]/.test(line)) continue;
      const cells = splitRow(line, '|');
      const keyword = cells[0].toUpperCase();
      if (keyword === 'FORMAT') {
        // NX writes the column names with the type and width appended —
        // DIAMETER|REAL|6.4 — or in parentheses. Either way the name is
        // the leading run of letters, digits and underscores.
        columns = cells.slice(1)
          .map((c) => (c.match(/[A-Za-z_][A-Za-z0-9_ ]*/) || [''])[0].trim())
          .filter((c, i, all) => c !== '' || i < all.length);
      } else if (keyword === 'CLASS') {
        family = cells.slice(1).filter(Boolean).join(' ');
      } else if (keyword === 'DATA' && columns) {
        const rec = { _class: family };
        for (let i = 0; i < columns.length; i++) {
          if (columns[i]) rec[columns[i]] = cells[i + 1] !== undefined ? cells[i + 1] : '';
        }
        out.push(rec);
      }
    }
    if (out.length) return out;
  }

  // A spreadsheet: a header row and then one tool per line.
  const sep = delimiterOf(lines);
  if (!sep) return [];
  const header = splitRow(lines[0], sep);
  // A header row is words, not numbers.
  if (header.filter((h) => h && !/^-?[\d.]+$/.test(h)).length < 2) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = splitRow(line, sep);
    if (cells.length < 2 || cells.every((c) => c === '')) continue;
    const rec = { _class: '' };
    for (let i = 0; i < header.length; i++) if (header[i]) rec[header[i]] = cells[i] !== undefined ? cells[i] : '';
    out.push(rec);
  }
  return out;
}

/** Does this text look like something we can read tools out of? */
export function isNXText(text) {
  const recs = nxRecords(text);
  if (!recs.length) return false;
  return recs.some((r) => Number.isFinite(pick(r, 'diameter')));
}

/**
 * One value out of a record, by what it means rather than what it is
 * called.
 *
 * @param {object} rec
 * @param {string} field a key of COLUMNS
 */
function pick(rec, field) {
  const wanted = COLUMNS[field] || [];
  const index = new Map();
  for (const k of Object.keys(rec)) {
    const kk = key(k);
    if (!index.has(kk)) index.set(kk, rec[k]);
  }
  for (const name of wanted) {
    if (!index.has(name)) continue;
    const raw = String(index.get(name)).trim();
    if (raw === '') continue;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return undefined;
}

/** Same, but only when it is a number. */
const number = (rec, field, fallback) => {
  const v = pick(rec, field);
  return Number.isFinite(v) ? v : fallback;
};

/** Same, but only when it is text. */
const textOf = (rec, field) => {
  const v = pick(rec, field);
  return v === undefined ? '' : String(v);
};

/**
 * Turn NX text into a library.
 *
 * @param {string} text the file, as it came off disk
 * @param {{units?:'mm'|'in'}} [opts] the unit the numbers are in, which no
 *   NX text states: a library is metric or english by the directory it
 *   lives in, and a spreadsheet says nothing.
 * @returns {null|{tools:object[], holders:object[], assemblies:object[],
 *                 skipped:number}}
 */
export function fromNX(text, { units = 'mm' } = {}) {
  const recs = nxRecords(text);
  if (!recs.length) return null;
  const k = units === 'in' ? MM_PER_INCH : 1;
  const len = (v) => (Number.isFinite(v) ? mm(v * k) : undefined);

  const tools = [];
  const assemblies = [];
  const taken = new Set();
  let skipped = 0;

  for (const rec of recs) {
    const diameter = len(number(rec, 'diameter', NaN));
    // A row with no diameter is a header, a blank or a holder — not a
    // cutter, and guessing one would put a tool in the library that
    // nobody owns.
    if (!(diameter > 0)) { skipped++; continue; }

    const cornerRadius = Math.min(len(number(rec, 'cornerRadius', 0)) || 0, diameter / 2);
    const type = nxToolType(
      [textOf(rec, 'type'), rec._class, textOf(rec, 'name')].filter(Boolean).join(' '),
      { diameter, cornerRadius },
    );
    const fluteLength = Math.max(len(number(rec, 'fluteLength', 0)) || diameter * 2, 0.1);
    const overall = Math.max(len(number(rec, 'overallLength', 0)) || fluteLength * 3, fluteLength + 1);
    const taperAngle = number(rec, 'taperAngle', 0) || 0;
    // NX leaves the tip angle at 0 on a cutter that has no point. A drill
    // without one is a 118° drill, which is what is in the drawer.
    const tipAngle = number(rec, 'tipAngle', 0) || (type === 'drill' ? 118 : (taperAngle > 0 ? Math.max(180 - 2 * taperAngle, 1) : 90));

    let n = Math.max(1, Math.round(number(rec, 'number', 0) || 0)) || (tools.length + 1);
    while (taken.has(n)) n++;
    taken.add(n);

    const name = textOf(rec, 'name').trim()
      || `Ø${diameter >= 10 ? diameter.toFixed(1) : diameter.toFixed(2)} ${type}`;

    const tool = makeTool({
      name,
      type,
      number: n,
      diameter,
      cornerRadius,
      tipDiameter: len(number(rec, 'tipDiameter', 0)) || 0,
      tipAngle,
      taperAngle,
      fluteLength,
      fluteCount: Math.max(1, Math.round(number(rec, 'fluteCount', 0) || 2)),
      shankDiameter: len(number(rec, 'shankDiameter', 0)) || diameter,
      neckDiameter: len(number(rec, 'neckDiameter', 0)) || 0,
      neckLength: len(number(rec, 'neckLength', 0)) || 0,
      overallLength: overall,
      material: /hss|high.?speed/i.test(textOf(rec, 'material')) ? 'hss' : 'carbide',
      notes: [rec._class, textOf(rec, 'material'), textOf(rec, 'holder')].filter(Boolean).join(' · '),
      cutting: cuttingFrom(rec, k),
    });
    tools.push(tool);

    assemblies.push(makeAssembly({
      name: `T${n} · ${tool.name}`,
      number: n,
      toolId: tool.id,
      holderId: '',
      // NX states a projection on the holder rather than on the tool, so
      // unless the sheet carries one the stickout is taken as enough to
      // clear the flutes — which is what the operator would set.
      stickout: len(number(rec, 'stickout', 0)) || mm(Math.max(fluteLength * 1.4, fluteLength + 5)),
    }));
  }

  if (!tools.length) return null;
  return { tools, holders: [], assemblies, skipped };
}

/** Speeds and feeds, when the sheet carries them. */
function cuttingFrom(rec, k) {
  const out = {};
  const rpm = number(rec, 'rpm', 0);
  const feed = number(rec, 'feed', 0);
  if (rpm > 0) out.rpm = Math.round(rpm);
  if (feed > 0) out.feed = Math.round(feed * k);
  return Object.keys(out).length ? out : undefined;
}
