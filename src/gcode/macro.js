// Macro B: variables, arithmetic and control flow.
//
// A program that says `G1 X[#100 + #101]` is not exotic — it is how a shop
// writes a family of parts, how a probing cycle reports what it found, and
// how every tool-change program the builder shipped is written. Without it
// the real programs in a real control's memory cannot be read at all, so a
// verifier that stops at plain G-code stops short of the job.
//
// What is implemented is the Fanuc subset that carries its weight:
//
//   #100 = [#101 + 3] * SIN[30]     assignment and arithmetic
//   G1 X#100 Y[#1 * 2]              an expression anywhere a number goes
//   IF [#1 GT 5] GOTO 200           a conditional jump
//   IF [#1 EQ 0] THEN #2 = 4        a conditional assignment
//   WHILE [#1 LT 10] DO 1 … END 1   a loop
//   G65 P9010 A1. B2.               a call, with arguments as #1, #2, …
//
// Deliberately not implemented: BIN/BCD, the system-variable space beyond
// the few positions below, and the interrupt codes (M96/M97). They are
// listed here rather than left to be discovered.

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

const COMPARISONS = {
  EQ: (a, b) => (Math.abs(a - b) < 1e-9 ? 1 : 0),
  NE: (a, b) => (Math.abs(a - b) < 1e-9 ? 0 : 1),
  GT: (a, b) => (a > b ? 1 : 0),
  LT: (a, b) => (a < b ? 1 : 0),
  GE: (a, b) => (a >= b ? 1 : 0),
  LE: (a, b) => (a <= b ? 1 : 0),
};

const KEYWORDS = new Set(['IF', 'THEN', 'GOTO', 'WHILE', 'DO', 'END', 'MOD', 'AND', 'OR', 'XOR',
  ...Object.keys(FUNCTIONS), ...Object.keys(COMPARISONS)]);

/** Does this block need the macro reader at all? */
export function hasMacroSyntax(code) {
  if (code.includes('#') || code.includes('[')) return true;
  return /\b(IF|WHILE|GOTO|THEN|END\s*\d)\b/i.test(code);
}

// ---- tokens ---------------------------------------------------------------

function tokenize(code) {
  const out = [];
  let i = 0;
  const text = code;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#' || c === '[' || c === ']' || c === '+' || c === '-'
      || c === '*' || c === '/' || c === '=') {
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
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z]/.test(text[j])) j++;
      const word = text.slice(i, j).toUpperCase();
      // A run of letters is a keyword if it is one, and otherwise an
      // address: "SIN" is a function, "GX" is G then X.
      if (KEYWORDS.has(word)) {
        out.push({ kind: 'name', text: word });
        i = j;
      } else {
        out.push({ kind: 'address', text: text[i].toUpperCase() });
        i++;
      }
      continue;
    }
    // Anything else is not ours; keep it so the error says where.
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
  constructor(tokens) {
    this.t = tokens;
    this.i = 0;
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

  expression() { return this.comparison(); }

  comparison() {
    let left = this.logical();
    while (this.peek().kind === 'name' && COMPARISONS[this.peek().text]) {
      const op = this.next().text;
      left = { op: 'cmp', name: op, left, right: this.logical() };
    }
    return left;
  }

  logical() {
    let left = this.additive();
    while (this.peek().kind === 'name' && ['AND', 'OR', 'XOR'].includes(this.peek().text)) {
      const op = this.next().text;
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
  switch (node.op) {
    case 'num': return node.value;
    case 'var': return vars.get(evaluate(node.left, vars));
    case 'neg': return -evaluate(node.left, vars);
    case 'fn': return FUNCTIONS[node.name](evaluate(node.left, vars));
    case 'cmp': return COMPARISONS[node.name](evaluate(node.left, vars), evaluate(node.right, vars));
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
    case 'AND': return (evaluate(node.left, vars) && evaluate(node.right, vars)) ? 1 : 0;
    case 'OR': return (evaluate(node.left, vars) || evaluate(node.right, vars)) ? 1 : 0;
    case 'XOR': return (!!evaluate(node.left, vars) !== !!evaluate(node.right, vars)) ? 1 : 0;
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
export function parseMacroBlock(code) {
  const words = [];
  const assigns = [];
  let control = null;
  const p = new Parser(tokenize(code));

  try {
    while (p.peek().kind !== 'end') {
      // An assignment: #100 = something.
      if (p.is('#')) {
        p.next();
        const target = p.primary();
        p.expect('=');
        assigns.push({ target, value: p.expression() });
        continue;
      }

      if (p.peek().kind === 'name') {
        const name = p.next().text;
        if (name === 'IF') {
          const cond = p.expression();
          if (p.peek().kind === 'name' && p.peek().text === 'GOTO') {
            p.next();
            control = { kind: 'if-goto', cond, target: p.expression() };
          } else if (p.peek().kind === 'name' && p.peek().text === 'THEN') {
            p.next();
            p.expect('#');
            const target = p.primary();
            p.expect('=');
            control = { kind: 'if-then', cond, assign: { target, value: p.expression() } };
          } else {
            throw new Error('IF needs a GOTO or a THEN after its condition');
          }
          continue;
        }
        if (name === 'WHILE') {
          const cond = p.expression();
          const doTok = p.eat('name', 'DO');
          if (!doTok) throw new Error('WHILE needs a DO after its condition');
          control = { kind: 'while', cond, level: evaluateConstant(p.expression()) };
          continue;
        }
        if (name === 'END') {
          control = { kind: 'end', level: evaluateConstant(p.expression()) };
          continue;
        }
        if (name === 'GOTO') {
          control = { kind: 'goto', target: p.expression() };
          continue;
        }
        if (name === 'DO') {
          control = { kind: 'do', level: evaluateConstant(p.expression()) };
          continue;
        }
        throw new Error(`"${name}" cannot start a block`);
      }

      if (p.peek().kind === 'address') {
        const letter = p.next().text;
        // The value can be a plain number, a variable or a bracket.
        const node = p.expression();
        if (node.op === 'num') words.push({ letter, value: node.value, text: `${letter}${node.value}` });
        else words.push({ letter, expr: node, value: 0, text: letter });
        continue;
      }

      throw new Error(`"${p.peek().text}" does not belong here`);
    }
  } catch (err) {
    return { words, assigns, control, error: err.message };
  }

  return { words, assigns, control };
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
  constructor() {
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
    const store = k <= 33 ? this.local : this.common;
    const v = store.get(k);
    return v === undefined ? 0 : v;
  }

  set(n, value) {
    const k = Math.round(n);
    if (k <= 0) return;
    (k <= 33 ? this.local : this.common).set(k, value);
  }

  /** What is set, for the summary — the common ones are the interesting ones. */
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
