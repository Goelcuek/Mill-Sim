// G-code tokenizer.
//
// Splits a program into blocks (lines) of address/value words while
// preserving the original line numbers, which the UI needs to highlight
// the currently executing line and to report collisions.

const WORD_RE = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;

/**
 * A name, rather than a number: `M98 <ROUGH>`, `CALL "ROUGH"`.
 *
 * Only Fanuc insists that a program is a number. A control that saves its
 * files under names calls them by those names, so the name is lifted out of
 * the block before anything tries to read it as arithmetic or as junk.
 */
const NAME_RE = /<([^<>]*)>|"([^"]*)"|'([^']*)'/g;

/** A bare word: CALL, EXTCALL, or the name of a file on controls that ask for it that way. */
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_.\-]*/g;

import { hasMacroSyntax, parseMacroBlock, usesBrackets, FUNCTION_NAMES } from './macro.js';
import { DIALECTS } from './dialects.js';

/**
 * @typedef {{ letter:string, value:number, text:string }} Word
 * @typedef {{ line:number, raw:string, words:Word[], comments:string[],
 *             blockDelete:boolean, skipped:boolean, error?:string }} Block
 */

/**
 * Strip comments, returning the cleaned code and the comment texts.
 *
 * Which marks are comments is the control's business: most read `( … )` as
 * a remark, and Siemens reads it as arithmetic and takes only `;`. Getting
 * that wrong turns `X=SIN(30)` into a comment, so it is asked rather than
 * assumed.
 */
export function stripComments(line, dialect) {
  const d = dialect || DIALECTS.fanuc;
  const lineMarks = d.lineComments || [';'];
  // Some controls write both a remark and a condition in round brackets.
  // Which this is depends on whether the block is a condition, so it is
  // asked rather than assumed: eating the brackets off an IF leaves a
  // block that says "if" and nothing else.
  const parens = d.parenComments === 'code'
    ? !usesBrackets(line, d)
    : d.parenComments !== false;
  const comments = [];
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '(' && parens) {
      depth++;
      let text = '';
      i++;
      while (i < line.length && depth > 0) {
        if (line[i] === '(') depth++;
        else if (line[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
        text += line[i];
        i++;
      }
      comments.push(text.trim());
      continue;
    }
    const mark = lineMarks.find((m) => line.startsWith(m, i));
    if (mark) {
      comments.push(line.slice(i + mark.length).trim());
      break;
    }
    out += c;
  }
  return { code: out, comments };
}

/**
 * Tokenize a whole program.
 * @param {string} text
 * @returns {Block[]}
 */
export function lex(text, dialect) {
  const d = dialect || DIALECTS.fanuc;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const { code, comments } = stripComments(raw, d);
    let body = code.trim();

    // A Siemens file by its name on the control:
    // /_N_CUS_DIR/_N_BLUM_DIR/_N_SUB2006_SPF. The folders are the control's
    // business, and the file is the last part — so the path is cut down to
    // it before anything else reads the block, or its leading / would skip
    // the block and SUB2006 would give up a B2006.
    if (d.siemensWords) body = body.replace(/\/?(?:_N_\w+?_DIR\/)+(?=_N_\w+?_[SM]PF\b)/gi, '');

    let blockDelete = false;
    if (body.startsWith('/')) {
      blockDelete = true;
      body = body.slice(1).trim();
    }

    // What a Siemens block says in words of its own — a cycle called like
    // a function, a frame, TRAORI, T="NAME", C=DC(90) — taken out before
    // the rest is read, and carried on the block for the interpreter.
    let extra = null;
    if (d.siemensWords) {
      const pre = siemensWords(body, d);
      body = pre.body;
      extra = pre.extra;
    }
    const pushBlock = (blk) => blocks.push(extra ? Object.assign(blk, extra) : blk);

    // "Do this now": a mark in front of a line on the controls that have
    // one. It says when the block runs, not what it does, so the reader
    // takes it off and reads the rest as it always would.
    if (d.direct && body.startsWith(d.direct)) body = body.slice(d.direct.length).trim();

    // Arguments in braces after an M code — M520{%1=2 %4=2} — are the
    // control's own macro call. The M code is reported; what it was handed
    // is not modelled, and leaving the braces in would only read as junk.
    if (d.braceArgs && body.includes('{')) body = body.replace(/\{[^}]*\}/g, ' ');

    // A file this control asks for by name. The path in front of it is the
    // control's own; what matters is which file, so the name is taken and
    // the rest left where it is.
    if (d.call && d.call.line) {
      const asks = new RegExp(d.call.line, 'i').exec(body);
      if (asks) {
        const name = asks[1].trim().split(/[\\/]/).pop();
        pushBlock({
          line: i + 1,
          raw,
          words: [],
          comments,
          names: [name],
          idents: [],
          macro: { assigns: [], control: null, label: null, call: true },
          blockDelete,
          skipped: false,
        });
        continue;
      }
    }

    // A line that fills in one of the machine's own tables — the tool
    // table, on a Fidia — rather than saying anything about the part. It is
    // recorded and skipped whole: read word by word it is a page of
    // nonsense coordinates on a program that is perfectly correct. See the
    // `settings` note in dialects.js.
    if (d.settings && d.settings.length) {
      const set = settingIn(body, d.settings);
      if (set) {
        pushBlock({
          line: i + 1, raw, words: [], comments, names: [], idents: [],
          setting: set, blockDelete, skipped: false,
        });
        continue;
      }
    }

    // Program start/end markers and O-numbers carry no motion.
    // %_N_PART_MPF: the name a Siemens file carries on its first line.
    if (body === '%' || (d.siemensWords && /^%_N_\w+$/i.test(body))) {
      pushBlock({ line: i + 1, raw, words: [], comments, blockDelete, skipped: false, marker: true });
      continue;
    }

    // Names come out first, whichever reader the rest of the block goes to:
    // what is inside the quotes is a file, not an expression.
    const names = [];
    body = body.replace(NAME_RE, (all, angle, dq, sq, at, whole) => {
      // Text given to a variable — NAME="ROUGH", IF PART=="A" — is a value,
      // not a file: it stays in the block for the macro reader.
      if (d.namedVariables && dq !== undefined && /=\s*$/.test(whole.slice(0, at))) return all;
      const name = (angle !== undefined ? angle : dq !== undefined ? dq : sq).trim();
      if (name) names.push(name);
      return ' '.repeat(all.length);
    });

    // A block that uses variables, brackets or the macro keywords is read
    // by the macro parser instead. Everything else takes the path it
    // always took, which is most blocks in most programs.
    if (hasMacroSyntax(body, d)) {
      const macro = parseMacroBlock(body, d);
      pushBlock({
        line: i + 1,
        raw,
        words: macro.words,
        comments,
        names,
        blockDelete,
        skipped: false,
        macro: { assigns: macro.assigns, control: macro.control, label: macro.label, call: macro.call, defs: macro.defs || [] },
        error: macro.error,
      });
      continue;
    }

    const words = [];
    // What the words did not take. Blanking each one where it stood keeps
    // the rest in order, so `CALL ROUGH` does not come back as `CALLROUGH`.
    let rest = body;

    // A word in its own right: RTCP ON, ORIGIN 4. Read before the letters
    // are, because ORIGIN 4 taken letter by letter is an N word of 4.
    let command = null;
    if (d.commands && d.commands.length) {
      const name = d.commands.find((w) => new RegExp(`^${w}\\b`, 'i').test(body));
      if (name) {
        const tail = body.slice(name.length).trim();
        const num = /^-?\d+(\.\d+)?$/.exec(tail.split(/\s+/)[0] || '');
        command = { name: name.toUpperCase(), text: tail, value: num ? Number(num[0]) : null };
        pushBlock({
          line: i + 1, raw, words: [], comments, names, idents: [], command, blockDelete, skipped: false,
        });
        continue;
      }
    }

    // Addresses of more than one letter — DX, DY, DZ — taken first, or the
    // X in DX would be read as an X word and put the tool somewhere else
    // entirely.
    if (d.addresses && d.addresses.length) {
      const re = new RegExp(`(${d.addresses.join('|')})\\s*([+-]?(?:\\d+\\.?\\d*|\\.\\d+))`, 'gi');
      rest = rest.replace(re, (all, letter, value, at) => {
        words.push({ letter: letter.toUpperCase(), value: parseFloat(value), text: all, at });
        return ' '.repeat(all.length);
      });
    }

    let m;
    WORD_RE.lastIndex = 0;
    const scan = rest;
    while ((m = WORD_RE.exec(scan)) !== null) {
      words.push({ letter: m[1].toUpperCase(), value: parseFloat(m[2]), text: m[0] });
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }

    // Whatever is left is either a name — the call word of a control that
    // spells one, or the name of a file — or text this reader cannot read.
    // Which of the two is a question about the machine's subprograms, so it
    // is left to the interpreter and only the symbols are judged here.
    const idents = rest.match(IDENT_RE) || [];
    const junk = rest.replace(IDENT_RE, '').replace(/\s+/g, '');
    const error = junk.length ? `Unrecognised text: ${junk.slice(0, 24)}` : undefined;

    pushBlock({ line: i + 1, raw, words, comments, names, idents, blockDelete, skipped: false, error });
  }

  return blocks;
}

/**
 * Words a mode is spelled with on a Siemens, rather than a G code. Each is
 * taken out of the block wherever it stands — SOFT or FFWON sit on motion
 * blocks — and handed to the interpreter by name; TRAORI may carry a
 * transformation number in brackets.
 */
const SIEMENS_MODES = [
  'TRAORI', 'TRAFOOF', 'DIAMOF', 'DIAMON', 'DIAM90', 'SUPA',
  'ORIWKS', 'ORIMKS', 'ORIAXES', 'ORIVECT', 'ORIEULER', 'ORIRPY', 'ORIPLANE', 'ORICONCW', 'ORICONCCW',
  'SOFT', 'BRISK', 'FFWON', 'FFWOF', 'CFC', 'CFTCP', 'CFIN', 'COMPCAD', 'COMPCURV', 'COMPSURF', 'COMPON', 'COMPOF',
  'STOPRE', 'TOFRAME', 'TOROT', 'TOROTOF', 'PAROT', 'PAROTOF', 'UPATH', 'SPATH',
];
const MODES_RE = new RegExp(`\\b(${SIEMENS_MODES.join('|')})\\b(?:\\s*\\(\\s*[^()]*\\))?`, 'gi');
/** The frame words: each a block of its own, its axes the frame's numbers. */
const FRAMES_RE = /^(ROT|AROT|TRANS|ATRANS|SCALE|ASCALE|MIRROR|AMIRROR)\b/i;
/** How a single axis value may be qualified: C=DC(90), X=IC(10). */
const VALUE_MODE_RE = /\b([A-Za-z][A-Za-z0-9]*)\s*=\s*(DC|ACP|ACN|AC|IC)\s*\(/gi;

/**
 * A call written as a function that ends the block — NAME( … ) with the
 * bracket closing last — or null. A name starts with two letters or an
 * underscore, so M00 (CHECK) is an M word, and the functions an expression
 * uses (SIN, COS) are not calls.
 */
function trailingCall(text) {
  const t = text.trim();
  const re = /([A-Za-z_][A-Za-z_][A-Za-z0-9_]*|_[A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const name = m[1].toUpperCase();
    const prev = m.index > 0 ? t[m.index - 1] : ' ';
    if (FUNCTION_NAMES.has(name) || /[=A-Za-z0-9_.(+\-*/]/.test(prev)) continue;
    const open = m.index + m[0].length - 1;
    if (closing(t, open) === t.length - 1) return { name, at: m.index, args: t.slice(open + 1, t.length - 1) };
  }
  return null;
}

/** Where the bracket opened at `open` closes, or -1. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Take the Siemens-only words out of a block.
 *
 * @returns {{body:string, extra:null|{siemens?:object, toolName?:string, axisModes?:object}}}
 */
export function siemensWords(input, d = DIALECTS.siemens) {
  let body = input;
  const extra = {};
  // T="FACE MILL 50": a tool chosen by its name rather than a pot number.
  body = body.replace(/\bT\s*=\s*"([^"]*)"/i, (all, name) => {
    extra.toolName = name.trim();
    return ' ';
  });
  // A3=0.2 B3=0.2 C3=0.9195: the tool's direction under TRAORI, and the
  // other orientation words spelled the same way (A2 angles, A4 normals).
  // Each value is whatever stands after the = — a number, a name, or a
  // bracket — and is worked out by the interpreter.
  const ORIENT_RE = /\b([ABC])([2-7])\s*=\s*/gi;
  let o;
  while ((o = ORIENT_RE.exec(body)) !== null) {
    let end = o.index + o[0].length;
    if (body[end] === '(') {
      const close = closing(body, end);
      end = close < 0 ? body.length : close + 1;
    } else {
      while (end < body.length && !/\s/.test(body[end])) end++;
    }
    extra.orient = extra.orient || {};
    extra.orient[`${o[1].toUpperCase()}${o[2]}`] = body.slice(o.index + o[0].length, end);
    body = `${body.slice(0, o.index)} ${body.slice(end)}`;
    ORIENT_RE.lastIndex = o.index;
  }
  // LIMS=3000 the most the spindle may turn under G96; SPOS=0 (SPOS[1]=0,
  // SPOS=DC(90)) the spindle stopped at an angle. Values as the above.
  const SPINDLE_RE = /\b(LIMS|SPOS)(?:\[\s*\d+\s*\])?\s*=\s*/gi;
  let sp;
  while ((sp = SPINDLE_RE.exec(body)) !== null) {
    let end = sp.index + sp[0].length;
    const mode = /^(DC|ACP|ACN|AC|IC)\s*\(/i.exec(body.slice(end));
    if (mode) end += mode[0].length - 1;
    if (body[end] === '(') {
      const close = closing(body, end);
      end = close < 0 ? body.length : close + 1;
    } else {
      while (end < body.length && !/\s/.test(body[end])) end++;
    }
    extra.spindle = extra.spindle || {};
    const text = body.slice(sp.index + sp[0].length, end);
    extra.spindle[sp[1].toUpperCase()] = mode ? text.slice(mode[0].length - 1) : text;
    body = `${body.slice(0, sp.index)} ${body.slice(end)}`;
    SPINDLE_RE.lastIndex = sp.index;
  }
  // C=DC(90): the value in brackets, with how the axis is to get there.
  let m;
  VALUE_MODE_RE.lastIndex = 0;
  while ((m = VALUE_MODE_RE.exec(body)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closing(body, open);
    if (close < 0) break;
    extra.axisModes = extra.axisModes || {};
    extra.axisModes[m[1].toUpperCase()] = m[2].toUpperCase();
    body = `${body.slice(0, m.index)}${m[1]}=(${body.slice(open + 1, close)})${body.slice(close + 1)}`;
    VALUE_MODE_RE.lastIndex = m.index + m[1].length + 1;
  }
  // The modes, wherever they stand.
  const modes = [];
  body = body.replace(MODES_RE, (all, name) => {
    modes.push(name.toUpperCase());
    return ' ';
  });
  if (modes.length) extra.modes = modes;

  const trimmed = body.trim();
  // A block number in front — N235 — is the block's own and stays with it;
  // what the block says is read after it.
  const num = /^N\d+\s*/i.exec(trimmed);
  const prefix = num ? num[0].trim() : '';
  let rest = num ? trimmed.slice(num[0].length) : trimmed;
  const withPrefix = (tail) => `${prefix} ${tail || ''}`.trim();

  // MCALL alone stops a modal cycle.
  if (/^MCALL$/i.test(rest)) {
    extra.siemens = { op: 'mcall-off' };
    return { body: prefix, extra };
  }
  // A call written as a function, ending the block: CYCLE81(10, 0, 2, , -20),
  // MCALL CYCLE83(...), or G0 X10 Y20 CYCLE81(...) with a move before it,
  // which the call follows once the move is made.
  const call = trailingCall(rest);
  if (call) {
    let before = rest.slice(0, call.at).trim();
    let modal = false;
    const mc = /(^|\s)MCALL$/i.exec(before);
    if (mc) {
      modal = true;
      before = before.slice(0, mc.index).trim();
    }
    extra.siemens = { op: 'call', name: call.name, argsText: call.args, modal, after: !!before };
    return { body: withPrefix(before), extra };
  }
  // MCALL and a name with no brackets: a subprogram made modal.
  const mcall = /^MCALL\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(rest);
  if (mcall) {
    extra.siemens = { op: 'call', name: mcall[1].toUpperCase(), argsText: '', modal: true };
    return { body: prefix, extra };
  }
  // ROT Z45, TRANS X10 Y5, ROT: the frame word, its numbers left to be read.
  const frame = FRAMES_RE.exec(rest);
  if (frame) {
    extra.siemens = { op: 'frame', name: frame[1].toUpperCase() };
    body = withPrefix(rest.slice(frame[0].length));
    return { body, extra };
  }
  // RET: back to whatever called this subprogram, as M17 does.
  if (/^RET$/i.test(rest)) {
    extra.siemens = { op: 'ret' };
    return { body: prefix, extra };
  }
  // A subprogram called by its name and nothing else — L_M54, PART_2,
  // L100 — perhaps with a count, P3 or P=3. Read letter by letter, L_M54 is
  // an M54 word and some junk; a name is a name. One that is a macro
  // keyword (ENDWHILE) or an address with a number (M30) is not one.
  const bare = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+P\s*=?\s*(\d+))?$/.exec(rest);
  if (bare) {
    const name = bare[1].toUpperCase();
    const address = /^[A-Za-z]\d+$/.test(name) && name[0] !== 'L';
    if (!address && !hasMacroSyntax(bare[1], d)) {
      extra.siemens = { op: 'call', name, argsText: '', modal: false, bare: true, count: bare[2] ? Number(bare[2]) : 1 };
      return { body: prefix, extra };
    }
  }
  return { body, extra: Object.keys(extra).length ? extra : null };
}

/**
 * A tool-table line, or null.
 *
 * Two shapes count: one of the words this dialect names, and anything
 * written WORD__n — the index form the declaring lines carry. Either way
 * the rest of the line has to be numbers, so the same word asking a
 * question keeps the reader it had.
 */
function settingIn(body, settings) {
  const m = /^([A-Za-z][A-Za-z0-9]*)(_{2,}\d+)?\b([^]*)$/.exec(body);
  if (!m) return null;
  const name = m[1].toUpperCase();
  const indexed = !!m[2];
  if (!indexed && !settings.some((w) => w.toUpperCase() === name)) return null;
  const tail = m[3].trim();
  if (tail && !/^[-+\d.\s]+$/.test(tail)) return null;
  return { name, text: tail, index: indexed ? Number(m[2].replace(/_/g, '')) : null };
}

/**
 * The O number a file declares, or null.
 *
 * This is how a control knows which subprogram a file is: the O word at the
 * top of it. M98 P1000 looks for the file that says O1000, so that is what
 * is read here rather than anything about the file's name.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function programNumber(text) {
  for (const b of lex(text)) {
    const o = b.words.find((w) => w.letter === 'O');
    if (o) return o.value;
  }
  return null;
}
