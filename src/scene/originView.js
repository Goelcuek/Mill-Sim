// Work-coordinate origins drawn in the scene.
//
// "Where is G54?" is a question the viewport should answer without anybody
// reading a number field, especially now that the origin can be moved by
// clicking. Each offset gets a small labelled triad; the active one is
// drawn solid and larger, the rest sit back.

import * as THREE from 'three';

const AXIS_COLORS = [0xff453a, 0x32d74b, 0x0a84ff];

function labelSprite(text, active) {
  const pad = 8;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '600 34px -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = 48;
  canvas.width = w;
  canvas.height = h;

  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = active ? 'rgba(10,132,255,0.95)' : 'rgba(120,120,128,0.75)';
  roundRect(ctx, 0, 4, w, h - 8, 9);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, pad, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, depthTest: false, transparent: true,
  }));
  sprite.renderOrder = 995;
  sprite.userData.aspect = w / h;
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class OriginView {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'origins';
    this.entries = [];
    this.size = 26;
  }

  /**
   * @param {Record<string, number[]>} wcs
   * @param {string} active
   */
  set(wcs, active) {
    this.clear();

    // Offsets commonly sit on top of each other — a fresh setup has all six
    // at the origin. Drawing six identical triads just stacks six labels in
    // the same pixel, so coincident offsets share one marker.
    const groups = new Map();
    for (const [name, point] of Object.entries(wcs || {})) {
      const key = point.map((v) => Math.round(v * 1000)).join(',');
      if (!groups.has(key)) groups.set(key, { point, names: [] });
      groups.get(key).names.push(name);
    }

    for (const { point, names } of groups.values()) {
      const isActive = names.includes(active);
      const name = names.length === 1
        ? names[0]
        : isActive
          ? `${active} +${names.length - 1}`
          : `${names[0]} +${names.length - 1}`;
      const entry = new THREE.Group();
      entry.position.set(point[0], point[1], point[2]);

      const len = isActive ? this.size : this.size * 0.62;
      for (let a = 0; a < 3; a++) {
        const dir = [0, 0, 0];
        dir[a] = len;
        const geom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(dir[0], dir[1], dir[2]),
        ]);
        const line = new THREE.Line(geom, new THREE.LineBasicMaterial({
          color: AXIS_COLORS[a],
          depthTest: false,
          transparent: true,
          opacity: isActive ? 0.95 : 0.4,
        }));
        line.renderOrder = 994;
        entry.add(line);
      }

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(isActive ? 1.6 : 1.0, 16, 12),
        new THREE.MeshBasicMaterial({
          color: isActive ? 0x0a84ff : 0x8e8e93,
          depthTest: false,
          transparent: true,
          opacity: isActive ? 1 : 0.5,
        }),
      );
      dot.renderOrder = 995;
      entry.add(dot);

      const label = labelSprite(name, isActive);
      label.position.set(len * 0.35, len * 0.35, len * 0.5);
      entry.add(label);

      this.group.add(entry);
      this.entries.push({ name, entry, label, active: isActive });
    }
  }

  /** Keep labels a constant size on screen. */
  update(camera) {
    for (const e of this.entries) {
      const world = new THREE.Vector3();
      e.entry.getWorldPosition(world);
      const d = camera.position.distanceTo(world);
      const h = Math.max(d * 0.03, 2.5);
      e.label.scale.set(h * e.label.userData.aspect, h, 1);
    }
  }

  setVisible(v) { this.group.visible = v; }

  clear() {
    for (const e of this.entries) {
      e.entry.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
      this.group.remove(e.entry);
    }
    this.entries = [];
  }

  dispose() { this.clear(); }
}
