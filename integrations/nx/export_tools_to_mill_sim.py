# Export the tools in this NX part to a Mill-Sim tool library.
#
#   NX -> Tools -> Journal -> Play...  and pick this file.
#
# It walks the CAM setup's tool group, reads what each tool measures, and
# writes a JSON library that Mill-Sim's Tools > Library > Import reads
# directly: cutter geometry, flute count, tool number and an assembly per
# tool so everything arrives ready to run.
#
# Two notes on how it is written.
#
# NX names the same parameter differently between versions and between tool
# classes -- a mill's diameter is TlDiameterBuilder, a drill's may not be --
# so every field is looked up by trying a list of names and taking the first
# that answers. A parameter that cannot be found is left out rather than
# guessed at, and Mill-Sim fills it with a sensible default. That is why
# this keeps working when the API moves under it.
#
# Everything is written in millimetres. NX holds tool parameters in the
# part's units, so an inch part is converted here rather than leaving the
# question open at the far end.
#
# If this does not run on your seat, the other route needs no scripting at
# all: Mill-Sim reads NX's own ASCII tool libraries (tool_database.dat and
# its neighbours under MACH/resource/library/tool/metric) as they stand.

import json
import math
import os
import traceback

import NXOpen
import NXOpen.CAM

# Where to write it. Change this if you want it somewhere else.
OUTPUT = os.path.join(os.path.expanduser("~"), "mill-sim-tools.json")

MM_PER_INCH = 25.4


# ---- reading a parameter whatever it is called this version --------------

def value_of(builder, names):
    """First of `names` the builder answers to, as a number, or None."""
    for name in names:
        try:
            attr = getattr(builder, name)
        except Exception:
            continue
        if attr is None:
            continue
        # Most tool parameters are inheritable builders carrying .Value;
        # some are the plain number already.
        for path in ("Value", None):
            try:
                v = getattr(attr, path) if path else attr
            except Exception:
                continue
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                return float(v)
    return None


FIELDS = {
    "diameter": ["TlDiameterBuilder", "DiameterBuilder", "TlDiameter", "Diameter"],
    "cornerRadius": ["TlCor1RadBuilder", "TlCornerRadiusBuilder", "CornerRadiusBuilder",
                     "TlCor1Rad", "CornerRadius"],
    "tipDiameter": ["TlTipDiaBuilder", "TipDiameterBuilder", "TlPointDiaBuilder", "TipDiameter"],
    "tipAngle": ["TlTipAngleBuilder", "TipAngleBuilder", "TlPointAngleBuilder",
                 "PointAngleBuilder", "TipAngle"],
    "taperAngle": ["TlTaperAngBuilder", "TaperAngleBuilder", "TlTaperAng", "TaperAngle"],
    "fluteLength": ["TlFluteLnBuilder", "FluteLengthBuilder", "TlFluteLn", "FluteLength"],
    "fluteCount": ["TlNumFlutesBuilder", "NumberOfFlutesBuilder", "TlNumFlutes", "NumFlutes"],
    "shankDiameter": ["TlShankDiaBuilder", "ShankDiameterBuilder", "TlShankDia", "ShankDiameter"],
    "neckDiameter": ["TlNeckDiaBuilder", "NeckDiameterBuilder", "NeckDiameter"],
    "neckLength": ["TlNeckLnBuilder", "NeckLengthBuilder", "NeckLength"],
    "overallLength": ["TlHeightBuilder", "HeightBuilder", "TlLengthBuilder", "TlHeight", "Height"],
    "number": ["TlNumberBuilder", "ToolNumberBuilder", "TlNumber", "ToolNumber"],
}

# Lengths are converted; angles and counts are not.
LENGTHS = ("diameter", "cornerRadius", "tipDiameter", "fluteLength", "shankDiameter",
           "neckDiameter", "neckLength", "overallLength")


def family(name, diameter, corner_radius):
    """Which of Mill-Sim's cutter families this tool belongs to."""
    s = (name or "").lower()
    for words, kind in (
        (("ball",), "ball"),
        (("bull", "torus", "toroid"), "bull"),
        (("chamfer", "spot", "center", "centre", "countersink", "engrav"), "chamfer"),
        (("barrel", "taper"), "taper"),
        (("t cutter", "t-cutter", "tslot", "t-slot", "lollipop", "undercut", "dovetail"), "lollipop"),
        (("face", "shell"), "face"),
        (("drill", "reamer", "tap", "bore", "counterbore"), "drill"),
    ):
        if any(w in s for w in words):
            return kind
    if corner_radius > 0 and corner_radius >= diameter / 2.0 - 1e-6:
        return "ball"
    if corner_radius > 0:
        return "bull"
    return "flat"


def main():
    session = NXOpen.Session.GetSession()
    lw = session.ListingWindow
    lw.Open()

    part = session.Parts.Work
    if part is None:
        lw.WriteLine("No work part is open.")
        return

    # NX holds tool parameters in the part's units.
    try:
        inches = part.PartUnits == NXOpen.BasePart.Units.Inches
    except Exception:
        inches = False
    scale = MM_PER_INCH if inches else 1.0
    lw.WriteLine("Reading tools in %s." % ("inches" if inches else "millimetres"))

    setup = part.CAMSetup
    if setup is None:
        lw.WriteLine("This part has no CAM setup, so it has no tools.")
        return

    tools = []
    assemblies = []
    taken = set()
    failed = []

    for group in setup.CAMGroupCollection:
        if not isinstance(group, NXOpen.CAM.Tool):
            continue
        name = group.Name
        builder = None
        try:
            builder = setup.CAMGroupCollection.CreateToolBuilder(group)
            read = {}
            for field, names in FIELDS.items():
                v = value_of(builder, names)
                if v is None:
                    continue
                read[field] = v * scale if field in LENGTHS else v
        except Exception:
            failed.append((name, traceback.format_exc().strip().splitlines()[-1]))
            continue
        finally:
            if builder is not None:
                try:
                    builder.Destroy()
                except Exception:
                    pass

        diameter = read.get("diameter", 0.0)
        if diameter <= 0:
            failed.append((name, "no diameter could be read"))
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
        assemblies.append({
            "id": "nxa%d" % len(assemblies),
            "name": "T%d · %s" % (number, name),
            "number": number,
            "toolId": tool_id,
            "holderId": "",
            "stickout": round(max(flute * 1.4, flute + 5.0), 4),
        })
        lw.WriteLine("  T%-4d %-32s %s ø%.3f" % (number, name, kind, diameter))

    library = {
        "version": 1,
        "exported": "NX",
        "tools": tools,
        "holders": [],
        "assemblies": assemblies,
    }
    with open(OUTPUT, "w") as f:
        json.dump(library, f, indent=2)

    lw.WriteLine("")
    lw.WriteLine("Wrote %d tool%s to %s" % (len(tools), "" if len(tools) == 1 else "s", OUTPUT))
    if failed:
        lw.WriteLine("Could not read %d:" % len(failed))
        for name, why in failed:
            lw.WriteLine("  %s - %s" % (name, why))
    lw.WriteLine("In Mill-Sim: Tools > Library > Import library... and choose that file.")


if __name__ == "__main__":
    main()
