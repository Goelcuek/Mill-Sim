// Rendering the stock.
//
// The material is held along X, Y and Z (see sim/triDexel.js), so there is
// no single surface to lift a grid to: the stock is drawn as the closed
// surface its lines describe, which DexelSurface builds block by block as
// the cut changes it. This class is what the app talks to — colours, the
// reference part and its deviation map, the section plane — and passes
// each of them on to the surface.

import * as THREE from 'three';
import { DexelSurface } from './dexelView.js';

const MAX_TOOL_COLORS = 8;

export class StockView {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'stock';
    this.stock = null;
    this.lastVersion = -1;
    /**
     * One colour per cutter, for the question this answers: which tool left
     * this face?
     *
     * That question is only answered if the colours can be told apart at a
     * glance, on a shaded surface, next to raw stock — so these are eight
     * hues spread right round the wheel at a similar lightness, rather than
     * eight shades of the same steel. Blue against orange, green against
     * purple: pairs that stay distinct for the commonest colour blindness
     * too, and none of them close to the raw stock grey.
     */
    this.toolColors = [
      new THREE.Color('#5b9bd5'), new THREE.Color('#e8933f'), new THREE.Color('#45ab84'),
      new THREE.Color('#a06cc8'), new THREE.Color('#dcbb46'), new THREE.Color('#d96b63'),
      new THREE.Color('#4cb9c9'), new THREE.Color('#93a844'),
    ];
    /** What a machined face looks like when the tool is not being named. */
    this.cutColor = new THREE.Color('#d5dde8');
    /** The reference part, when there is one, and the deviation map's settings. */
    this.target = null;
    this.devTolerance = 0.02;
    /** The section plane, or null: {axis 0|1|2, value, flip}. */
    this.section = null;
    /** What the inside of the part looks like through a section. */
    this.capColor = new THREE.Color('#c4705a');
  }

  /** Attach to a stock, rebuilding all GPU resources. */
  setStock(stock) {
    this.dispose();
    this.stock = stock;
    if (!stock) return;
    this.surface = new DexelSurface(stock, {
      stockColor: new THREE.Color(this.stockHex || '#8e97a6'),
      cutColor: this.cutColor,
      toolColors: this.toolColors,
      capColor: this.capColor,
    });
    this.surface.uniforms.uShowTools.value = this.showTools === false ? 0 : 1;
    this.surface.setDeviation(this.deviationState());
    this.surface.setSection(this.section);
    this.group.add(this.surface.group);
  }

  /**
   * Bring the picture up to the cut. Blocks still waiting from the last
   * frames are made even when nothing new was cut, so the picture catches
   * up with the run.
   */
  sync(force = false, budget) {
    const stock = this.stock;
    if (!this.surface) return false;
    if (!force && stock.version === this.lastVersion && !this.surface.pending) return false;
    this.lastVersion = stock.version;
    stock.clearDirty();
    return this.surface.sync(force, budget);
  }

  /** The shade a machined face takes when the tool is not being named. */
  setCutColor(hex) {
    if (this.surface) this.surface.uniforms.uCutColor.value.set(hex);
  }

  setStockColor(hex) {
    this.stockHex = hex;
    if (this.surface) this.surface.uniforms.uStockColor.value.set(hex);
  }

  setToolColor(index, hex) {
    if (index >= 0 && index < MAX_TOOL_COLORS) this.toolColors[index].set(hex);
  }

  /** Colour machined faces per tool, or use a single machined colour. */
  setShowToolColors(on) {
    this.showTools = !!on;
    if (this.surface) this.surface.uniforms.uShowTools.value = on ? 1 : 0;
  }

  /** Is the reference map drawn on this stock's grid? A stale one is not. */
  targetFits() {
    const t = this.target;
    return !!(t && this.stock && t.map && t.map.length === this.stock.nx * this.stock.ny);
  }

  /** The reference part to measure against, and how far a cut may pass it. */
  setTarget(target, tolerance = this.devTolerance) {
    this.target = target || null;
    this.devTolerance = Math.max(0, Number(tolerance) || 0);
    if (this.surface) this.surface.setDeviation(this.deviationState());
  }

  /** What the deviation map is to show, from the settings here. */
  deviationState() {
    return {
      mode: !!this.devMode,
      target: this.targetFits() ? this.target : null,
      tolerance: this.devTolerance,
      range: this.devRange || 0.5,
    };
  }

  /**
   * Colour the stock by how far it stands from the reference part.
   * @param {boolean} on
   * @param {number} [range] mm of deviation that takes the full colour
   */
  setDeviationMode(on, range) {
    this.devMode = !!on;
    if (Number.isFinite(range) && range > 0) this.devRange = range;
    if (this.surface) this.surface.setDeviation(this.deviationState());
  }

  /**
   * Cut the stock open on a plane square to X, Y or Z, keeping the side
   * below it — or above it, flipped. The part is closed, so what shows
   * through the opening is its own inside, drawn as the cut face.
   *
   * @param {null | {axis:0|1|2, value:number, flip?:boolean}} plane
   */
  setSection(plane) {
    this.section = plane || null;
    if (this.surface) this.surface.setSection(this.section);
  }

  setVisible(v) { this.group.visible = v; }

  /** Is part of the picture still waiting to be drawn? */
  get pending() { return !!(this.surface && this.surface.pending); }

  boundingBox() {
    if (!this.stock) return new THREE.Box3();
    const s = this.stock;
    return new THREE.Box3(
      new THREE.Vector3(s.origin[0], s.origin[1], s.base),
      new THREE.Vector3(s.origin[0] + s.size[0], s.origin[1] + s.size[1], s.top),
    );
  }

  dispose() {
    if (this.surface) {
      this.surface.dispose();
      this.group.remove(this.surface.group);
      this.surface = null;
    }
    this.lastVersion = -1;
  }
}
