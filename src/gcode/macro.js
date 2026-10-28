// Variables, arithmetic and control flow, in whatever the control spells.
//
// A program that works something out — a family of parts, a probing cycle
// reporting what it found, the tool-change program the machine builder
// shipped — is most of what is actually in a control's memory, so a reader
// that stops at plain G-code stops short of the job.
//
// What the arithmetic *is* does not vary between controls. What varies is
// the spelling, and that lives in gcode/dialects.js rather than in here:
//
//   Fanuc     #100 = [#1 + 2]     IF [#1 GT 5] GOTO 200   WHILE … DO 1 … END 1
//   Siemens   R100 = (R1 + 2)     IF R1 > 5 GOTOF MARK    WHILE … ENDWHILE
//
// Same parser, two tables. Everything below takes a dialect and reads
// whatever it describes, which is what lets a shop describe a control
// nobody here has ever seen.
//
// Deliberately not implemented, in any dialect: BIN/BCD, the system
// variable space beyond the few below, the interrupt codes, and
// Heidenhain's conversational language, which is not G-code at all. They
// are listed here rather than left to be discovered.

import { DIALECTS } from './dialects.js';

/** Functions a macro body may call, all taking one bracketed argument. */
const FUNCTIONS = {
  SIN: (v) => Math.sin((v * Math.PI) / 180),
  COS: (v) => Math.cos((v * Math.PI) / 180),
  TAN: (v) => Math.tan((v * Math.PI) / 180),
  ASIN: (v) => (Math.asin(v) * 180) / Math.PI,
  ACOS: (v) => (Math.acos(v) * 180) / Math.PI,
  ATAN: (v) => (Math.atan(v) * 180) / Math.PI,
  SQRT: Math.sqrt,
  ABS: Math.abs,
  LN: Math.log,
  EXP: Math.exp,
  /** Fanuc rounds half away from zero, unlike Math.round on negatives. */
  ROUND: (v) => Math.sign(v) * Math.round(Math.abs(v)),
  FIX: (v) => Math.trunc(v),
  /** Siemens spellings: TRUNC drops the fraction, POT squares. */
  TRUNC: (v) => Math.trunc(v),
  POT: (v) => v * v,
  FUP: (v) => (v < 0 ? Math.floor(v) : Math.ceil(v)),
};

/** Keyed by what the comparison *is*, not by how a control spells it. */
const isText = (a, b) => typeof a === 'string' || typeof b === 'string';
const COMPARE = {
  // Text compares as text: a STRING variable against a quoted word.
  eq: (a, b) => (isText(a, b) ? (String(a) === String(b) ? 1 : 0) : (Math.abs(a - b) < 1e-9 ? 1 : 0)),
  ne: (a, b) => (isText(a, b) ? (String(a) === String(b) ? 0 : 1) : (Math.abs(a - b) < 1e-9 ? 0 : 1)),
  gt: (a, b) => (a > b ? 1 : 0),
  lt: (a, b) => (a < b ? 1 : 0),
  ge: (a, b) => (a >= b ? 1 : 0),
  le: (a, b) => (a <= b ? 1 : 0),
};

const ALWAYS = ['MOD', ...Object.keys(FUNCTIONS)];
/** The functions an expression may call, which a call to a cycle is not. */
export const FUNCTION_NAMES = new Set(Object.keys(FUNCTIONS));

/** A literal, safe to drop into a regular expression. */
const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is this spelled as a word rather than as a symbol?
 *
 * A control that marks its keywords — $IF — spells them with letters all
 * the same; what it does not do is spell them with < and >.
 */
const isWordy = (t) => /^[$@#]?[A-Za-z][A-Za-z0-9_]*$/.test(String(t));

/** Every word this dialect reserves, so a letter run can be told apart. */
function keywordsOf(d) {
  const out = new Set(ALWAYS);
  for (const v of Object.values(d.compare)) if (isWordy(v)) out.add(v.toUpperCase());
  for (const v of Object.values(d.logic)) if (isWordy(v)) out.add(v.toUpperCase());
  for (const v of Object.values(d.keywords)) if (v && isWordy(v)) out.add(v.toUpperCase());
  // Only a word: Fanuc's "call" is the letter P of G65 P9010, and reserving
  // a single letter would take it away from every block that uses it.
  if (d.call && d.call.program && d.call.program.length > 1 && /^[A-Z]+$/i.test(d.call.program)) {
    out.add(d.call.program.toUpperCase());
  }
  return out;
}

/** Operators written as symbols, longest first so <= beats <. */
function symbolsOf(d) {
  const out = [];
  for (const [op, text] of Object.entries(d.compare)) {
    if (!isWordy(text)) out.push({ text, kind: 'compare', op });
  }
  for (const [op, text] of Object.entries(d.logic)) {
    if (!isWordy(text)) out.push({ text, kind: 'logic', op });
  }
  return out.sort((a, b) => b.text.length - a.text.length);
}

/**
 * Does this block need the macro reader at all?
 *
 * Kept cheap and generous: a block it wrongly sends here still reads
 * correctly, whereas one it wrongly keeps would lose its variables.
 */
export function hasMacroSyntax(code, dialect) {
  const d = dialect || DIALECTS.fanuc;
  if (d.sigil && code.includes(d.sigil)) return true;
  if (code.includes(d.group[0])) return true;
  if (code.includes('=')) return true;
  // DEF REAL STEP declares a variable without giving it a value.
  if (d.namedVariables && /^\s*DEF\b/i.test(code)) return true;
  // A label definition on a control that names them: "MARK1:".
  // With its block number in front, as a post-processor writes it: N224 TP3:
  if (d.labels === 'name' && /^\s*(?:N\d+\s*)?[A-Za-z_][A-Za-z0-9_.]*\s*:/i.test(code)) return true;
  for (const letter of d.letters) {
    if (new RegExp(`\\b${escapeRe(letter)}\\s*[0-9\\${d.group[0]}]`, 'i').test(code)) return true;
  }
  // A control that writes its keywords with a mark in front — $IF — has
  // words that do not start on a word boundary, and a $ in a pattern is
  // not a $ in the text, so both are dealt with rather than assumed away.
  const words = [...keywordsOf(d)].filter((w) => w.length > 1);
  if (!words.length) return false;
  const pattern = words.map((w) => `${/^\w/.test(w) ? '\\b' : ''}${escapeRe(w)}\\b`).join('|');
  return new RegExp(`(${pattern})`, 'i').test(code);
}

/**
 * Does this block need its round brackets left alone?
 *
 * On a control where ( ) is both a remark and the brackets a condition is
 * written in, the difference is whether the block is a condition — so the
 * question is asked here, where the keywords live, rather than guessed at
 * by the comment stripper.
 */
export function usesBrackets(code, dialect) {
  const d = dialect || DIALECTS.fanuc;
  if (d.group[0] !== '(') return false;
  const words = ['if', 'while', 'until', 'repeat', 'for']
    .map((role) => d.keywords[role])
    .filter((w) => w && w.length > 1);
  if (!words.length) return false;
  const pattern = words.map((w) => `${/^\w/.test(w) ? '\\b' : ''}${escapeRe(w)}\\b`).join('|');
  return new RegExp(`(${pattern})`, 'i').test(code);
}

// ---- tokens ---------------------------------------------------------------

function tokenize(code, d) {
  const out = [];
  const keywords = keywordsOf(d);
  const symbols = symbolsOf(d);
  const [open, close] = d.group;
  let i = 0;
  const text = code;

  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    // The grouping brackets, whatever this control uses for them.
    if (c === open) { out.push({ kind: '[', text: c }); i++; continue; }
    if (c === close) { out.push({ kind: ']', text: c }); i++; continue; }

    // Where round brackets group, square ones index an array: ARR[2, 1].
    if (d.namedVariables && c === '[') { out.push({ kind: 'idx[', text: c }); i++; continue; }
    if (d.namedVariables && c === ']') { out.push({ kind: 'idx]', text: c }); i++; continue; }
    if (c === ',') { out.push({ kind: ',', text: c }); i++; continue; }

    // Quoted text, which a STRING variable holds.
    if (d.namedVariables && c === '"') {
      const j = text.indexOf('"', i + 1);
      const end = j < 0 ? text.length : j;
      out.push({ kind: 'string', value: text.slice(i + 1, end), text: text.slice(i, end + 1) });
      i = end + 1;
      continue;
    }

    // An operator spelled as a symbol: <> before <, >= before >.
    const sym = symbols.find((s2) => text.startsWith(s2.text, i));
    if (sym) {
      out.push({ kind: 'name', text: sym.op.toUpperCase(), op: sym.op, group: sym.kind });
      i += sym.text.length;
      continue;
    }

    if (d.sigil && c === d.sigil) { out.push({ kind: '#', text: c }); i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '=') {
      out.push({ kind: c, text: c });
      i++;
      continue;
    }

    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      out.push({ kind: 'number', value: Number(text.slice(i, j)), text: text.slice(i, j) });
      i = j;
      continue;
    }

    // A Siemens system variable — $P_TOOLNO, $TC_DP15[…] — is a name the
    // control keeps for itself, read like any other.
    if (d.namedVariables && !d.keywordPrefix && c === '$' && /[A-Za-z_]/.test(text[i + 1] || '')) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      out.push({ kind: 'ident', text: text.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }

    // A control word with a mark in front of it — $IF, $GOTO — is one word.
    const prefixed = d.keywordPrefix && c === d.keywordPrefix && /[A-Za-z]/.test(text[i + 1] || '');
    // A name of one's own may start with an underscore: _DEPTH.
    const named = d.namedVariables && c === '_';
    if (/[A-Za-z]/.test(c) || prefixed || named) {
      let j = prefixed ? i + 1 : i;
      while (j < text.length && /[A-Za-z_]/.test(text[j])) j++;
      const word = text.slice(i, j).toUpperCase();

      // A reserved word is a reserved word; a letter that this control uses
      // for its variables and is followed by a number or a bracket is one
      // of those; anything else is an ordinary address.
      if (keywords.has(word)) {
        const compareOp = Object.entries(d.compare).find(([, v]) => v.toUpperCase() === word);
        const logicOp = Object.entries(d.logic).find(([, v]) => v.toUpperCase() === word);
        out.push({
          kind: 'name',
          text: word,
          op: compareOp ? compareOp[0] : logicOp ? logicOp[0] : undefined,
          group: compareOp ? 'compare' : logicOp ? 'logic' : undefined,
        });
        i = j;
        continue;
      }

      // A question about the tool table: TLENGTH 07, TDIAM 00.
      if (d.tables && d.tables[word]) {
        out.push({ kind: 'table', text: word, name: d.tables[word] });
        i = j;
        continue;
      }

      // A letter this control counts in — R, Q, V — followed by a number or
      // a bracket is a variable rather than an address.
      const letter = d.letters.find((L) => word === L.toUpperCase());
      const next = text.slice(j).replace(/^[ \t]*/, '')[0];
      if (letter && next && (/[0-9.]/.test(next) || next === open)) {
        out.push({ kind: '#', text: letter, letter });
        i = j;
        continue;
      }

      // Controls that write X=R1 also have addresses of more than one
      // letter (CR=, AR=) and labels with names, so a run of letters is
      // kept whole. Where a block is strictly letter-number — Fanuc and its
      // relatives — a run is what it has always been: one letter at a time.
      if (word.length > 1 && (d.labels === 'name' || d.wordEquals)) {
        // A name may carry digits after its first letter — MARK1, POS_2 —
        // which is what a label looks like on the controls that use them,
        // and dots too where the control counts its labels ITEM4.00.
        const more = d.identDots ? /[A-Za-z0-9_.]/ : /[A-Za-z0-9_]/;
        let k = j;
        while (k < text.length && more.test(text[k])) k++;
        out.push({ kind: 'ident', text: text.slice(i, k).toUpperCase() });
        i = k;
        continue;
      }

      out.push({ kind: 'address', text: text[i].toUpperCase() });
      i++;
      continue;
    }

    if (c === ':') { out.push({ kind: ':', text: c }); i++; continue; }

    out.push({ kind: 'other', text: c });
    i++;
  }
  return out;
}

// ---- expressions ----------------------------------------------------------
//
// Precedence, loosest first: the comparisons, then AND/OR/XOR, then + and -,
// then * / MOD, then unary signs, then #, then brackets and functions.

class Parser {
  constructor(tokens, dialect) {
    this.t = tokens;
    this.d = dialect;
    this.i = 0;
  }

  /** Is the next token this dialect's word for something? */
  isWord(role) {
    const want = this.d.keywords[role];
    return !!want && this.peek().kind === 'name' && this.peek().text === want.toUpperCase();
  }

  eatWord(role) {
    if (!this.isWord(role)) return false;
    this.next();
    return true;
  }

  peek(n = 0) { return this.t[this.i + n] || { kind: 'end', text: '' }; }
  next() { return this.t[this.i++] || { kind: 'end', text: '' }; }
  is(kind, text) {
    const t = this.peek();
    return t.kind === kind && (text === undefined || t.text === text);
  }
  eat(kind, text) {
    if (!this.is(kind, text)) return null;
    return this.next();
  }
  expect(kind, text) {
    const t = this.eat(kind, text);
    if (!t) throw new Error(`expected ${text || kind} but found "${this.peek().text || 'the end of the block'}"`);
    return t;
  }

  /**
   * Where a jump goes: a line number on controls that count lines, or the
   * name of a label on controls that name them.
   */
  jumpTarget() {
    if (this.d.labels === 'name') {
      const t = this.peek();
      if (t.kind === 'ident' || t.kind === 'address') return { label: this.next().text };
      throw new Error('a jump needs the name of a label');
    }
    return { target: this.expression() };
  }

  expression() { return this.comparison(); }

  comparison() {
    let left = this.logical();
    for (;;) {
      if (this.peek().group === 'compare') {
        const op = this.next().op;
        left = { op: 'cmp', name: op, left, right: this.logical() };
        continue;
      }
      // A single = where a test belongs. Controls that spell assignment
      // without one — see assignEquals — are free to spell equality with
      // it, and a Fidia does: $IF (RG 50 = 1). Assignments are read before
      // any expression is, so the two never want the same =.
      if (this.d.eqCompare && this.is('=')) {
        this.next();
        left = { op: 'cmp', name: 'eq', left, right: this.logical() };
        continue;
      }
      return left;
    }
  }

  logical() {
    let left = this.additive();
    while (this.peek().group === 'logic') {
      const op = this.next().op;
      left = { op, left, right: this.additive() };
    }
    return left;
  }

  additive() {
    let left = this.multiplicative();
    for (;;) {
      if (this.is('+')) { this.next(); left = { op: '+', left, right: this.multiplicative() }; }
      else if (this.is('-')) { this.next(); left = { op: '-', left, right: this.multiplicative() }; }
      else return left;
    }
  }

  multiplicative() {
    let left = this.unary();
    for (;;) {
      if (this.is('*')) { this.next(); left = { op: '*', left, right: this.unary() }; }
      else if (this.is('/')) { this.next(); left = { op: '/', left, right: this.unary() }; }
      else if (this.peek().kind === 'name' && this.peek().text === 'MOD') {
        this.next();
        left = { op: 'MOD', left, right: this.unary() };
      } else return left;
    }
  }

  unary() {
    if (this.is('-')) { this.next(); return { op: 'neg', left: this.unary() }; }
    if (this.is('+')) { this.next(); return this.unary(); }
    return this.primary();
  }

  primary() {
    if (this.is('#')) {
      // Which bank it is in, on a control with more than one: PT 5 is not RG 5.
      const mark = this.next();
      return { op: 'var', bank: mark.letter || null, left: this.primary() };
    }
    // TLENGTH 07: what the tool table says about a pot, 0 being whatever
    // is in the spindle.
    if (this.is('table')) {
      const word = this.next();
      return { op: 'table', name: word.name, left: this.primary() };
    }
    if (this.is('[')) {
      this.next();
      const inner = this.expression();
      this.expect(']');
      return inner;
    }
    if (this.peek().kind === 'name' && FUNCTIONS[this.peek().text]) {
      const name = this.next().text;
      this.expect('[');
      const arg = this.expression();
      // ATAN[y]/[x] — and ATAN[y,x] on the newer controls — is one function
      // of two arguments that knows its quadrant, not an arctangent divided
      // by something: ATAN[-1]/[-1] is 225, and reading it as atan(1) put
      // the third hole of a bolt circle in the first quadrant.
      if (name === 'ATAN' && this.is(',')) {
        this.next();
        const x = this.expression();
        this.expect(']');
        return { op: 'atan2', left: arg, right: x };
      }
      this.expect(']');
      if (name === 'ATAN' && this.is('/') && this.peek(1).kind === '[') {
        this.next();
        return { op: 'atan2', left: arg, right: this.primary() };
      }
      return { op: 'fn', name, left: arg };
    }
    if (this.peek().kind === 'number') return { op: 'num', value: this.next().value };
    if (this.peek().kind === 'string') return { op: 'str', value: this.next().value };
    // A variable called by its name — DEPTH, _COUNT, POS[2] — on a control
    // that lets a program declare its own.
    if (this.d.namedVariables && this.peek().kind === 'ident') return this.namedRef();
    throw new Error(`"${this.peek().text || 'the end of the block'}" is not a number, a variable or a bracket`);
  }

  /** A name, and an index in square brackets if it has one. */
  namedRef() {
    const name = this.next().text;
    let index = null;
    if (this.is('idx[')) {
      this.next();
      // A system variable is indexed by an axis as often as by a number:
      // $AA_IW[X]. The axis is taken as its name.
      const item = () => {
        const t = this.peek();
        if (name[0] === '$' && (t.kind === 'address' || t.kind === 'ident') && [',', 'idx]'].includes(this.peek(1).kind)) {
          this.next();
          return { op: 'num', value: 0, axis: t.text };
        }
        return this.expression();
      };
      index = [item()];
      while (this.eat(',')) index.push(item());
      this.expect('idx]');
    }
    return { op: 'named', name, index };
  }
}

/**
 * Work out what an expression comes to.
 *
 * @param {object} node
 * @param {{get:(n:number) => number}} vars
 */
export function evaluate(node, vars) {
  if (!node) return 0;
  if (node.op === 'table') {
    // Answered by whoever built the variables, because only they know what
    // is in the machine — and in which units the program is asking.
    return vars && typeof vars.table === 'function'
      ? Number(vars.table(node.name, evaluate(node.left, vars))) || 0
      : 0;
  }
  switch (node.op) {
    case 'num': return node.value;
    case 'str': return node.value;
    case 'named': {
      const index = node.index ? node.index.map((e) => evaluate(e, vars)) : null;
      if (vars && typeof vars.getNamed === 'function') return vars.getNamed(node.name, index);
      throw new Error(`${node.name} is not defined`);
    }
    case 'var': return vars.get(evaluate(node.left, vars), node.bank);
    case 'neg': return -evaluate(node.left, vars);
    case 'fn': return FUNCTIONS[node.name](evaluate(node.left, vars));
    case 'atan2': {
      // Fanuc's range is 0 to 360, not -180 to 180.
      const deg = (Math.atan2(evaluate(node.left, vars), evaluate(node.right, vars)) * 180) / Math.PI;
      return deg < 0 ? deg + 360 : deg;
    }
    case 'cmp': return COMPARE[node.name](evaluate(node.left, vars), evaluate(node.right, vars));
    case '+': return evaluate(node.left, vars) + evaluate(node.right, vars);
    case '-': return evaluate(node.left, vars) - evaluate(node.right, vars);
    case '*': return evaluate(node.left, vars) * evaluate(node.right, vars);
    case '/': {
      const d = evaluate(node.right, vars);
      if (Math.abs(d) < 1e-12) throw new Error('division by zero');
      return evaluate(node.left, vars) / d;
    }
    case 'MOD': {
      const d = evaluate(node.right, vars);
      if (Math.abs(d) < 1e-12) throw new Error('division by zero');
      return evaluate(node.left, vars) % d;
    }
    case 'and': return (evaluate(node.left, vars) && evaluate(node.right, vars)) ? 1 : 0;
    case 'or': return (evaluate(node.left, vars) || evaluate(node.right, vars)) ? 1 : 0;
    case 'xor': return (!!evaluate(node.left, vars) !== !!evaluate(node.right, vars)) ? 1 : 0;
    default: return 0;
  }
}

// ---- a block --------------------------------------------------------------

/**
 * Read one block that uses macro syntax.
 *
 * Ordinary words come back as they always did, with `expr` set instead of
 * `value` when the value has to be worked out at the time. Assignments and
 * control flow come back beside them.
 *
 * @param {string} code the block with its comments already stripped
 * @returns {{words:Array, assigns:Array, control:object|null, error?:string}}
 */
/**
 * Which way a jump looks for its label: GOTOF forward, GOTOB back, a
 * Siemens GOTO forward and then back, GOTOC the same and quiet when the
 * label is nowhere.
 */
function jumpHow(p) {
  if (p.isWord('gotoBack')) return { back: true };
  if (p.isWord('gotoEither')) return { back: false, either: true };
  if (p.isWord('gotoChecked')) return { back: false, either: true, quiet: true };
  return { back: false };
}

export function parseMacroBlock(code, dialect) {
  const d = dialect || DIALECTS.fanuc;
  const words = [];
  const assigns = [];
  /** DEF declarations: a program's own variables, on a control that has them. */
  const defs = [];
  let control = null;
  let label = null;
  let call = false;
  const p = new Parser(tokenize(code, d), d);
  /** This control's word for "run that file", when it spells it as a word. */
  const callWord = d.call && d.call.program && d.call.program.length > 1
    ? d.call.program.toUpperCase() : null;

  const assignment = () => {
    const mark = p.expect('#');
    const target = p.primary();
    // Some controls name the register and then the value, with nothing in
    // between: a Fidia writes RG 50 1.00 where a Fanuc writes #50 = 1.
    if (d.assignEquals === false) p.eat('=');
    else p.expect('=');
    return { target, bank: mark.letter || null, value: p.expression() };
  };

  try {
    while (p.peek().kind !== 'end') {
      // An assignment: the variable, however this control writes one.
      if (p.is('#')) {
        assigns.push(assignment());
        continue;
      }

      // A declaration: DEF REAL DEPTH=5, STEP  ·  DEF INT POS[3]=(1,2,3)
      if (d.namedVariables && p.peek().kind === 'ident' && p.peek().text === 'DEF') {
        p.next();
        defs.push(...declaration(p));
        continue;
      }

      // An element of an array, set: POS[2]=12.5. An address never has an
      // index, so a name with one is a variable.
      if (d.namedVariables && p.peek().kind === 'ident' && p.peek(1).kind === 'idx[') {
        const ref = p.namedRef();
        p.expect('=');
        assigns.push({ named: ref.name, index: ref.index, value: p.expression() });
        continue;
      }

      // A named label this control can jump to: MARK1:
      if (p.peek().kind === 'ident' && p.peek(1).kind === ':') {
        label = p.next().text;
        p.next();
        continue;
      }

      if (p.peek().kind === 'name') {
        if (p.isWord('if')) {
          p.next();
          const cond = p.expression();
          if (p.isWord('goto') || p.isWord('gotoBack') || p.isWord('gotoEither') || p.isWord('gotoChecked')) {
            const how = jumpHow(p);
            p.next();
            control = { kind: 'if-goto', cond, ...how, ...p.jumpTarget() };
          } else if (d.keywords.endIf && p.peek().kind === 'end') {
            // IF R5 == 29 on its own: the lines down to ELSE or ENDIF run
            // when it holds.
            control = { kind: 'if-block', cond };
          } else if (p.isWord('then')) {
            p.next();
            control = { kind: 'if-then', cond, assign: assignment() };
          } else if (d.keywords.endIf) {
            // Neither a jump nor the end of the condition: the condition
            // itself is where reading stopped.
            throw new Error(`${d.keywords.if}: the condition could not be read from "${p.peek().text}" on`);
          } else if (d.keywords.then === null) {
            // Siemens writes the jump straight after the condition, with no
            // THEN at all, so anything else here is a mistake worth naming.
            throw new Error(`${d.keywords.if} needs ${d.keywords.goto} and a label after its condition`);
          } else {
            throw new Error(`${d.keywords.if} needs ${d.keywords.goto} or ${d.keywords.then} after its condition`);
          }
          continue;
        }

        if (p.isWord('while')) {
          p.next();
          const cond = p.expression();
          if (d.keywords.do) {
            if (!p.eatWord('do')) throw new Error(`${d.keywords.while} needs ${d.keywords.do} after its condition`);
            control = { kind: 'while', cond, level: evaluateConstant(p.expression()) };
          } else {
            control = { kind: 'while', cond, level: 0 };
          }
          continue;
        }

        if (p.isWord('endWhile')) { p.next(); control = { kind: 'end', level: 0 }; continue; }
        if (p.isWord('end')) { p.next(); control = { kind: 'end', level: evaluateConstant(p.expression()) }; continue; }
        if (p.isWord('do')) { p.next(); control = { kind: 'do', level: evaluateConstant(p.expression()) }; continue; }

        if (p.isWord('goto') || p.isWord('gotoBack') || p.isWord('gotoEither') || p.isWord('gotoChecked')) {
          const how = jumpHow(p);
          p.next();
          control = { kind: 'goto', ...how, ...p.jumpTarget() };
          continue;
        }
        if (p.isWord('else')) { p.next(); control = { kind: 'else' }; continue; }
        if (p.isWord('endIf')) { p.next(); control = { kind: 'endif' }; continue; }

        if (p.isWord('for')) {
          p.next();
          const counter = assignmentFor(p);
          if (!p.eatWord('to')) throw new Error(`${d.keywords.for} needs ${d.keywords.to}`);
          control = { kind: 'for', counter, last: p.expression(), level: 0 };
          continue;
        }
        if (p.isWord('endFor')) { p.next(); control = { kind: 'end-for', level: 0 }; continue; }

        // A loop that counts instead of testing: $REP 4 ... $END.
        if (p.isWord('rep')) { p.next(); control = { kind: 'times', count: p.expression(), level: 0 }; continue; }
        if (p.isWord('repEnd')) { p.next(); control = { kind: 'end-times', level: 0 }; continue; }

        if (p.isWord('repeat')) {
          p.next();
          // REPEAT on its own opens a loop that UNTIL closes. REPEAT and a
          // label is a Siemens section repetition: the lines from that
          // label — to a second label, to ENDLABEL:, or back down to the
          // REPEAT itself — run P times, and the program carries on below.
          if (p.peek().kind === 'ident' || (p.peek().kind === 'address' && p.peek(1).kind !== '=')) {
            control = repeatSection(p, 'section');
          } else {
            control = { kind: 'repeat', level: 0 };
          }
          continue;
        }
        if (p.isWord('until')) { p.next(); control = { kind: 'until', cond: p.expression(), level: 0 }; continue; }

        // CALL "ROUGH": the name itself was lifted out of the block before
        // it reached here, because a file name is not arithmetic.
        if (callWord && p.peek().text === callWord) {
          p.next();
          call = true;
          continue;
        }

        throw new Error(`"${p.peek().text}" cannot start a block`);
      }

      // REPEATB LABEL P=n: the one block with that label, n times.
      if (d.keywords.repeat && p.peek().kind === 'ident' && p.peek().text === 'REPEATB') {
        p.next();
        control = repeatSection(p, 'block');
        continue;
      }

      // An address, one letter or several, with or without an = in front of
      // its value depending on what this control writes.
      if (p.peek().kind === 'address' || p.peek().kind === 'ident') {
        const letter = p.next().text;
        p.eat('=');
        const node = p.expression();
        if (node.op === 'num') words.push({ letter, value: node.value, text: `${letter}${node.value}` });
        else words.push({ letter, expr: node, value: 0, text: letter });
        continue;
      }

      throw new Error(`"${p.peek().text}" does not belong here`);
    }
  } catch (err) {
    // An IF that cannot be read still opens a block: what it guards is
    // passed over rather than run as if the condition held — which, with a
    // GOTOB back to the IF inside it, ran for ever.
    if (!control && d.keywords.endIf && new RegExp(`^\\s*(?:N\\d+\\s*)?${d.keywords.if}\\b`, 'i').test(code)
      && !/\bGOTO[FBC]?\b/i.test(code)) {
      control = { kind: 'if-block', cond: null };
    }
    return { words, assigns, control, label, call, defs, error: err.message };
  }

  return { words, assigns, control, label, call, defs };
}

/**
 * The rest of a REPEAT that names its section: a label, perhaps a second
 * one, and how many times (P=n, once if not said).
 */
function repeatSection(p, shape) {
  const start = p.next().text;
  let end = null;
  const isCount = () => p.peek().text === 'P' && p.peek(1).kind === '=';
  if (shape === 'section' && !isCount() && (p.peek().kind === 'ident' || p.peek().kind === 'address')) end = p.next().text;
  let count = null;
  if (isCount()) {
    p.next();
    p.next();
    count = p.expression();
  }
  return { kind: shape === 'block' ? 'repeat-block' : 'repeat-section', start, end, count, level: 0 };
}

/**
 * The arguments of a call written as a function — CYCLE81(10, 0, 2, , -20),
 * CYCLE800(1, "TABLE", 0, 57, ...) — each an expression, a quoted text, or
 * left out, which is how a Siemens cycle says "take the default".
 *
 * @returns {Array<object|null>} parsed expressions, null where left empty
 */
export function parseArgs(text, dialect) {
  const d = dialect || DIALECTS.fanuc;
  const tokens = tokenize(String(text || ''), d);
  if (!tokens.length) return [];
  const parts = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === '[' || t.kind === 'idx[') depth++;
    else if (t.kind === ']' || t.kind === 'idx]') depth--;
    if (t.kind === ',' && depth === 0) { parts.push([]); continue; }
    parts[parts.length - 1].push(t);
  }
  return parts.map((ts) => {
    if (!ts.length) return null;
    const p = new Parser(ts, d);
    const node = p.expression();
    if (p.peek().kind !== 'end') throw new Error(`"${p.peek().text}" does not belong in an argument`);
    return node;
  });
}

/** The counter of a FOR loop: a variable, an =, and where it starts. */
function assignmentFor(p) {
  // FOR COUNT=1 TO 5 counts in a variable of the program's own.
  if (p.d.namedVariables && p.peek().kind === 'ident') {
    const ref = p.namedRef();
    p.expect('=');
    return { named: ref.name, index: ref.index, value: p.expression() };
  }
  const mark = p.expect('#');
  const target = p.primary();
  p.expect('=');
  return { target, bank: mark.letter || null, value: p.expression() };
}

/** The types a Siemens DEF can declare. */
export const VARIABLE_TYPES = ['REAL', 'INT', 'BOOL', 'CHAR', 'STRING', 'AXIS', 'FRAME'];

/**
 * The rest of a DEF block: a type, then one name or more, each with an
 * optional array size and starting value.
 *
 *   DEF REAL DEPTH=5, STEP
 *   DEF INT POS[3]=(1, 2, 3)
 *   DEF STRING[32] NAME="ROUGH"
 *   DEF BOOL DONE=FALSE
 */
function declaration(p) {
  const t = p.next();
  const type = String(t.text || '').toUpperCase();
  if (!VARIABLE_TYPES.includes(type)) {
    throw new Error(`DEF needs a type — ${VARIABLE_TYPES.join(', ')} — and found "${t.text || 'nothing'}"`);
  }
  // STRING[32]: the longest text it holds, which is not a dimension.
  let length = null;
  if (type === 'STRING' && p.is('idx[')) {
    p.next();
    length = p.expression();
    p.expect('idx]');
  }
  const out = [];
  do {
    if (p.peek().kind === 'address') {
      // The control's own rule: a letter alone is an address, so a name
      // starts with two letters or an underscore.
      throw new Error(`${p.peek().text} is an address; a variable's name starts with two letters or an underscore`);
    }
    if (p.peek().kind !== 'ident') throw new Error(`DEF ${type} needs a name, and found "${p.peek().text || 'nothing'}"`);
    const name = p.next().text;
    let dims = null;
    if (p.is('idx[')) {
      p.next();
      dims = [p.expression()];
      while (p.eat(',')) dims.push(p.expression());
      p.expect('idx]');
    }
    let init = null;
    let initList = null;
    if (p.eat('=')) {
      // An array is filled from a list in brackets, or with SET( ).
      if (dims && (p.is('[') || (p.peek().kind === 'ident' && p.peek().text === 'SET'))) {
        if (!p.is('[')) p.next();
        p.expect('[');
        initList = [p.expression()];
        while (p.eat(',')) initList.push(p.expression());
        p.expect(']');
      } else {
        init = p.expression();
      }
    }
    out.push({ type, name, dims, init, initList, length });
  } while (p.eat(','));
  return out;
}

/** A level number on DO/END has to be a plain digit, and usually is. */
function evaluateConstant(node) {
  return node && node.op === 'num' ? node.value : 1;
}

/** What a declared variable holds before anything is put in it. */
const EMPTY = { REAL: 0, INT: 0, BOOL: 0, CHAR: 0, STRING: '', AXIS: '', FRAME: '' };

/**
 * A value made to fit its type, the way the control does it: an INT is
 * rounded, half away from zero; a BOOL is 1 or 0; a STRING is text; a REAL
 * will not hold text.
 */
export function coerce(type, value, name = '') {
  switch (type) {
    case 'INT': {
      if (typeof value === 'string') throw new Error(`text cannot go in the INT ${name}`);
      const n = Number(value) || 0;
      return Math.sign(n) * Math.round(Math.abs(n));
    }
    case 'BOOL': return value ? 1 : 0;
    case 'REAL':
      if (typeof value === 'string') throw new Error(`text cannot go in the REAL ${name}`);
      return Number(value) || 0;
    case 'STRING': return String(value);
    case 'CHAR': return typeof value === 'string' ? value.slice(0, 1) : Number(value) || 0;
    default: return value;
  }
}

/** The words a Siemens program may use as values without declaring them. */
const CONSTANTS = { TRUE: 1, FALSE: 0 };

/**
 * The variables a running program has.
 *
 * #1 to #33 are local to the macro call that is running, which is what
 * makes a macro callable from another macro without the two treading on
 * each other. #100 upwards are common to the whole program.
 *
 * On a control that lets a program name its own — Siemens: DEF REAL DEPTH
 * — those live here too, one scope per call, so a subprogram's DEPTH is not
 * its caller's (LUD). A name nothing has declared is the control's global
 * user data (GUD), which belongs to the machine and is set up before the
 * program runs.
 *
 * And every change can be written down as it happens — which variable,
 * what it became, on which line, before which move — so a program can be
 * looked at as it runs rather than only as it ended.
 */
export class Vars {
  /**
   * @param {number} [locals] variables up to this number belong to the
   *   macro call that is running. Fanuc's 33; zero on a control whose
   *   parameters are all global, as Siemens's R are.
   */
  constructor(locals = 33) {
    this.locals = Math.max(0, locals);
    this.common = new Map();
    this.frames = [new Map()];
    /** Which call each set of locals belongs to; null is the main program. */
    this.frameLabels = [null];
    /** How a numbered variable is written: #, R, Q. */
    this.prefix = '#';
    /** Banks beside the main one, each its own numbers: PT beside RG, VC beside V. */
    this.banks = new Map();
    /** The numbers each bank has; checked when the control is strict about them. */
    this.ranges = null;
    this.strict = false;
    /** #0 on a Fanuc: always empty, reads as nothing, cannot be set. */
    this.vacantZero = true;
    /** Told about the control's own variables, which this does not keep. */
    this.onSystem = null;
    /** Named variables, one scope per call; the first is the main program. */
    this.scopes = [{ label: null, vars: new Map() }];
    /** Global user data: named, belonging to the machine. */
    this.globals = new Map();
    /** Every name ever declared or used as global data, for the readout. */
    this.catalogue = new Map();
    /** Changes as they happen, when someone has asked for them. */
    this.trace = null;
    this.traceLimit = 200000;
    this.traceTruncated = false;
    /** Where the program is: set by the interpreter before each block. */
    this.where = { line: 0, move: 0, src: null, block: -1 };
  }

  /** Take the banks and their limits from what a dialect says it has. */
  configure({ main, ranges, strict }, { vacantZero = false } = {}) {
    this.prefix = main;
    this.ranges = ranges;
    this.strict = !!strict;
    this.vacantZero = vacantZero;
  }

  get local() { return this.frames[this.frames.length - 1]; }

  /** A macro call: its own #1 to #33, filled from the call's letters. */
  push(args, label = 'macro') {
    const frame = new Map();
    this.frames.push(frame);
    this.frameLabels.push(label);
    for (const [n, v] of args || []) {
      frame.set(n, v);
      if (this.trace) this.record(this.localKey(n), v);
    }
  }

  pop() {
    if (this.frames.length > 1) {
      this.frames.pop();
      this.frameLabels.pop();
    }
  }

  /** How a local is shown: #1 in the main program, #1 · O9010 inside a call. */
  localKey(k) {
    const label = this.frameLabels[this.frameLabels.length - 1];
    return label ? `${this.prefix}${k} · ${label}` : `${this.prefix}${k}`;
  }

  /** The range a number falls in, in its bank. */
  rangeOf(bank, k) {
    return this.ranges ? this.ranges.find((r) => r.bank === bank && k >= r.from && k <= r.to) || null : null;
  }

  /**
   * The register a number names, checked against what this control has.
   * Null for the always-empty #0 when read.
   */
  number(n, bank, writing) {
    const k = Math.round(n);
    if (!Number.isFinite(k)) throw new Error(`${bank}${n} is not a variable`);
    if (k === 0 && this.vacantZero && bank === this.prefix) {
      if (writing) throw new Error(`${bank}0 is always empty and cannot be set`);
      return null;
    }
    if (k < 0) throw new Error(`${bank}${k} is not a variable`);
    if (this.strict && this.ranges && !this.rangeOf(bank, k)) {
      const has = this.ranges.filter((r) => r.bank === bank)
        .map((r) => (r.to >= 99999 ? `${bank}${r.from} up` : `${bank}${r.from} to ${bank}${r.to}`));
      throw new Error(`${bank}${k} is not a variable on this control, which has ${has.join(', ')}`);
    }
    return k;
  }

  /** The control's own state: said once, rather than read as a silent zero. */
  system(bank, k, writing, value) {
    const r = this.rangeOf(bank, k);
    if (r && r.system && this.onSystem) this.onSystem(`${bank}${k}`, k, writing, value);
  }

  /** #0 is always null, which reads as zero here. */
  get(n, bank = null) {
    const mark = bank || this.prefix;
    const k = this.number(n, mark, false);
    if (k === null) return 0;
    if (mark !== this.prefix) {
      const v = this.banks.has(mark) ? this.banks.get(mark).get(k) : undefined;
      return v === undefined ? 0 : v;
    }
    const store = k >= 1 && k <= this.locals ? this.local : this.common;
    const v = store.get(k);
    if (v === undefined) this.system(mark, k, false);
    return v === undefined ? 0 : v;
  }

  set(n, value, bank = null) {
    const mark = bank || this.prefix;
    const k = this.number(n, mark, true);
    if (mark !== this.prefix) {
      if (!this.banks.has(mark)) this.banks.set(mark, new Map());
      this.banks.get(mark).set(k, value);
      if (this.trace) this.record(`${mark}${k}`, value);
      return;
    }
    const local = k >= 1 && k <= this.locals;
    if (!local) this.system(mark, k, true, value);
    (local ? this.local : this.common).set(k, value);
    if (this.trace) this.record(local ? this.localKey(k) : `${mark}${k}`, value);
  }

  /** Write a change down, if anyone is reading. */
  record(key, value) {
    if (!this.trace) return;
    if (this.trace.length >= this.traceLimit) { this.traceTruncated = true; return; }
    this.trace.push({ key, value, line: this.where.line, move: this.where.move, src: this.where.src, block: this.where.block });
  }

  // ---- named variables ----------------------------------------------------

  get scope() { return this.scopes[this.scopes.length - 1]; }

  /** A subprogram has started: its declarations are its own. */
  pushScope(label) { this.scopes.push({ label: label || 'subprogram', vars: new Map() }); }

  popScope() { if (this.scopes.length > 1) this.scopes.pop(); }

  /** The same subprogram again, from the top: its declarations start over. */
  resetScope() { if (this.scopes.length > 1) this.scope.vars = new Map(); }

  /** How a name is shown: with the subprogram it belongs to, if not the main one. */
  keyOf(entry) { return entry.scope ? `${entry.name} · ${entry.scope}` : entry.name; }

  /** Global user data, before the program runs. */
  defineGlobal(name, value, type = 'REAL') {
    const key = String(name).toUpperCase();
    const entry = { name: key, type, dims: null, value: coerce(type, value, key), scope: null, global: true, used: false };
    this.globals.set(key, entry);
  }

  /**
   * The machine's data is listed once the program reads it, and not
   * before: a machine holds dozens of these, and a readout of the ones a
   * program never looks at is noise around the three that matter. What it
   * held from the start goes down as set before the first block.
   */
  use(entry) {
    if (!entry.global || entry.used) return;
    entry.used = true;
    this.catalogue.set(entry.name, { name: entry.name, type: entry.type, dims: null, scope: 'machine', global: true, line: 0 });
    if (this.trace && this.trace.length < this.traceLimit) {
      this.trace.push({ key: entry.name, value: entry.value, line: 0, move: 0, src: null, block: -1 });
    }
  }

  /**
   * DEF: a variable of the program's own, in the scope that is running.
   * Declared again — the same subprogram called a second time — it starts
   * over, as it does on the control.
   *
   * @param {{type:string, name:string, dims:Array|null, init:object|null,
   *          initList:Array|null}} def  as parsed
   * @param {(node:object) => *} evalFn  works out an expression
   */
  declare(def, evalFn) {
    const name = def.name;
    const dims = def.dims ? def.dims.map((e) => Math.max(1, Math.floor(Number(evalFn(e)) || 0))) : null;
    const size = dims ? dims.reduce((a, b) => a * b, 1) : 1;
    if (size > 100000) throw new Error(`${name} would have ${size} elements; that is more than this reader holds`);
    const scope = this.scope;
    const entry = {
      name, type: def.type, dims, scope: scope.label,
      value: dims ? new Array(size).fill(EMPTY[def.type]) : EMPTY[def.type],
    };
    scope.vars.set(name, entry);
    const key = this.keyOf(entry);
    if (!this.catalogue.has(key)) {
      this.catalogue.set(key, { name, type: def.type, dims, scope: scope.label, line: this.where.line, src: this.where.src });
    }
    if (dims) {
      const list = def.initList ? def.initList.map(evalFn) : def.init ? [evalFn(def.init)] : [];
      list.forEach((v, i) => { if (i < size) entry.value[i] = coerce(def.type, v, name); });
      // Every element as it starts, so the readout has each one from here.
      for (let i = 0; i < size && i < 256; i++) this.record(this.elementKey(entry, i), entry.value[i]);
    } else {
      if (def.init) entry.value = coerce(def.type, evalFn(def.init), name);
      this.record(key, entry.value);
    }
  }

  /** The variable a name means here: this scope's own, or the machine's. */
  resolve(name) {
    return this.scope.vars.get(name) || this.globals.get(name) || null;
  }

  hasNamed(name) { return !!this.resolve(String(name).toUpperCase()); }

  /** Where in a flat array an index lands, checked against the declaration. */
  offset(entry, index) {
    if (!entry.dims) {
      if (index && index.length) throw new Error(`${entry.name} is not an array`);
      return -1;
    }
    if (!index || index.length !== entry.dims.length) {
      throw new Error(`${entry.name} has ${entry.dims.length} ${entry.dims.length === 1 ? 'index' : 'indices'}`);
    }
    let at = 0;
    for (let i = 0; i < index.length; i++) {
      const k = Math.round(Number(index[i]));
      // Siemens counts from 0: POS[3] holds POS[0] to POS[2].
      if (!(k >= 0 && k < entry.dims[i])) throw new Error(`${entry.name}[${index.join(', ')}] is outside ${entry.name}[${entry.dims.join(', ')}]`);
      at = at * entry.dims[i] + k;
    }
    return at;
  }

  elementKey(entry, flat) {
    const idx = [];
    let rest = flat;
    for (let i = entry.dims.length - 1; i >= 0; i--) {
      idx.unshift(rest % entry.dims[i]);
      rest = Math.floor(rest / entry.dims[i]);
    }
    const base = `${entry.name}[${idx.join(', ')}]`;
    return entry.scope ? `${base} · ${entry.scope}` : base;
  }

  getNamed(name, index) {
    // The control's own variables, $ in front: the interpreter answers them.
    if (name[0] === '$' && this.dollar) return this.dollar(name, index);
    const entry = this.resolve(name);
    if (!entry) {
      if (name in CONSTANTS) return CONSTANTS[name];
      throw new Error(`${name} is not defined: declare it with DEF, or give the machine a parameter of that name (global user data)`);
    }
    this.use(entry);
    const at = this.offset(entry, index);
    return at < 0 ? entry.value : entry.value[at];
  }

  setNamed(name, index, value) {
    const entry = this.resolve(name);
    if (!entry) throw new Error(`${name} is not defined: declare it with DEF, or give the machine a parameter of that name (global user data)`);
    this.use(entry);
    const at = this.offset(entry, index);
    const v = coerce(entry.type, value, name);
    if (at < 0) {
      entry.value = v;
      this.record(this.keyOf(entry), v);
    } else {
      entry.value[at] = v;
      this.record(this.elementKey(entry, at), v);
    }
  }

  /** What is set, for the summary — the shared ones are the interesting ones. */
  snapshot() {
    const out = [...this.common.entries()].sort((a, b) => a[0] - b[0]).map(([n, v]) => ({ n, value: v }));
    for (const [bank, store] of this.banks) {
      for (const [n, v] of [...store.entries()].sort((a, b) => a[0] - b[0])) out.push({ n, bank, value: v });
    }
    return out;
  }

  /** Every named variable the run declared or used, for the readout. */
  catalogueList() {
    return [...this.catalogue.entries()].map(([key, c]) => ({ key, ...c }));
  }
}

/**
 * Where a G65 argument lands.
 *
 * The awkward part of macro B, and worth writing out: the letters are not
 * in alphabetical order, G, L, N, O and P are not arguments at all, and I,
 * J and K repeat for the ten-argument form, which is not implemented.
 */
export const ARGUMENTS = {
  A: 1, B: 2, C: 3, I: 4, J: 5, K: 6, D: 7, E: 8, F: 9, H: 11,
  M: 13, Q: 17, R: 18, S: 19, T: 20, U: 21, V: 22, W: 23, X: 24, Y: 25, Z: 26,
};
