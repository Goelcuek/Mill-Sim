// Picking points in the viewport.
//
// This is what makes "move this from here to there" and "put zero on that
// corner" possible. A pick is a short conversation: the caller asks for one
// or two points, the user clicks them, the caller gets world coordinates.
//
// Snapping is what makes it usable. A raw surface hit is almost never what
// somebody means — they mean *that corner*, or the middle of that face. So
// every candidate near the cursor is projected to screen space and the
// closest one within a few pixels wins, ranked so a corner beats an edge
// and an edge beats a face.

import * as THREE from 'three';

/** Screen-space radius, in CSS pixels, within which a candidate snaps. */
const SNAP_RADIUS = 18;

/** Higher wins when two candidates are equally close. */
const RANK = { corner: 4, vertex: 4, origin: 5, edge: 3, centre: 2, face: 2, surface: 0 };

export const SNAP_COLORS = {
  corner: 0xff9f0a,
  vertex: 0xff9f0a,
  origin: 0xaf52de,
  edge: 0x30d158,
  centre: 0x0a84ff,
  face: 0x0a84ff,
  surface: 0x8e8e93,
};

export class PickController {
  /**
   * @param {import('./viewer.js').Viewer} viewer
   * @param {{stock:() => object, models:() => object, machine:() => object,
   *          origins:() => Array<{name:string, point:number[]}>,
   *          workFrame?:() => object, bodies?:() => object[]}} ctx
   *
   * Everything this controller produces is in **work coordinates**, because
   * that is what a work offset, a stock origin and a model position are all
   * measured in. In part-only view the work frame is the scene, so the two
   * are the same; in full-machine view the work frame rides the table and
   * they are not. Hence `workFrame`: the ray is carried into it before
   * anything is tested, and the markers are parented to it so a point drawn
   * at (0,0,0) lands on the part's zero rather than the floor of the shop.
   *
   * A request may ask for `space: 'world'` instead. Assembling a machine is
   * the case: the two points being mated are on castings, not on the job,
   * and the answer has nothing to do with where the part happens to be
   * clamped. Then the frame is the scene and `bodies: true` adds the
   * machine's own geometry to what can be hit.
   */
  constructor(viewer, ctx) {
    this.viewer = viewer;
    this.ctx = ctx;
    this.request = null;
    this.points = [];
    this.hover = null;
    /** 0/1/2 while the second point is locked to X/Y/Z, else null. */
    this.axisLock = null;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    /** Work ray: the pointer ray carried into work coordinates. */
    this.workRay = new THREE.Ray();
    this.invWork = new THREE.Matrix4();
    this.tmpVec = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = 'pick';
    viewer.scene.add(this.group);

    this.buildMarkers();
    this.bind();

    /** Called with ({active, step, hover, points}) whenever anything changes. */
    this.onUpdate = () => {};
  }

  buildMarkers() {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x0a84ff, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    marker.renderOrder = 990;
    marker.visible = false;
    this.marker = marker;
    this.group.add(marker);

    const anchor = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xff375f, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    anchor.renderOrder = 990;
    anchor.visible = false;
    this.anchor = anchor;
    this.group.add(anchor);

    const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const band = new THREE.Line(geom, new THREE.LineDashedMaterial({
      color: 0xff375f, dashSize: 3, gapSize: 2, depthTest: false, transparent: true, opacity: 0.9,
    }));
    band.renderOrder = 989;
    band.visible = false;
    this.band = band;
    this.group.add(band);
  }

  bind() {
    const dom = this.viewer.renderer.domElement;
    this.dom = dom;
    let downAt = null;

    this.onPointerDown = (e) => {
      if (!this.request) return;
      downAt = { x: e.clientX, y: e.clientY };
    };

    this.onPointerMove = (e) => {
      if (!this.request) return;
      this.updateHover(e);
    };

    this.onPointerUp = (e) => {
      if (!this.request || !downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return;             // that was an orbit, not a click
      this.updateHover(e);
      if (this.hover) this.commit();
    };

    this.onKeyDown = (e) => {
      if (!this.request) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
        return;
      }
      // Lock the move to one axis, the way you would say "up 40" rather
      // than hunting for a point that happens to be straight above.
      const axis = { x: 0, X: 0, y: 1, Y: 1, z: 2, Z: 2 }[e.key];
      if (axis !== undefined && this.points.length) {
        e.preventDefault();
        this.axisLock = this.axisLock === axis ? null : axis;
        if (this.lastEvent) this.updateHover(this.lastEvent);
        else this.emit();
      }
    };

    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /**
   * Ask the user for points.
   *
   * @param {{steps:number, title:string, hints:string[],
   *          onDone:(points:number[][]) => void, onCancel?:() => void}} req
   */
  begin(req) {
    this.cancel(true);
    this.request = req;
    // Markers are drawn in the frame the request works in, so a point at
    // the origin lands where the numbers say it does.
    const frame = this.frameObject();
    if (this.group.parent !== (frame || this.viewer.scene)) {
      (frame || this.viewer.scene).add(this.group);
    }
    this.points = [];
    this.hover = null;
    this.axisLock = null;
    this.lastEvent = null;
    this.dom.style.cursor = 'crosshair';
    this.emit();
  }

  /** The object work coordinates are expressed in, or null for world. */
  frameObject() {
    if (this.request && this.request.space === 'world') return null;
    return (this.ctx.workFrame && this.ctx.workFrame()) || null;
  }

  cancel(silent = false) {
    const req = this.request;
    this.request = null;
    this.points = [];
    this.hover = null;
    this.axisLock = null;
    this.marker.visible = false;
    this.anchor.visible = false;
    this.band.visible = false;
    if (this.dom) this.dom.style.cursor = '';
    this.viewer.invalidate();
    if (req && req.onCancel && !silent) req.onCancel();
    if (!silent) this.emit();
  }

  get active() { return !!this.request; }

  emit() {
    this.onUpdate({
      active: this.active,
      request: this.request,
      step: this.points.length,
      points: this.points,
      hover: this.hover,
      axisLock: this.axisLock,
    });
  }

  commit() {
    this.points.push(this.hover.point.slice());
    if (this.points.length >= this.request.steps) {
      const req = this.request;
      const pts = this.points;
      this.request = null;
      this.points = [];
      this.hover = null;
      this.axisLock = null;
      this.marker.visible = false;
      this.anchor.visible = false;
      this.band.visible = false;
      this.dom.style.cursor = '';
      this.emit();
      req.onDone(pts);
      this.viewer.invalidate();
      return;
    }
    // First of two: leave an anchor behind and start the rubber band.
    this.anchor.visible = true;
    this.anchor.position.fromArray(this.points[0]);
    this.emit();
    this.viewer.invalidate();
  }

  /**
   * The pointer ray, in both frames.
   *
   * `raycaster` stays in world coordinates because that is what three.js
   * intersection tests expect; `workRay` is the same ray carried into work
   * coordinates, which is where the stock heightmap lives.
   */
  rayFor(event) {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.viewer.camera);

    const frame = this.frameObject();
    if (frame) {
      frame.updateWorldMatrix(true, false);
      this.invWork.copy(frame.matrixWorld).invert();
    } else {
      this.invWork.identity();
    }
    this.workRay.copy(this.raycaster.ray).applyMatrix4(this.invWork);
    this.workRay.direction.normalize();
    return { rect, screen: { x: event.clientX - rect.left, y: event.clientY - rect.top } };
  }

  /** A world point brought into work coordinates. */
  toWork(point) {
    this.tmpVec.set(point[0], point[1], point[2]).applyMatrix4(this.invWork);
    return [this.tmpVec.x, this.tmpVec.y, this.tmpVec.z];
  }

  /** A work point projected to the screen, for snap ranking. */
  projectWork(point, out) {
    const frame = this.frameObject();
    out.set(point[0], point[1], point[2]);
    if (frame) out.applyMatrix4(frame.matrixWorld);
    return out.project(this.viewer.camera);
  }

  updateHover(event) {
    this.lastEvent = event;
    const { rect, screen } = this.rayFor(event);
    let hit = this.findPoint(screen, rect);

    // With an axis locked, only the component along that axis survives, so
    // the destination stays exactly in line with where the move started.
    if (hit && this.axisLock !== null && this.points.length) {
      const a = this.points[0];
      const p = a.slice();
      p[this.axisLock] = hit.point[this.axisLock];
      hit = { ...hit, point: p, kind: hit.kind === 'surface' ? 'surface' : hit.kind };
    }
    this.hover = hit;

    if (hit) {
      const scale = this.markerScale(hit.point);
      this.marker.visible = true;
      this.marker.position.fromArray(hit.point);
      this.marker.scale.setScalar(scale);
      this.marker.material.color.setHex(SNAP_COLORS[hit.kind] || SNAP_COLORS.surface);
      this.anchor.scale.setScalar(scale);

      if (this.points.length === 1) {
        const a = this.points[0];
        const pos = this.band.geometry.attributes.position;
        pos.setXYZ(0, a[0], a[1], a[2]);
        pos.setXYZ(1, hit.point[0], hit.point[1], hit.point[2]);
        pos.needsUpdate = true;
        this.band.geometry.computeBoundingSphere();
        this.band.computeLineDistances();
        this.band.visible = true;
      }
    } else {
      this.marker.visible = false;
      this.band.visible = false;
    }
    this.viewer.invalidate();
    this.emit();
  }

  /** Keep the marker a constant size on screen. */
  markerScale(point) {
    const v = new THREE.Vector3(...point);
    const frame = this.frameObject();
    if (frame) v.applyMatrix4(frame.matrixWorld);
    const d = this.viewer.camera.position.distanceTo(v);
    return Math.max(d * 0.005, 0.15);
  }

  /**
   * Find the best point under the cursor: the closest snap candidate within
   * the screen radius, else the raw surface hit.
   */
  findPoint(screen, rect) {
    const free = this.freeHit();
    const candidates = this.candidates(free);

    let best = null;
    const v = new THREE.Vector3();
    for (const c of candidates) {
      this.projectWork(c.point, v);
      if (v.z > 1) continue;                       // behind the camera
      const sx = ((v.x + 1) / 2) * rect.width;
      const sy = ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(sx - screen.x, sy - screen.y);
      if (d > SNAP_RADIUS) continue;
      const rank = RANK[c.kind] ?? 0;
      if (!best || rank > best.rank || (rank === best.rank && d < best.d)) {
        best = { ...c, d, rank };
      }
    }
    if (best) return { point: best.point, kind: best.kind, label: best.label };
    return free;
  }

  /** The unsnapped point under the cursor. */
  freeHit() {
    const r = this.workRay;
    const origin = [r.origin.x, r.origin.y, r.origin.z];
    const dir = [r.direction.x, r.direction.y, r.direction.z];
    let best = null;
    // Mating castings has nothing to do with the job: hitting the stock or
    // a clamp while assembling a machine is never what anyone meant.
    const assembling = !!(this.request && this.request.bodies);

    const stock = assembling ? null : this.ctx.stock();
    if (stock) {
      const hit = stock.raycast(origin, dir);
      if (hit && (!best || hit.distance < best.distance)) {
        best = { point: hit.point, kind: 'surface', label: 'stock', distance: hit.distance };
      }
    }

    const meshes = [];
    const models = assembling ? null : this.ctx.models();
    if (models && models.models.length) {
      for (const m of models.models) if (m.visible) meshes.push(m.mesh);
    }
    // The machine itself is a surface like any other. In full-machine view
    // the table, the trunnion and the castings are exactly what somebody
    // means when they click "there" to put the stock down; leaving them out
    // dropped the point through the machine onto a bare plane instead.
    if (this.ctx.bodies) {
      for (const mesh of this.ctx.bodies()) meshes.push(mesh);
    }
    if (meshes.length) {
      const hits = this.raycaster.intersectObjects(meshes, false);
      if (hits.length && (!best || hits[0].distance < best.distance)) {
        const h = hits[0];
        best = {
          point: this.toWork([h.point.x, h.point.y, h.point.z]),
          kind: 'surface',
          label: h.object.name || 'model',
          distance: h.distance,
          intersection: h,
        };
      }
    }

    if (best) return best;

    // Nothing solid under the cursor. Once a move has an anchor, fall back
    // to the plane through that anchor facing the camera: clicking in mid
    // air then means "level with where I started", which is predictable.
    // Falling through to the table plane instead would silently throw the
    // destination metres away.
    if (this.points.length) {
      const a = this.points[0];
      const n = this.viewer.camera.getWorldDirection(new THREE.Vector3());
      n.transformDirection(this.invWork);
      const denom = n.x * dir[0] + n.y * dir[1] + n.z * dir[2];
      if (Math.abs(denom) > 1e-9) {
        const t = (n.x * (a[0] - origin[0]) + n.y * (a[1] - origin[1]) + n.z * (a[2] - origin[2])) / denom;
        if (t > 0) {
          return {
            point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
            kind: 'surface',
            label: 'in line with the start point',
            distance: t,
          };
        }
      }
    }

    // Otherwise the table plane, so there is always somewhere to click.
    const machine = this.ctx.machine();
    const planeZ = machine && machine.table ? machine.table.z : 0;
    if (Math.abs(dir[2]) > 1e-9) {
      const t = (planeZ - origin[2]) / dir[2];
      if (t > 0) {
        return {
          point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, planeZ],
          kind: 'surface',
          label: 'table plane',
          distance: t,
        };
      }
    }
    return null;
  }

  /** Snap candidates worth testing for this ray. */
  candidates(free) {
    const out = [];
    const assembling = !!(this.request && this.request.bodies);

    if (!assembling) {
      const stock = this.ctx.stock();
      if (stock) {
        for (const s of stock.snapPoints()) out.push({ ...s, label: 'stock' });
        // The rim of whatever has been cut near the cursor. This is what
        // makes a bore measurable: the wall of one is a single column wide,
        // so its top edge is the only part of it worth pointing at.
        if (free && free.label === 'stock') {
          const rim = stock.rimNear(free.point[0], free.point[1]);
          if (rim) out.push({ point: rim.point, kind: 'edge', label: 'rim' });
        }
      }

      const models = this.ctx.models();
      if (models) {
        for (const m of models.models) {
          if (!m.visible) continue;
          for (const s of modelBoxSnaps(m, this.invWork)) out.push({ ...s, label: m.name });
        }
      }

      for (const o of this.ctx.origins()) {
        out.push({ point: o.point, kind: 'origin', label: o.name });
      }
    } else if (this.ctx.axisOrigins) {
      // Assembling, the useful landmarks are the joints themselves: a
      // casting is located on its own pivot, not on the workpiece.
      for (const o of this.ctx.axisOrigins()) {
        out.push({ point: o.point, kind: 'origin', label: o.name });
      }
    }

    // Vertices of the triangle actually under the cursor.
    if (free && free.intersection && free.intersection.face) {
      for (const s of triangleSnaps(free.intersection, this.invWork)) out.push({ ...s, label: free.label });
    }

    return out;
  }

  dispose() {
    this.cancel(true);
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    this.marker.geometry.dispose();
    this.marker.material.dispose();
    this.anchor.geometry.dispose();
    this.anchor.material.dispose();
    this.band.geometry.dispose();
    this.band.material.dispose();
    this.viewer.scene.remove(this.group);
  }
}

/** Corners, edge midpoints and face centres of a model's bounding box. */
function modelBoxSnaps(model, inv) {
  const bb = model.mesh.geometry.boundingBox;
  if (!bb) return [];
  model.object.updateMatrixWorld(true);
  const lo = [bb.min.x, bb.min.y, bb.min.z];
  const hi = [bb.max.x, bb.max.y, bb.max.z];
  const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const axis = [[lo[0], mid[0], hi[0]], [lo[1], mid[1], hi[1]], [lo[2], mid[2], hi[2]]];

  const out = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        const mids = (i === 1 ? 1 : 0) + (j === 1 ? 1 : 0) + (k === 1 ? 1 : 0);
        if (mids === 3) continue;
        const kind = mids === 0 ? 'corner' : mids === 1 ? 'edge' : 'face';
        v.set(axis[0][i], axis[1][j], axis[2][k]).applyMatrix4(model.object.matrixWorld);
        if (inv) v.applyMatrix4(inv);
        out.push({ point: [v.x, v.y, v.z], kind });
      }
    }
  }
  return out;
}

/** Vertices, edge midpoints and centroid of one picked triangle. */
function triangleSnaps(intersection, inv) {
  const geom = intersection.object.geometry;
  const pos = geom.attributes.position;
  const face = intersection.face;
  if (!pos || !face) return [];

  const m = intersection.object.matrixWorld;
  const bring = (v) => (inv ? v.applyMatrix4(m).applyMatrix4(inv) : v.applyMatrix4(m));
  const a = bring(new THREE.Vector3().fromBufferAttribute(pos, face.a));
  const b = bring(new THREE.Vector3().fromBufferAttribute(pos, face.b));
  const c = bring(new THREE.Vector3().fromBufferAttribute(pos, face.c));

  const mid = (p, q) => [(p.x + q.x) / 2, (p.y + q.y) / 2, (p.z + q.z) / 2];
  return [
    { point: [a.x, a.y, a.z], kind: 'vertex' },
    { point: [b.x, b.y, b.z], kind: 'vertex' },
    { point: [c.x, c.y, c.z], kind: 'vertex' },
    { point: mid(a, b), kind: 'edge' },
    { point: mid(b, c), kind: 'edge' },
    { point: mid(c, a), kind: 'edge' },
    { point: [(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3], kind: 'centre' },
  ];
}
