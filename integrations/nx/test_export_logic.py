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
def eq(got, want, what):
    global ok
    if got != want:
        ok = False
        print('  FAIL %-38s got %r want %r' % (what, got, want))
    else:
        print('  ok   %-38s %r' % (what, got))

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
print('make_builder() walks past the one that is not there:')
class Missing:
    # Exactly the failure off their seat: the generic name raises.
    def CreateToolBuilder(self, tool): raise AttributeError("no attribute 'CreateToolBuilder'")
    def CreateMillToolBuilder(self, tool): return 'BUILDER'
tried = []
b, nm = j.make_builder(Missing(), None, tried)
eq(b, 'BUILDER', 'fell through to the one that works')
eq(nm, 'CreateMillToolBuilder', 'and says which it used')

print()
print('numbers_on() and fields_from() read a builder by shape, not by name:')
class Inh:
    def __init__(self, v): self.Value = v
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
        self.ShankSectionBuilder = SectionBuilderObjects()
eq(j.holder_stages(ShankOnly(), 1.0), [], 'a shank profile is not a holder')

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
