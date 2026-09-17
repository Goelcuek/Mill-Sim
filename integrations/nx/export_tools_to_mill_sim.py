# Export the tools in this NX part to a Mill-Sim tool library.
#
#   NX -> Tools -> Journal -> Play...  and pick this file.
#
# It walks the CAM setup's tool group, reads what each tool measures, and
# writes a JSON library that Mill-Sim's Tools > Library > Import reads
# directly: cutter geometry, flute count, tool number and an assembly per
# tool so everything arrives ready to run.
#
# It does not assume it knows NX Open's spelling. The name of the call that
# hands you a tool's parameters has moved between versions and differs
# between tool classes, and a journal built on one guess fails on every
# tool at once -- which is exactly what the first version of this did:
#
#     AttributeError: 'NXOpen.CAM.NCGroupCollection' object has no
#     attribute 'CreateToolBuilder'
#
# So this asks the objects in front of it what they can do. It looks for
# anything on the group collection that makes a builder, tries each in turn,
# and reads the builder's parameters by matching what it finds on it rather
# than by naming them in advance. Failing all that it falls back to the UF
# parameter calls, which have outlived several versions of the .NET API.
#
# Whatever happens it writes a diagnostic file next to the library saying
# what it found and what it tried. If this still comes up empty, send that
# file: it names the call this seat wants.
#
# If you would rather not run a journal at all, there is a route that needs
# no scripting: Mill-Sim reads NX's own ASCII tool libraries as they stand
# -- tool_database.dat and its neighbours under
# MACH/resource/library/tool/metric (or .../english).

import json
import os
import traceback

import NXOpen
import NXOpen.CAM

# Where to write it. Change these if you want them somewhere else.
OUTPUT = os.path.join(os.path.expanduser("~"), "mill-sim-tools.json")
DIAGNOSTIC = os.path.join(os.path.expanduser("~"), "mill-sim-tools-diagnostic.txt")

MM_PER_INCH = 25.4


# ---- finding the call that reads a tool ----------------------------------

def builder_factories(collection):
    """Every method on the collection that looks like it makes a builder.

    The specific ones first: a mill tool builder is more likely to answer
    for a mill than a generic one, and trying it first keeps the error list
    short when several exist.
    """
    names = [n for n in dir(collection) if n.startswith("Create") and n.endswith("Builder")]
    def rank(n):
        s = n.lower()
        return (
            0 if "tool" in s and s != "createtoolbuilder" else
            1 if "tool" in s else 2,
            len(n),
        )
    return sorted(names, key=rank)


# The essentials. A builder that knows these knows the tool.
_ESSENTIAL = ("diameter", "fluteLength", "overallLength", "fluteCount")


def score_of(found):
    """How much of a tool a builder actually knew.

    Several factories will answer for the same tool and they do not all
    know the same amount about it: a T-cutter builder answers for a drill
    and hands back four numbers, none of them a diameter. Taking the first
    that answers took that. Taking the one that knows the most takes the
    right one.
    """
    fields = fields_from(found)
    essential = sum(1 for f in _ESSENTIAL if (fields.get(f) or 0) > 0)
    return (essential, len([v for v in fields.values() if v]), len(found))


# What sort of builder a tool of each family wants, so the right one is
# tried first rather than found by exhaustion.
_PREFERRED = {
    "drill": ("drill",),
    "lollipop": ("ttool", "tcutter"),
    "chamfer": ("drill", "mill"),
    "taper": ("barrel", "mill"),
    "face": ("mill",),
    "ball": ("mill",),
    "bull": ("mill",),
    "flat": ("mill",),
}


def ordered_factories(collection, tool_name):
    """Factories, likeliest for this tool first.

    Building an NX builder is not free and there are ninety of them on the
    collection; trying all ninety for each of seven tools is half a minute
    of a workstation's life. The tool's own name says what it is, so the
    builder that suits it is tried first and the rest are only reached if
    it does not answer.
    """
    names = builder_factories(collection)
    if "probe" in (tool_name or "").lower():
        want = ("probe",)
    else:
        want = _PREFERRED.get(family(tool_name, 0, 0), ("mill",))
    return sorted(names, key=lambda n: 0 if any(w in n.lower() for w in want) else 1)


def read_tool(collection, tool, name, tried, scale):
    """The best reading of this tool any factory can give.

    @returns (numbers, holder stages, which factory)
    """
    best = (None, None, (0, 0, 0))
    tries = 0
    for factory_name in ordered_factories(collection, name):
        try:
            factory = getattr(collection, factory_name)
        except Exception:
            continue
        try:
            builder = factory(tool)
        except Exception as err:
            tried.append("%s -> %s" % (factory_name, str(err).splitlines()[0][:70]))
            continue
        if builder is None:
            continue
        tries += 1
        try:
            found = numbers_on(builder)
            rank = score_of(found)
            if rank > best[2]:
                best = (found, factory_name, rank)
        except Exception:
            pass
        finally:
            try:
                builder.Destroy()
            except Exception:
                pass
        # Everything that matters, from one builder: nothing left to beat,
        # and no reason to keep building.
        if best[2][0] == len(_ESSENTIAL):
            break
        # A tool nothing suits is not worth ninety attempts either.
        if tries >= 12:
            break

    if best[1] is None:
        return None, [], None

    # The holder, the shank and the insertion all come off the winner
    # alone. Reading them from every candidate was most of the half minute.
    extra = {"holder": [], "shank": [], "insertion": None}
    try:
        builder = getattr(collection, best[1])(tool)
        try:
            extra["holder"] = nose_first(holder_stages(builder, scale))
            extra["shank"] = shank_stages(builder, scale)
            extra["insertion"] = insertion_of(builder, scale)
        finally:
            try:
                builder.Destroy()
            except Exception:
                pass
    except Exception:
        pass
    return best[0], extra, best[1]


def numbers_on(builder):
    """Every number the builder will show us, keyed by the name it uses.

    A tool parameter is usually an inheritable builder carrying .Value;
    some are the plain number. Anything that throws, or is not a number, is
    not a parameter and is skipped.
    """
    out = {}
    for name in dir(builder):
        if name.startswith("_") or name in ("Tag", "JournalIdentifier"):
            continue
        try:
            attr = getattr(builder, name)
        except Exception:
            continue
        if attr is None or callable(attr):
            continue
        for path in ("Value", None):
            try:
                v = getattr(attr, path) if path else attr
            except Exception:
                continue
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                continue
            out[name] = float(v)
            break
    return out


def inventory(builder):
    """Everything on the builder and what shape it is.

    The numbers are only half of a tool. A holder is a stack of steps, so
    it arrives as a list or as a sub-builder rather than as a float, and
    the first version of this walked straight past it. This is what says
    where it went.
    """
    out = []
    for name in dir(builder):
        if name.startswith("_") or name in ("Tag", "JournalIdentifier"):
            continue
        try:
            attr = getattr(builder, name)
        except Exception as err:
            out.append((name, "raised", str(err).splitlines()[0][:60], None))
            continue
        if attr is None or callable(attr):
            continue
        kind = type(attr).__name__
        if isinstance(attr, bool):
            out.append((name, "bool", attr, None))
        elif isinstance(attr, (int, float)):
            out.append((name, "number", attr, None))
        elif isinstance(attr, str):
            out.append((name, "text", attr[:40], None))
        elif hasattr(attr, "Value"):
            try:
                out.append((name, "value(%s)" % kind, attr.Value, None))
            except Exception:
                out.append((name, kind, "?", None))
        else:
            items = as_list(attr)
            if items is not None:
                out.append((name, "list(%s)" % kind, len(items),
                            [numbers_on(i) for i in items[:4]]))
            else:
                # A sub-builder's numbers, how many sections it claims, and
                # what it can be asked -- the section data is behind calls,
                # so the call names are the useful half.
                note = numbers_on(attr)
                n = count_of(attr)
                if n:
                    note = dict(note)
                    note["<sections>"] = n
                    note["<calls>"] = ", ".join(nm for nm, _ in getters(attr))[:400]
                    rows = sections_of(attr)
                    note["<read>"] = rows[:4] if rows else "nothing"
                    note["<stages>"] = stages_from_rows(rows, 1.0)[:4]
                    # What every call actually does, verbatim -- but only
                    # when the sections could not be read, because that is
                    # the only time anybody needs it and calling everything
                    # twice is not free.
                    if not rows:
                        note["<probe>"] = probe_calls(attr, n)
                out.append((name, kind, "", note))
    return out


def as_list(attr):
    """The attribute as a list, if it will simply iterate."""
    if isinstance(attr, (str, bytes)):
        return None
    try:
        items = list(attr)
    except Exception:
        return None
    return items or None


def plain(v):
    """A value, through the wrapper NX may have put round it."""
    if v is None:
        return None
    if hasattr(v, "Value"):
        try:
            v = v.Value
        except Exception:
            return None
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def count_of(obj):
    """How many sections this builder says it has.

    The count arrives as an inheritable builder as often as a number, which
    is why reading it with int() alone came back with nothing to iterate.
    """
    for name in ("NumberOfSections", "NumberOfSteps", "NumberOfStages",
                 "Count", "Length", "Size"):
        try:
            v = plain(getattr(obj, name))
        except Exception:
            continue
        if v is not None and v > 0:
            return int(v)
    return 0


# Never called speculatively: these do something rather than say something.
_DANGEROUS = ("set", "delete", "remove", "insert", "add", "create", "destroy",
              "commit", "apply", "clear", "append", "move", "update", "reset")


def getters(obj):
    """Methods that might hand back section i, likeliest first.

    The section data is not on the builder as properties -- a holder with
    three sections shows a count and nothing else -- so it is behind calls.
    Anything whose name says it changes something is left alone.
    """
    names = []
    for name in dir(obj):
        if name.startswith("_"):
            continue
        low = name.lower()
        if any(low.startswith(d) for d in _DANGEROUS):
            continue
        if not (low.startswith("get") or "section" in low or "step" in low
                or "item" in low or "element" in low):
            continue
        try:
            m = getattr(obj, name)
        except Exception:
            continue
        if callable(m):
            names.append((name, m))

    def rank(pair):
        s = pair[0].lower()
        return (0 if "section" in s or "step" in s else 1 if "item" in s else 2, len(pair[0]))

    out = sorted(names, key=rank)
    try:
        out.insert(0, ("[]", obj.__getitem__))
    except Exception:
        pass
    return out


def row_of_numbers(value):
    """A returned value as a plain row of numbers, or None.

    A C++ call with several out-parameters comes back into Python as a
    tuple, which is neither an object with attributes nor a single number
    — and that is what GetSection hands over. It was falling between the
    two cases and being dropped.
    """
    if isinstance(value, (str, bytes)) or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return None
    try:
        items = list(value)
    except Exception:
        return None
    if not items:
        return None
    out = [plain(v) for v in items]
    return out if all(v is not None for v in out) else None


def reader_calls(obj):
    """Calls that might read a section handed back to them.

    GetSection(i) does not give you the numbers, it gives you a handle;
    the numbers come from passing that handle back to the builder. The
    ones that say they return everything are tried first.
    """
    out = []
    for name in dir(obj):
        if name.startswith("_"):
            continue
        low = name.lower()
        if any(low.startswith(d) for d in _DANGEROUS):
            continue
        if not low.startswith("get"):
            continue
        try:
            m = getattr(obj, name)
        except Exception:
            continue
        if callable(m):
            out.append((name, m))
    out.sort(key=lambda pair: (0 if "all" in pair[0].lower() or "parameter" in pair[0].lower() else 1,
                               len(pair[0])))
    return out


def rows_from_handles(builder, handles):
    """Numbers for each section, given whatever GetSection handed back."""
    named = [numbers_on(h) for h in handles]
    if any(named):
        return named
    for _, call in reader_calls(builder):
        out = []
        for h in handles:
            try:
                v = call(h)
            except Exception:
                out = []
                break
            row = row_of_numbers(v)
            if row is None:
                nums = numbers_on(v)
                row = nums if nums else None
            if not row:
                out = []
                break
            out.append(row)
        if len(out) == len(handles):
            return out
    return []


def sections_of(obj):
    """The sections of a section builder.

    Every shape NX has been seen to use, because which one a build uses is
    not something this can know:

      * something that simply iterates;
      * a call that hands back a section object, whose numbers are on it;
      * a call that hands back a row of numbers — several out-parameters,
        which Python receives as a tuple;
      * a set of calls that each hand back one number for section i.

    A row of numbers comes back as a list rather than a dict, and is read
    by position; anything else is read by name.
    """
    items = as_list(obj)
    if items:
        return [numbers_on(i) for i in items]

    n = count_of(obj)
    if not n:
        return []

    columns = {}
    for name, call in getters(obj):
        got = []
        for i in range(n):
            try:
                value = call(i)
            except Exception:
                got = []
                break
            if value is None:
                got = []
                break
            got.append(value)
        if len(got) != n:
            continue

        # A row of numbers per section settles it: that is the whole
        # section, in the order NX lists it.
        rows = [row_of_numbers(v) for v in got]
        if all(r is not None and len(r) >= 2 for r in rows):
            return rows

        # A handle per section. The numbers are not on it — it is an
        # opaque NXObject — so it goes back to the builder to be read.
        if all(not isinstance(v, (int, float, str, bool)) and plain(v) is None for v in got):
            rows = rows_from_handles(obj, got)
            if rows:
                return rows

        # ...otherwise one number per section, and it takes several such
        # calls to make a section.
        numbers = [plain(v) for v in got]
        if all(v is not None for v in numbers):
            columns[name] = numbers

    if columns:
        return [{name: col[i] for name, col in columns.items()} for i in range(n)]
    return []


def probe_calls(obj, n):
    """What each call on a section builder actually does.

    Written into the diagnostic verbatim. A name on its own says nothing
    about what comes back, and what comes back is the whole question.
    """
    out = []
    for name, call in getters(obj)[:8]:
        for args, label in (((0,), "(0)"), ((), "()")):
            try:
                v = call(*args)
            except Exception as err:
                out.append("%s%s -> %s" % (name, label, str(err).splitlines()[0][:60]))
                continue
            out.append("%s%s -> %s %s" % (name, label, type(v).__name__, repr(v)[:110]))
    return out


# ---- the holder ----------------------------------------------------------

STEP_DIA = ("lowerdia", "lowerdiameter", "diameter", "dia", "botdia", "bottomdiameter")
STEP_TOP = ("upperdia", "upperdiameter", "topdia", "topdiameter")
STEP_LEN = ("length", "len", "height", "ln")

def _pick(nums, names, avoid=()):
    """One value out of a step, by what it means.

    Exact first, so a step carrying both a lower and an upper diameter is
    read the right way round. Then by ending, because a flat parameter
    carries its stack in its name — HolderDia1 is a diameter — and `avoid`
    keeps that pass from answering "the lower diameter" with the upper one.
    """
    index = {}
    for k, v in nums.items():
        index.setdefault(norm(k), v)
    for n in names:
        if n in index:
            return index[n]
    for n in names:
        for k, v in index.items():
            if k.endswith(n) and not any(bad in k for bad in avoid):
                return v
    return None


def holder_stages(builder, scale):
    """The holder as a stack of cones, nose first, or an empty list.

    NX describes a holder the way Mill-Sim does — a run of steps, each with
    a lower diameter, an upper diameter and a length — so the only question
    is where on the builder it is kept. Three shapes are tried: a list of
    step objects, a sub-builder holding one, and flat parameters numbered
    off the end of their names (HolderDia1, HolderLen1, ...).
    """
    # 1: a section builder. This is what NX actually hands over -- a thing
    # that knows how many sections there are and answers for each of them
    # when asked, rather than laying them out as properties.
    for name in dir(builder):
        low = name.lower()
        if name.startswith("_") or "holder" not in low:
            continue
        # The shank is a stepped profile too, and it is not the holder.
        if "shank" in low:
            continue
        try:
            attr = getattr(builder, name)
        except Exception:
            continue
        if attr is None or callable(attr) or isinstance(attr, (int, float, str, bool)):
            continue
        rows = sections_of(attr)
        stages = stages_from_rows(rows, scale)
        if stages:
            return stages
        # A sub-builder that is one step, or that numbers them in its names.
        nums = numbers_on(attr)
        stages = numbered_stages(nums, scale)
        if not stages:
            one = stage_from(nums, scale)
            stages = [one] if one else []
        if stages:
            return stages

    # 2: anything else that is a list of steps.
    for name in dir(builder):
        low = name.lower()
        if name.startswith("_") or not ("section" in low or "step" in low):
            continue
        if "shank" in low or "trackpoint" in low:
            continue
        try:
            attr = getattr(builder, name)
        except Exception:
            continue
        if attr is None or callable(attr) or isinstance(attr, (int, float, str, bool)):
            continue
        rows = sections_of(attr)
        stages = stages_from_rows(rows, scale)
        if stages:
            return stages

    # 3: flat parameters on the tool builder itself.
    holder_nums = {}
    for k, v in numbers_on(builder).items():
        if "holder" in k.lower() or "hld" in k.lower():
            holder_nums[k] = v
    return numbered_stages(holder_nums, scale)


def stages_from_rows(rows, scale):
    """A stack of cones from however the sections came back.

    A row read by name is matched by name. A row read by position is the
    section as NX lists it — diameter first, then length, then the taper
    and corner radius this model has no use for — and that reading is
    checked rather than trusted: every diameter and every length has to be
    positive, and a holder widens away from the tool, so a column pair that
    says otherwise is the wrong pair and the next one is tried.
    """
    if not rows:
        return []
    if isinstance(rows[0], dict):
        return [st for st in (stage_from(r, scale) for r in rows) if st]

    width = min(len(r) for r in rows)
    if width < 2:
        return []
    order = [(0, 1), (1, 0)] + [(a, b) for a in range(width) for b in range(width) if a != b]
    best = None
    for dia_at, len_at in order:
        dias = [r[dia_at] for r in rows]
        lens = [r[len_at] for r in rows]
        if not all(d > 0 for d in dias) or not all(l > 0 for l in lens):
            continue
        widening = all(dias[i] <= dias[i + 1] + 1e-9 for i in range(len(dias) - 1))
        stack = [{"dia": round(d * scale, 4), "topDia": round(d * scale, 4),
                  "length": round(l * scale, 4)} for d, l in zip(dias, lens)]
        # A step is a cylinder unless the next one is wider, in which case
        # it is the cone up to it. That is what the table means.
        for i in range(len(stack) - 1):
            stack[i]["topDia"] = max(stack[i]["dia"], stack[i + 1]["dia"])
        if widening:
            return stack
        if best is None:
            best = stack
    return best or []


def stage_from(nums, scale):
    """One step, from whatever numbers describe it."""
    dia = _pick(nums, STEP_DIA, avoid=("upper", "top"))
    length = _pick(nums, STEP_LEN)
    if not dia or not length or dia <= 0 or length <= 0:
        return None
    top = _pick(nums, STEP_TOP) or dia
    return {"dia": round(dia * scale, 4), "topDia": round(top * scale, 4),
            "length": round(length * scale, 4)}


def numbered_stages(nums, scale):
    """Steps kept as HolderDia1, HolderLen1, HolderDia2, ... ."""
    import re
    groups = {}
    for key, v in nums.items():
        m = re.search(r"(\d+)(\D*)$", key)
        if not m:
            continue
        # The index is not part of what the parameter means, so it comes
        # off before the name is matched: HolderDia1 is a diameter, in the
        # first step.
        bare = key[:m.start(1)] + m.group(2)
        groups.setdefault(int(m.group(1)), {})[bare] = v
    stages = []
    for i in sorted(groups):
        st = stage_from(groups[i], scale)
        if st:
            stages.append(st)
    return stages


def shank_stages(builder, scale):
    """The tool's own body above the flutes, as a stack of cones.

    NX describes it exactly as it describes a holder — a run of sections —
    and it is part of the tool rather than of the holder, so it goes on the
    tool. A stepped shank, a reduced neck or a tapered shank is a real
    difference to what will fit in a pocket, which is the only reason the
    body is drawn at all.

    Read tip-upwards, which is the order Mill-Sim wants, so it is not
    turned over the way a holder is.
    """
    for name in dir(builder):
        low = name.lower()
        if name.startswith("_") or "shank" not in low or "section" not in low:
            continue
        try:
            attr = getattr(builder, name)
        except Exception:
            continue
        if attr is None or callable(attr) or isinstance(attr, (int, float, str, bool)):
            continue
        rows = sections_of(attr)
        stages = stages_from_rows(rows, scale)
        if stages:
            return stages
    return []


def insertion_of(builder, scale):
    """How far the tool is pushed into the holder, if NX says.

    Mill-Sim asks for the stickout — how much of the tool is *out* of the
    holder — and NX states the other end of the same measurement. One is
    the overall length less the other, so this is a reading rather than a
    second number, and it is converted here rather than carried inside.
    """
    best = None
    for name in dir(builder):
        low = name.lower()
        if name.startswith("_"):
            continue
        if not ("holderoffset" in low or "profilestartposition" in low
                or "insertion" in low or "zmount" in low):
            continue
        try:
            v = plain(getattr(builder, name))
        except Exception:
            continue
        if v is not None and v > 0:
            best = v * scale if best is None else min(best, v * scale)
    # The same names live on the section builders, which is where the one
    # that is actually set was seen.
    for name in dir(builder):
        low = name.lower()
        if name.startswith("_") or "holder" not in low or "section" not in low:
            continue
        try:
            attr = getattr(builder, name)
        except Exception:
            continue
        if attr is None or callable(attr) or isinstance(attr, (int, float, str, bool)):
            continue
        for sub in dir(attr):
            if "holderoffset" not in sub.lower() and "profilestart" not in sub.lower():
                continue
            try:
                v = plain(getattr(attr, sub))
            except Exception:
                continue
            if v is not None and v > 0:
                best = v * scale if best is None else min(best, v * scale)
    return best


def stickout_of(overall, flute, insertion, stated):
    """How much of the tool is out of the holder.

    Three ways of knowing, in order of how much they are worth: a stickout
    NX stated outright, the overall length less how far it is inserted, and
    failing both, enough to clear the flutes and a little more. A reading
    that would put the holder on the flutes, or that would leave the tool
    held by nothing, is not the right reading and is not used.
    """
    for candidate in (stated, (overall - insertion) if insertion else None):
        # Gripped right at the end of the flutes is a real setting and a
        # common one, so the flute length itself is allowed; what is not is
        # a holder sitting on the flutes, or a tool held by nothing.
        if candidate and flute - 1e-9 <= candidate <= overall - 0.5:
            return candidate
    return max(flute * 1.4, flute + 5.0)


def nose_first(stages):
    """Turn the stack the right way up.

    A holder tapers outwards away from the tool, so the narrow end is the
    nose. If the stack arrives the other way round it is reversed, and each
    step's two diameters swap with it.
    """
    if len(stages) < 2:
        return stages
    first = max(stages[0]["dia"], stages[0]["topDia"])
    last = max(stages[-1]["dia"], stages[-1]["topDia"])
    if first <= last:
        return stages
    return [{"dia": s["topDia"], "topDia": s["dia"], "length": s["length"]}
            for s in reversed(stages)]


TAPERS = ("BT30", "BT40", "BT50", "CAT40", "CAT50", "HSK63A", "HSK100A", "ISO30")

def taper_of(text):
    """The spindle interface, when the name says which."""
    s = (text or "").upper().replace("-", "").replace(" ", "")
    for t in TAPERS:
        if t in s:
            return t
    if "HSK63" in s:
        return "HSK63A"
    if "HSK100" in s:
        return "HSK100A"
    return "none"


def norm(name):
    """A parameter name with the noise taken out, for matching.

    NX's own prefix and the builder suffix go; nothing else does. Stripping
    "tl" wherever it appeared turned GetLength into "geength", which is a
    good reminder that a substring is not a word: only the ends are noise,
    and only when they are the noise they look like.
    """
    s = name.lower().replace("_", "").replace(" ", "")
    if s.startswith("inheritable"):
        s = s[len("inheritable"):]
    if s.startswith("tl"):
        s = s[2:]
    for tail in ("builder", "value"):
        if s.endswith(tail):
            s = s[: -len(tail)]
    return s


# What each of our fields can be called, matched on the normalised name.
# First hit wins, so the specific spellings come before the vague ones.
ALIASES = {
    "diameter": ["diameter", "dia", "cuttingdiameter", "cutterdiameter"],
    "cornerRadius": ["cor1rad", "cornerradius", "cornerrad", "corner1radius", "cornerradius1"],
    "tipDiameter": ["tipdia", "tipdiameter", "pointdiameter", "lowerdiameter"],
    # NX writes TlTipAngBuilder, not TipAngle: without the short form a
    # drill arrives with no point on it.
    "tipAngle": ["tipang", "tipangle", "pointangle", "includedangle"],
    "taperAngle": ["taperang", "taperangle"],
    "fluteLength": ["fluteln", "flutelength", "cuttinglength", "lengthofcut"],
    "fluteCount": ["numflutes", "numberofflutes", "flutes", "numteeth", "teeth"],
    "shankDiameter": ["shankdia", "shankdiameter"],
    # The relief is the necked-down section on a tool that has one.
    "neckDiameter": ["neckdia", "neckdiameter", "reliefdiameter", "reliefdia"],
    "neckLength": ["neckln", "necklength", "relieflength", "reliefln"],
    "overallLength": ["height", "overalllength", "toollength", "length"],
    "number": ["toolnumber", "tlnumber", "number", "adjustregister"],
    # How far the cutter stands out of the holder: Mill-Sim's stickout.
    "stickout": ["projection", "toolprojection", "holderoffset", "zoffset",
                 "stickout", "holderprojection"],
}

# Lengths are converted from the part's units; angles and counts are not.
LENGTHS = ("diameter", "cornerRadius", "tipDiameter", "fluteLength",
           "shankDiameter", "neckDiameter", "neckLength", "overallLength",
           "stickout")


def fields_from(found):
    """Map what the builder offered onto what Mill-Sim wants."""
    index = {}
    for key, v in found.items():
        index.setdefault(norm(key), v)
    out = {}
    for field, names in ALIASES.items():
        for name in names:
            if name in index:
                out[field] = index[name]
                break
    return out


# ---- the fallback: the UF parameter calls --------------------------------

def uf_fields(tool):
    """Read the parameters through UF_PARAM, which predates the .NET API.

    The constants live on NXOpen.UF.Param and are named for what they read.
    Which of them this build has is discovered the same way as everything
    else here, rather than assumed.
    """
    try:
        import NXOpen.UF
        ufs = NXOpen.UF.UFSession.GetUFSession()
    except Exception:
        return {}, "no UF session"

    try:
        constants = NXOpen.UF.Param
    except Exception:
        return {}, "no NXOpen.UF.Param"

    found = {}
    for name in dir(constants):
        if name.startswith("_"):
            continue
        try:
            const = getattr(constants, name)
        except Exception:
            continue
        if not isinstance(const, int):
            continue
        for call in ("AskDblValue", "AskIntValue"):
            try:
                v = getattr(ufs.Param, call)(tool.Tag, const)
            except Exception:
                continue
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                found[name] = float(v)
                break
    return found, "read %d parameters through UF" % len(found)


# ---- what kind of cutter it is -------------------------------------------

def family(name, diameter, corner_radius):
    """Which of Mill-Sim's cutter families this tool belongs to.

    The word list is English and Turkish, because a tool called FREZE is a
    milling cutter and one called MATKAP is a drill, and a shop names its
    tools in the language it works in.
    """
    s = (name or "").lower()
    for words, kind in (
        (("ball", "kure", "küre", "bilye"), "ball"),
        (("bull", "torus", "toroid", "radyus"), "bull"),
        (("chamfer", "spot", "center", "centre", "countersink", "engrav",
          "havsa", "havşa", "punta", "pah"), "chamfer"),
        (("barrel", "taper", "konik", "fıçı", "fici"), "taper"),
        (("t cutter", "t-cutter", "tslot", "t-slot", "lollipop", "lolipop",
          "undercut", "dovetail", "kirlangic", "kırlangıç"), "lollipop"),
        (("face", "shell", "tarama", "alin", "alın"), "face"),
        (("drill", "reamer", "tap", "bore", "counterbore",
          "matkap", "rayba", "kilavuz", "kılavuz", "delik"), "drill"),
        (("freze", "mill", "parmak"), None),          # a mill: the end decides
    ):
        if any(w in s for w in words):
            if kind:
                return kind
            break
    if corner_radius > 0 and corner_radius >= diameter / 2.0 - 1e-6:
        return "ball"
    if corner_radius > 0:
        return "bull"
    return "flat"


def main():
    session = NXOpen.Session.GetSession()
    lw = session.ListingWindow
    lw.Open()

    diag = ["Mill-Sim tool export diagnostic", ""]

    part = session.Parts.Work
    if part is None:
        lw.WriteLine("No work part is open.")
        return

    try:
        inches = part.PartUnits == NXOpen.BasePart.Units.Inches
    except Exception:
        inches = False
    scale = MM_PER_INCH if inches else 1.0
    lw.WriteLine("Reading tools in %s." % ("inches" if inches else "millimetres"))
    diag.append("Part units: %s" % ("inches" if inches else "millimetres"))

    setup = part.CAMSetup
    if setup is None:
        lw.WriteLine("This part has no CAM setup, so it has no tools.")
        return

    collection = setup.CAMGroupCollection
    factories = builder_factories(collection)
    diag.append("")
    diag.append("Builder factories on %s:" % type(collection).__name__)
    if factories:
        diag.extend("  %s" % n for n in factories)
    else:
        diag.append("  (none)")
    diag.append("")
    diag.append("Everything on the collection:")
    diag.append("  " + ", ".join(sorted(n for n in dir(collection) if not n.startswith("_"))))

    tools = []
    holders = []
    assemblies = []
    taken = set()
    failed = []
    first_dump = True
    # One holder per distinct stack: a shop runs forty tools in a dozen
    # holders, and forty copies of the same chuck is forty things to edit.
    holder_ids = {}

    for group in collection:
        if not isinstance(group, NXOpen.CAM.Tool):
            continue
        name = group.Name
        tried = []
        found = {}
        how = ""

        stages = []
        shank = []
        insertion = None
        shape = []
        factory_name = None
        try:
            found, extra, factory_name = read_tool(collection, group, name, tried, scale)
            found = found or {}
            stages = extra.get("holder", [])
            shank = extra.get("shank", [])
            insertion = extra.get("insertion")
            how = factory_name or ""
        except Exception:
            failed.append((name, traceback.format_exc().strip().splitlines()[-1]))

        # The whole shape of the winning builder, once, for the diagnostic.
        if first_dump and factory_name:
            try:
                probe = getattr(collection, factory_name)(group)
                shape = inventory(probe)
                probe.Destroy()
            except Exception:
                shape = []

        if not found:
            found, how = uf_fields(group)

        # The first tool's parameters, verbatim, so a run that reads nothing
        # still says what there was to read.
        if first_dump:
            first_dump = False
            diag.append("")
            diag.append("First tool: %s" % name)
            diag.append("  builder: %s" % (factory_name or "none"))
            for line in tried:
                diag.append("  tried: %s" % line)
            diag.append("  parameters found (%d):" % len(found))
            for k in sorted(found):
                diag.append("    %s = %s" % (k, found[k]))
            diag.append("  holder steps read: %d" % len(stages))
            for st in stages:
                diag.append("    %s" % st)
            # Everything on the builder, numbers and otherwise. A holder is
            # a list or a sub-builder rather than a float, so this is where
            # it shows up when the three ways of looking for it come back
            # empty.
            diag.append("  everything on the builder (%d):" % len(shape))
            for nm, nkind, value, sub in shape:
                diag.append("    %-34s %-22s %s" % (nm, nkind, value))
                if sub:
                    for entry in (sub if isinstance(sub, list) else [sub]):
                        if entry:
                            diag.append("        %s" % entry)

        read = fields_from(found)
        if not read:
            failed.append((name, "no parameters could be read from any of %d builders" % len(builder_factories(collection))))
            continue

        for field in LENGTHS:
            if field in read:
                read[field] *= scale

        diameter = read.get("diameter", 0.0)
        if diameter <= 0:
            failed.append((name, "no diameter among %d parameters" % len(found)))
            continue

        corner = min(read.get("cornerRadius", 0.0), diameter / 2.0)
        kind = family(name, diameter, corner)
        flute = read.get("fluteLength") or diameter * 2.0
        overall = max(read.get("overallLength") or flute * 3.0, flute + 1.0)
        # NX leaves the point angle at zero on a tool that never had one; a
        # drill without a point is not a thing.
        tip_angle = read.get("tipAngle") or (118.0 if kind == "drill" else 90.0)

        neck = read.get("neckDiameter", 0.0)
        neck_len = read.get("neckLength", 0.0)
        if not (0 < neck < diameter) or neck_len <= 0:
            neck = 0.0
            neck_len = 0.0

        number = int(read.get("number") or 0)
        if number <= 0:
            number = len(tools) + 1
        while number in taken:
            number += 1
        taken.add(number)

        tool_id = "nx%d" % (len(tools) + 1)
        tools.append({
            "id": tool_id,
            "name": name,
            "type": kind,
            "number": number,
            "diameter": round(diameter, 4),
            "cornerRadius": round(corner, 4),
            "tipDiameter": round(read.get("tipDiameter", 0.0), 4),
            "tipAngle": round(tip_angle, 3),
            "taperAngle": round(read.get("taperAngle", 0.0), 3),
            "fluteLength": round(flute, 4),
            "fluteCount": max(1, int(read.get("fluteCount") or 2)),
            "shankDiameter": round(read.get("shankDiameter") or diameter, 4),
            # A neck is only a neck if it is narrower than the cutter. NX
            # leaves a relief diameter sitting at something meaningless on
            # a tool that has no relief, and a "neck" wider than the flutes
            # would be drawn as a collar that is not there.
            "neckDiameter": round(neck, 4),
            "neckLength": round(neck_len, 4),
            "overallLength": round(overall, 4),
            "material": "carbide",
            "notes": "From NX: %s" % name,
            # The shank profile, when NX described one. Left out otherwise,
            # because a tool with no stages is built the way every tool was
            # built before there were any.
            "bodyStages": shank or None,
        })
        # The holder, shared with every tool that runs in the same one.
        holder_id = ""
        if stages:
            key = tuple((st["dia"], st["topDia"], st["length"]) for st in stages)
            if key not in holder_ids:
                holder_ids[key] = "nxh%d" % (len(holders) + 1)
                holders.append({
                    "id": holder_ids[key],
                    "name": "Holder %d (%s)" % (len(holders) + 1, name),
                    "type": "custom",
                    "taper": taper_of(name),
                    "stages": stages,
                    "notes": "From NX, first seen on %s" % name,
                })
            holder_id = holder_ids[key]

        assemblies.append({
            "id": "nxa%d" % len(assemblies),
            "name": "T%d · %s" % (number, name),
            "number": number,
            "toolId": tool_id,
            "holderId": holder_id,
            # NX says how far the tool goes *into* the holder; Mill-Sim
            # asks how much of it is out. One is the overall length less
            # the other. The conversion is checked rather than trusted: a
            # stickout that does not clear the flutes, or that leaves
            # nothing gripped, is not the right reading of that number, and
            # enough to clear the flutes is what an operator would set.
            "stickout": round(stickout_of(overall, flute, insertion, read.get("stickout")), 4),
        })
        lw.WriteLine("  T%-4d %-32s %-8s ø%.3f  %s [%s]"
                     % (number, name, kind, diameter,
                        ("holder, %d steps" % len(stages)) if stages else "no holder", how))

    library = {
        "version": 1,
        "exported": "NX",
        "tools": tools,
        "holders": holders,
        "assemblies": assemblies,
    }
    with open(OUTPUT, "w") as f:
        json.dump(library, f, indent=2)

    diag.append("")
    diag.append("Wrote %d tools and %d holders, could not read %d."
                % (len(tools), len(holders), len(failed)))
    for name, why in failed:
        diag.append("  %s - %s" % (name, why))
    try:
        with open(DIAGNOSTIC, "w") as f:
            f.write("\n".join(diag))
    except Exception:
        pass

    lw.WriteLine("")
    lw.WriteLine("Wrote %d tool%s and %d holder%s to %s"
                 % (len(tools), "" if len(tools) == 1 else "s",
                    len(holders), "" if len(holders) == 1 else "s", OUTPUT))
    if tools and not holders:
        lw.WriteLine("No holder geometry was found on any tool. The builder's")
        lw.WriteLine("whole shape is in %s - it is in there somewhere." % DIAGNOSTIC)
    if failed:
        lw.WriteLine("Could not read %d:" % len(failed))
        for name, why in failed:
            lw.WriteLine("  %s - %s" % (name, why))
        lw.WriteLine("")
        lw.WriteLine("What this seat offers is written to %s." % DIAGNOSTIC)
        lw.WriteLine("Send that file and the call it wants can be named exactly.")
    if tools:
        lw.WriteLine("In Mill-Sim: Tools > Library > Import library... and choose that file.")


if __name__ == "__main__":
    main()
