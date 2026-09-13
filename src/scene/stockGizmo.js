// Dragging the stock where it belongs.
//
// Typing "min X −60" is exact and nobody thinks in it. Clamping a billet is
// a physical act — it goes *there*, turned *that* way — so the block gets
// the same handles the fixtures have: arrows to slide it and a ring to turn
// it, with the numbers on the Stock page following along.
//
// Two things make this less trivial than attaching a gizmo to a mesh. The
// stock is not a mesh: it is a field of columns whose grid has to be rebuilt
// when it moves, which is far too expensive to do per frame — so a drag
// moves a preview and only the release rebuilds. And the ring only turns
// about Z: material runs in columns from the base upwards, so a block tipped
// about X or Y is a solid this model cannot hold. Tilting the part is what
// the machine's rotaries are for, and the handles say so by not being there.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export class StockGizmo {
  /**
   * @param {import('./viewer.js').Viewer} viewer
   * @param {{frame:() => THREE.Object3D,
   *          onPreview:(move:number[], turn:number) => void,
   *          onCommit:(move:number[], turn:number) => void,
   *          onChange?:() => void}} opts
   */
  constructor(viewer, opts) {
    this.viewer = viewer;
    this.opts = opts;
    this.mode = 'translate';

    /** What the handles are attached to: a stand-in for the block. */
    this.proxy = new THREE.Object3D();
    this.proxy.name = 'stock-handle';

    this.gizmo = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.gizmo.setSpace('world');
    this.gizmo.addEventListener('dragging-changed', (e) => {
      viewer.controls.enabled = !e.value;
      if (e.value) return;
      const { move, turn } = this.delta();
      if (move[0] || move[1] || move[2] || turn) this.opts.onCommit(move, turn);
      else this.opts.onPreview([0, 0, 0], 0);
    });
    this.gizmo.addEventListener('objectChange', () => {
      const { move, turn } = this.delta();
      this.opts.onPreview(move, turn);
      if (this.opts.onChange) this.opts.onChange(move, turn);
      viewer.invalidate();
    });

    const helper = this.gizmo.getHelper ? this.gizmo.getHelper() : this.gizmo;
    this.helper = helper;
    helper.visible = false;
    viewer.scene.add(helper);
  }

  /** Is the pointer on a handle, or pulling one? */
  get busy() { return !!(this.gizmo.dragging || this.gizmo.axis); }
  get attached() { return !!this.gizmo.object; }

  /** How far the handles have been pulled since they were put on the block. */
  delta() {
    const p = this.proxy.position;
    const s = this.start;
    if (!s) return { move: [0, 0, 0], turn: 0 };
    return {
      move: [p.x - s.position[0], p.y - s.position[1], p.z - s.position[2]],
      turn: this.proxy.rotation.z - s.rotation,
    };
  }

  /**
   * Put the handles on the block.
   *
   * @param {{centre:number[], rotation:number}} at the middle of the block
   *   in work coordinates, and how far it is already turned, in radians.
   */
  attach(at) {
    const frame = this.opts.frame() || this.viewer.scene;
    if (this.proxy.parent !== frame) frame.add(this.proxy);
    this.proxy.position.set(at.centre[0], at.centre[1], at.centre[2]);
    this.proxy.rotation.set(0, 0, at.rotation || 0);
    this.proxy.updateMatrixWorld(true);
    this.start = { position: [...at.centre], rotation: at.rotation || 0 };
    this.gizmo.attach(this.proxy);
    this.applyMode();
    this.helper.visible = true;
    this.viewer.invalidate();
  }

  detach() {
    this.gizmo.detach();
    this.helper.visible = false;
    this.start = null;
    this.viewer.invalidate();
  }

  setMode(mode) {
    this.mode = mode === 'rotate' ? 'rotate' : 'translate';
    this.applyMode();
    this.viewer.invalidate();
  }

  applyMode() {
    this.gizmo.setMode(this.mode);
    // Turning in the vice is real; tipping the block is not something a
    // field of vertical columns can be, so those two rings are not offered.
    const turning = this.mode === 'rotate';
    this.gizmo.showX = !turning;
    this.gizmo.showY = !turning;
    this.gizmo.showZ = true;
  }
}
