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
print('PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
