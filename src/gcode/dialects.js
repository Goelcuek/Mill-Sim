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
    rep: null, repEnd: null,
  },
  locals: 33,
  labels: 'line',
  call: { code: 'G65', program: 'P', ret: 'M99' },
  /** What a program written for this control looks like from the outside. */
  marks: ['#\\d+\\s*=', '\\bM98\\s*P\\d', '\\bG65\\s*P\\d', '\\bWHILE\\s*\\[', '\\bG68\\.2\\b', '\\bG43\\.4\\b'],
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
    rep: null, repEnd: null,
  },
  locals: 0,
  labels: 'name',
  call: { code: null, program: 'CALL', ret: 'M17' },
  marks: ['\\bGOTOF\\b', '\\bGOTOB\\b', '\\bENDWHILE\\b', '\\bR\\d+\\s*=', '\\bMSG\\s*\\(', '\\bCYCLE\\d+', '\\bTRANS\\b'],
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
    rep: null, repEnd: null,
  },
  locals: 0,
  labels: 'line',
  call: { code: 'G65', program: 'P', ret: 'M99' },
  marks: ['\\bQ\\d+\\s*=', '\\bFN\\s*\\d'],
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
    rep: null, repEnd: null,
  },
  locals: 0,
  labels: 'line',
  call: { code: 'G65', program: 'P', ret: 'M99' },
  marks: ['\\bVC\\d+\\s*=', '\\bCALL\\s+O\\d'],
};

/**
 * Fidia.
 *
 * The odd one out, and the reason this table exists. A Fidia program is a
 * stream of direct commands — `>` in front of a line means "do this now" —
 * with `;` remarks, `$IF` and `$GOTO` round named labels, and registers
 * written `RG 50`. Several things a Fanuc does with G codes it does with
 * words of its own: RTCP ON/OF rather than G43.4/G49, ORIGIN rather than
 * G54, and no tilted working plane at all.
 *
 * The rest of what makes it different is in the flags below, because it is
 * behaviour rather than spelling: G0/G2/G3 last one block, an arc radius is
 * written negative, a tool is T0.07, and G92 puts the control in vector
 * mode where a DX/DY/DZ tool direction is turned into the A and C that
 * produce it.
 */
const FIDIA = {
  id: 'fidia',
  name: 'Fidia',
  notes: 'Direct commands with > in front, ; for a remark, $IF and $GOTO round named labels, registers as RG 50. No tilted plane: RTCP ON holds the tip still while the rotaries move, and G92 turns a DX/DY/DZ tool vector into the rotary positions that produce it.',
  sigil: null,
  letters: ['RG'],
  group: ['(', ')'],
  /** ( ) is a remark, except where a keyword needs the brackets it took. */
  parenComments: 'code',
  lineComments: [';'],
  wordEquals: false,
  compare: { eq: '==', ne: '!=', gt: '>', lt: '<', ge: '>=', le: '<=' },
  logic: { and: 'AND', or: 'OR', xor: 'XOR' },
  keywords: {
    if: '$IF', then: null, goto: '$GOTO', gotoBack: null,
    while: '$WHILE', do: null, end: null, endWhile: '$ENDWHILE',
    for: null, to: null, endFor: null, repeat: null, until: null,
    /**
     * Count, rather than test: $REP 4 runs everything down to $END four
     * times over. It is how a Fidia program says "and the same again on
     * the next face" — the body calls the toolpath, indexes the rotary a
     * quarter turn, and $REP does the counting.
     */
    rep: '$REP', repEnd: '$END',
  },
  /** Control words wear a $; labels and registers do not. */
  keywordPrefix: '$',
  /** A label may carry dots: ITEM4.00. */
  identDots: true,
  locals: 0,
  labels: 'name',
  call: {
    code: null,
    program: 'IPC',
    ret: 'M30',
    /** How a Fidia asks for a file: the path is the control's, the name is ours. */
    line: '^IPC\\s*=>\\s*CNC\\s+(.+)$',
  },
  /** A line may start with this; it means "act on it now" and reads the same. */
  direct: '>',
  /** Arguments in braces after an M code: M520{%1=2 %4=2}. */
  braceArgs: true,
  /** Addresses of more than one letter, which have to be read before X and Y. */
  addresses: ['DX', 'DY', 'DZ'],
  /** Words that are commands in their own right. */
  commands: ['RTCP', 'RTCPTLCN', 'CQAHDW', 'CQA', 'ORIGIN', 'TDIAM', 'TLENGTH'],
  /**
   * Lines that describe the machine's own tool table rather than the part.
   *
   * Every Fidia program opens with a block of them — one group per cutter,
   * declaring its type, diameter, corner radius, flute count, top speed —
   * because on the machine these fill in the table the control holds. The
   * simulator gets its cutters from its own library, so what these say is
   * already known and what they set is nothing this reads. They are skipped
   * whole, and counted, rather than picked over word by word: taken as
   * coordinates they are a page of errors on a program that is perfectly
   * correct.
   *
   * The declaring form may carry an index — TDIAM__1 7 0.1969 is the first
   * diameter of pot 7 — which is what tells it apart from the same word
   * asking a question inside an expression: $IF (TDIAM 00 < 0.1) is still
   * answered from the tool table. See `tables`.
   *
   * That index is also the general rule, so the list does not have to be
   * complete: any word written WORD__n at the head of a line of numbers is
   * one of these, whether or not it is named here.
   */
  settings: [
    'TTYP', 'TDIAM', 'TLENGTH', 'PREDIAM', 'TRADIUS', 'PRERADIUS',
    'TCUTNR', 'TMAXSP', 'MAXCUTLEN', 'TTOLLD',
  ],
  /** A register is set by naming it: RG 50 1.00, with no = in between. */
  assignEquals: false,
  /** And tested with one: $IF (RG 50 = 1). == is accepted as well. */
  eqCompare: true,
  /**
   * Questions a program asks about the tool table: TLENGTH 07 is the
   * length of pot 7, and 0 means whatever is in the spindle. A program
   * that checks its tool before it cuts — $IF (TLENGTH 00 < 0.1) — is
   * asking the machine something real, so it is answered from the tool
   * table rather than read as a register that happens to be zero.
   */
  tables: { TLENGTH: 'length', TDIAM: 'diameter' },
  /** G0, G2 and G3 last one block rather than staying on. */
  modalMotion: false,
  /**
   * The feed is written a hundred times over: F80000 is 800 a minute, and
   * F3000 is 30. Whichever unit is in force — the same programs use G20
   * and G21 in the same header — it is the same hundred.
   */
  feedScale: 0.01,
  /** R is written negative for the arc a Fanuc writes positive. */
  arcRSign: -1,
  /** T0.07 is tool 7. */
  toolDecimal: true,
  /** The G codes that turn the DX/DY/DZ tool vector on and off. */
  vectorMode: { on: 92, off: 93 },
  /** RTCP ON / RTCP OF, in place of G43.4 and G49. */
  rtcp: true,
  /**
   * The part indexer.
   *
   * U is not a slide and it is not one of the machine's own axes: it says
   * which way round the work is sitting. U-90 between two calls of the
   * same toolpath is the next face of the part coming up — the program
   * says so with U0.0000(ITEM BASLANGIC ACISI), the item's starting angle
   * — and nothing on the machine moves to do it. So the work turns and
   * everything else stands exactly where it was.
   */
  indexer: { letter: 'U', axis: 'Z' },
  /**
   * The axis that moves the tool along its own line.
   *
   * W is not a joint and there is no quill: the control takes it as "move
   * the tip this far the way the spindle is pointing" and works out the
   * X, Y and Z that get it there, in whatever combination the head's angle
   * calls for. So it belongs here with the other things the control does
   * rather than in any machine's chain — and a machine that does have a
   * real W slide keeps it, the same way as the indexer.
   */
  alongTool: { letter: 'W' },
  marks: [
    '^\\s*>', '\\bIPC\\s*=>\\s*CNC\\b', '\\bRTCP(TLCN)?\\s+(ON|OF)\\b',
    '\\$IF\\b', '\\$GOTO\\b', '^\\s*ORIGIN\\s+\\d', '^\\s*CQA\\b', '\\bRG\\s*\\d+',
    '\\bDX-?[\\d.]+\\s+DY',
  ],
};

export const DIALECTS = {
  fanuc: FANUC,
  siemens: SIEMENS,
  heidenhain: HEIDENHAIN,
  okuma: OKUMA,
  fidia: FIDIA,
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
  fidia: 'fidia',
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
    addresses: overrides.addresses || base.addresses,
    commands: overrides.commands || base.commands,
    settings: overrides.settings || base.settings,
    tables: overrides.tables || base.tables,
    vectorMode: overrides.vectorMode || base.vectorMode,
    indexer: overrides.indexer || base.indexer,
    alongTool: overrides.alongTool || base.alongTool,
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

/**
 * Which control a program was written for, judged by the program itself.
 *
 * A program read against the wrong control does not produce a slightly
 * wrong toolpath — it produces a hundred and fifty errors and no path at
 * all, which is a question ("which machine is this for?") wearing the
 * costume of a fault. So the question gets asked directly: every dialect
 * carries the marks a program written for it wears, and this counts them.
 *
 * Only a clear answer is an answer. A tie, or a handful of coincidences,
 * returns null rather than a guess — the machine's own control is the
 * better guess in that case, and it is already what is being used.
 *
 * @param {string} text
 * @returns {string|null} a dialect id
 */
export function detectDialect(text) {
  const src = String(text || '');
  if (!src.trim()) return null;

  const scored = Object.values(DIALECTS).map((d) => {
    let hits = 0;
    let kinds = 0;
    for (const mark of d.marks || []) {
      const found = src.match(new RegExp(mark, 'gim'));
      if (found && found.length) {
        kinds += 1;
        hits += found.length;
      }
    }
    return { id: d.id, hits, kinds };
  }).sort((a, b) => b.hits - a.hits || b.kinds - a.kinds);

  const best = scored[0];
  const next = scored[1];
  if (!best || best.kinds < 2 || best.hits < 3) return null;
  if (next && next.hits > best.hits * 0.6) return null;
  return best.id;
}
