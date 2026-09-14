// Fidia.
//
// The control this reader was least like. Most of what makes it different
// is spelling — > in front of a line, ; for a remark, $IF and $GOTO, RTCP
// where a Fanuc writes G43.4 — and that belongs in the dialect table. The
// rest is behaviour, and this is where it is pinned down: rapid and the
// arcs last one block, an arc radius is written negative, a tool is T0.07,
// and G92 puts the control in vector mode, where the block says which way
// the tool points and the control works out the angles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { interpret } from '../src/gcode/interpreter.js';
import { lex } from '../src/gcode/lexer.js';
import { DIALECTS } from '../src/gcode/dialects.js';
import { buildPreset } from '../src/machine/presets.js';

const d = DIALECTS.fidia;
const trunnion = () => buildPreset('tableTable');
const run = (src, extra = {}) => interpret(Array.isArray(src) ? src.join('\n') : src, {
  controller: { flavour: 'fidia', dialect: 'fidia' },
  kinematics: trunnion(),
  ...extra,
});
const errs = (p) => p.warnings.filter((w) => w.severity === 'error');
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);

test('a direct mark, a remark and a brace argument are read off the block', () => {
  const blocks = lex([
    '>G90 G21',
    '>M520{%1=2 %4=2 %8=2 %9=2}',
    '>U0.0000(ITEM BASLANGIC ACISI)',
    '; ***** a remark *****',
  ].join('\n'), d);
  assert.deepEqual(blocks[0].words.map((w) => `${w.letter}${w.value}`), ['G90', 'G21']);
  assert.deepEqual(blocks[1].words.map((w) => `${w.letter}${w.value}`), ['M520']);
  assert.deepEqual(blocks[2].words.map((w) => `${w.letter}${w.value}`), ['U0']);
  assert.deepEqual(blocks[2].comments, ['ITEM BASLANGIC ACISI']);
  assert.deepEqual(blocks[3].words, []);
  for (const b of blocks) assert.equal(b.error, undefined, `${b.raw}: ${b.error}`);
});

test('DX is a tool vector, not an X word', () => {
  const [b] = lex('X-4.9392 Y0.0000 Z2.9641 DX-0.9135 DY0.0000 DZ0.4067', d);
  const words = Object.fromEntries(b.words.map((w) => [w.letter, w.value]));
  assert.deepEqual(words, { X: -4.9392, Y: 0, Z: 2.9641, DX: -0.9135, DY: 0, DZ: 0.4067 });
});

test('rapid and the arcs last one block', () => {
  const p = run(['>G90 G21 G54', 'F500', '>G0 X0 Y0 Z0', 'X10 Y0 Z0', 'M30']);
  assert.deepEqual(errs(p), []);
  assert.deepEqual(p.moves.map((m) => m.kind), ['rapid', 'feed'], 'the block after G0 is a feed');

  // And the first block of a program, before any G word at all.
  const bare = run(['>G90 G21 G54', 'F500', 'X10 Y0 Z0', 'M30']);
  assert.equal(bare.moves[0].kind, 'feed');
});

test('an arc radius is written negative for the arc a Fanuc writes positive', () => {
  // Not a semicircle. With the chord exactly twice the radius the two arcs
  // are the same arc, so that case cannot tell a minor from a major one —
  // which is how this went out wrong the first time.
  const opts = { arcTolerance: 0.0005 };
  const path = (p) => {
    const m = p.moves.find((x) => x.kind === 'arc');
    let len = 0;
    for (let i = 3; i < m.path.length; i += 3) {
      len += Math.hypot(m.path[i] - m.path[i - 3], m.path[i + 1] - m.path[i - 2]);
    }
    const mid = Math.floor(m.path.length / 6) * 3;
    return { len, mid: [m.path[mid], m.path[mid + 1]] };
  };

  for (const [g, dir] of [['G03', 3], ['G02', 2]]) {
    const here = run([">G90 G21 G54", 'F500', 'G01 X0 Y0 Z0', `${g} X12 Y0 R-10`, 'M30'], opts);
    const there = interpret(`G90 G21 G54\nF500\nG01 X0 Y0 Z0\n${g} X12 Y0 R10\nM30`, opts);
    assert.deepEqual(errs(here), []);
    const a = path(here);
    const b = path(there);
    near(a.len, b.len, 1e-6, `${g}: the same arc length`);
    near(a.mid[0], b.mid[0], 1e-6, `${g}: the same way round (x)`);
    near(a.mid[1], b.mid[1], 1e-6, `${g}: the same way round (y)`);

    // And it really is the short way: a minor arc of a 10 mm radius over a
    // 12 mm chord is 12.6 mm, not the 50 mm the long way round.
    near(a.len, 10 * 2 * Math.asin(6 / 10), 0.01, `${g}: the short side of the circle`);
    // The two directions are mirror images, so the midpoint flips sides.
    assert.ok((dir === 3 ? -1 : 1) * a.mid[1] > 0, `${g}: turns the way it says`);
  }
});

test('a machine macro runs in the machine\'s own millimetres', () => {
  // The body is the machine builder's, written in the units the machine's
  // positions are kept in. A program in inches does not turn a tool change
  // position of −320 mm into −320 inches, which put the machine eight
  // metres out on its way to the carousel.
  const macros = [{
    id: 'm6', code: 'M6', enabled: true, name: 'Tool change',
    body: 'M5\nG91 G28 Z0\nG90 G53 G0 X#toolChangeX Y#toolChangeY',
  }];
  const parameters = { toolChangeX: -320, toolChangeY: 210 };
  const where = (units) => interpret(
    `${units}\nG90 G54\nG0 X0 Y0 Z0\nM6 T2\nG0 X1 Y1\nM30`,
    { macros, parameters, machineZero: [0, 0, 250] },
  ).moves;

  for (const units of ['G21', 'G20']) {
    const moves = where(units);
    const atChange = moves.find((m) => m.source === 'M6 macro' && Math.abs(m.to[0] + 320) < 1e-6);
    assert.ok(atChange, `${units}: the macro went to the change position`);
    near(atChange.to[1], 210, 1e-6, `${units}: and to the Y of it`);
  }

  // And the program's own units are still its own afterwards.
  const inches = where('G20');
  near(inches[inches.length - 1].to[0], 25.4, 1e-6, 'G20 still applies to the program');
});

test('the pot number is the digits after the point, not the value', () => {
  // T0.7 and T0.07 are the same pot on this control and are not the same
  // number, so reading them as a value times a hundred made one of them
  // pot 70 — and a tool table with no pot 70 in it.
  const p = run(['>M06 T0.07', '>M6T.05', '>M06 T0.7', '>M06 T12.03', '>M06 T2', 'M30']);
  assert.deepEqual(p.toolChanges.map((c) => c.tool), [7, 5, 7, 12, 2]);
});

test('RTCP holds the tip, ORIGIN picks the offset, the rest is said once', () => {
  const p = run([
    'ORIGIN 4',
    'RTCP ON',
    'G01 X0 Y0 Z0 F500',
    'RTCP OF',
    'G01 X1 Y0 Z0',
    'CQAHDW ON',
    'CQAHDW OF',
    'RTCPTLCN OF',
    'M30',
  ], { wcs: { G54: [0, 0, 0], G55: [0, 0, 0], G56: [0, 0, 0], G57: [5, 5, 5], G58: [0, 0, 0], G59: [0, 0, 0] } });
  assert.deepEqual(errs(p), []);
  // ORIGIN 4 is the fourth offset, so the move lands on G57's zero.
  assert.deepEqual(p.moves[0].to, [5, 5, 5]);
  assert.equal(p.moves[0].tcp, 4, 'RTCP ON is tool centre point control');
  assert.ok(!p.moves[1].tcp, 'and RTCP OF turns it off');
  // A compensation switch is mentioned once, not once per block.
  const said = p.warnings.filter((w) => /CQAHDW/.test(w.message));
  assert.equal(said.length, 1);
  assert.ok(p.warnings.some((w) => /RTCPTLCN/.test(w.message)));
});

test('G92 reads a tool vector and works out the angles; G93 goes back', () => {
  const kin = trunnion();
  const p = run([
    'G92',
    'F1000',
    'X0 Y0 Z0 DX0 DY0 DZ1',
    'X0 Y0 Z-1 DX0 DY-0.4226 DZ0.9063',
    'G93',
    'X0 Y0 Z-2 A10 C20',
    'M30',
  ], { kinematics: kin });
  assert.deepEqual(errs(p), []);

  const flat = p.moves[0].rotTo;
  near(flat.A, 0, 1e-6, 'straight up is no rotation');
  const tipped = p.moves[1].rotTo;
  near(tipped.A, -25, 1e-3, 'a 25 degree vector is 25 degrees of A');
  // And the angles it chose really do point the tool that way.
  const axis = kin.toolAxis(tipped, 0);
  near(axis[1], -0.4226, 1e-3, 'tool axis Y');
  near(axis[2], 0.9063, 1e-3, 'tool axis Z');
  // After G93 the block's own A and C are back in charge.
  assert.equal(p.moves[2].rotTo.A, 10);
  assert.equal(p.moves[2].rotTo.C, 20);
});

test('a tool vector outside vector mode is reported rather than obeyed', () => {
  const p = run(['F500', 'X0 Y0 Z0 DX0 DY-0.4226 DZ0.9063', 'M30']);
  assert.ok(p.warnings.some((w) => /vector mode/i.test(w.message)));
  assert.equal(p.moves[0].rotTo.A, 0);
});

test('IPC => CNC runs the file it names, wherever the control keeps it', () => {
  const p = run([
    '>M03 S1000',
    'IPC => CNC C:\\TEI\\TOOLPATH\\2445M92P01_OP110_IT1_HELICAL_DELIK.txt',
    '>M05',
    'M30',
  ], {
    subprograms: [{
      name: '2445M92P01_OP110_IT1_HELICAL_DELIK.txt',
      text: '(IT1_HELICAL_DELIK - Kesim Suresi : 29 sn )\nG01 X-4.59 Y0 Z4.173 F20000\nG01 Z2.467\nM30\n',
    }],
  });
  assert.deepEqual(errs(p), []);
  assert.deepEqual(p.moves.map((m) => m.source), [
    '2445M92P01_OP110_IT1_HELICAL_DELIK.txt',
    '2445M92P01_OP110_IT1_HELICAL_DELIK.txt',
  ]);
});

test('$IF jumps to a named label, and a register decides', () => {
  const body = [
    '>G90 G21 G54',
    'F500',
    '$IF (RG 50 != 5) $GOTO ITEM6.00',
    'G01 X10 Y0 Z0',
    'ITEM6.00:',
    'G01 X0 Y10 Z0',
    'M30',
  ];
  // Nothing set: the register is zero, so the guarded block is skipped.
  const skipped = run(body);
  assert.deepEqual(errs(skipped), []);
  assert.deepEqual(skipped.moves.map((m) => m.to[0]), [0]);

  // Set to 5, and it runs.
  const ran = run(body, { parameters: { 50: 5 } });
  assert.deepEqual(errs(ran), []);
  assert.deepEqual(ran.moves.map((m) => m.to[0]), [10, 0]);
});

// ---- a real main program --------------------------------------------------
//
// The shape a Fidia main program actually comes in: a label, the control
// words, a mark in front of nearly every line, the compensation switches,
// an M code carrying braces, and a file called by name at the end of it.
// Read against a Fanuc this produced a hundred and fifty errors and no
// toolpath, which is the report this test exists to keep from coming back.

const MAIN = [
  'TP5:',
  ';*********************** IT5_HELICAL_DELIK - 1 ***********************',
  'ORIGIN 4',
  'RTCP OF',
  'RTCPTLCN OF',
  'RTCP ON',
  '',
  ';>>>>>>>>>>TURN ON FLAT AND OFF CENTER COMPENSATIONS',
  '>M321',
  '>M311',
  '>M312',
  '>S22000',
  '>G20',
  '>G21',
  '>G90 G40 G80',
  'CQAHDW OF',
  'CQAHDW ON',
  '',
  '>W0.',
  '>X-10.59 Y0.00 A0. C90. F80000',
  '>G17',
  '',
  '>U0.0000(ITEM BASLANGIC ACISI)',
  '',
  'CQA XP .000',
  'CQA YP .000',
  'CQA ZP .000',
  'CQA WP .000',
  '',
  '>M03 S1000',
  '>M08',
  '',
  'IPC => CNC C:\\TEI\\TOOLPATH\\2445M92P01_OP110_IT1_HELICAL_DELIK.txt',
  '>M520{%1=2 %4=2 %8=2 %9=2}',
  '>M05',
  '>M09',
  '>Z4.173 F80000',
  '>X-10.59 Y0.00',
  '',
  '>G91 G0 U-90.0',
  '>G90',
  '>M01',
  'M30',
];

/** And what it calls: coordinates, a tool vector, and nothing else. */
const SUB = [
  '(TOOLPATH/ACILI_DELIK_HELICAL,TOOL=FREZE TKY11986)',
  'G92',
  'F20000',
  'X-4.9392 Y0.0000 Z2.9641 DX-0.9135 DY0.0000 DZ0.4067',
  'M10',
  'F4000',
  'X-4.0257 Y0.0000 Z2.5573',
  'F3000',
  'X-4.0255 Y-0.0026 Z2.5576',
  'X-4.0251 Y-0.0050 Z2.5586',
  'G93',
  'M30',
].join('\n');

test('a Fidia main program reads without a single error', () => {
  const p = run(MAIN, {
    subprograms: [{ name: '2445M92P01_OP110_IT1_HELICAL_DELIK.txt', text: SUB }],
  });
  assert.deepEqual(errs(p), []);

  // The file it named ran, and the vector in it turned the machine.
  assert.ok(p.moves.some((m) => m.source === '2445M92P01_OP110_IT1_HELICAL_DELIK.txt'), 'the called file ran');
  assert.ok(p.moves.some((m) => Math.abs((m.rotTo || {}).A || 0) > 1), 'the tool vector turned the rotaries');

  // U is the indexer on this machine, so U-90 is an index and not a slide.
  const indexed = p.moves[p.moves.length - 1];
  assert.ok(Math.abs(indexed.rotTo.U + 90) < 1e-6 || Math.abs(indexed.rotTo.C) > 0, 'U was read as the axis the chain says it is');
});

test('a program written for another control says so instead of falling apart', () => {
  // The same program, read by a machine that thinks it is a Fanuc.
  const fanuc = interpret(MAIN.join('\n'), { kinematics: trunnion() });
  assert.equal(fanuc.suggested, 'fidia');
  assert.ok(fanuc.warnings.some((w) => /written for a Fidia/.test(w.message)));

  // And read by the right one, there is nothing to suggest.
  const p = run(MAIN);
  assert.equal(p.suggested, null);
});

test('a program can ask the machine about its tool', () => {
  // TDIAM at the head of a block is a command, not — as it was — an M word
  // and a stray number, which read as M00 and stopped the program.
  const src = [
    '>G21',
    '>M06 T0.07',
    'TDIAM 00 5.0',
    '$IF (TLENGTH 00 < 0.1) $GOTO SHORT',
    'G01 X10 Y0 Z0 F500',
    'SHORT:',
    'M30',
  ];
  const tools = { 7: { length: 120, diameter: 5 } };

  const set = run(src, { tools });
  assert.deepEqual(errs(set), []);
  assert.equal(set.moves.length, 1, 'a tool that is there is long enough to cut with');
  assert.ok(!set.events.some((e) => /stop/i.test(e.text)), 'TDIAM is not a program stop');

  // Pot 0 is whatever is in the spindle, and the answer is in the units
  // the program is asking in — a 120 mm tool is 4.7 inches, still not short.
  const inches = run(['>G20', ...src.slice(1)], { tools });
  assert.equal(inches.moves.length, 1);
  near(inches.moves[0].to[0], 254, 1e-9, 'and the program is still in inches');

  // An empty pot answers zero, so the guard does what it would on the
  // machine: takes the branch.
  const empty = run(src, { tools: {} });
  assert.deepEqual(empty.moves, []);
});

// ----------------------------------------------- the machine's own tables

test('the tool-table block a program opens with is skipped, not read as coordinates', () => {
  const p = run([
    '; *********** DEFINE TOOLS ***********',
    'TTYP 7 10',
    'TDIAM__1 7 0.1969',
    'PREDIAM__1 7 0.1969',
    'TRADIUS__1 7 0.0984',
    'PRERADIUS__1 7 0.0984',
    'TCUTNR__1 7 2',
    'TMAXSP 7 20000',
    'MAXCUTLEN__1 7 0.2469',
    'TTOLLD__1 7 0.010',
    '>G90 G21 G54',
    'F500',
    '>G0 X0 Y0 Z0',
    'X10 Y0 Z0',
    'M30',
  ]);
  assert.deepEqual(errs(p), [], 'a tool-table header should not be a page of errors');
  assert.equal(p.settings.length, 9, 'the skipped lines are not accounted for');
  assert.equal(p.settings[0].name, 'TTYP');
  // Nothing from them reaches the toolpath: a 20000 on a TMAXSP line is a
  // spindle limit, not twenty metres of travel.
  assert.deepEqual(p.moves.map((m) => m.kind), ['rapid', 'feed']);
  // (Z starts at the machine's own park height, which is not the program's.)
  assert.ok(p.stats.bounds.max[0] <= 10 + 1e-9 && p.stats.bounds.max[1] <= 1e-9,
    `the table lines moved something: ${p.stats.bounds.max}`);
});

test('a word ending in __n is a table line whether or not it is named', () => {
  const p = run(['TSOMETHINGNEW__2 7 0.5', '>G90 G21 G54', '>G0 X1 Y1 Z1', 'M30']);
  assert.deepEqual(errs(p), []);
  assert.equal(p.settings.length, 1);
  assert.equal(p.settings[0].name, 'TSOMETHINGNEW');
});

test('but a word that means something still means it', () => {
  // TDIAM declares up in the header and asks a question down in the
  // program. Which one it is, is where it stands.
  const p = run([
    'TDIAM__1 7 0.1969',
    '>G90 G21 G54',
    '$IF (TDIAM 00 > 3) $GOTO BIG',
    '>G0 X1 Y0 Z0',
    'BIG:',
    '>G0 X50 Y0 Z0',
    'M30',
  ], { tools: { 7: { diameter: 5, length: 100 } }, tool: 7 });
  assert.deepEqual(errs(p), []);
  assert.equal(p.settings.length, 1, 'the declaration was not skipped');
  assert.ok(p.stats.bounds.max[0] > 40, 'the question was not answered from the tool table');
});

test('nonsense is still nonsense', () => {
  // The rule is narrow on purpose: a line of numbers under a known name,
  // or the __n form. A typo is neither, and still gets said out loud.
  const p = run(['>G90 G21 G54', 'TDIAMX 7 0.1969', '>G0 X1 Y0 Z0', 'M30']);
  assert.ok(errs(p).length > 0, 'a word nobody knows went through quietly');
});

test('a register is set by naming it and tested with one =', () => {
  const p = run([
    'RG 50 1.00',
    '>G90 G21 G54',
    '$IF (RG 50 = 1) $GOTO TP1',
    '>G0 X99 Y0 Z0',
    'TP1:',
    '>G0 X5 Y0 Z0',
    'M30',
  ]);
  assert.deepEqual(errs(p), []);
  assert.ok(p.stats.bounds.max[0] < 90, 'the jump did not fire, so RG 50 never took the value');
  // == is the same test, for a program that writes it that way.
  const other = run([
    'RG 50 1.00', '>G90 G21 G54', '$IF (RG 50 == 1) $GOTO TP1',
    '>G0 X99 Y0 Z0', 'TP1:', '>G0 X5 Y0 Z0', 'M30',
  ]);
  assert.deepEqual(errs(other), []);
  assert.ok(other.stats.bounds.max[0] < 90);
});
