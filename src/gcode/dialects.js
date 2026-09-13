// What a control's macro language looks like.
//
// `#100 = [#1 + 2]` is not "macro syntax". It is *Fanuc's* macro syntax.
// Siemens writes `R100 = R1 + 2` and compares with `<>`; Heidenhain counts
// in Q parameters; Okuma uses V. The arithmetic underneath is the same in
// all of them — what differs is the spelling, and spelling belongs in a
// table rather than in a parser.
//
// So a dialect is data: which character marks a variable, which brackets
// group an expression, how the six comparisons are spelled, what the
// control-flow words are called, and how a comment is written. The reader
// takes one of these and reads whatever it describes, which is also what
// lets a shop describe a control nobody here has ever seen.

/** The operations a dialect can spell however it likes. */
export const COMPARISONS = ['eq', 'ne', 'gt', 'lt', 'ge', 'le'];
export const LOGIC = ['and', 'or', 'xor'];

/**
 * @typedef {object} Dialect
 * @property {string} id
 * @property {string} name
 * @property {string} notes            what this is and what it is not
 * @property {string|null} sigil       the character in front of a variable
 * @property {string[]} letters        letters that introduce one (R1, Q1, V1)
 * @property {[string,string]} group   brackets that group an expression
 * @property {boolean} parenComments   whether ( ) is a comment
 * @property {string[]} lineComments   what starts a comment to end of line
 * @property {boolean} wordEquals      whether X=expr is written with an =
 * @property {Record<string,string>} compare  operation -> spelling
 * @property {Record<string,string>} logic
 * @property {Record<string,string|null>} keywords
 * @property {'line'|'name'} labels    GOTO finds an N number, or a name
 * @property {{code:string|null, program:string, ret:string}} call
 */

const FANUC = {
  id: 'fanuc',
  name: 'Fanuc macro B',
  notes: 'Also Haas, Mazak ISO, Fadal and most of what a post writes. Variables are #, expressions group with square brackets, and the comparisons are spelled out.',
  sigil: '#',
  letters: [],
  group: ['[', ']'],
  parenComments: true,
  lineComments: [';'],
  wordEquals: false,
  compare: { eq: 'EQ', ne: 'NE', gt: 'GT', lt: 'LT', ge: 'GE', le: 'LE' },
  logic: { and: 'AND', or: 'OR', xor: 'XOR' },
  keywords: {
    if: 'IF', then: 'THEN', goto: 'GOTO', gotoBack: null,
    while: 'WHILE', do: 'DO', end: 'END', endWhile: null,
    for: null, to: null, endFor: null, repeat: null, until: null,
  },
  locals: 33,
  labels: 'line',
  call: { code: 'G65', program: 'P', ret: 'M99' },
};

const SIEMENS = {
  id: 'siemens',
  name: 'Siemens 840D',
  notes: 'R parameters, round brackets, symbol comparisons, and jumps to a named label rather than a line number. Comments are semicolons: a bracket is arithmetic here, not a remark.',
  sigil: null,
  letters: ['R'],
  group: ['(', ')'],
  parenComments: false,
  lineComments: [';'],
  wordEquals: true,
  compare: { eq: '==', ne: '<>', gt: '>', lt: '<', ge: '>=', le: '<=' },
  logic: { and: 'AND', or: 'OR', xor: 'XOR' },
  keywords: {
    if: 'IF', then: null, goto: 'GOTOF', gotoBack: 'GOTOB',
    while: 'WHILE', do: null, end: null, endWhile: 'ENDWHILE',
    for: 'FOR', to: 'TO', endFor: 'ENDFOR', repeat: 'REPEAT', until: 'UNTIL',
  },
  locals: 0,
  labels: 'name',
  call: { code: null, program: 'CALL', ret: 'M17' },
};

const HEIDENHAIN = {
  id: 'heidenhain',
  name: 'Heidenhain Q parameters (ISO)',
  notes: 'The Q parameters of a Heidenhain program written in ISO. Klartext — the conversational L/CC/CP language — is a different language and is not read; this is a starting point to edit rather than a complete control.',
  sigil: null,
  letters: ['Q'],
  group: ['[', ']'],
  parenComments: true,
  lineComments: [';'],
  wordEquals: false,
  compare: { eq: 'EQU', ne: 'NE', gt: 'GT', lt: 'LT', ge: 'GE', le: 'LE' },
  logic: { and: 'AND', or: 'OR', xor: 'XOR' },
  keywords: {
    if: 'IF', then: 'THEN', goto: 'GOTO', gotoBack: null,
    while: 'WHILE', do: 'DO', end: 'END', endWhile: null,
    for: null, to: null, endFor: null, repeat: null, until: null,
  },
  locals: 0,
  labels: 'line',
  call: { code: 'G65', program: 'P', ret: 'M99' },
};

const OKUMA = {
  id: 'okuma',
  name: 'Okuma OSP (V variables)',
  notes: 'Okuma counts in V variables and otherwise reads much like Fanuc here. The OSP’s own three-way IF and its subprogram forms are not read; edit this one to match the control in front of you.',
  sigil: null,
  letters: ['V', 'VC'],
  group: ['[', ']'],
  parenComments: true,
  lineComments: [';'],
  wordEquals: false,
  compare: { eq: 'EQ', ne: 'NE', gt: 'GT', lt: 'LT', ge: 'GE', le: 'LE' },
  logic: { and: 'AND', or: 'OR', xor: 'XOR' },
  keywords: {
    if: 'IF', then: 'THEN', goto: 'GOTO', gotoBack: null,
    while: 'WHILE', do: 'DO', end: 'END', endWhile: null,
    for: null, to: null, endFor: null, repeat: null, until: null,
  },
  locals: 0,
  labels: 'line',
  call: { code: 'G65', program: 'P', ret: 'M99' },
};

export const DIALECTS = {
  fanuc: FANUC,
  siemens: SIEMENS,
  heidenhain: HEIDENHAIN,
  okuma: OKUMA,
};

/**
 * The controls a machine can be built with.
 *
 * A control arrives with the machine and stays with it, so this list is
 * read where a machine is *made* rather than where one is edited.
 */
export const CONTROLS = [
  { value: 'fanuc', label: 'Fanuc' },
  { value: 'haas', label: 'Haas' },
  { value: 'fidia', label: 'Fidia' },
  { value: 'siemens', label: 'Siemens 840D' },
  { value: 'heidenhain', label: 'Heidenhain' },
  { value: 'okuma', label: 'Okuma' },
  { value: 'generic', label: 'Generic ISO' },
];

/** What to call one. */
export function controlName(flavour) {
  const found = CONTROLS.find((c) => c.value === flavour);
  return found ? found.label : String(flavour || 'Fanuc');
}

/** Which dialect a controller flavour starts from. */
export const FLAVOUR_DIALECT = {
  fanuc: 'fanuc',
  haas: 'fanuc',
  fidia: 'fanuc',
  siemens: 'siemens',
  heidenhain: 'heidenhain',
  okuma: 'okuma',
  generic: 'fanuc',
};

/**
 * The dialect a machine reads, with whatever the shop changed about it.
 *
 * Overrides are merged one level down, so a machine can say "everything
 * Fanuc, but this control spells not-equal <>" without restating the rest.
 *
 * @param {string} id
 * @param {object} [overrides]
 * @returns {Dialect}
 */
export function resolveDialect(id, overrides) {
  const base = DIALECTS[id] || FANUC;
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    id: overrides.id || base.id,
    letters: overrides.letters || base.letters,
    group: overrides.group || base.group,
    lineComments: overrides.lineComments || base.lineComments,
    compare: { ...base.compare, ...(overrides.compare || {}) },
    logic: { ...base.logic, ...(overrides.logic || {}) },
    keywords: { ...base.keywords, ...(overrides.keywords || {}) },
    call: { ...base.call, ...(overrides.call || {}) },
  };
}

/** One line of what this dialect looks like, for the interface. */
export function describeDialect(d) {
  const v = d.sigil ? `${d.sigil}100` : `${(d.letters[0] || 'R')}100`;
  const [open, close] = d.group;
  return `${v} = ${open}${v} + 1${close} · ${d.compare.ne} · ${d.keywords.while} … ${d.keywords.endWhile || `${d.keywords.end} 1`}`;
}

/** An example program in this dialect, for the page that offers it. */
export function sampleFor(d) {
  const v = (n) => (d.sigil ? `${d.sigil}${n}` : `${d.letters[0] || 'R'}${n}`);
  const [o, c] = d.group;
  const k = d.keywords;
  const x = d.wordEquals ? 'X=' : 'X';
  const lines = [`${v(1)} = 0`];
  if (k.while && k.endWhile) {
    lines.push(`${k.while} ${v(1)} ${d.compare.lt} 6`);
    lines.push(`  ${x}${o}25 * COS${o}60 * ${v(1)}${c}${c}`);
    lines.push(`  ${v(1)} = ${v(1)} + 1`);
    lines.push(k.endWhile);
  } else {
    lines.push(`${k.while} ${o}${v(1)} ${d.compare.lt} 6${c} ${k.do} 1`);
    lines.push(`  G0 ${x}${o}25 * COS${o}60 * ${v(1)}${c}${c}`);
    lines.push(`  ${v(1)} = ${v(1)} + 1`);
    lines.push(`${k.end} 1`);
  }
  return lines.join('\n');
}
