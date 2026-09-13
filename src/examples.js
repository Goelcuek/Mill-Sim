// Example programs shipped with the simulator.
//
// Only the metadata lives here; the G-code itself is fetched from
// examples/ on demand so a 7000-line surfacing program does not sit in
// memory until somebody asks for it.

export const EXAMPLES = [
  {
    "name": "Demo bracket (face, pocket, chamfer, drill)",
    "description": "Four tools, a rectangular pocket with radiused corners, a chamfer pass and a pecked hole pattern.",
    "setup": {
      "stock": {
        "size": [
          120,
          80,
          25
        ],
        "origin": [
          -60,
          -40,
          -25
        ],
        "resolution": 0.25
      }
    },
    "file": "examples/demo-bracket-face-pocket-chamfer-drill-.nc",
    "lines": 195
  },
  {
    "name": "Helical bore and profile",
    "description": "Helical ramp into a 40 mm bore, full-circle arcs opened out in radial steps, and a climb-milled outside contour.",
    "setup": {
      "stock": {
        "size": [
          80,
          80,
          30
        ],
        "origin": [
          -40,
          -40,
          -30
        ],
        "resolution": 0.22
      }
    },
    "file": "examples/helical-bore-and-profile.nc",
    "lines": 84
  },
  {
    "name": "3D dome (rough then ball-nose finish)",
    "description": "A 32 mm dome roughed in levels and finished with a 6 mm ball nose at 0.8 mm stepover, so the scallops are visible.",
    "setup": {
      "stock": {
        "size": [
          90,
          90,
          22
        ],
        "origin": [
          -45,
          -45,
          -22
        ],
        "resolution": 0.2
      }
    },
    "file": "examples/3d-dome-rough-then-ball-nose-finish-.nc",
    "lines": 6047
  },
  {
    "name": "Crash test (deliberately bad)",
    "description": "Rapids into solid material, a slot deeper than the flute length, a wrong H offset and a cut with the spindle stopped.",
    "setup": {
      "stock": {
        "size": [
          100,
          60,
          30
        ],
        "origin": [
          -50,
          -30,
          -30
        ],
        "resolution": 0.3
      }
    },
    "file": "examples/crash-test-deliberately-bad-.nc",
    "lines": 29
  },
  {
    "name": "Five axis: tilted planes and a swarf pass",
    "description": "G68.2 tilted work planes with G53.1 to swing the head onto each flank, then a continuous swarf pass under G43.4 tool centre point control.",
    "setup": {
      "stock": {
        "size": [
          120,
          90,
          40
        ],
        "origin": [
          -60,
          -45,
          -40
        ],
        "resolution": 0.25
      },
      "machine": {
        "preset": "headTable"
      }
    },
    "file": "examples/five-axis-tilted-planes-and-swarf.nc",
    "lines": 101
  },
  {
    "name": "Macro family of parts",
    "description": "One program, any size of the same plate: Fanuc macro B variables, WHILE loops for the roughing rings and the bolt circle, and IF to clip the last depth pass.",
    "setup": {
      "stock": {
        "size": [
          100,
          70,
          20
        ],
        "origin": [
          -50,
          -35,
          -20
        ],
        "resolution": 0.25
      }
    },
    "file": "examples/macro-family-of-parts.nc",
    "lines": 67
  },
  {
    "name": "Siemens 840D bolt circle",
    "description": "The same job in the other spelling: R parameters, round brackets for arithmetic, symbol comparisons, ENDWHILE, FOR/ENDFOR and a named label. Loading it sets the machine to read Siemens.",
    "setup": {
      "stock": {
        "size": [
          80,
          80,
          20
        ],
        "origin": [
          -40,
          -40,
          -20
        ],
        "resolution": 0.25
      },
      "machine": {
        "controller": {
          "flavour": "siemens",
          "dialect": "siemens",
          "syntax": null,
          "plane": 17,
          "metric": true,
          "absolute": true,
          "arcCentreAbsolute": false,
          "feedMode": 94
        }
      }
    },
    "file": "examples/siemens-bolt-circle-840d.nc",
    "lines": 64
  }
];

/** Fetch an example's G-code text. */
export async function loadExample(example) {
  const url = new URL('../' + example.file, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load ' + example.file + ' (HTTP ' + res.status + ')');
  return res.text();
}
