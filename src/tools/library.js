// The tool library: tools, holders and the assemblies that pair them.
//
// Everything is plain JSON, kept in localStorage and exportable as a file,
// so a shop can build a library once and carry it between machines.

import { defaultTools, makeTool, buildTool } from './toolDefs.js';
import { defaultHolders, makeHolder, buildHolder } from './holderDefs.js';
import { buildAssembly, makeAssembly } from './assembly.js';
import { uid } from '../core/util.js';

const STORAGE_KEY = 'millsim.library.v1';
export const LIBRARY_VERSION = 1;

export class ToolLibrary {
  constructor() {
    this.tools = [];
    this.holders = [];
    this.assemblies = [];
    this.listeners = new Set();
    this.cache = new Map();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(what) {
    this.cache.clear();
    for (const fn of this.listeners) fn(what, this);
  }

  // ---- defaults & persistence -------------------------------------------

  loadDefaults() {
    this.tools = defaultTools();
    this.holders = defaultHolders();
    this.assemblies = [
      makeAssembly({ id: 'asm_face', name: 'T1 · 50 face mill', toolId: 'tool_face50', holderId: 'hld_shell', stickout: 40, number: 1 }),
      makeAssembly({ id: 'asm_10flat', name: 'T2 · 10 flat', toolId: 'tool_flat10', holderId: 'hld_er32', stickout: 42, number: 2 }),
      makeAssembly({ id: 'asm_6flat', name: 'T3 · 6 flat', toolId: 'tool_flat6', holderId: 'hld_shrink', stickout: 30, number: 3 }),
      makeAssembly({ id: 'asm_6ball', name: 'T4 · 6 ball', toolId: 'tool_ball6', holderId: 'hld_shrink', stickout: 32, number: 4 }),
      makeAssembly({ id: 'asm_8bull', name: 'T5 · 8 bull R1', toolId: 'tool_bull8', holderId: 'hld_er32', stickout: 34, number: 5 }),
      makeAssembly({ id: 'asm_cham', name: 'T6 · 90° chamfer', toolId: 'tool_cham', holderId: 'hld_er32', stickout: 26, number: 6 }),
      makeAssembly({ id: 'asm_drill', name: 'T7 · 5 drill', toolId: 'tool_drill5', holderId: 'hld_drill', stickout: 45, number: 7 }),
      makeAssembly({ id: 'asm_taper', name: 'T8 · 3° taper ball', toolId: 'tool_taper', holderId: 'hld_slim', stickout: 30, number: 8 }),
    ];
    this.emit('reset');
    return this;
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      return true;
    } catch (err) {
      return false;
    }
  }

  restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      return this.fromJSON(data);
    } catch (err) {
      return false;
    }
  }

  toJSON() {
    return {
      version: LIBRARY_VERSION,
      exported: new Date().toISOString(),
      tools: this.tools,
      holders: this.holders,
      assemblies: this.assemblies,
    };
  }

  fromJSON(data, { merge = false } = {}) {
    if (!data || typeof data !== 'object') return false;
    const tools = Array.isArray(data.tools) ? data.tools.map((t) => makeTool(t)) : [];
    const holders = Array.isArray(data.holders) ? data.holders.map((h) => makeHolder(h)) : [];
    const assemblies = Array.isArray(data.assemblies) ? data.assemblies.map((a) => makeAssembly(a)) : [];
    if (!tools.length && !holders.length && !assemblies.length) return false;

    if (merge) {
      const byId = (list) => new Set(list.map((x) => x.id));
      const haveT = byId(this.tools);
      const haveH = byId(this.holders);
      const haveA = byId(this.assemblies);
      this.tools.push(...tools.map((t) => (haveT.has(t.id) ? { ...t, id: uid('tool') } : t)));
      this.holders.push(...holders.map((h) => (haveH.has(h.id) ? { ...h, id: uid('hld') } : h)));
      this.assemblies.push(...assemblies.map((a) => (haveA.has(a.id) ? { ...a, id: uid('asm') } : a)));
    } else {
      this.tools = tools;
      this.holders = holders;
      this.assemblies = assemblies;
    }
    this.emit('load');
    return true;
  }

  // ---- lookups -----------------------------------------------------------

  tool(id) { return this.tools.find((t) => t.id === id) || null; }
  holder(id) { return this.holders.find((h) => h.id === id) || null; }
  assembly(id) { return this.assemblies.find((a) => a.id === id) || null; }
  assemblyByNumber(n) { return this.assemblies.find((a) => Number(a.number) === Number(n)) || null; }

  /** Build (and cache) the geometry for an assembly. */
  build(assemblyId, machine = {}) {
    const key = `${assemblyId}|${machine.spindleDiameter || 0}|${machine.spindleLength || 0}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const asm = this.assembly(assemblyId);
    if (!asm) return null;
    const built = buildAssembly(asm, this.tool(asm.toolId), this.holder(asm.holderId), machine);
    this.cache.set(key, built);
    return built;
  }

  /** Build a throwaway assembly, used by the parametric editor preview. */
  buildDraft(toolDef, holderDef, stickout, machine = {}) {
    return buildAssembly({ stickout }, toolDef, holderDef, machine);
  }

  // ---- mutation ----------------------------------------------------------

  addTool(patch = {}) {
    const t = makeTool({ name: 'New tool', ...patch });
    this.tools.push(t);
    this.emit('tools');
    return t;
  }

  updateTool(id, patch) {
    const i = this.tools.findIndex((t) => t.id === id);
    if (i < 0) return null;
    this.tools[i] = { ...this.tools[i], ...patch, id };
    this.emit('tools');
    return this.tools[i];
  }

  removeTool(id) {
    this.tools = this.tools.filter((t) => t.id !== id);
    for (const a of this.assemblies) if (a.toolId === id) a.toolId = '';
    this.emit('tools');
  }

  duplicateTool(id) {
    const t = this.tool(id);
    if (!t) return null;
    const copy = makeTool({ ...t, id: undefined, name: `${t.name} copy` });
    this.tools.push(copy);
    this.emit('tools');
    return copy;
  }

  addHolder(patch = {}) {
    const h = makeHolder({ name: 'New holder', ...patch });
    this.holders.push(h);
    this.emit('holders');
    return h;
  }

  updateHolder(id, patch) {
    const i = this.holders.findIndex((h) => h.id === id);
    if (i < 0) return null;
    this.holders[i] = { ...this.holders[i], ...patch, id };
    this.emit('holders');
    return this.holders[i];
  }

  removeHolder(id) {
    this.holders = this.holders.filter((h) => h.id !== id);
    for (const a of this.assemblies) if (a.holderId === id) a.holderId = '';
    this.emit('holders');
  }

  duplicateHolder(id) {
    const h = this.holder(id);
    if (!h) return null;
    const copy = makeHolder({ ...h, id: undefined, name: `${h.name} copy` });
    this.holders.push(copy);
    this.emit('holders');
    return copy;
  }

  addAssembly(patch = {}) {
    const next = this.assemblies.reduce((m, a) => Math.max(m, Number(a.number) || 0), 0) + 1;
    const a = makeAssembly({ name: `T${next} · new assembly`, number: next, toolId: this.tools[0] ? this.tools[0].id : '', holderId: this.holders[0] ? this.holders[0].id : '', ...patch });
    this.assemblies.push(a);
    this.emit('assemblies');
    return a;
  }

  updateAssembly(id, patch) {
    const i = this.assemblies.findIndex((a) => a.id === id);
    if (i < 0) return null;
    this.assemblies[i] = { ...this.assemblies[i], ...patch, id };
    this.emit('assemblies');
    return this.assemblies[i];
  }

  removeAssembly(id) {
    this.assemblies = this.assemblies.filter((a) => a.id !== id);
    this.emit('assemblies');
  }

  /** Validation report shown in the Tools panel. */
  audit(machine = {}) {
    const issues = [];
    const numbers = new Map();
    for (const a of this.assemblies) {
      if (!a.toolId || !this.tool(a.toolId)) issues.push({ level: 'error', text: `${a.name}: no cutter assigned.` });
      if (a.holderId && !this.holder(a.holderId)) issues.push({ level: 'error', text: `${a.name}: holder is missing.` });
      const n = Number(a.number);
      if (!n) issues.push({ level: 'warning', text: `${a.name}: no T number, so no G-code tool change can select it.` });
      else if (numbers.has(n)) issues.push({ level: 'error', text: `T${n} is used by both "${numbers.get(n)}" and "${a.name}".` });
      else numbers.set(n, a.name);

      const built = this.build(a.id, machine);
      if (built) for (const w of built.warnings) issues.push({ level: 'warning', text: `${a.name}: ${w}` });
    }
    return issues;
  }
}

export { buildTool, buildHolder, makeTool, makeHolder, makeAssembly };
