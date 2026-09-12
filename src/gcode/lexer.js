// G-code tokenizer.
//
// Splits a program into blocks (lines) of address/value words while
// preserving the original line numbers, which the UI needs to highlight
// the currently executing line and to report collisions.

const WORD_RE = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;

/**
 * @typedef {{ letter:string, value:number, text:string }} Word
 * @typedef {{ line:number, raw:string, words:Word[], comments:string[],
 *             blockDelete:boolean, skipped:boolean, error?:string }} Block
 */

/** Strip comments, returning the cleaned code and the comment texts. */
export function stripComments(line) {
  const comments = [];
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '(') {
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
    if (c === ';') {
      comments.push(line.slice(i + 1).trim());
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
export function lex(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const { code, comments } = stripComments(raw);
    let body = code.trim();

    let blockDelete = false;
    if (body.startsWith('/')) {
      blockDelete = true;
      body = body.slice(1).trim();
    }

    // Program start/end markers and O-numbers carry no motion.
    if (body === '%') {
      blocks.push({ line: i + 1, raw, words: [], comments, blockDelete, skipped: false, marker: true });
      continue;
    }

    const words = [];
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(body)) !== null) {
      words.push({ letter: m[1].toUpperCase(), value: parseFloat(m[2]), text: m[0] });
    }

    // Anything left over that is not whitespace is unparseable.
    const consumed = words.reduce((n, w) => n + w.text.replace(/\s/g, '').length, 0);
    const stripped = body.replace(/\s/g, '');
    let error;
    if (stripped.length > consumed) {
      const junk = stripped.replace(/([A-Za-z])[+-]?(\d+\.?\d*|\.\d+)/g, '');
      if (junk.length) error = `Unrecognised text: ${junk.slice(0, 24)}`;
    }

    blocks.push({ line: i + 1, raw, words, comments, blockDelete, skipped: false, error });
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
