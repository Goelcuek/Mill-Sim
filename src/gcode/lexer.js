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

import { hasMacroSyntax, parseMacroBlock, usesBrackets } from './macro.js';
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

    let blockDelete = false;
    if (body.startsWith('/')) {
      blockDelete = true;
      body = body.slice(1).trim();
    }

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
        blocks.push({
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

    // Program start/end markers and O-numbers carry no motion.
    if (body === '%') {
      blocks.push({ line: i + 1, raw, words: [], comments, blockDelete, skipped: false, marker: true });
      continue;
    }

    // Names come out first, whichever reader the rest of the block goes to:
    // what is inside the quotes is a file, not an expression.
    const names = [];
    body = body.replace(NAME_RE, (all, angle, dq, sq) => {
      const name = (angle !== undefined ? angle : dq !== undefined ? dq : sq).trim();
      if (name) names.push(name);
      return ' '.repeat(all.length);
    });

    // A block that uses variables, brackets or the macro keywords is read
    // by the macro parser instead. Everything else takes the path it
    // always took, which is most blocks in most programs.
    if (hasMacroSyntax(body, d)) {
      const macro = parseMacroBlock(body, d);
      blocks.push({
        line: i + 1,
        raw,
        words: macro.words,
        comments,
        names,
        blockDelete,
        skipped: false,
        macro: { assigns: macro.assigns, control: macro.control, label: macro.label, call: macro.call },
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
        blocks.push({
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

    blocks.push({ line: i + 1, raw, words, comments, names, idents, blockDelete, skipped: false, error });
  }

  return blocks;
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
