# Mill-Sim

A CNC milling simulator that runs in the browser. Build tools and holders
parametrically, read a G-code program, watch the machine cut a block of
stock, and get told about every crash before the real machine finds it.

No build step, no bundler, no backend. It is plain ES modules plus a
vendored copy of three.js.

## Running it

**No toolchain?** Download [`dist/mill-sim.html`](dist/mill-sim.html) and open
it. That one file is the whole simulator — three.js, every source file, the
stylesheet and all four example programs inlined — so it runs straight off
your filesystem with no install, no server and no Node.

**From source**, which you want if you're going to change anything:

```bash
npm start          # serves on http://localhost:8080
npm test           # 67 unit tests, no browser needed
npm run build      # regenerate dist/mill-sim.html (needs: npm i -D esbuild)
```

There is nothing to `npm install` — the project has no dependencies and
three.js is vendored in `vendor/`. You just need Node 20+.

Serving over HTTP is required when running from source: the app is plain ES
modules, and browsers block module imports over `file://`. Any static server
works — `python3 -m http.server 8080` is fine if you'd rather not use Node.
The single-file build sidesteps this entirely by bundling to one classic
script.

Open the page, pick an example from the **Program** tab, and press play.

![The dome example after a full run](assets/dome.png)

---

## What it does

**Parametric tool library.** Eight cutter families — flat, ball, bull nose,
chamfer/V, tapered, drill, face mill and undercut — each generated from its
real dimensions rather than picked from a fixed list. Holders are stacks of
cones running from the nose up to the gauge line, so a stubby shrink-fit
holder and a slim extension behave differently in a deep pocket, as they
should. The taper above the gauge line is deliberately not modelled: it
lives inside the spindle bore and can never touch anything. The gauge line
is the mating face, and the spindle nose starts exactly there. A tool plus a holder plus a stickout is an *assembly*, and
an assembly is what a `T` number selects.

A shop's tools arrive as a file rather than as forty sets of numbers to
retype, so **Tools › Library › Import** reads four kinds directly:

| From | File | Notes |
| --- | --- | --- |
| Mill-Sim | `.json` | What Export writes. |
| Fusion 360 / HSMWorks | `.json`, `.tools`, `.hsmlib` | ISO 13399 geometry, holders, presets, `T` numbers. |
| Siemens NX | `tool_database.dat` and friends | NX's own ASCII library, as it sits on disk under `MACH/resource/library/tool/…`. Pick the unit in the dialog: NX keeps metric and english libraries in separate directories, and the file itself does not say which it is. |
| Anything else | `.csv`, `.tsv`, `.txt` | A tool list with a header row. Columns are matched by meaning, so NX's `FLUTE_LN`, ISO's `LCF` and a plain `Flute Length` all land in the same place. |

For tools that live in a part's CAM setup rather than in the NX library,
`integrations/nx/export_tools_to_mill_sim.py` is an NX Open journal — **Tools
› Journal › Play…** — that walks the setup's tool group and writes a
Mill-Sim library. It reads each parameter by trying the names NX has used
for it across versions and tool classes, so a parameter it cannot find is
left out and defaulted rather than guessed at.

**G-code interpretation.** A full modal interpreter: linear and helical
arcs in all three planes, both `I/J/K` and `R` forms, inch and metric,
absolute and incremental, work offsets, tool-length offsets, canned
drilling cycles, subprogram calls, and reference returns. It reports what
it could not make sense of instead of quietly doing something else.

**Material removal.** The stock is a heightmap and the cutter is a swept
envelope, so what you see is the surface the tool actually leaves —
scallops from a ball nose stepover, the radius a cutter leaves in a square
corner, the ramp from a helical entry.

**Stock that is not a block.** **Add stock…** offers three shapes, because
three is what a shop has: a rectangular block (X, Y, Z), a round bar (Ø and
height), and a model — a casting, a forging, a weldment, or the output of
the last operation, imported as STL. The simulation is a field of vertical
columns, so a shape is nothing more than the height each column starts at:
a block answers "the top, everywhere", a bar answers "the top, inside the
circle", and a model answers with its own upper surface. Everything
downstream already works column by column, so cutting, collision checking,
volume and the picked surface need to know nothing about which of the three
they are looking at — a facing pass over a Ø50 bar removes the disc, not
the square, and a cut that reaches the bottom leaves a hole rather than a
film. Like the rest of this model a shape cannot hold an undercut: what
hides beneath the top surface is taken to be solid.

**Collision checking.** Not just the cutter: the shank, the neck, the
holder and the spindle nose are all part of the crash model, along with
imported fixtures, the table surface and the travel limits. **Setup ›
Checks** decides what counts: ask for clearance and a pass that clears a
clamp by 2 mm is reported as the near miss it is, rather than only metal
in metal. Which parts of the assembly are checked at all is a switch, and
two exceptions live on the fixture itself — a soft jaw being cut can be
ignored, a fragile one can ask for more room than everything else.

**Macros, in whatever the control spells.** Variables, arithmetic and
control flow, because that is what the programs in a real control's memory
are made of:

```gcode
#1 = 0
WHILE [#1 LT #2] DO 1
  #10 = #3 * COS[360 * #1 / #2]
  #11 = #3 * SIN[360 * #1 / #2]
  G0 X#10 Y#11
  G83 Z-12. R2. Q3. F180
  #1 = #1 + 1
END 1
```

That is Fanuc's spelling. It is not *the* spelling — Siemens writes the
same job like this:

```gcode
R1 = 0
WHILE R1 < R21
  R4 = 360. * R3 / R21
  G0 X=R20 * COS(R4) Y=R20 * SIN(R4)
  R1 = R1 + 1
ENDWHILE
```

so the syntax is a table rather than an assumption: which character marks
a variable (`#`) or which letter introduces one (`R`, `Q`, `V`), which
brackets group an expression, how the six comparisons are spelled, what
the control-flow words are called, whether a jump goes to a line number or
a named label, whether values are written `X100` or `X=100`, whether a
variable is local to a macro call, and — the one that bites — whether
round brackets are arithmetic or a remark. Get that last one wrong and
`X=SIN(30)` becomes a comment.

**Machine › Macros › Reads like** picks the table: Fanuc (also Haas, Mazak
and Fadal), Siemens 840D, Heidenhain Q parameters, Okuma V. **Edit
syntax…** changes any of it, which is how a control nobody here has ever
seen gets described rather than waited for — give it an `@` sigil and
`LOOP … ENDLOOP` and it reads that from the next block on. The table is
saved with the machine, so a program that moves between machines is read
by each of them the way that machine would read it.

Underneath, all of them get the same thing: assignment and arithmetic with
the usual precedence and the usual functions (in degrees, like the
control), an expression anywhere a number goes, conditional jumps and
assignments, `WHILE` loops, `FOR` and `REPEAT` on the controls that have
them, and macro calls whose letters arrive as arguments. A program that
uses none of it is read exactly as it was before. What a run left in the
variables is on **Program › Summary** — written the way that control
writes them — which is the first place to look when a macro program lands
somewhere odd.

**Measuring.** A verifier that cannot answer "how deep is that pocket" is
asking to be trusted and checked somewhere else. **View › Measure** takes
two points for a distance, with its three components, or three points
round a bore for its diameter and centre. Points snap to corners, edges,
face centres, work origins — and to the rim of whatever has been cut,
which is what makes a bore measurable at all: its wall is one column wide,
so the top edge is the only part worth pointing at. A Ø10 hole on a
0.28 mm grid measures Ø10.045.

**Five-axis machines.** A machine is a tree of joints rather than a fixed
layout, so head-head, head-table and table-table are the same code with the
rotaries in different places. Start from a preset, move a pivot, slave one
axis to another, and hang your own STL castings on each axis. The tilted
work-plane and tool-centre-point codes are interpreted, the tool is carved
at whatever angle the machine puts it, and the rig in the viewport moves the
way the real machine does.

**Assembling a machine.** Start from a preset, or from **New machine…** —
a base that does not move, a table to clamp to, a spindle to hang the tool
on, and no axes. Add the axes on the Axes page, then bring the machine in
as STL bodies on the Assembly page and say which axis carries each one. A
body on the base never moves; a body on X rides the X slide; an axis can
carry as many bodies as it has castings. **Mate by two points** does the
placing: click a point on the body, click where that point belongs, and it
moves so the two coincide — joints snap as targets, so a casting drops
straight onto its own pivot. The move is measured in the frame of the axis
that carries it, so a saddle nudged 20 mm has moved 20 mm along its own
slide whatever the rest of the machine is doing.

**The controller** is part of the machine too. Controls do not agree on the
modal state they power up in, and a program posted for one machine read by
another is the classic way to crash — the second one starts in inches, or
reads I/J as absolute, or comes up in G18. The Controller page holds those
defaults and changing one re-reads the program.

**Macros: what the machine does at an M code.** A control does not really
*do* M06. It runs a program the machine builder wrote, which retracts the
head, crosses to the change position, unclamps and indexes the carousel —
which is why two machines reading the same G-code visibly do different
things at the same code. **Machine › Macros** holds those programs, as
G-code:

```gcode
(KR199 tool change: square the head, cross to the changer)
M5
G91 G28 Z0
G90 G53 G0 C0 A0
G53 G0 X#toolChangeX Y#toolChangeY
G4 P3.0            (arm swings)
```

`#toolChangeX` is a machine parameter, set in the same place; `#T`, `#S`,
`#P`, `#Q`, `#R`, `#H` and `#D` are the words of the block that called the
macro, so the body can say which tool it is loading. Everything else is
ordinary G-code read by the ordinary interpreter, so G28, G53, dwells and
canned cycles all work inside one. They ship switched off: a macro that
runs changes what every program does at that code, and that should be a
decision rather than a surprise.

The same page holds the **subprograms that live in the machine** — probing
cycles, pallet routines, the builder's own O9000 programs, the files that
stay in the control between jobs. Any program loaded on the machine can
call them with M98 without carrying a copy, and they are saved and loaded
with the machine, because they are part of it.

**Subprograms that belong to the job** are on **Program › Subprograms**,
and they are files, nothing more: open one or several the same way the main
program is opened, edit them in the same editor. The number M98 asks for is
the `O` word at the top of the file, exactly as a control reads it — rename
the file however you like. The moves inside a subprogram are simulated,
carved and collision-checked like any others, and the toolpath and every
warning say which file they came from. Two files claiming the same O number
is reported rather than quietly resolved. A program that carries its own
O-numbered sections still works exactly as it did.

**The job as one file.** A setup is not a program: it is a program, the
machine it runs on, the stock it starts from, where that stock sits
against the work offsets, which tools the T numbers mean, and the clamps
standing around it. **Setup › Project** saves all of it as one zip —
`project.json` for the setup, `program/` for the G-code and its
subprograms, `machine/` laid out exactly as **Save machine** writes it,
`library.json` for the tools, `models/` and `stock/` as STL. Opening one
puts it back in the order the thing itself requires, camera included.
Every part of it opens in something else: a project only this program can
read is a hostage, not an archive.

Your own machine goes in through **Machine › Layout › Load machine…**, and
comes out through **Save machine…** as a folder — a `.zip`, because a web
page cannot hand you a directory, and every operating system opens one as a
folder anyway:

```
fidia-kr199.zip
├── machine.json     the chain; the controller's power-up state; the
│                    travels, table, spindle nose and rates; where home is;
│                    the macro and subprogram list; and which axis carries
│                    each body, and where
├── macros/M6.nc     one file per macro, plain G-code
├── macros/M30.nc
├── subprograms/     the files that live in this control between jobs
├── bodies/*.stl     the castings themselves, in millimetres
└── README.txt
```

Everything on the Machine tab is in there, geometry included: load the
folder on another computer and you have the same machine, with the same
envelope, the same crash model and the same idea of what M06 does. The two
exceptions are deliberate — whether the full machine is *drawn*, and which
preset it started life as, are about the window rather than the machine.
`examples/machines/fidia-kr199.json` is a worked example of the JSON on its
own — a bridge machine with a fixed table and an A/C birotary head, X Y Z C
A all in series, with its tool-change macro — to copy and edit; loading a
bare `.json` like that restores the arrangement and asks for the STLs
separately.

Until you import castings, each preset draws itself: a plinth with a chip
skirt, a column with ways down its front face, a T-slotted table on a
saddle, telescoping way covers, a trunnion with two cheeks and a cradle
between them, a fork head with its tilt bearings. They are coloured by what
a part *does* — everything that slides one colour, everything that rotates
another, the spindle bright because it is the bit you watch — and each
machine family paints its moving castings its own colour. A machine you
cannot read is a machine you cannot check a program against.

**Models in and out.** Import STL fixtures, clamps and reference parts,
place them with a gizmo or by typing coordinates, and export the machined
part as STL or OBJ when the run finishes.

---

## Getting around

One rule decides where everything lives:

> **The ribbon navigates. The side panel acts.**

The tabs across the top say which part of the job you are working on, and
the row under them says which page of it. Neither ever *does* anything —
clicking a page changes what the side panel shows, and that is all. Every
control that changes something lives in the panel, next to the thing it
changes, so no button is ever in two places and there is only one place to
look for it. Double-click a tab, or use the chevron on the right, to
collapse the page row and give the viewport the space back.

| Tab | Pages |
| --- | --- |
| **Setup** | Project · Stock · Work offsets · Fixtures · Checks |
| **Machine** | Layout · Axes · Assembly · Controller · Macros · Travels |
| **Tools** | Tool table · Cutters · Holders · Library |
| **Program** | Main · Subprograms · Summary |
| **Results** | Findings · Compare · Export |
| **View** | Camera · Show · Inspect · Measure |

The viewport draws **on demand**. A machining simulator is static most of
the time — the program is not running, nobody is dragging the view, and the
picture is the same one it was a second ago. Redrawing it sixty times a
second anyway costs a whole core, which a desktop absorbs and a laptop
turns into fan noise. So the renderer runs when something says it needs to:
a change anywhere in the app, the orbit controls while they move, or the
simulator while it cuts. Idle is zero frames a second.

**Background** is a setting, on View › Show. A pale part on a pale ground
has no silhouette, and a machined face reads by its silhouette before
anything else, so the default puts a mid grey-blue behind the work and
there is a dark ground for inspecting a bright finish, a blueprint blue, a
paper white for screenshots, and a colour picker.

Anything that has to be created from nothing is behind an **Add** button at
the top of the page that lists it, and Add always opens a window: a cutter,
a holder, an assembly, a fixture, an axis, a casting. A window is a task
with a beginning and an end — fill it in, watch the preview redraw as you
type, then commit or cancel. Nothing changes until you commit, so Escape is
always safe. Everything else is editing something that already exists, and
that happens in the panel directly.

Playback is the one thing that is neither: the bar under the viewport is
always visible and owns ⏮ ▶ ⏭ ⏭⏭, the scrubber and the speed, so it is
never repeated in a panel.

Keyboard: `Space` play/pause, `R` reset, `→` step one move, `F` fit view.
During a placement: `X` / `Y` / `Z` lock the move to an axis, `Esc` cancels.

## Placing things by clicking

Typing coordinates to position a vice is a bad way to set up a job. Every
placement tool here is the same conversation instead — click the point, click
where it should go:

- **Move stock** and **Move model** translate the thing so the first point
  lands on the second.
- **Set zero** drops the active work origin straight onto a clicked point;
  **Move G54** shifts it by the distance between two points.

Points snap. Everything near the cursor is projected to the screen and the
closest candidate within a few pixels wins, ranked so a corner beats an edge
and an edge beats a face:

| Colour | Snaps to |
| --- | --- |
| Amber | Block corners and mesh vertices |
| Green | Edge midpoints |
| Blue | Face centres and triangle centroids |
| Purple | Existing work origins |
| Grey | Anywhere on a surface, unsnapped |

The stock snaps to its 26 box features and to the machined surface itself —
the floor of a pocket is clickable, because the ray is walked through the
heightmap rather than against the flat mesh the GPU displaces.

Press `X`, `Y` or `Z` mid-move to lock to one axis, which is how you say "up
40" without hunting for a point that happens to be straight above. Clicking
empty space during a move lands on the plane through the start point rather
than throwing the destination across the room.

---

## How the cutting works

Every solid of revolution in the simulator — cutter, neck, shank, holder,
spindle nose — is described by a silhouette polyline of `{radius, height}`
points. From that, `src/tools/envelope.js` builds a **lower envelope**
table: for a point at radial distance `r` from the tool axis, the lowest
height at which that solid occupies that radius.

That one function answers both questions the simulator needs:

```
cutting     h = min(h, tipZ + LE_flutes(r))     for each stock column
collision   h >     tipZ + LE_body(r)           for each stock column
```

The table is indexed by `r²` rather than `r`, so the inner loop never takes
a square root, and resolution concentrates near the outer edge of the tool
where the profile curves most. A ball nose reproduces its analytic sphere
to within a micron.

The stock is a regular XY grid of columns (a Z-dexel field), each holding
the height of the remaining material. A 16×16 tile pyramid holds the
maximum height of each block, so air moves — most of every program — are
rejected without touching a single column. Rejecting 200,000 air moves
takes about 15 ms.

The simulator is time-sliced: `run(dt, budgetMs)` does as much work as fits
in a frame and returns, so the UI stays responsive whether the program has
80 moves or 80,000.

### Why it can run at 0.025 mm

Stamping the tool at every sub-step costs O(1/cell³) — four times the
columns and twice the steps for every halving — which is why a fine grid
dies. Instead each straight move is carved as a **swept volume**: for a
column at distance r(t) from the moving axis, the surface the tool can
reach is z(t) + LE(r(t)²), where r(t)² is a parabola in t. The interval
where the tool covers the column at all comes out of a quadratic, and since
LE is non-decreasing and convex in r for every cutter shape here, the sum is
unimodal and a golden-section search finds the minimum exactly. Every column
is visited once per move rather than once per sub-step, which is O(1/cell²).
Flat-bottomed cutters skip the search entirely — a constant envelope is
lowest at one end of the pass.

Around that: whole 16×16 tiles are rejected against the max-height pyramid
before any column is touched; a column already below the lowest the tool
gets is skipped in a few nanoseconds; the holder probe rejects by tile and
then samples on a fixed physical spacing, because a Ø63 holder covers six
million columns at 0.025 mm and a crash worth reporting is never a quarter
of a millimetre across.

The display is decoupled too. A 0.025 mm grid is twelve million columns; the
view keeps a reduced grid sized to a vertex budget, each display texel taking
the lowest column in its block so a cut is never averaged away, and only the
rectangle the cutter actually touched is uploaded each frame.

Measured on the demo bracket (251 moves, four tools including a Ø50 face
mill), whole program, in Node:

| Cell size | Columns | Simulate |
| --- | --- | --- |
| 0.4 mm | 0.06 M | 76 ms |
| 0.1 mm | 0.96 M | 211 ms |
| 0.05 mm | 3.8 M | 758 ms |
| 0.025 mm | 15.4 M | 3.1 s |

Removed volume agrees to 0.01 cm³ across all four.

### When the tool leans

A leaning tool is a different problem. The swept envelope of an upright
cutter is just the envelope translated, which is what makes the fast path
fast; tilt it and that stops being true. So a tilted move is carved by a
second routine that works from the same lower-envelope table but answers a
harder question per column.

Along the vertical line through a column, with `u` the height above the tool
tip's plane, both the distance along the tool axis and the distance from it
are quadratics in `u`:

```
s(u)        = k + u·az                     along the axis
radial²(u)  = A + B·u + C·u²               from the axis,  C = 1 − az²
```

`C` vanishes when the tool stands upright, which is the upright case falling
out of the same algebra. The column is inside the cutter where
`s ≥ LE(radial²)`, and since every cutter here is convex that region is a
single interval — so the carve brackets where the tool could reach at all,
finds the deepest penetration by golden-section search, and bisects down to
the surface the tool leaves.

Two guards matter. The lowest point the whole tilted solid can reach is
computed once per move, so most columns are rejected on one compare. And a
tilted tool can sit entirely *below* the surface without having touched it —
the overhanging side passes under standing material. A heightmap cannot hold
that undercut, but it must not claim the material was removed either, so a
column past the tool's upper crossing is left alone.

Tilted moves are stamped rather than swept, at a spacing taken from the
scallop it leaves (`d²/8r`) and capped so the swing between stamps cannot
step down a wall. Validated against the analytic shapes: a tilted ball nose
bottoms out within 3 µm of where the sphere says, at every angle from 0° to
60°, and a flat end mill leaning 30° leaves an ellipse whose axes match
`d` and `d/cos 30°` to a tenth of a millimetre.

### Kinematics

A machine is a tree of joints rooted at the base. Two paths lead away from
it, one ending at the spindle and one at the table, and which path a rotary
sits on is the entire difference between the three families:

| | |
| --- | --- |
| **head-head** | both rotaries on the spindle path — a gantry |
| **head-table** | one on each — the classic 5-axis conversion of a VMC |
| **table-table** | both on the table path — a trunnion |

There is no separate code for the three, only different trees. What the
simulator asks for is the tool expressed in the workpiece's frame,
`inverse(workChain) · toolChain`, which gives a tip and a direction and
nothing about how many axes produced them.

Two inverse problems come up. Tool centre point control needs the linear
axes that put the tip on a given point: with the rotaries fixed the tip
depends on X/Y/Z through a pure translation chain, so the map is affine, and
sampling it at the origin and three unit steps recovers it exactly — the
solve is then one 3×3 system, no iteration. `G53.1` needs the rotaries that
point the tool along a given direction, which is trigonometric and wound
differently by every machine; that one is searched, coarsely then by pattern
search, staying inside the travel throughout so it can report "cannot reach"
rather than a pose the machine cannot make.

### Gouging

Import a model as a **reference part** and it becomes the shape the job is
supposed to produce. It is rasterised onto the stock's own grid, so the
check costs one array read inside the carving loop that is already running:
cut below that surface by more than the tolerance and it is reported as a
gouge, with its depth, alongside the collisions.

The Results panel also reports the other half of the comparison — how much
stock is still standing above the part, and what fraction of the reference
surface was gouged. The tolerance is adjustable; the default is 0.02 mm.

### What the crash model catches

| Reported as | Meaning |
| --- | --- |
| **Rapid into material** | A `G0` removed material. On the machine that is a crash, not a cut. |
| **Depth of cut exceeds flute length** | Material stands above the top of the flutes inside the cutter's own footprint — the shank is dragging in the cut. Caught even for a plain end mill whose shank is exactly its cutting diameter. |
| **Holder / shank crash** | The holder or spindle nose is buried in the stock, with the depth. |
| **Fixture collision** | Any part of the assembly reached into a fixture or clamp. |
| **Table collision** | The assembly went below the table surface inside its footprint. |
| **Travel limit exceeded** | The tool tip left the machine envelope. |
| **Gouge into the reference part** | The cutter went below the reference surface by more than the tolerance. |
| **Cutting with spindle stopped** | Material removed with no `M03`/`M04` active. |
| **No tool assembly loaded** | The program selected a `T` number the library has no assembly for. |

The interpreter adds its own notes: a `G43 H` that does not match the
active `T`, an arc whose end point misses the programmed radius, an
`R`-format arc smaller than half its chord, cutter compensation that is
acknowledged but not applied, and macro variables it cannot evaluate.

---

## G-code support

**Motion** `G00` `G01` `G02` `G03` — arcs by `I/J/K` (incremental or
absolute via `G90.1`/`G91.1`) or by `R`, including full circles and helical
interpolation.

**Planes** `G17` `G18` `G19` · **Units** `G20` `G21` · **Distance** `G90`
`G91`

**Offsets** `G54`–`G59`, `G10 L2 P`, `G92`/`G92.1`, `G43`/`G44`/`G49` with
`H`, `G53` machine coordinates

**Cycles** `G73` `G81` `G82` `G83` `G84` `G85` `G89` `G80`, with `G98`/`G99`
return planes, `Q` pecks, `P` dwells and `L` repeats

**Five axis** `G68.2` tilted work plane (`P1` Euler ZXZ, `P2` roll-pitch-yaw),
`G69` cancel, `G53.1` orient the tool normal to the plane, `G43.4`/`G43.5`
tool centre point control, and `A`/`B`/`C` words on any move

**Other** `G04` dwell, `G28`/`G30` reference return, `G40`–`G42`,
`G61`/`G64`, `G93`/`G94`/`G95`

**M codes** `M00` `M01` `M02` `M03` `M04` `M05` `M06` `M07` `M08` `M09`
`M30`, and `M98`/`M99` subprogram calls with `L` repeats

**Syntax** `%` markers, `O` numbers, `N` line numbers, `( )` and `;`
comments, `/` block delete

Not supported: macro variables and expressions (`#1`, `[ ]`), and cutter
radius compensation as an actual path offset. Each is reported rather than
silently ignored.

---

## Honest limitations

- **The stock is a heightmap, so it cannot represent undercuts.** Each
  column stores one top surface. This is the standard trade-off for
  interactive 3-axis verification. Undercut tools are drawn and
  collision-checked, but the material beneath an overhang will not be
  removed. The Tools panel says so when you build one.
- **Fixture collision uses each model's oriented bounding box.** A complex
  clamp will read as a slightly bigger block than it is. Import an awkward
  fixture as a few simple pieces for a tighter fit.
- **A tilted tool can pass under standing material.** The heightmap holds
  one surface per column, so an undercut a leaning cutter creates cannot be
  drawn. The carver refuses to remove a column the tool passes entirely
  beneath rather than report material gone that is still there, which is the
  honest failure of the two.
- **Non-TCP five-axis programs assume the part zero is at the machine's home
  tip.** Without `G43.4` the programmed X/Y/Z are axis positions, and turning
  those into a point on the part needs the work offset and the tool length
  that the control holds. Mill-Sim ties the two frames together at the
  machine's home position, where the programmed point and the tool tip
  coincide by definition. Under `G43.4`/`G43.5` there is nothing to assume:
  the programmed point is the tip.
- **Cutter compensation is not applied.** The simulated path is the
  programmed centreline, which is what most posted CAM output already is.
- **Feed rates are taken from the program**, not from any cutting model.
  The reference cutting data stored on each tool is for your own notes.

---

## Layout

```
index.html            page shell, import map, WebGL2 check
styles/app.css        the whole stylesheet
src/
  core/
    util.js           formatting and small helpers
    mat4.js           4x4 maths, dependency-free so kinematics tests run in Node
  tools/
    envelope.js       lower-envelope tables — the geometric core
    toolDefs.js       parametric cutters
    holderDefs.js     parametric holders, nose to gauge line
    assembly.js       cutter + holder + stickout -> cut/shank/holder envelopes
    library.js        CRUD, localStorage, JSON import/export
  machine/
    kinematics.js     the joint tree, forward kinematics and both IK solves
    presets.js        3-axis VMC, head-head, head-table, table-table
    parts.js          the machine's own bodies and where each one sits
  gcode/
    lexer.js          tokeniser
    interpreter.js    modal state machine -> flat move list
  sim/
    stock.js          heightmap, swept and tilted carving, tile pyramid
    target.js         reference-part rasterisation and gouge comparison
    collision.js      sphere chains vs boxes, table and limits
    simulator.js      the time-sliced run loop
  scene/
    viewer.js         renderer, camera, lighting
    stockView.js      GPU-displaced heightmap mesh
    toolView.js       lathed assemblies with helical flutes
    toolpathView.js   backplot
    machineView.js    the chain-driven rig: one group per axis
    castings.js       proxy machine parts, and the palette they use
    backgrounds.js    viewport backdrops
    modelsView.js     imported models and the transform gizmo
    pickController.js raycasting and snapping for click-to-place
    originView.js     work-origin markers
  io/
    stl.js            STL read/write, OBJ write
    mesh.js           heightmap and lathe triangulation
  ui/
    ribbon.js         tabs and pages — navigation only, no actions
    panel.js          the shape every side panel has: pages, Add bars,
                      action rows
    dialog.js         the windows Add opens
    toolDialogs.js    cutter, holder and assembly editors
    setupDialogs.js   the Add-a-fixture window
    machineDialogs.js the Add-an-axis and Add-a-casting windows
    icons.js          the stroked icon set
    ...               panels, G-code editor, preview, DOM helpers
  app.js              state, wiring and the frame loop
examples/             the seven example programs
  machines/           a worked machine definition to copy
scripts/              static server, smoke test, single-file build
test/                 unit tests (node --test)
dist/mill-sim.html    self-contained build, committed so it can just be opened
vendor/three/         three.js r180, MIT
```

Everything under `src/core`, `src/tools`, `src/gcode`, `src/sim`,
`src/machine/kinematics.js` and `src/io` is free of three.js, which is why the test suite runs in plain
Node with no browser and no mocks.

### Rendering the cut

Rebuilding a million-triangle mesh every frame would not keep up, so the
heightmap lives in a float texture and the stock mesh is a flat grid that
the vertex shader lifts to the current surface. Surface normals come from
the same texture by central difference, so a freshly machined face shades
correctly the instant it changes. Cutting costs one texture upload per
frame instead of a geometry rebuild.

---

## Testing

```bash
npm test           # 104 unit tests: geometry, G-code, kinematics, cutting, I/O
npm run smoke      # optional: boots the app in headless Chromium
```

The unit tests check real numbers, not just that nothing threw: facing a
block removes exactly the swept volume, a ball nose matches its analytic
sphere, a `G2` the long way round is 270° and not 90°, `G83` pecks land on
the right depths, the exported STL is closed with outward-facing normals,
and scrubbing backwards and forwards again lands on the identical result.

`npm run smoke` needs Playwright, which is not a dependency:

```bash
npm i -D playwright && npx playwright install chromium
npm run smoke
```

It boots the app, runs the demo bracket end to end and asserts it comes out
clean, then runs the deliberately bad example and asserts every mistake in
it is caught.

---

## Requirements

A browser with WebGL2 — Chrome, Edge, Firefox or Safari 15+. The page
checks and says so plainly if not.

three.js r180 is vendored under `vendor/three/` (MIT, license included).
Nothing else is fetched at runtime.
