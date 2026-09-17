"""Exercise the journal without NX.

Everything in the journal that decides something — which factory to try,
what a builder is offering, what family a tool belongs to — is plain
Python and can be tested on a machine with no NX on it. What cannot be
tested here is whether a real NCGroupCollection answers to any of the
names, which is exactly why the journal asks it rather than assuming.

    python3 integrations/nx/test_export_logic.py
"""
import sys, types, importlib.util

# Stand in for the NXOpen modules so the file imports.
for name in ('NXOpen', 'NXOpen.CAM', 'NXOpen.UF'):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules['NXOpen'].CAM = sys.modules['NXOpen.CAM']
sys.modules['NXOpen'].UF = sys.modules['NXOpen.UF']
class _Tool: pass
sys.modules['NXOpen.CAM'].Tool = _Tool

spec = importlib.util.spec_from_file_location('j', 'integrations/nx/export_tools_to_mill_sim.py')
j = importlib.util.module_from_spec(spec); spec.loader.exec_module(j)

ok = True
def near(got, want, what, tol=1e-4):
    """Same, for numbers that are the end of a conversion.

    Stage lengths are rounded to four decimals on the way out, so a total
    of several of them is a few ten-thousandths off an exact figure. That
    is a tenth of a micron and it is not what these are checking.
    """
    eq(abs(got - want) < tol if isinstance(got, (int, float)) else got == want, True,
       '%s (%s)' % (what, got))


def eq(got, want, what):
    global ok
    if got != want:
        ok = False
        print('  FAIL %-38s got %r want %r' % (what, got, want))
    else:
        print('  ok   %-38s %r' % (what, got))

class Inh:
    """Stands in for NX's inheritable builders: a value behind .Value."""
    def __init__(self, v): self.Value = v


print('family(), on the names off their machine:')
eq(j.family('TK1314_MATKAP', 8.5, 0), 'drill', 'MATKAP is a drill')
eq(j.family('TK2206_RAYBA', 10, 0), 'drill', 'RAYBA is a reamer')
eq(j.family('TKY60053_LOLIPOP', 12, 0), 'lollipop', 'LOLIPOP')
eq(j.family('TK2105_FREZE', 10, 0), 'flat', 'FREZE with a sharp corner')
eq(j.family('TK1457_FREZE', 10, 5), 'ball', 'FREZE with a full radius')
eq(j.family('TK---.250_FREZE', 6.35, 0.8), 'bull', 'FREZE with a corner radius')
eq(j.family('PARTPROBE_3MM_DIA', 3, 1.5), 'ball', 'a probe reads as its ball')
eq(j.family('Ball Mill', 10, 0), 'ball', 'English still works')
eq(j.family('SPOT DRILL 90', 10, 0), 'chamfer', 'a spot drill is a chamfer tool')

print()
print('builder_factories() ranks the specific ones first:')
class Coll:
    def CreateGeometryGroupBuilder(self, x): pass
    def CreateMillToolBuilder(self, x): pass
    def CreateToolBuilder(self, x): pass
    def CreateDrillToolBuilder(self, x): pass
    def CreateFeedsBuilder(self, x): pass
got = j.builder_factories(Coll())
eq(got[0] in ('CreateMillToolBuilder', 'CreateDrillToolBuilder'), True, 'a tool builder comes first')
eq('CreateGeometryGroupBuilder' in got, True, 'others are still tried')
eq(got[-1], 'CreateGeometryGroupBuilder', 'the least likely is last')

print()
print('read_tool() walks past the factory that is not there:')
class Thin:
    # What a T-cutter builder gave for a drill: four numbers, no diameter.
    def __init__(self): self.ChamferLengthBuilder = Inh(0.0); self.MaxCutWidth = 50.0
    def Destroy(self): pass
class Full:
    def __init__(self):
        self.TlDiameterBuilder = Inh(12.0); self.TlFluteLnBuilder = Inh(26.0)
        self.TlHeightBuilder = Inh(75.0); self.TlNumFlutesBuilder = Inh(4)
    def Destroy(self): pass
class Missing:
    # Exactly the failure off their seat: the generic name raises.
    def CreateToolBuilder(self, tool): raise AttributeError("no attribute 'CreateToolBuilder'")
    def CreateTToolBuilder(self, tool): return Thin()
    def CreateMillToolBuilder(self, tool): return Full()
tried = []
found, extra, nm = j.read_tool(Missing(), None, 'TK2105_FREZE', tried, 1.0)
eq(nm, 'CreateMillToolBuilder', 'the builder that knew the most won')
eq(j.fields_from(found).get('diameter'), 12.0, 'and it is the one with the diameter on it')

# When the one that suits the tool raises, the next is reached and the
# failure is written down rather than swallowed.
class MillMissing:
    def CreateMillToolBuilder(self, tool): raise AttributeError("no attribute 'CreateMillToolBuilder'")
    def CreateTToolBuilder(self, tool): return Full()
tried2 = []
_, _, nm4 = j.read_tool(MillMissing(), None, 'TK2105_FREZE', tried2, 1.0)
eq(nm4, 'CreateTToolBuilder', 'fell through to one that works')
eq(any('CreateMillToolBuilder' in t for t in tried2), True, 'the one that raised is recorded')

print()
print('...and a builder that answers with almost nothing does not win:')
eq(j.score_of({'ChamferLengthBuilder': 0.0, 'MaxCutWidth': 50.0})[0], 0, 'no essentials')
eq(j.score_of({'TlDiameterBuilder': 12.0, 'TlFluteLnBuilder': 26.0,
               'TlHeightBuilder': 75.0, 'TlNumFlutesBuilder': 4})[0], 4, 'all four essentials')

print()
print('numbers_on() and fields_from() read a builder by shape, not by name:')
class MillBuilder:
    def __init__(self):
        self.TlDiameterBuilder = Inh(12.0)
        self.TlCor1RadBuilder = Inh(0.8)
        self.TlHeightBuilder = Inh(75.0)
        self.TlFluteLnBuilder = Inh(26.0)
        self.TlNumFlutesBuilder = 4
        self.TlShankDiaBuilder = Inh(12.0)
        self.TlTaperAngBuilder = Inh(0.0)
        self.Name = 'not a number'
        self.SomeFlag = True
    def Destroy(self): pass
found = j.numbers_on(MillBuilder())
eq('Name' in found, False, 'text is not a parameter')
eq('SomeFlag' in found, False, 'a flag is not a parameter')
f = j.fields_from(found)
eq(f.get('diameter'), 12.0, 'diameter')
eq(f.get('cornerRadius'), 0.8, 'corner radius')
eq(f.get('overallLength'), 75.0, 'overall length from Height')
eq(f.get('fluteLength'), 26.0, 'flute length')
eq(f.get('fluteCount'), 4.0, 'flute count, plain number')

print()
print('...and the same builder under different names:')
class OtherBuilder:
    def __init__(self):
        self.DiameterBuilder = Inh(6.0)
        self.CornerRadiusBuilder = Inh(0.0)
        self.LengthOfCutBuilder = Inh(18.0)
        self.OverallLengthBuilder = Inh(60.0)
        self.NumberOfFlutesBuilder = Inh(3)
f2 = j.fields_from(j.numbers_on(OtherBuilder()))
eq(f2.get('diameter'), 6.0, 'diameter under another spelling')
eq(f2.get('fluteLength'), 18.0, 'flute length under another spelling')
eq(f2.get('fluteCount'), 3.0, 'flute count under another spelling')

print()
print('holder_stages(), the three ways NX might keep a holder:')

class Step:
    def __init__(self, lo, up, ln):
        self.LowerDiameterBuilder = Inh(lo)
        self.UpperDiameterBuilder = Inh(up)
        self.LengthBuilder = Inh(ln)

class ListHolder:
    # A list of step objects, under a name that says what it is.
    def __init__(self):
        self.HolderSections = [Step(22, 34, 26), Step(34, 44, 24), Step(44, 48, 22)]
        self.TlDiameterBuilder = Inh(10.0)
st = j.nose_first(j.holder_stages(ListHolder(), 1.0))
eq(len(st), 3, 'three steps off a list')
eq(st[0], {'dia': 22.0, 'topDia': 34.0, 'length': 26.0}, 'nose step')
eq(st[-1]['topDia'], 48.0, 'top step')

class SubHolder:
    # A sub-builder carrying numbered steps.
    class H:
        def __init__(self):
            self.Dia1 = 20.0; self.Len1 = 30.0
            self.Dia2 = 40.0; self.Len2 = 25.0
    def __init__(self):
        self.HolderBuilder = SubHolder.H()
st2 = j.nose_first(j.holder_stages(SubHolder(), 1.0))
eq(len(st2), 2, 'two steps off a sub-builder')
eq(st2[0]['dia'], 20.0, 'first step diameter')

class FlatHolder:
    # Flat parameters on the tool builder itself.
    def __init__(self):
        self.TlHolderDia1 = 25.0; self.TlHolderLen1 = 40.0
        self.TlHolderDia2 = 50.0; self.TlHolderLen2 = 30.0
        self.TlDiameterBuilder = Inh(12.0)
st3 = j.nose_first(j.holder_stages(FlatHolder(), 1.0))
eq(len(st3), 2, 'two steps off flat parameters')

print()
print('...and an inch part is converted, and an upside-down stack turned over:')
st4 = j.nose_first(j.holder_stages(ListHolder(), 25.4))
eq(round(st4[0]['dia'], 3), 558.8, '22 in is 558.8 mm')

class Upside:
    def __init__(self):
        self.HolderSections = [Step(48, 44, 22), Step(44, 34, 24), Step(34, 22, 26)]
st5 = j.nose_first(j.holder_stages(Upside(), 1.0))
eq(st5[0]['dia'], 22.0, 'the narrow end is the nose')
eq(st5[-1]['topDia'], 48.0, 'the wide end is the gauge line')

print()
print('a tool with no holder on it says so rather than inventing one:')
class Bare:
    def __init__(self):
        self.TlDiameterBuilder = Inh(8.0)
        self.TlFluteLnBuilder = Inh(20.0)
eq(j.holder_stages(Bare(), 1.0), [], 'no holder, no stages')

print()
print('a HolderSectionBuilder shaped the way their NX hands it over:')

class IntB:
    # NX wraps the count, which is why reading it with int() found nothing.
    def __init__(self, v): self.Value = v

class Section:
    def __init__(self, lo, up, ln):
        self.DiameterBuilder = Inh(lo)
        self.UpperDiameterBuilder = Inh(up)
        self.LengthBuilder = Inh(ln)

class SectionBuilderObjects:
    """Counts, and answers with a whole section when asked for one."""
    def __init__(self):
        self.NumberOfSections = IntB(3.0)
        self.ProfileStartPosition = 0.0
        self.TlHolderOffsetBuilder = Inh(1.0)
        self._s = [Section(1.0, 1.4, 1.0), Section(1.4, 1.8, 0.9), Section(1.8, 2.5, 0.8)]
    def GetSection(self, i): return self._s[i]
    def SetSection(self, i): raise AssertionError('a setter was called')

class ToolWithHolder:
    def __init__(self, sb):
        self.TlDiameterBuilder = Inh(0.75)
        self.TlFluteLnBuilder = Inh(2.0)
        self.TlHeightBuilder = Inh(3.0)
        self.DefineShank = True
        self.HolderSectionBuilder = sb
        self.ShankSectionBuilder = SectionBuilderObjects()   # not the holder
        self.HolderDescription = 'BT40 shrink'

st = j.nose_first(j.holder_stages(ToolWithHolder(SectionBuilderObjects()), 25.4))
eq(len(st), 3, 'three sections through GetSection(i)')
eq(st[0]['dia'], 25.4, '1 in nose becomes 25.4 mm')
eq(st[-1]['topDia'], 63.5, '2.5 in top becomes 63.5 mm')

class SectionBuilderScalars:
    """Counts, and answers one number at a time."""
    def __init__(self):
        self.NumberOfSections = IntB(2.0)
        self._d = [20.0, 40.0]; self._u = [30.0, 50.0]; self._l = [25.0, 30.0]
    def GetDiameter(self, i): return self._d[i]
    def GetUpperDiameter(self, i): return self._u[i]
    def GetLength(self, i): return self._l[i]
st2 = j.nose_first(j.holder_stages(ToolWithHolder(SectionBuilderScalars()), 1.0))
eq(len(st2), 2, 'two sections through one call per number')
eq(st2[0], {'dia': 20.0, 'topDia': 30.0, 'length': 25.0}, 'assembled from the columns')

print()
print('...and it does not mistake the shank for the holder:')
class ShankOnly:
    def __init__(self):
        self.TlDiameterBuilder = Inh(0.5)
        self.DefineShank = True
        self.ShankSectionBuilder = SectionBuilderObjects()
eq(j.holder_stages(ShankOnly(), 1.0), [], 'a shank profile is not a holder')

print()
print('GetSection(i) handing back a tuple, which is what their seat does:')

class TupleSectionBuilder:
    """Counts, and answers with a row of out-parameters.

    Exactly what the diagnostic showed: NumberOfSections 3, and calls named
    GetSection, RetrieveStepsFromSolid, Get, GetAllParameters.
    """
    def __init__(self, rows):
        self.NumberOfSections = IntB(float(len(rows)))
        self.ProfileStartPosition = 0.0
        self.TlHolderOffsetBuilder = Inh(1.0)
        self._rows = rows
    # diameter, length, taper angle, corner radius
    def GetSection(self, i): return tuple(self._rows[i])
    def RetrieveStepsFromSolid(self, i): raise Exception('needs a solid')
    def Get(self, i): raise TypeError('wrong arguments')
    def GetAllParameters(self): raise TypeError('takes no index')

holder = TupleSectionBuilder([(1.25, 1.6, 0.0, 0.0), (1.75, 1.0, 0.0, 0.0), (2.5, 0.8, 0.0, 0.0)])
rows = j.sections_of(holder)
eq(len(rows), 3, 'three rows out of GetSection')
eq(rows[0], [1.25, 1.6, 0.0, 0.0], 'the row comes through as numbers')
st = j.nose_first(j.stages_from_rows(rows, 25.4))
eq(len(st), 3, 'three stages')
eq(st[0]['dia'], 31.75, '1.25 in nose is 31.75 mm')
eq(st[0]['topDia'], 44.45, 'the nose step cones up to the next one')
eq(st[-1]['dia'], 63.5, '2.5 in at the gauge line')
eq([s2['length'] for s2 in st], [40.64, 25.4, 20.32], 'lengths, converted')

print()
print('...and the column pair is checked rather than trusted:')
# Length first, diameter second: taking (0,1) would give a stack that
# narrows towards the gauge line, so the other pair has to win.
swapped = TupleSectionBuilder([(1.6, 1.25, 0.0), (1.0, 1.75, 0.0), (0.8, 2.5, 0.0)])
st2 = j.stages_from_rows(j.sections_of(swapped), 1.0)
eq([s2['dia'] for s2 in st2], [1.25, 1.75, 2.5], 'the widening column is the diameter')

print()
print('a row with a zero length is not a section:')
bad = TupleSectionBuilder([(1.0, 0.0, 0.0), (2.0, 0.0, 0.0)])
eq(j.stages_from_rows(j.sections_of(bad), 1.0), [], 'nothing usable, nothing invented')

print()
print('probe_calls() says what each call did, not just its name:')
lines = j.probe_calls(holder, 3)
eq(any('GetSection(0) -> tuple' in l for l in lines), True, 'GetSection is reported with its return')
eq(any('RetrieveStepsFromSolid(0) -> needs a solid' in l for l in lines), True, 'and a failure is reported too')

print()
print('GetSection(i) hands back a handle, which goes back to the builder:')

class Handle:
    """An opaque NXObject: nothing readable on it at all."""
    def __init__(self, row): self._row = row

class HandleSectionBuilder:
    """Exactly their seat: GetSection(i) -> NXObject, and Get/GetAllParameters
    want that object passed back to them."""
    def __init__(self, rows):
        self.NumberOfSections = IntB(float(len(rows)))
        self.ProfileStartPosition = 0.0
        self._h = [Handle(r) for r in rows]
    def GetSection(self, i):
        if not isinstance(i, int): raise TypeError('First parameter is invalid.')
        return self._h[i]
    def GetAllParameters(self, section):
        if not isinstance(section, Handle):
            raise TypeError('First parameter is invalid. Expecting NXOpen.NXObject type')
        return tuple(section._row)
    def Get(self, section):
        if not isinstance(section, Handle):
            raise TypeError('First parameter is invalid. Expecting NXOpen.NXObject type')
        return section._row[0]
    def RetrieveStepsFromSolid(self): raise Exception('takes no arguments')

hb = HandleSectionBuilder([(1.25, 1.6, 0.0, 0.0), (1.75, 1.0, 0.0, 0.0), (2.5, 0.8, 0.0, 0.0)])
rows = j.sections_of(hb)
eq(len(rows), 3, 'three sections through the handle')
eq(rows[0], [1.25, 1.6, 0.0, 0.0], 'read by handing the handle back')
st3 = j.nose_first(j.stages_from_rows(rows, 25.4))
eq([round(x['dia'], 2) for x in st3], [31.75, 44.45, 63.5], 'a real BT-sized stack, in mm')

print()
print('...and a handle with nothing on it is not mistaken for a section:')
class DeadEnd:
    def __init__(self):
        self.NumberOfSections = IntB(2.0)
    def GetSection(self, i): return Handle((1.0, 2.0))
    # Nothing that will read it back.
eq(j.sections_of(DeadEnd()), [], 'no way to read it, so nothing claimed')

print()
print('a tool is read without building ninety builders:')
class Counting:
    """Ninety factories; only the mill one knows anything."""
    def __init__(self): self.built = []
    def __getattr__(self, name):
        if not (name.startswith('Create') and name.endswith('Builder')):
            raise AttributeError(name)
        def make(tool):
            self.built.append(name)
            if 'Mill' in name: return Full()
            return Thin()
        return make
    def __dir__(self):
        return (['CreateMillToolBuilder', 'CreateDrillStdToolBuilder', 'CreateTToolBuilder']
                + ['CreateJunk%dToolBuilder' % i for i in range(90)])
c = Counting()
found2, extra2, nm2 = j.read_tool(c, None, 'TK2105_FREZE', [], 1.0)
eq(nm2, 'CreateMillToolBuilder', 'the mill builder answered for a FREZE')
eq(len(c.built) <= 2, True, 'and it stopped there: %d builders made' % len(c.built))

c2 = Counting()
j.read_tool(c2, None, 'TK1314_MATKAP', [], 1.0)
eq(c2.built[0], 'CreateDrillStdToolBuilder', 'a MATKAP tries a drill builder first')

class AllThin(Counting):
    """Ninety factories and not one of them knows this tool."""
    def __getattr__(self, name):
        if not (name.startswith('Create') and name.endswith('Builder')):
            raise AttributeError(name)
        def make(tool):
            self.built.append(name)
            return Thin()
        return make
c3 = AllThin()
found3, _, nm3 = j.read_tool(c3, None, 'NOTHING_SUITS_THIS', [], 1.0)
# Twelve tries, then one more to read the holder off whichever did best.
eq(len(c3.built), 13, 'a tool nothing suits gives up after twelve, not ninety')
eq(nm3 is not None, True, 'and still reports the best it managed')

print()
print('count_of() sees through the wrapper:')
eq(j.count_of(SectionBuilderObjects()), 3, 'NumberOfSections behind .Value')
class Bare2: pass
eq(j.count_of(Bare2()), 0, 'nothing to count')

print()
print('getters() leaves anything that would change something alone:')
names = [n for n, _ in j.getters(SectionBuilderObjects())]
eq('SetSection' in names, False, 'SetSection is not called speculatively')
eq('GetSection' in names, True, 'GetSection is')

print()
print('stickout, from however NX says it:')
# A 3 in tool with 2 in of flute, inserted 1 in: 2 in of it is out.
near(j.stickout_of(76.2, 50.8, 25.4, None), 50.8, 'overall less the insertion')
eq(j.stickout_of(76.2, 50.8, None, 60.0), 60.0, 'a stated stickout is taken as stated')
# An insertion that would put the holder on the flutes is the wrong
# reading of that number, whatever it is.
near(j.stickout_of(76.2, 50.8, 60.0, None), max(50.8 * 1.4, 50.8 + 5.0),
     'a stickout inside the flutes is refused')
near(j.stickout_of(76.2, 50.8, 0.0, None), max(50.8 * 1.4, 50.8 + 5.0),
     'nothing gripped is refused too')
near(j.stickout_of(76.2, 50.8, None, None), max(50.8 * 1.4, 50.8 + 5.0),
     'and with nothing said, enough to clear the flutes')
# Gripped right at the end of the flutes: allowed, because it is what a
# short tool in a shrink fit actually looks like.
near(j.stickout_of(100.0, 50.0, 50.0, None), 50.0, 'gripped at the flute line')

print()
print('the shank sections become the tool\'s own body, tip upwards:')
class ToolWithShank:
    def __init__(self):
        self.TlDiameterBuilder = Inh(0.5)
        self.DefineShank = True          # the tick box on the Shank tab
        self.ShankSectionBuilder = HandleSectionBuilder(
            [(0.3, 0.4, 0.0), (0.5, 0.2, 0.0)])
sh = j.shank_stages(ToolWithShank(), 25.4)
eq(len(sh), 2, 'two shank sections')
eq(sh[0]['dia'], 7.62, 'a reduced neck of 0.3 in')
eq(sh[-1]['dia'], 12.7, 'up to a 0.5 in shank')
# It is the tool's body, so it is not turned over the way a holder is.
eq([x['dia'] for x in sh], sorted(x['dia'] for x in sh), 'read tip upwards')

print()
print('...and a tool with no shank sections says nothing rather than guessing:')
class NoShank:
    def __init__(self): self.TlDiameterBuilder = Inh(0.5)
eq(j.shank_stages(NoShank(), 1.0), [], 'no sections, no body')

print()
print('a shank reading that cannot be true is refused, not drawn:')
# The trap that put a 38 mm collar on a 3 mm cutter. Here the diameters
# are in the second column, so reading the first as diameters gives a
# stack that does not widen — and with nothing to check it against, that
# wrong reading is what gets returned and drawn.
# The lengths happen to grow upwards while the diameters shrink, so the
# wrong column pair is the one that looks like a widening stack.
swapped = [(1.0, 0.12, 0.0), (2.0, 0.06, 0.0)]
loose = j.stages_from_rows(swapped, 25.4)
eq([round(x['dia'], 2) for x in loose], [25.4, 50.8], 'unbounded, the lengths become diameters')

# Bounded by the cutter the shank belongs to, that reading cannot be true,
# and the bound does not merely refuse it — it steers to the pair that can.
bounded = j.stages_from_rows(swapped, 25.4, (3.05 / 20.0, 3.05 * 4.0))
eq([round(x['dia'], 2) for x in bounded], [3.05, 1.52], 'the real diameters, out of the other column')
eq([round(x['length'], 1) for x in bounded], [25.4, 50.8], 'and the lengths out of the first')

# When no pair could be true, nothing is claimed at all.
nonsense = [(50.0, 60.0), (70.0, 80.0)]
eq(j.stages_from_rows(nonsense, 1.0, (0.15, 12.2)), [], 'no reading is better than a wrong one')

class TinyTool:
    def __init__(self, rows):
        self.TlDiameterBuilder = Inh(0.12)
        self.DefineShank = True
        self.ShankSectionBuilder = HandleSectionBuilder(rows)
eq([round(x['dia'], 2) for x in j.shank_stages(TinyTool(swapped), 25.4, 3.05)], [3.05, 1.52],
   'a 3 mm cutter gets its real shank')
eq(j.shank_stages(TinyTool(nonsense), 1.0, 3.05), [], 'and no collar that exists nowhere')
# With no cutter size to check against the old behaviour stands: this is a
# bound, not a second guess at the geometry.
eq([round(x['dia'], 2) for x in j.shank_stages(TinyTool(swapped), 25.4, 0.0)], [25.4, 50.8],
   'nothing to check against, nothing refused')

print('insertion_of() finds the offset wherever NX keeps it:')
class WithOffset:
    class HS:
        def __init__(self):
            self.NumberOfSections = IntB(3.0)
            self.TlHolderOffsetBuilder = Inh(1.0)
    def __init__(self):
        self.HolderSectionBuilder = WithOffset.HS()
eq(j.insertion_of(WithOffset(), 25.4), 25.4, 'one inch, on the section builder')
eq(j.insertion_of(NoShank(), 1.0), None, 'nothing said')

print()
print('a tool is as long as its cutting part and its shank together:')
# NX's height is the cutting part; the shank sections stand on top of it.
# 3 in of tool with 2 in of flute, and 2 in of shank above, is 5 in long
# — and a stickout worked out from the 3 came up two inches short.
height, flute = 76.2, 50.8
shank = [{'dia': 12.7, 'topDia': 12.7, 'length': 25.4},
         {'dia': 19.05, 'topDia': 19.05, 'length': 25.4}]
gap = height - flute
body = [{'dia': 19.05, 'topDia': 19.05, 'length': gap}] + shank
overall = flute + sum(x['length'] for x in body)
near(overall, 127.0, 'five inches all told')
near(j.stickout_of(overall, flute, 25.4, None), 101.6, 'inserted one inch, four inches out')
# Which is what it was short by before: the height alone gave two inches,
# exactly the flute length, and the holder sat on the flutes.
near(j.stickout_of(height, flute, 25.4, None), 50.8, 'the old reading, short by the shank')

print()
print("the column order, read off a diagnostic and checked by its own arithmetic:")
# The two shank rows off TKY60053_LOLIPOP, verbatim. The taper angle is
# the angle from the lower diameter to the upper one over the length, so
# the row proves its own column order rather than being guessed at.
lolli_shank = [[0.07, 1.1500000000000001, 3.235015057784577, 0.2, 0.0],
               [0.2, 1.8499999999999999, 0.0, 0.2, 0.0]]
st = j.stages_from_rows(lolli_shank, 25.4)
eq(len(st), 2, 'both sections read')
near(st[0]['dia'], 1.778, 'Ø0.07 in at the bottom')
near(st[0]['topDia'], 5.08, 'Ø0.2 in at the top, from the upper-diameter column')
near(st[0]['length'], 29.21, '1.15 in long')
near(st[1]['dia'], 5.08, 'then straight at Ø0.2 in')
near(st[1]['length'], 46.99, 'for 1.85 in')
# Which agrees with the three scalars NX states the same shank with.
near(st[0]['length'] + st[1]['length'], 3.0 * 25.4, 'TaperedShankLength 3.0')
near(st[0]['length'], 1.15 * 25.4, 'TaperedShankTaperLength 1.15')
near(st[1]['topDia'], 0.2 * 25.4, 'TaperedShankDiameter 0.2')

# The holder row off the same tool: one section, straight.
near(j.stages_from_rows([[1.0826771653543308, 5.0, 0.0, 1.08268, 0.0]], 25.4)[0]['dia'],
     27.5, 'the holder is Ø1.0827 in')

print()
print("...and a row whose taper angle does not corroborate is not those columns:")
# Same numbers, a taper angle that cannot come from them. The reading is
# refused rather than taken, which is the whole difference from guessing.
eq(j.stage_from_nx_row([0.07, 1.15, 45.0, 0.2, 0.0], 25.4), None,
   'the angle does not match the diameters over the length')
eq(j.stage_from_nx_row([0.07, 1.15], 25.4), None, 'too few columns to be sure')
eq(j.stage_from_nx_row([0.0, 1.15, 0.0, 0.2, 0.0], 25.4), None, 'no lower diameter')
eq(j.stage_from_nx_row([0.2, 1.85, 0.0, 0.2, 0.0], 25.4),
   {'dia': 5.08, 'topDia': 5.08, 'length': 46.99}, 'a straight section corroborates at zero')

print()
print("both tools land on the numbers their NX dialogs show:")

def whole_tool(found, shank_rows, insertion_in):
    read = j.fields_from(found)
    for f in j.LENGTHS:
        if f in read:
            read[f] *= 25.4
    D = read['diameter']
    shank = j.stages_from_rows(shank_rows, 25.4, (D / 20.0, D * 4.0)) if shank_rows else []
    flute = read.get('fluteLength') or D * 2
    height = read.get('overallLength') or flute * 3
    if not shank:
        height = max(height, flute + 1.0)
    body = []
    if shank:
        gap = height - flute
        if gap > 0.01:
            sd = read.get('shankDiameter') or D
            body.append({'dia': round(sd, 4), 'topDia': round(sd, 4), 'length': round(gap, 4)})
        body.extend(shank)
    overall = flute + sum(x['length'] for x in body) if body else height
    return overall, j.stickout_of(overall, flute, insertion_in * 25.4, None), body

# TKY60053_LOLIPOP: head 0.12 in, shank 3.0 in, inserted 2.0 in.
overall, out, body = whole_tool(
    {'TlDiameterBuilder': 0.12, 'TlFluteLnBuilder': 0.10873397172404482,
     'TlHeightBuilder': 0.12, 'TlNumFlutesBuilder': 8.0, 'TlShankDiaBuilder': 0.07,
     'TlCor1RadBuilder': 0.06},
    lolli_shank, 2.0)
near(overall / 25.4, 3.12, 'the lollipop is 3.12 in: head 0.12 plus shank 3.0')
near(out / 25.4, 1.12, 'and 1.12 in of it is out of the holder')
eq(len(body), 3, 'the head, the taper and the straight shank')
# No phantom millimetre: what is above the flutes is what NX says it is.
near(body[0]['length'], (0.12 - 0.10873397172404482) * 25.4, 'the head above the flutes, exactly')

# TK1457_FREZE: height 3.0 in, shank 2.0 in, inserted 1.0 in. The dialog
# says (L) Length 5.0, and 5 less 1 is 4 out.
overall2, out2, _ = whole_tool(
    {'TlDiameterBuilder': 0.75, 'TlFluteLnBuilder': 2.0, 'TlHeightBuilder': 3.0,
     'TlNumFlutesBuilder': 4.0, 'TlShankDiaBuilder': 0.0},
    [[0.75, 1.0, 0.0, 0.75, 0.0], [0.75, 1.0, 0.0, 0.75, 0.0]], 1.0)
near(overall2 / 25.4, 5.0, 'the end mill is 5 in, which is what (L) Length says')
near(out2 / 25.4, 4.0, 'and 4 in out, which is 5 less the 1 in insertion')

print()
print("a shank NX is not using is not a shank:")

class Section5:
    """A section builder that answers with rows, like the real one."""
    def __init__(self, rows):
        self.NumberOfSections = IntB(float(len(rows)))
        self._r = rows
    def GetSection(self, i): return tuple(self._r[i])


class RealTool:
    """A tool as NX hands it over: sections, and the tool's own summary of
    the same shank. Clearing Define Shank zeroes the summary and leaves the
    sections behind."""
    def __init__(self, dia, scalars, rows, extra=None):
        self.TlDiameterBuilder = Inh(dia)
        self.TaperedShankDiameterBuilder = Inh(scalars[0])
        self.TaperedShankLengthBuilder = Inh(scalars[1])
        self.TaperedShankTaperLengthBuilder = Inh(scalars[2])
        self.ShankSectionBuilder = Section5(rows)
        for k, v in (extra or {}).items():
            setattr(self, k, v)

LOLLI_ROWS = [[0.07, 1.15, 3.235015057784577, 0.2, 0.0], [0.2, 1.85, 0.0, 0.2, 0.0]]
TK_ROWS = [[1.0, 0.75, 18.43494882292202, 1.5, 0.0], [1.5, 2.25, 0.0, 1.5, 0.0]]

# Both tools, exactly as their diagnostics read. The lollipop's tick box is
# set and its summary matches its sections; TK1457's is cleared and its
# summary has gone to zero while the sections are still remembered.
lolli = RealTool(0.12, (0.2, 3.0, 1.15), LOLLI_ROWS, {'UseTaperedShank': True})
tk = RealTool(0.75, (0.0, 0.0, 0.0), TK_ROWS)

eq(len(j.shank_stages(lolli, 25.4, 3.048)), 2, 'the lollipop keeps the shank it is using')
eq(j.shank_stages(tk, 25.4, 19.05), [], 'TK1457 does not get the one it is not')
eq(j.tapered_summary(lolli), (0.2, 3.0, 1.15), 'the summary is read off the tool')
eq(j.tapered_summary(tk), (0.0, 0.0, 0.0), 'and is zero where the box is cleared')

# UseTaperedShank is True on the lollipop and says nothing about whether
# there is a shank, so it is never the thing that decides.
eq(j.shank_defined(lolli), None, 'a taper flag is not a define flag')

# A flag, where a build has one, overrules the summary either way.
eq(j.shank_stages(RealTool(0.12, (0.2, 3.0, 1.15), LOLLI_ROWS,
                           {'DefineShank': False}), 25.4, 3.048), [],
   'an explicit no beats an agreeing summary')
eq(len(j.shank_stages(RealTool(0.75, (0.0, 0.0, 0.0), TK_ROWS,
                               {'DefineShank': True}), 25.4, 19.05)), 2,
   'and an explicit yes beats a zeroed one')
eq(j.shank_defined(RealTool(0.12, (0.2, 3.0, 1.15), LOLLI_ROWS,
                            {'ShankIsDefined': True})), True, 'however it is spelt')

# A summary that disagrees in size, not just in being zero, is the tick box
# cleared on a tool that used to have a different shank.
eq(j.shank_stages(RealTool(0.75, (1.5, 9.0, 0.75), TK_ROWS), 25.4, 19.05), [],
   'a summary that does not match the sections is not describing them')

print()
print("...and TK1457 comes out at the length its dialog states:")
read = {'diameter': 19.05, 'fluteLength': 50.8, 'overallLength': 127.0}
flute, height = read['fluteLength'], read['overallLength']
for tool, want_len, want_out, what in ((tk, 127.0, 101.6, 'shank cleared'),
                                       (RealTool(0.75, (1.5, 3.0, 0.75), TK_ROWS),
                                        203.2, 177.8, 'shank in use')):
    shank = j.shank_stages(tool, 25.4, 19.05)
    body = []
    if shank:
        gap = height - flute
        if gap > 0.01:
            body.append({'dia': 19.05, 'topDia': 19.05, 'length': gap})
        body.extend(shank)
    overall = flute + sum(x['length'] for x in body) if body else height
    near(overall, want_len, '%s: %.1f mm long' % (what, want_len))
    near(j.stickout_of(overall, flute, 25.4, None), want_out, '%s: %.1f mm out' % (what, want_out))

print('taper_of() reads the interface out of the name:')
eq(j.taper_of('TK2105_FREZE_BT40'), 'BT40', 'BT40')
eq(j.taper_of('HSK 63 A shrink'), 'HSK63A', 'HSK63-A however it is spelt')
eq(j.taper_of('TKY60053_LOLIPOP'), 'none', 'nothing claimed')

print()
print('the real parameters off their TK1457_FREZE, all 34 of them:')
real = {
 'ChamferLengthBuilder': 0.0, 'HelicalDiameter': 90.0, 'HelicalRampAngle': 15.0,
 'IncrementalTurretRotationBuilder': 0.0, 'IndexNotchBuilder': 0.0, 'MaxCutWidth': 50.0,
 'MinRampLength': 70.0, 'ReliefDiameterBuilder': 1.0, 'ReliefLengthBuilder': 0.0,
 'TaperedShankDiameterBuilder': 0.0, 'TaperedShankLengthBuilder': 0.0,
 'TaperedShankTaperLengthBuilder': 0.0, 'TlAdjRegBuilder': 0.0, 'TlCor1RadBuilder': 0.0,
 'TlCor2RadBuilder': 0.0, 'TlCutcomReg': 0.0, 'TlCutcomRegBuilder': 0.0,
 'TlDiameterBuilder': 0.75, 'TlFluteLnBuilder': 2.0, 'TlHeightBuilder': 3.0,
 'TlHolderNumberBuilder': 0.0, 'TlLowCorRadBuilder': 0.0, 'TlNumFlutesBuilder': 4.0,
 'TlNumberBuilder': 1.0, 'TlShankDiaBuilder': 0.0, 'TlTaperAngBuilder': 0.0,
 'TlTipAngBuilder': 0.0, 'TlUpCorRadBuilder': 0.0, 'TlXcenCor1Builder': 0.0,
 'TlXcenCor2Builder': 0.0, 'TlYcenCor1Builder': 0.0, 'TlYcenCor2Builder': 0.0,
 'TlZMountBuilder': 0.0, 'TlZOffsetBuilder': 0.0,
}
f = j.fields_from(real)
eq(f.get('diameter'), 0.75, 'a 3/4 inch cutter')
eq(f.get('fluteLength'), 2.0, 'two inches of flute')
eq(f.get('overallLength'), 3.0, 'three inches overall, from TlHeightBuilder')
eq(f.get('fluteCount'), 4.0, 'four flutes')
eq(f.get('number'), 1.0, 'T1')
eq('tipAngle' in f, True, 'the point angle is read at all')
# The traps in that list: none of these is the cutting diameter.
eq(f.get('diameter') != 90.0, True, 'HelicalDiameter is not the cutter')
eq(f.get('overallLength') != 70.0, True, 'MinRampLength is not the length')
eq(f.get('fluteLength') != 50.0, True, 'MaxCutWidth is not the flute length')

print()
print('norm() takes off the ends and nothing else:')
eq(j.norm('GetLength'), 'getlength', 'an interior tl is not noise')
eq(j.norm('TlDiameterBuilder'), 'diameter', 'the NX prefix and the suffix are')
eq(j.norm('TotalLength'), 'totallength', 'nor is this one')
eq(j.norm('TlHeightBuilder'), 'height', 'height')

print()
print('PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
