// The tool library: tools, holders and the assemblies that pair them.
//
// Everything is plain JSON, kept in localStorage and exportable as a file,
// so a shop can build a library once and carry it between machines.

import { defaultTools, makeTool, buildTool } from './toolDefs.js';
import { defaultHolders, makeHolder, buildHolder } from './holderDefs.js';
import { buildAssembly, makeAssembly } from './assembly.js';
import { fromFusion } from './fusionLibrary.js';
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
    const d = builtIn();
    this.tools = d.tools;
    this.holders = d.holders;
    this.assemblies = d.assemblies;
    this.emit('reset');
    return this;
  }

  /**
   * Put back whichever built-ins are missing, without touching anything the
   * user added.
   *
   * The destructive reset is the wrong tool for the usual case — a library
   * that has lost its cutters but kept the tools someone spent an afternoon
   * entering — so this one matches on id and adds only what is absent.
   *
   * @returns {number} how many things were put back
   */
  mergeDefaults() {
    const d = builtIn();
    let added = 0;
    const fill = (mine, theirs) => {
      const have = new Set(mine.map((x) => x.id));
      for (const item of theirs) if (!have.has(item.id)) { mine.push(item); added++; }
    };
    fill(this.tools, d.tools);
    fill(this.holders, d.holders);
    fill(this.assemblies, d.assemblies);
    if (added) this.emit('reset');
    return added;
  }

  /**
   * What a stored library is missing wholesale.
   *
   * A library that comes back with assemblies but no cutters is not a
   * library the user built; it is one that lost a category somewhere, and
   * booting into it silently leaves every T number pointing at nothing with
   * no way out but the destructive reset. Filling an empty category from
   * the built-ins is safe — nothing of theirs is overwritten — and it is
   * what the reset would have done anyway.
   *
   * @returns {string[]} the categories that had to be refilled
   */
  repair() {
    const d = builtIn();
    const back = [];
    if (!this.tools.length) { this.tools = d.tools; back.push('cutters'); }
    if (!this.holders.length) { this.holders = d.holders; back.push('holders'); }
    if (!this.assemblies.length) { this.assemblies = d.assemblies; back.push('the tool table'); }
    if (back.length) this.emit('repair');
    return back;
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
      const stats = this.fromJSON(data);
      if (!stats) return false;
      /** Categories that were empty in storage and had to be put back. */
      this.repaired = this.repair();
      return stats;
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
    let tools = Array.isArray(data.tools) ? data.tools.map((t) => makeTool(t)) : [];
    let holders = Array.isArray(data.holders) ? data.holders.map((h) => makeHolder(h)) : [];
    let assemblies = Array.isArray(data.assemblies) ? data.assemblies.map((a) => makeAssembly(a)) : [];

    // Nothing of ours in the file: it may still be a library, just one
    // written by somebody else. A shop's tools arrive as a Fusion export
    // far more often than as one of ours, so that is read directly.
    if (!tools.length && !holders.length && !assemblies.length) {
      const foreign = fromFusion(data);
      if (foreign) ({ tools, holders, assemblies } = foreign);
    }
    if (!tools.length && !holders.length && !assemblies.length) return false;

    if (merge) {
      const byId = (list) => new Set(list.map((x) => x.id));
      const haveT = byId(this.tools);
      const haveH = byId(this.holders);
      const haveA = byId(this.assemblies);
      const remap = new Map();
      for (const t of tools) {
        if (!haveT.has(t.id)) continue;
        const fresh = uid('tool');
        remap.set(t.id, fresh);
        t.id = fresh;
      }
      const remapH = new Map();
      for (const h of holders) {
        if (!haveH.has(h.id)) continue;
        const fresh = uid('hld');
        remapH.set(h.id, fresh);
        h.id = fresh;
      }
      // Two libraries both numbered from T1 is the normal case, and an
      // ambiguous tool table is worse than a renumbered one: the incoming
      // assemblies move up to the first free numbers rather than shadowing
      // what is already there.
      const used = new Set(this.assemblies.map((a) => Number(a.number)));
      let next = 1;
      for (const a of assemblies) {
        if (haveA.has(a.id)) a.id = uid('asm');
        if (remap.has(a.toolId)) a.toolId = remap.get(a.toolId);
        if (remapH.has(a.holderId)) a.holderId = remapH.get(a.holderId);
        if (used.has(Number(a.number))) {
          while (used.has(next)) next++;
          a.number = next;
          a.name = a.name.replace(/^T\d+\s*\u00b7\s*/, `T${next} \u00b7 `);
        }
        used.add(Number(a.number));
      }
      this.tools.push(...tools);
      this.holders.push(...holders);
      this.assemblies.push(...assemblies);
    } else {
      this.tools = tools;
      this.holders = holders;
      this.assemblies = assemblies;
    }
    this.emit('load');
    return { tools: tools.length, holders: holders.length, assemblies: assemblies.length };
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


/**
 * The library Mill-Sim ships with, freshly made each call.
 *
 * Handing out the same objects twice would let an edit to the restored
 * copy reach back into the defaults, so this is a factory rather than a
 * constant. The ids are fixed on purpose: that is what lets a library
 * that has lost its cutters be refilled without the assemblies losing
 * track of which cutter they meant.
 */
function builtIn() {
  return {
    tools: defaultTools(),
    holders: defaultHolders(),
    assemblies: [
      makeAssembly({ id: 'asm_face', name: 'T1 \u00b7 50 face mill', toolId: 'tool_face50', holderId: 'hld_shell', stickout: 40, number: 1 }),
      makeAssembly({ id: 'asm_10flat', name: 'T2 \u00b7 10 flat', toolId: 'tool_flat10', holderId: 'hld_er32', stickout: 42, number: 2 }),
      makeAssembly({ id: 'asm_6flat', name: 'T3 \u00b7 6 flat', toolId: 'tool_flat6', holderId: 'hld_shrink', stickout: 30, number: 3 }),
      makeAssembly({ id: 'asm_6ball', name: 'T4 \u00b7 6 ball', toolId: 'tool_ball6', holderId: 'hld_shrink', stickout: 32, number: 4 }),
      makeAssembly({ id: 'asm_8bull', name: 'T5 \u00b7 8 bull R1', toolId: 'tool_bull8', holderId: 'hld_er32', stickout: 34, number: 5 }),
      makeAssembly({ id: 'asm_cham', name: 'T6 \u00b7 90\u00b0 chamfer', toolId: 'tool_cham', holderId: 'hld_er32', stickout: 26, number: 6 }),
      makeAssembly({ id: 'asm_drill', name: 'T7 \u00b7 5 drill', toolId: 'tool_drill5', holderId: 'hld_drill', stickout: 45, number: 7 }),
      makeAssembly({ id: 'asm_taper', name: 'T8 \u00b7 3\u00b0 taper ball', toolId: 'tool_taper', holderId: 'hld_slim', stickout: 30, number: 8 }),
    ],
  };
}
