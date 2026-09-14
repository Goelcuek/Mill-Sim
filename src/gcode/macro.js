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

import { DIALECTS, resolveDialect } from './dialects.js';

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
  FUP: (v) => (v < 0 ? Math.floor(v) : Math.ceil(v)),
};

/** Keyed by what the comparison *is*, not by how a control spells it. */
const COMPARE = {
  eq: (a, b) => (Math.abs(a - b) < 1e-9 ? 1 : 0),
  ne: (a, b) => (Math.abs(a - b) < 1e-9 ? 0 : 1),
  gt: (a, b) => (a > b ? 1 : 0),
  lt: (a, b) => (a < b ? 1 : 0),
  ge: (a, b) => (a >= b ? 1 : 0),
  le: (a, b) => (a <= b ? 1 : 0),
};

const ALWAYS = ['MOD', ...Object.keys(FUNCTIONS)];

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
  // A label definition on a control that names them: "MARK1:".
  if (d.labels === 'name' && /^\s*[A-Za-z_][A-Za-z0-9_.]*\s*:/.test(code)) return true;
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

    // A control word with a mark in front of it — $IF, $GOTO — is one word.
    const prefixed = d.keywordPrefix && c === d.keywordPrefix && /[A-Za-z]/.test(text[i + 1] || '');
    if (/[A-Za-z]/.test(c) || prefixed) {
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
      this.next();
      return { op: 'var', left: this.primary() };
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
      this.expect(']');
      return { op: 'fn', name, left: arg };
    }
    if (this.peek().kind === 'number') return { op: 'num', value: this.next().value };
    throw new Error(`"${this.peek().text || 'the end of the block'}" is not a number, a variable or a bracket`);
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
    case 'var': return vars.get(evaluate(node.left, vars));
    case 'neg': return -evaluate(node.left, vars);
    case 'fn': return FUNCTIONS[node.name](evaluate(node.left, vars));
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
export function parseMacroBlock(code, dialect) {
  const d = dialect || DIALECTS.fanuc;
  const words = [];
  const assigns = [];
  let control = null;
  let label = null;
  let call = false;
  const p = new Parser(tokenize(code, d), d);
  /** This control's word for "run that file", when it spells it as a word. */
  const callWord = d.call && d.call.program && d.call.program.length > 1
    ? d.call.program.toUpperCase() : null;

  const assignment = () => {
    p.expect('#');
    const target = p.primary();
    // Some controls name the register and then the value, with nothing in
    // between: a Fidia writes RG 50 1.00 where a Fanuc writes #50 = 1.
    if (d.assignEquals === false) p.eat('=');
    else p.expect('=');
    return { target, value: p.expression() };
  };

  try {
    while (p.peek().kind !== 'end') {
      // An assignment: the variable, however this control writes one.
      if (p.is('#')) {
        assigns.push(assignment());
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
          if (p.isWord('goto') || p.isWord('gotoBack')) {
            const back = p.isWord('gotoBack');
            p.next();
            control = { kind: 'if-goto', cond, back, ...p.jumpTarget() };
          } else if (p.isWord('then')) {
            p.next();
            control = { kind: 'if-then', cond, assign: assignment() };
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

        if (p.isWord('goto') || p.isWord('gotoBack')) {
          const back = p.isWord('gotoBack');
          p.next();
          control = { kind: 'goto', back, ...p.jumpTarget() };
          continue;
        }

        if (p.isWord('for')) {
          p.next();
          const counter = assignmentFor(p);
          if (!p.eatWord('to')) throw new Error(`${d.keywords.for} needs ${d.keywords.to}`);
          control = { kind: 'for', counter, last: p.expression(), level: 0 };
          continue;
        }
        if (p.isWord('endFor')) { p.next(); control = { kind: 'end-for', level: 0 }; continue; }
        if (p.isWord('repeat')) { p.next(); control = { kind: 'repeat', level: 0 }; continue; }
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
    return { words, assigns, control, label, call, error: err.message };
  }

  return { words, assigns, control, label, call };
}

/** The counter of a FOR loop: a variable, an =, and where it starts. */
function assignmentFor(p) {
  p.expect('#');
  const target = p.primary();
  p.expect('=');
  return { target, value: p.expression() };
}

/** A level number on DO/END has to be a plain digit, and usually is. */
function evaluateConstant(node) {
  return node && node.op === 'num' ? node.value : 1;
}

/**
 * The variables a running program has.
 *
 * #1 to #33 are local to the macro call that is running, which is what
 * makes a macro callable from another macro without the two treading on
 * each other. #100 upwards are common to the whole program.
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
  }

  get local() { return this.frames[this.frames.length - 1]; }

  push(args) {
    const frame = new Map();
    for (const [n, v] of args || []) frame.set(n, v);
    this.frames.push(frame);
  }

  pop() {
    if (this.frames.length > 1) this.frames.pop();
  }

  /** #0 is always null, which reads as zero here. */
  get(n) {
    const k = Math.round(n);
    if (k <= 0) return 0;
    const store = k <= this.locals ? this.local : this.common;
    const v = store.get(k);
    return v === undefined ? 0 : v;
  }

  set(n, value) {
    const k = Math.round(n);
    if (k <= 0) return;
    (k <= this.locals ? this.local : this.common).set(k, value);
  }

  /** What is set, for the summary — the shared ones are the interesting ones. */
  snapshot() {
    return [...this.common.entries()].sort((a, b) => a[0] - b[0]).map(([n, v]) => ({ n, value: v }));
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
