// Siemens 840D sl: the words a Siemens program writes for itself.
//
// Frames (ROT, TRANS), modes (TRAORI, DIAMOF), the swivel cycle, the
// drilling cycles called like functions, tools chosen by name, G75, axis
// values with their own mode (C=DC(90)) and REPEAT over a labelled section.

import test from 'node:test';
import assert from 'node:assert/strict';

import { interpret } from '../src/gcode/interpreter.js';
import { buildPreset } from '../src/machine/presets.js';

const SIEMENS = { controller: { flavour: 'siemens', dialect: 'siemens' } };
const run = (code, extra = {}) => interpret(code, { ...SIEMENS, ...extra });
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const ends = (p) => p.moves.map((m) => m.to.map((v) => +v.toFixed(3)));
const errors = (p) => p.warnings.filter((w) => w.severity === 'error').map((w) => `${w.line}: ${w.message}`);
const said = (p) => p.warnings.map((w) => `${w.line}: ${w.message}`);

test('ROT turns the program, AROT adds to it, ROT alone takes it away', () => {
  const p = run('G0 X10 Y0 Z5\nROT Z90\nG0 X10 Y0\nAROT Z90\nG0 X10 Y0\nROT\nG0 X10 Y0\nM30');
  const to = ends(p);
  assert.deepEqual(errors(p), []);
  assert.deepEqual(to[1], [0, 10, 5], 'X10 under ROT Z90 is Y10');
  assert.deepEqual(to[2], [-10, 0, 5], 'AROT Z90 on top of it: 180 in all');
  assert.deepEqual(to[3], [10, 0, 5], 'ROT on its own: the turn is gone');
});

test('TRANS shifts the zero, ATRANS adds to it in the turned axes, TRANS alone clears', () => {
  const p = run('TRANS X100 Y50\nG0 X0 Y0 Z5\nAROT RPL=90\nATRANS X10\nG0 X0 Y0\nTRANS\nG0 X0 Y0\nM30');
  const to = ends(p);
  assert.deepEqual(errors(p), []);
  assert.deepEqual(to[0], [100, 50, 5]);
  assert.deepEqual(to[1], [100, 60, 5], 'ATRANS X10 is along the turned X, which is Y');
  assert.deepEqual(to[2], [0, 0, 5]);
});

test('TRAORI is tool centre point on and TRAFOOF off; DIAMOF is accepted, DIAMON said once', () => {
  const p = run('DIAMOF\nTRAORI\nG1 X10 F500\nTRAFOOF\nG1 X20\nDIAMON\nM30');
  assert.deepEqual(p.moves.map((m) => m.tcp), [4, 0]);
  assert.ok(p.events.some((e) => /TRAORI/.test(e.text)));
  assert.deepEqual(errors(p), []);
  assert.ok(said(p).some((w) => /DIAMON is diameter programming/.test(w)));
  assert.ok(!said(p).some((w) => /DIAMOF|TRAORI|TRAFOOF/.test(w)), said(p).join('\n'));
});

test('CYCLE800 swivels the plane and the machine; CYCLE800() takes the plane away', () => {
  const kin = buildPreset('headTable');
  // Axis by axis, X then Y then Z (57), 90 about Y: the plane's Z is the
  // machine's X, and the B head swings to lie along it.
  const p = run([
    'G0 X0 Y0 Z50',
    'CYCLE800(0,"HEAD",0,57,0,0,0,0,90,0,0,0,0,-1,100,1)',
    'G1 X0 Y0 Z20 F500',
    'CYCLE800()',
    'G0 X0 Y0 Z50',
    'M30',
  ].join('\n'), { kinematics: kin });
  assert.deepEqual(errors(p), []);
  const swing = p.moves[1];
  near(Math.abs(swing.rotTo.B), 90, 1e-6, 'the head lies down');
  const inPlane = p.moves[2];
  near(inPlane.to[0], 20, 1e-9, 'Z20 in the swivelled plane is X20');
  near(inPlane.to[2], 0, 1e-9, 'and nothing in Z');
  assert.equal(inPlane.tcp, 4, 'a swivelled plane programs the tip');
  assert.deepEqual(ends(p)[3], [0, 0, 50], 'after CYCLE800() Z is Z again');
  assert.equal(p.moves[3].tcp, 0);
});

test('CYCLE800 shifts before and after turning, and retracts first when asked', () => {
  const kin = buildPreset('headTable');
  // Shift to X30, turn 90 about Y, then 5 along the turned X (which is −Z).
  const p = run('G0 X0 Y0 Z10\nCYCLE800(1,"",0,57,30,0,0,0,90,0,5,0,0,0)\nG1 X0 Y0 Z0 F500\nM30', { kinematics: kin, machineZero: [0, 0, 250] });
  assert.deepEqual(errors(p), []);
  assert.equal(p.moves[0].to[2], 10);
  near(p.moves[1].to[2], 250, 1e-9, '_FR 1: up to Z home first');
  const last = p.moves[p.moves.length - 1].to;
  near(last[0], 30, 1e-9, 'X0 shift');
  near(last[2], -5, 1e-9, 'X1 shift, along the turned X');
  assert.equal(p.moves.length, 3, '_DIR 0: the plane turns, the machine does not swing');
});

test('G75 sends the axes it names home; G74 too', () => {
  const p = run('G0 X40 Y30 Z-5\nG75 FP=1 Z1.0\nG74 X1 Y1\nM30', { machineZero: [0, 0, 250] });
  const to = ends(p);
  assert.deepEqual(errors(p), []);
  assert.deepEqual(to[1], [40, 30, 250], 'G75 Z: only Z, straight up');
  assert.deepEqual(to[2], [0, 0, 250]);
  assert.equal(p.moves[1].kind, 'rapid');
});

test('T before M6, by name or number; M6 on its own line changes to it', () => {
  const p = run('T="FACE MILL 50"\nM6\nG0 X10 Z5\nT3\nG0 X20\nM6\nG0 X30\nM30');
  assert.deepEqual(errors(p), []);
  assert.deepEqual(p.toolChanges.map((c) => c.tool), ['FACE MILL 50', 3]);
  assert.deepEqual(p.moves.map((m) => m.tool), ['FACE MILL 50', 'FACE MILL 50', 3]);
  assert.ok(p.events.some((e) => e.text === 'Tool change T="FACE MILL 50"'));
});

test('A labelled section: REPEAT runs label to ENDLABEL, then carries on after the REPEAT', () => {
  const p = run([
    'G0 X0 Y0 Z5',           // 1
    'HOLE:',                 // 2
    'G1 Z-1 F100',           // 3
    'G0 Z5',                 // 4
    'ENDLABEL:',             // 5
    'G0 X10',                // 6
    'REPEAT HOLE P=2',       // 7
    'G0 X20',                // 8
    'M30',
  ].join('\n'));
  assert.deepEqual(errors(p), []);
  // Once in passing, then twice more from the REPEAT, then on.
  assert.deepEqual(p.moves.map((m) => m.line), [1, 3, 4, 6, 3, 4, 3, 4, 8]);
});

test('REPEAT between two labels, REPEAT back to a label above, and REPEATB', () => {
  // A label starts with two letters or an underscore: A1 would be an A word.
  // The section runs to the line carrying the end label, that line included.
  const two = run('AA1:\nG0 X1\nBB1: G0 X2\nG0 X3\nREPEAT AA1 BB1\nG0 X9\nM30');
  assert.deepEqual(two.moves.map((m) => m.to[0]), [1, 2, 3, 1, 2, 9]);
  const back = run('G0 X0\nTOP: G0 X1\nG0 X2\nREPEAT TOP P=2\nG0 X9\nM30');
  assert.deepEqual(back.moves.map((m) => m.to[0]), [0, 1, 2, 1, 2, 1, 2, 9]);
  const one = run('G0 X0\nSTEP: G91 G0 X1\nREPEATB STEP P=3\nG90 G0 X9\nM30');
  assert.deepEqual(one.moves.map((m) => m.to[0]), [0, 1, 2, 3, 4, 9]);
  assert.deepEqual([...errors(two), ...errors(back), ...errors(one)], []);
});

test('An axis value with its own mode: DC the short way, ACP forwards, ACN back, AC and IC', () => {
  const kin = buildPreset('tableTable');
  const p = run('G0 C10\nG0 C=DC(350)\nG0 C=ACP(5)\nG0 C=ACN(20)\nG0 X5 Y0 Z0\nG0 X=IC(5) Y=AC(3)\nM30', { kinematics: kin });
  assert.deepEqual(errors(p), []);
  const c = p.moves.slice(0, 4).map((m) => +m.rotTo.C.toFixed(6));
  assert.deepEqual(c, [10, -10, 5, -340], 'DC: 10 to 350 is 20 back; ACP: on round to 5; ACN: back round to 20');
  assert.deepEqual(ends(p)[5], [10, 3, 0]);
});

test('CYCLE832 and MSG change nothing and say nothing; an unknown cycle is named once', () => {
  const p = run('CYCLE832(0.01,_ROUGH,1)\nMSG("ROUGHING")\nPOCKET3(10,0,2,-5)\nPOCKET3(10,0,2,-5)\nG0 X1\nM30');
  assert.deepEqual(errors(p), []);
  assert.deepEqual(said(p).filter((w) => /CYCLE832|MSG/.test(w)), []);
  assert.equal(said(p).filter((w) => /POCKET3 is not simulated/.test(w)).length, 1);
});

// ---- the drilling cycles ---------------------------------------------------

test('CYCLE81 at the tool: to RFP + SDIS fast, to depth fed, out to RTP; DPR wins over DP', () => {
  const p = run('G0 X10 Y20 Z50\nF200\nCYCLE81(10, 0, 2, -15)\nCYCLE81(10, 0, 2, -15, 8)\nM30');
  assert.deepEqual(errors(p), []);
  const [, a1, a2, a3, b1, b2, b3] = p.moves;
  assert.deepEqual([a1.kind, a1.to], ['rapid', [10, 20, 2]]);
  assert.deepEqual([a2.kind, a2.to, a2.feed], ['feed', [10, 20, -15], 200]);
  assert.deepEqual([a3.kind, a3.to], ['rapid', [10, 20, 10]]);
  assert.deepEqual(b2.to, [10, 20, -8], 'DPR 8 below RFP 0');
  assert.equal(b1.to[2], 2);
  assert.equal(b3.to[2], 10);
});

test('MCALL makes a cycle run at every position after it, MCALL alone stops it', () => {
  const p = run('G0 X0 Y0 Z20\nF150\nMCALL CYCLE82(10, 0, 2, -5, , 0.5)\nX10\nX20 Y5\nMCALL\nX30\nM30');
  assert.deepEqual(errors(p), []);
  const bottoms = p.moves.filter((m) => m.kind === 'feed').map((m) => [m.to[0], m.to[1], m.to[2]]);
  assert.deepEqual(bottoms, [[10, 0, -5], [20, 5, -5]]);
  assert.equal(p.moves.filter((m) => m.kind === 'dwell').length, 2, 'CYCLE82 dwells at the bottom');
  assert.deepEqual(ends(p).slice(-1)[0], [30, 5, 10], 'after MCALL off, X30 is only a move');
});

test('CYCLE83 deep hole: strokes shrinking by DAM, chip breaking or clearing', () => {
  // RFP 0, depth −20, first stroke to −8, each next 2 shorter (6, 4, 2...).
  const breaking = run('G0 X0 Y0 Z20\nF100\nCYCLE83(10, 0, 2, -20, , -8, , 2, 0, 0, 1, 0)\nM30');
  const strokes = breaking.moves.filter((m) => m.kind === 'feed').map((m) => +m.to[2].toFixed(3));
  assert.deepEqual(strokes, [-8, -14, -18, -20]);
  const backs = breaking.moves.filter((m) => m.kind === 'rapid').map((m) => +m.to[2].toFixed(3));
  // After the move in and the rapid down to RFP + SDIS.
  assert.deepEqual(backs.slice(2, 5), [-7, -13, -17], 'VARI 0: back off a millimetre');
  const clearing = run('G0 X0 Y0 Z20\nF100\nCYCLE83(10, 0, 2, -20, , -8, , 2, 0, 0, 1, 1)\nM30');
  const ups = clearing.moves.filter((m) => m.kind === 'rapid' && Math.abs(m.to[2] - 2) < 1e-9).length;
  assert.ok(ups >= 4, `VARI 1: out to RFP + SDIS between strokes (${ups})`);
  assert.deepEqual([...errors(breaking), ...errors(clearing)], []);
});

test('CYCLE84 taps at the pitch times the speed, in and out; CYCLE85 feeds out; CYCLE86 lifts off the wall', () => {
  const tap = run('G0 X0 Y0 Z20\nS500 M3\nCYCLE84(10, 0, 2, -12, , 0, 3, 8)\nM30');
  const fed = tap.moves.filter((m) => m.kind === 'feed');
  assert.deepEqual(fed.map((m) => m.to[2]), [-12, 2]);
  assert.equal(fed[0].feed, 625, 'M8 is 1.25 a turn, at 500 rpm');
  const bore = run('G0 X0 Y0 Z20\nF80\nCYCLE85(10, 0, 2, -10, , 0, 60, 300)\nM30');
  const bf = bore.moves.filter((m) => m.kind === 'feed');
  assert.deepEqual(bf.map((m) => [m.to[2], m.feed]), [[-10, 60], [2, 300]]);
  const lift = run('G0 X0 Y0 Z20\nF80\nCYCLE86(10, 0, 2, -10, , 0, 3, -0.5, 0, 0.2)\nM30');
  const off = lift.moves.find((m) => Math.abs(m.to[0] + 0.5) < 1e-9);
  assert.ok(off && Math.abs(off.to[2] + 9.8) < 1e-9, `lifted 0.5 off the wall and 0.2 up: ${JSON.stringify(off && off.to)}`);
  assert.deepEqual([...errors(tap), ...errors(bore), ...errors(lift)], []);
});

test('In a swivelled plane a cycle drills down the plane\'s own Z', () => {
  const kin = buildPreset('headTable');
  const p = run('G0 X0 Y0 Z50\nCYCLE800(0,"",0,57,60,0,-15,0,90,0,0,0,0,-1)\nF100\nG0 X0 Y0 Z20\nCYCLE81(10, 0, 2, -12)\nM30', { kinematics: kin });
  assert.deepEqual(errors(p), []);
  const bottom = p.moves.find((m) => m.kind === 'feed');
  near(bottom.to[0], 48, 1e-9, '12 into the face at X60');
  near(bottom.to[2], -15, 1e-9, 'at the height of the plane');
});

test('An address with a bracket after it is not a call: M00 (CHECK) stops', () => {
  const p = run('G0 X0 Y0 Z5\nG1 X10 F3000\nM00 (CHECK)\nG1 X20\nM30');
  assert.ok(p.events.some((e) => e.type === 'stop' && e.code === 0), JSON.stringify(p.events.map((e) => e.text)));
  assert.ok(!said(p).some((w) => /M00 is not simulated/.test(w)), said(p).join('\n'));
});

test('CYCLE800 mode 192: the angles are the rotary positions, _A axis 1 and _B axis 2, with arithmetic in them', () => {
  // A/C trunnion: axis 1 is A, axis 2 is C. The C slot written as a sum,
  // the way a shop offsets a fixture's turn: (30 + R20) with R20 = 15.
  const ac = run('R20=15\nDEF REAL TILT=-15\nG0 X0 Y0 Z50\nCYCLE800(0, "", 0, 192, 0, 0, 0, (TILT*2), (30+R20), 0, 0, 0, 0, -1)\nG1 X10 Y0 Z0 F500\nM30',
    { kinematics: buildPreset('tableTable') });
  assert.deepEqual(errors(ac), []);
  const swing = ac.moves[1];
  near(swing.rotTo.A, -30, 1e-9, 'A from _A, worked out');
  near(swing.rotTo.C, 45, 1e-9, 'C from _B, worked out');
  // The plane turns with the table: X in it is the part's X turned back by
  // the 45 the table went round, so the tool still runs along the machine.
  const x10 = ac.moves[2].to;
  near(x10[0], 7.071, 1e-3, 'plane X, on the part');
  near(x10[1], -7.071, 1e-3, 'turned by C');
  near(x10[2], 0, 1e-9, 'A turns about X, so X stays level');

  // Head and table: axis 1 is the head's B, axis 2 the table's C.
  const bc = run('G0 X0 Y0 Z50\nCYCLE800(0, "", 0, 192, 0, 0, 0, 90, 0, 0, 0, 0, 0, -1)\nG1 X0 Y0 Z20 F500\nM30',
    { kinematics: buildPreset('headTable') });
  assert.deepEqual(errors(bc), []);
  near(bc.moves[1].rotTo.B, 90, 1e-9, '_A is the head');
  near(bc.moves[1].rotTo.C, 0, 1e-9, '_B is the table');
  const z20 = bc.moves[2].to;
  near(z20[0], 20, 1e-9, 'the plane\'s Z is along the tool, now lying along X');
  near(z20[2], 0, 1e-9, 'and level');
});
