// The job, as one file.
//
// A setup is not a program. It is a program, and the machine it runs on,
// and the stock it starts from, and where that stock sits relative to the
// work offsets, and which tools the T numbers mean, and the clamps standing
// around it. Losing any one of those makes the rest unverifiable, so they
// travel together — a zip, laid out as the folder it would be if a browser
// could hand you one:
//
//   project.json        the setup: stock, offsets, models, what is where
//   program/job.nc      the main program, exactly as it was read
//   program/subs/*.nc   the subprograms it calls
//   machine/            the whole machine, in the same layout "Save machine"
//                       writes — machine.json, macros/, subprograms/, bodies/
//   library.json        the tools, holders and assemblies
//   models/*.stl        fixtures, clamps and reference parts
//   stock/*.stl         the stock model, when the stock is a model
//
// Everything in there is a format something else can read. That is the
// point: a project that can only be opened by the program that wrote it is
// a hostage, not an archive.

import { writeZip, readZip } from './zip.js';
import { writeSTL, parseSTL } from './stl.js';

export const PROJECT_VERSION = 1;

const text = (bytes) => new TextDecoder().decode(bytes);
const asBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** Turn a name into something safe to put in a zip. */
function safeName(name, ext) {
  const base = String(name || 'file').replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'file'}${ext}`;
}

/**
 * Collect the whole session.
 *
 * @param {object} app
 * @returns {Promise<{bytes:Uint8Array, name:string, summary:object}>}
 */
export async function writeProject(app) {
  const state = app.state;
  const files = [];
  const used = new Set();
  const unique = (name, ext) => {
    let out = safeName(name, ext);
    let n = 2;
    while (used.has(out)) out = safeName(`${name}-${n++}`, ext);
    used.add(out);
    return out;
  };

  // The machine, in exactly the layout "Save machine" writes.
  const machine = app.machineFiles('machine/');
  files.push(...machine.files);

  const programFile = `program/${unique(state.programName || 'program', '.nc')}`;
  files.push({ name: programFile, data: state.source || '' });

  const subprograms = (state.subprograms || []).map((sub) => {
    const file = `program/subs/${unique(String(sub.name || 'sub').replace(/\.[^.]+$/, ''), '.nc')}`;
    files.push({ name: file, data: sub.text || '' });
    return { id: sub.id, name: sub.name, file };
  });

  const models = app.models.models.map((m) => {
    const file = `models/${unique(m.name, '.stl')}`;
    const pos = m.mesh.geometry.getAttribute('position');
    files.push({ name: file, data: writeSTL(pos.array, { name: m.name }) });
    const o = m.object;
    return {
      name: m.name,
      role: m.role,
      visible: m.visible,
      file,
      position: [o.position.x, o.position.y, o.position.z],
      rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
      scale: [o.scale.x, o.scale.y, o.scale.z],
      ignore: !!m.ignore,
      clearance: Number.isFinite(m.clearance) ? m.clearance : null,
    };
  });

  const stock = {
    shape: state.stock.shape || 'box',
    size: [...state.stock.size],
    origin: [...state.stock.origin],
    rotation: Number(state.stock.rotation) || 0,
    resolution: state.stock.resolution,
    diameter: state.stock.diameter,
    model: null,
  };
  if (state.stock.shape === 'model' && state.stock.model) {
    const file = `stock/${unique(state.stock.model.name, '.stl')}`;
    files.push({ name: file, data: writeSTL(state.stock.model.positions, { name: state.stock.model.name }) });
    stock.model = { name: state.stock.model.name, file };
  }

  files.push({ name: 'library.json', data: JSON.stringify(app.library.toJSON(), null, 2) });

  const camera = app.viewer ? {
    position: app.viewer.camera.position.toArray(),
    target: app.viewer.controls.target.toArray(),
  } : null;

  const project = {
    format: 'mill-sim-project',
    version: PROJECT_VERSION,
    saved: new Date().toISOString(),
    name: state.programName || 'job',
    machine: 'machine/machine.json',
    library: 'library.json',
    program: { name: state.programName, file: programFile, subprograms },
    stock,
    wcs: JSON.parse(JSON.stringify(state.wcs)),
    wcsEdit: state.wcsEdit,
    machineZero: [...state.machineZero],
    gougeTolerance: state.gougeTolerance,
    checks: JSON.parse(JSON.stringify(state.checks)),
    activeAssemblyId: state.activeAssemblyId,
    display: { ...state.display },
    models,
    camera,
  };
  files.unshift({ name: 'project.json', data: JSON.stringify(project, null, 2) });

  files.push({
    name: 'README.txt',
    data: [
      `${project.name} — a Mill-Sim project.`,
      '',
      'project.json  the setup: the stock, the work offsets, where each',
      '              fixture sits, and which file is which.',
      'program/      the NC program and the subprograms it calls.',
      'machine/      the whole machine, as Save machine writes it.',
      'library.json  the cutters, holders and tool table.',
      'models/       fixtures, clamps and reference parts, as STL.',
      '',
      'Open it again with Setup > Project > Open project.',
      '',
    ].join('\n'),
  });

  const stem = safeName(project.name, '');
  return {
    bytes: await writeZip(files),
    name: `${stem || 'job'}-project.zip`,
    summary: {
      program: state.programName,
      subprograms: subprograms.length,
      models: models.length,
      bodies: machine.def.bodies.length,
      tools: app.library.tools.length,
    },
  };
}

/**
 * Read a project back into the app.
 *
 * The order matters: the machine first, because loading one rebuilds the
 * rig and re-reads whatever program is loaded; then the stock it cuts, the
 * fixtures around it, the tools, the offsets, and only then the program,
 * which is interpreted against all of the above.
 *
 * @param {object} app
 * @param {Map<string, Uint8Array>} entries
 */
export async function readProject(app, entries) {
  const raw = entries.get('project.json');
  if (!raw) throw new Error('there is no project.json in it');
  const def = JSON.parse(text(raw));
  if (def.format !== 'mill-sim-project') throw new Error('that zip is not a Mill-Sim project');

  const machineJson = entries.get(def.machine || 'machine/machine.json');
  if (machineJson) {
    await app.applyMachineDefinition(JSON.parse(text(machineJson)), entries, 'the project');
  }

  // Tools before the program: a tool change resolves against this table.
  const lib = entries.get(def.library || 'library.json');
  if (lib) app.library.fromJSON(JSON.parse(text(lib)));

  if (def.stock) {
    const patch = {
      shape: def.stock.shape || 'box',
      size: [...def.stock.size],
      origin: [...def.stock.origin],
      rotation: Number(def.stock.rotation) || 0,
      resolution: def.stock.resolution,
      diameter: def.stock.diameter,
      model: null,
    };
    if (patch.shape === 'model' && def.stock.model && entries.has(def.stock.model.file)) {
      const stl = parseSTL(asBuffer(entries.get(def.stock.model.file)));
      patch.model = {
        name: def.stock.model.name,
        positions: stl.positions,
        triangles: stl.triangles,
        size: patch.size,
      };
    }
    app.setStock(patch);
  }

  app.models.clear();
  for (const m of def.models || []) {
    const data = m.file && entries.get(m.file);
    if (!data) continue;
    const stl = parseSTL(asBuffer(data));
    const model = app.models.add({ name: m.name, positions: stl.positions, role: m.role, recentre: false });
    app.models.setTransform(model, { position: m.position, rotation: m.rotation, scale: m.scale });
    model.ignore = !!m.ignore;
    model.clearance = Number.isFinite(m.clearance) ? m.clearance : null;
    if (m.visible === false) app.models.setVisible(model, false);
  }
  app.refreshFixtures();

  if (def.wcs) app.state.wcs = JSON.parse(JSON.stringify(def.wcs));
  if (def.wcsEdit) app.state.wcsEdit = def.wcsEdit;
  if (Array.isArray(def.machineZero)) app.state.machineZero = def.machineZero.map(Number);
  if (Number.isFinite(def.gougeTolerance)) app.state.gougeTolerance = def.gougeTolerance;
  if (def.checks) {
    Object.assign(app.state.checks, def.checks);
    app.state.checks.parts = { ...app.state.checks.parts, ...(def.checks.parts || {}) };
  }
  if (def.display) Object.assign(app.state.display, def.display);
  app.state.activeAssemblyId = def.activeAssemblyId || null;
  app.applyDisplay();
  app.refreshOrigins();

  app.state.subprograms = (def.program && def.program.subprograms || [])
    .map((sub) => ({
      id: sub.id || `sub_${Math.random().toString(36).slice(2, 8)}`,
      name: sub.name,
      text: entries.has(sub.file) ? text(entries.get(sub.file)) : '',
    }));

  const programFile = def.program && def.program.file;
  const source = programFile && entries.has(programFile) ? text(entries.get(programFile)) : '';
  app.refreshSlots();
  app.loadProgram(source, (def.program && def.program.name) || 'program.nc');

  if (def.camera && app.viewer) {
    app.viewer.camera.position.fromArray(def.camera.position);
    app.viewer.controls.target.fromArray(def.camera.target);
    app.viewer.controls.update();
    app.viewer.invalidate();
  }

  return {
    name: def.name,
    program: def.program && def.program.name,
    subprograms: (def.program && def.program.subprograms || []).length,
    models: (def.models || []).length,
    tools: app.library.tools.length,
    machine: app.machineView.kinematics.name,
  };
}

/** Does this zip look like a project rather than a machine? */
export function isProject(entries) {
  return entries.has('project.json');
}

export { readZip, writeZip };
