// Reading a tool library out of Siemens NX.
//
// The samples here are written the way NX writes them: pipe-delimited
// records, a FORMAT line naming the columns for every DATA line that
// follows it, and a CLASS line naming the family — which is often the only
// place the word DRILL appears at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fromNX, nxRecords, nxToolType, isNXText } from '../src/tools/nxLibrary.js';
import { ToolLibrary } from '../src/tools/library.js';

const NX_DAT = `
! Mill tools, metric
CLASS|MILL|End Milling Tools
FORMAT|LIBRF|DESCR|MATREF|DIAMETER|COR1_RAD|HEIGHT|FLUTE_LN|NUM_FLUTES|TAPER_ANG|TIP_ANGLE|SHANK_DIA|TL_NUM
DATA|ugt0201_001|MILL 12 X 26 FLAT|HSS|12.0000|0.0000|75.0000|26.0000|4|0.0000|0.0000|12.0000|1
DATA|ugt0201_002|MILL 10 BALL NOSE|CARBIDE|10.0000|5.0000|72.0000|22.0000|2|0.0000|0.0000|10.0000|2
DATA|ugt0201_003|MILL 16 R0.8 BULL|CARBIDE|16.0000|0.8000|92.0000|35.0000|4|0.0000|0.0000|16.0000|3
CLASS|DRILL|Drilling Tools
FORMAT|LIBRF|DESCR|MATREF|DIAMETER|HEIGHT|FLUTE_LN|NUM_FLUTES|TIP_ANGLE|SHANK_DIA|TL_NUM
DATA|ugt0202_001|DRILL 8.5|HSS|8.5000|110.0000|70.0000|2|118.0000|8.5000|7
DATA|ugt0202_002|DRILL 5.0|HSS|5.0000|85.0000|52.0000|2|0.0000|5.0000|8
`;

test('an NX ASCII library reads as records with their class', () => {
  const recs = nxRecords(NX_DAT);
  assert.equal(recs.length, 5);
  assert.equal(recs[0].DESCR, 'MILL 12 X 26 FLAT');
  assert.equal(recs[0].DIAMETER, '12.0000');
  // The second FORMAT block has different columns, and the rows after it
  // are read against that one rather than against the first.
  assert.equal(recs[3].DESCR, 'DRILL 8.5');
  assert.equal(recs[3].TIP_ANGLE, '118.0000');
  assert.match(recs[3]._class, /DRILL/);
});

test('an NX library becomes cutters with their geometry and T numbers', () => {
  const lib = fromNX(NX_DAT);
  assert.equal(lib.tools.length, 5);

  const [flat, ball, bull, drill85, drill5] = lib.tools;
  assert.equal(flat.type, 'flat');
  assert.equal(flat.diameter, 12);
  assert.equal(flat.fluteLength, 26);
  assert.equal(flat.overallLength, 75);
  assert.equal(flat.fluteCount, 4);
  assert.equal(flat.number, 1);
  assert.equal(flat.material, 'hss');

  // A corner radius of half the diameter is a ball nose, whatever the
  // description happens to say.
  assert.equal(ball.type, 'ball');
  assert.equal(ball.cornerRadius, 5);
  assert.equal(bull.type, 'bull');
  assert.equal(bull.cornerRadius, 0.8);

  assert.equal(drill85.type, 'drill');
  assert.equal(drill85.tipAngle, 118);
  assert.equal(drill85.number, 7);
  // NX leaves the point angle at zero on a tool that was never given one.
  // A drill without a point is not a thing, so it gets the 118 that is in
  // the drawer rather than a flat bottom.
  assert.equal(drill5.tipAngle, 118);

  // Every cutter arrives ready to run: an assembly per tool, numbered to
  // match, with enough stickout to clear the flutes.
  assert.equal(lib.assemblies.length, 5);
  assert.equal(lib.assemblies[3].number, 7);
  assert.ok(lib.assemblies[0].stickout > flat.fluteLength);
});

test('an inch library is converted on the way in', () => {
  const lib = fromNX(NX_DAT, { units: 'in' });
  assert.ok(Math.abs(lib.tools[0].diameter - 12 * 25.4) < 1e-6);
  assert.ok(Math.abs(lib.tools[0].fluteLength - 26 * 25.4) < 1e-6);
});

test('a tool list saved as a spreadsheet reads the same way', () => {
  const csv = [
    'Tool Number,Description,Type,Cutting Diameter,Corner Radius,Flute Length,Overall Length,Flutes,Spindle Speed,Feed Rate',
    '4,"6mm, 3 flute alu",End Mill,6,0,18,60,3,12000,2400',
    '5,Spot drill 90,Spot Drill,10,0,10,70,2,4000,300',
  ].join('\n');
  const lib = fromNX(csv);
  assert.equal(lib.tools.length, 2);
  // A comma inside a quoted description is part of the description.
  assert.equal(lib.tools[0].name, '6mm, 3 flute alu');
  assert.equal(lib.tools[0].diameter, 6);
  assert.equal(lib.tools[0].number, 4);
  assert.equal(lib.tools[0].cutting.rpm, 12000);
  assert.equal(lib.tools[0].cutting.feed, 2400);
  // A spot drill is a chamfer tool, not a drill.
  assert.equal(lib.tools[1].type, 'chamfer');
});

test('tab-separated is read too, and a row without a diameter is not a tool', () => {
  const tsv = 'TOOL\tDESCR\tDIAMETER\tFLUTE_LN\n1\tEndmill 8\t8\t20\n2\tSpare holder\t\t\n';
  const lib = fromNX(tsv);
  assert.equal(lib.tools.length, 1);
  assert.equal(lib.skipped, 1);
});

test('two tools claiming the same pot do not both get it', () => {
  const csv = 'T,DESCR,DIAMETER\n3,A,10\n3,B,12\n';
  const lib = fromNX(csv);
  assert.deepEqual(lib.tools.map((t) => t.number), [3, 4]);
});

test('what is not a tool list is refused rather than guessed at', () => {
  assert.equal(fromNX('G00 X10 Y10\nG01 Z-5 F200\nM30\n'), null);
  assert.equal(fromNX(''), null);
  assert.equal(isNXText('%\nO1000\nG54\n'), false);
  assert.equal(isNXText(NX_DAT), true);
});

test('the family is read from the words, and measured when there are none', () => {
  assert.equal(nxToolType('Ball Mill', {}), 'ball');
  assert.equal(nxToolType('MILL', { diameter: 10, cornerRadius: 5 }), 'ball');
  assert.equal(nxToolType('MILL', { diameter: 10, cornerRadius: 1 }), 'bull');
  assert.equal(nxToolType('MILL', { diameter: 10, cornerRadius: 0 }), 'flat');
  assert.equal(nxToolType('T Cutter', {}), 'lollipop');
  assert.equal(nxToolType('02_00', {}), 'drill');
});

test('an NX library imports into a library beside the tools already there', () => {
  const lib = new ToolLibrary().loadDefaults();
  const before = lib.tools.length;
  const stats = lib.fromJSON(NX_DAT, { merge: true });
  assert.ok(stats);
  assert.equal(lib.tools.length, before + 5);
  // Merging renumbers what it has to: no two assemblies answer to one T.
  const numbers = lib.assemblies.map((a) => a.number);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('a shop that names its tools in Turkish is read too', () => {
  // Off a real machine: FREZE is a milling cutter, MATKAP a drill, RAYBA a
  // reamer. A tool called only FREZE says nothing about its end, so the
  // corner radius decides, the same as a tool called only MILL.
  assert.equal(nxToolType('TK1314_MATKAP', {}), 'drill');
  assert.equal(nxToolType('TK2206_RAYBA', {}), 'drill');
  assert.equal(nxToolType('TKY60053_LOLIPOP', {}), 'lollipop');
  assert.equal(nxToolType('TK2105_FREZE', { diameter: 10, cornerRadius: 0 }), 'flat');
  assert.equal(nxToolType('TK1457_FREZE', { diameter: 10, cornerRadius: 5 }), 'ball');
  assert.equal(nxToolType('TK---.250_FREZE', { diameter: 6.35, cornerRadius: 0.8 }), 'bull');
  assert.equal(nxToolType('HAVŞA 90', {}), 'chamfer');
  assert.equal(nxToolType('KILAVUZ M8', {}), 'drill');
  // ...and the English names still land where they did.
  assert.equal(nxToolType('Ball Mill', {}), 'ball');
  assert.equal(nxToolType('Spot Drill', {}), 'chamfer');
});
