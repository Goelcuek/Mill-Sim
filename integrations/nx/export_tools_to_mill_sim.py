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


def make_builder(collection, tool, tried):
    """First factory that will build this tool, or None."""
    for name in builder_factories(collection):
        try:
            factory = getattr(collection, name)
        except Exception:
            continue
        try:
            builder = factory(tool)
        except Exception as err:
            tried.append("%s -> %s" % (name, str(err).splitlines()[0][:90]))
            continue
        if builder is not None:
            return builder, name
    return None, None


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
                out.append((name, kind, "", numbers_on(attr)))
    return out


def as_list(attr):
    """The attribute as a list, if it is one. Strings are not lists here."""
    if isinstance(attr, (str, bytes)):
        return None
    try:
        items = list(attr)
    except Exception:
        # A collection that will not iterate may still count and index.
        for count in ("Length", "Count", "NumberOfSections", "NumberOfSteps"):
            try:
                n = int(getattr(attr, count))
            except Exception:
                continue
            try:
                return [attr[i] for i in range(n)]
            except Exception:
                try:
                    return [attr.FindItem(i) for i in range(n)]
                except Exception:
                    return None
        return None
    return items


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
    # 1: a list of steps, under something that says so in its name.
    for name in dir(builder):
        low = name.lower()
        if name.startswith("_") or not ("holder" in low or "section" in low or "step" in low):
            continue
        try:
            attr = getattr(builder, name)
        except Exception:
            continue
        if attr is None or callable(attr) or isinstance(attr, (int, float, str, bool)):
            continue
        items = as_list(attr)
        if items:
            stages = [stage_from(numbers_on(i), scale) for i in items]
            stages = [s for s in stages if s]
            if stages:
                return stages
        # 2: a sub-builder. Its own numbers may be one step, or numbered ones.
        nums = numbers_on(attr)
        stages = numbered_stages(nums, scale) or ([stage_from(nums, scale)] if stage_from(nums, scale) else [])
        if stages:
            return stages

    # 3: flat parameters on the tool builder itself.
    holder_nums = {}
    for k, v in numbers_on(builder).items():
        if "holder" in k.lower() or "hld" in k.lower():
            holder_nums[k] = v
    return numbered_stages(holder_nums, scale)


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
    """A parameter name with the noise taken out, for matching."""
    s = name.lower()
    for junk in ("builder", "inheritable", "value", "tl", "_"):
        s = s.replace(junk, "")
    return s


# What each of our fields can be called, matched on the normalised name.
# First hit wins, so the specific spellings come before the vague ones.
ALIASES = {
    "diameter": ["diameter", "dia", "cuttingdiameter", "cutterdiameter"],
    "cornerRadius": ["cor1rad", "cornerradius", "cornerrad", "corner1radius", "cornerradius1"],
    "tipDiameter": ["tipdia", "tipdiameter", "pointdiameter", "lowerdiameter"],
    "tipAngle": ["tipangle", "pointangle", "includedangle"],
    "taperAngle": ["taperang", "taperangle"],
    "fluteLength": ["fluteln", "flutelength", "cuttinglength", "lengthofcut"],
    "fluteCount": ["numflutes", "numberofflutes", "flutes", "numteeth", "teeth"],
    "shankDiameter": ["shankdia", "shankdiameter"],
    "neckDiameter": ["neckdia", "neckdiameter"],
    "neckLength": ["neckln", "necklength"],
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
        shape = []
        builder, factory_name = make_builder(collection, group, tried)
        if builder is not None:
            try:
                found = numbers_on(builder)
                stages = nose_first(holder_stages(builder, scale))
                how = "%s" % factory_name
                if first_dump:
                    shape = inventory(builder)
            except Exception:
                failed.append((name, traceback.format_exc().strip().splitlines()[-1]))
            finally:
                try:
                    builder.Destroy()
                except Exception:
                    pass

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
            failed.append((name, "no parameters could be read" + (("; tried " + tried[0]) if tried else "")))
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
            "neckDiameter": round(read.get("neckDiameter", 0.0), 4),
            "neckLength": round(read.get("neckLength", 0.0), 4),
            "overallLength": round(overall, 4),
            "material": "carbide",
            "notes": "From NX: %s" % name,
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
            # NX states how far the tool stands out of the holder; without
            # one, enough to clear the flutes, which is what an operator
            # would set.
            "stickout": round(read.get("stickout") or max(flute * 1.4, flute + 5.0), 4),
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
