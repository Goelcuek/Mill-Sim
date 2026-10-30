// Colouring a line of G-code: what each piece of it is.
//
// One reading for every control. The address letters mean the same thing
// everywhere — G a motion or mode, M a machine function, X to W where the
// axes go — and the rest is told apart by its shape: a word of two letters
// or more is a keyword (IF, GOTOF, CYCLE800, TRAORI) or a name, R1= and #100
// and $P_TOOLNO are variables, ( ) and ; open remarks, quotes hold text.
// It only colours: a reading that is wrong here is a colour that is wrong,
// never a program read differently.

/** Words a control reads as words rather than as a letter and a number. */
const KEYWORDS = new Set([
  'IF', 'THEN', 'ELSE', 'ENDIF', 'GOTO', 'GOTOF', 'GOTOB', 'GOTOC', 'WHILE', 'ENDWHILE', 'DO', 'END',
  'REPEAT', 'REPEATB', 'UNTIL', 'LOOP', 'ENDLOOP', 'FOR', 'TO', 'ENDFOR', 'ENDLABEL', 'CASE', 'OF', 'DEFAULT',
  'DEF', 'PROC', 'CALL', 'PCALL', 'MCALL', 'EXTCALL', 'RET', 'MSG', 'STOPRE', 'SUPA', 'SAVE', 'DISPLON', 'DISPLOF',
  'AND', 'OR', 'NOT', 'XOR', 'EQ', 'NE', 'GT', 'GE', 'LT', 'LE', 'MOD', 'DIV',
  'REAL', 'INT', 'BOOL', 'STRING', 'CHAR', 'AXIS', 'FRAME',
  'TRAORI', 'TRAFOOF', 'TRANSMIT', 'TRACYL', 'TRANS', 'ATRANS', 'ROT', 'AROT', 'ROTS', 'AROTS', 'SCALE', 'ASCALE',
  'MIRROR', 'AMIRROR', 'DIAMON', 'DIAMOF', 'DIAM90', 'ORIVECT', 'ORIWKS', 'ORIMKS', 'ORIAXES', 'ORIC', 'ORID',
  'ACP', 'ACN', 'DC', 'AC', 'IC', 'CR', 'AR', 'TURN', 'LIMS', 'SPOS', 'SPOSA', 'CFC', 'CFTCP', 'CFIN',
  'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATAN2', 'SQRT', 'ABS', 'ROUND', 'TRUNC', 'POT', 'LN', 'EXP',
  'FIX', 'FUP', 'BIN', 'BCD', 'MIN', 'MAX',
  'RTCP', 'ON', 'OFF',
]);

/** Families of cycle names: CYCLE800, POCKET4, SLOT1, HOLES2 … */
const CYCLE = /^(CYCLE|POCKET|SLOT|HOLES|LONGHOLE|CYCLE_)\w*$/;

/** What an address letter is, by letter. */
function letterClass(L, first) {
  switch (L) {
    case 'N': return first ? 'n' : 'a';
    case 'G': return 'g';
    case 'M': return 'm';
    case 'T': case 'S': case 'F': case 'D': case 'H': return 't';
    case 'O': return 'o';
    default: return 'a';
  }
}

const escape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The pieces of one line, in order, each with its class (or '' for plain).
 *
 * @param {string} line
 * @returns {Array<[string, string]>} [text, class]
 */
export function tokenizeLine(line) {
  const out = [];
  let i = 0;
  let first = true;          // nothing but space and a block-skip slash yet
  const n = line.length;
  const push = (text, cls) => { if (text) out.push([text, cls]); };
  while (i < n) {
    const c = line[i];
    // Space, and a block skip at the start.
    if (c === ' ' || c === '\t') { let j = i; while (j < n && (line[j] === ' ' || line[j] === '\t')) j++; push(line.slice(i, j), ''); i = j; continue; }
    if (first && c === '/') { push('/', 'k'); i++; continue; }
    // Remarks: ( … ) and ; to the end. A bracket straight after a name —
    // CYCLE800(…), ACN(300) — or after = or an operator is a call or an
    // expression, not a remark.
    if (c === '(') {
      const prev = out.length ? out[out.length - 1] : null;
      const opens = prev && prev[0].trim() && (prev[1] === 'k' || prev[1] === 'v' || prev[1] === 'p');
      if (opens) { push('(', 'p'); i++; first = false; continue; }
      const j = line.indexOf(')', i); const e = j < 0 ? n : j + 1; push(line.slice(i, e), 'c'); i = e; first = false; continue;
    }
    if (c === ';') { push(line.slice(i), 'c'); break; }
    // Text in quotes.
    if (c === '"') { const j = line.indexOf('"', i + 1); const e = j < 0 ? n : j + 1; push(line.slice(i, e), 's'); i = e; first = false; continue; }
    // A program's header: % on its own, %_N_PART_MPF, O1000 (as a letter word, below).
    if (c === '%') { push(line.slice(i), 'o'); break; }
    // Variables: #100, #[…], $P_TOOLNO, R12 (=).
    if (c === '#') { let j = i + 1; while (j < n && /\d/.test(line[j])) j++; push(line.slice(i, j), 'v'); i = j; first = false; continue; }
    if (c === '$') { let j = i + 1; while (j < n && /[\w]/.test(line[j])) j++; push(line.slice(i, j), 'v'); i = j; first = false; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      const up = word.toUpperCase();
      // A name: letters, then perhaps digits and more — a keyword, a cycle,
      // a label or a variable of the program's own.
      if (word.length > 1 || (j < n && line[j] === '_')) {
        let k = j;
        while (k < n && /[\w]/.test(line[k])) k++;
        const name = line.slice(i, k);
        const NAME = name.toUpperCase();
        // R12= on a Siemens is a parameter, and so is R12 in an expression.
        if (/^R\d+$/.test(NAME)) push(name, 'v');
        else if (KEYWORDS.has(NAME) || CYCLE.test(NAME)) push(name, 'k');
        else if (/^_N_\w+_[SM]PF$/.test(NAME)) push(name, 'o');
        else push(name, line[k] === ':' ? 'k' : 'v');
        i = k;
        first = false;
        continue;
      }
      // One letter: an address, and the number or expression after it.
      if (up === 'R' && /^R\d+\s*=/.test(line.slice(i).toUpperCase())) {
        let k = i + 1;
        while (k < n && /\d/.test(line[k])) k++;
        push(line.slice(i, k), 'v');
        i = k;
        first = false;
        continue;
      }
      const cls = letterClass(up, first);
      push(word, cls);
      i = j;
      // The value straight after: = and a sign, then the number.
      let k = i;
      if (line[k] === '=') k++;
      while (k < n && (line[k] === '-' || line[k] === '+')) k++;
      const numStart = k;
      while (k < n && /[\d.]/.test(line[k])) k++;
      if (k > numStart) {
        push(line.slice(i, numStart), 'p');
        push(line.slice(numStart, k), cls === 'n' ? 'n' : cls === 'g' || cls === 'm' || cls === 'o' ? cls : 'num');
        i = k;
      }
      first = false;
      continue;
    }
    // A bare number, an operator, anything else.
    if (/[\d.]/.test(c)) { let j = i; while (j < n && /[\d.]/.test(line[j])) j++; push(line.slice(i, j), 'num'); i = j; first = false; continue; }
    push(c, /[=+\-*/<>[\]:,()]/.test(c) ? 'p' : '');
    i++;
    first = false;
  }
  return out;
}

/** One line as HTML: each piece in a span of its class. */
export function highlightLine(line) {
  let html = '';
  for (const [text, cls] of tokenizeLine(line)) {
    html += cls ? `<span class="t-${cls}">${escape(text)}</span>` : escape(text);
  }
  return html;
}
