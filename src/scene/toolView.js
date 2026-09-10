// Drawing tool assemblies.
//
// Cutters and holders are solids of revolution, so their silhouettes go
// straight into a LatheGeometry. Flutes are drawn as helical grooves on
// top of that body — they carry no simulation meaning but they are what
// makes a rendered end mill read as an end mill.

import * as THREE from 'three';
import { deg2rad } from '../core/util.js';

const LATHE_SEGMENTS = 64;
/** Profile corners sharper than this get a hard edge instead of a blend. */
const CREASE_DEGREES = 30;

/**
 * Revolve a silhouette around the Z axis.
 *
 * three's LatheGeometry averages the normal at every profile point with
 * its neighbour, so the 90-degree shoulder between two holder stages
 * shades as a 45-degree bevel and the whole assembly looks melted. This
 * builder splits the ring at sharp corners — two rings at the same height,
 * each carrying its own normal — while still sharing a ring wherever the
 * profile is genuinely curved, so a ball nose stays smooth and a flange
 * stays crisp.
 */
function latheFrom(points, segments = LATHE_SEGMENTS) {
  const pts = [];
  for (const p of points) {
    if (!Number.isFinite(p.r) || !Number.isFinite(p.z)) continue;
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.r - p.r) < 1e-9 && Math.abs(last.z - p.z) < 1e-9) continue;
    pts.push({ r: Math.max(p.r, 0), z: p.z });
  }
  if (pts.length < 2) return new THREE.BufferGeometry();

  // Outward normal of each profile segment, in the (radius, height) plane.
  const segN = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dr = pts[i + 1].r - pts[i].r;
    const dz = pts[i + 1].z - pts[i].z;
    const len = Math.hypot(dr, dz) || 1;
    segN.push([dz / len, -dr / len]);
  }

  // One ring per profile point, or two where the profile creases.
  const creaseDot = Math.cos((CREASE_DEGREES * Math.PI) / 180);
  const rings = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = i > 0 ? segN[i - 1] : null;
    const next = i < segN.length ? segN[i] : null;
    if (!prev) rings.push({ i, p: pts[i], n: next });
    else if (!next) rings.push({ i, p: pts[i], n: prev });
    else if (prev[0] * next[0] + prev[1] * next[1] >= creaseDot) {
      const nr = prev[0] + next[0];
      const nz = prev[1] + next[1];
      const len = Math.hypot(nr, nz) || 1;
      rings.push({ i, p: pts[i], n: [nr / len, nz / len] });
    } else {
      rings.push({ i, p: pts[i], n: prev });
      rings.push({ i, p: pts[i], n: next });
    }
  }

  const ringVerts = segments + 1;
  const total = rings.length * ringVerts;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const index = [];

  const cos = new Float32Array(ringVerts);
  const sin = new Float32Array(ringVerts);
  for (let j = 0; j <= segments; j++) {
    const a = (j / segments) * Math.PI * 2;
    cos[j] = Math.cos(a);
    sin[j] = Math.sin(a);
  }

  const zMin = pts[0].z;
  const zSpan = pts[pts.length - 1].z - zMin || 1;

  for (let k = 0; k < rings.length; k++) {
    const { p, n } = rings[k];
    for (let j = 0; j <= segments; j++) {
      const o = (k * ringVerts + j) * 3;
      position[o] = p.r * cos[j];
      position[o + 1] = p.r * sin[j];
      position[o + 2] = p.z;
      normal[o] = n[0] * cos[j];
      normal[o + 1] = n[0] * sin[j];
      normal[o + 2] = n[1];
      uv[(k * ringVerts + j) * 2] = j / segments;
      uv[(k * ringVerts + j) * 2 + 1] = (p.z - zMin) / zSpan;
    }
  }

  for (let k = 0; k + 1 < rings.length; k++) {
    // A crease emits two coincident rings; there is no band between them.
    if (rings[k].i === rings[k + 1].i) continue;
    if (rings[k].p.r <= 0 && rings[k + 1].p.r <= 0) continue;
    for (let j = 0; j < segments; j++) {
      const a = k * ringVerts + j;
      const b = a + 1;
      const c = (k + 1) * ringVerts + j + 1;
      const d = c - 1;
      if (rings[k].p.r > 0) index.push(a, b, c);
      if (rings[k + 1].p.r > 0) index.push(a, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** Helical flute grooves along the cutting region. */
function fluteGeometry(built, helixDeg = 30) {
  const t = built.tool.def;
  const count = Math.max(0, Math.min(Math.round(t.fluteCount || 0), 12));
  const radius = built.cutRadius;
  const length = built.fluteLength;
  if (!count || radius < 0.15 || length < 0.5) return null;

  const helix = deg2rad(Math.max(5, Math.min(helixDeg, 60)));
  const lead = (2 * Math.PI * radius) / Math.tan(helix);
  const turns = lead > 0.01 ? length / lead : 0.4;
  const grooveR = Math.max(radius * 0.075, 0.05);
  const steps = Math.max(12, Math.min(Math.ceil(turns * 24) + 8, 220));

  const geoms = [];
  for (let f = 0; f < count; f++) {
    const phase = (f / count) * Math.PI * 2;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const z = u * length;
      // Follow the cutter silhouette so tapered and ball tools keep flutes.
      const localR = radiusAt(built.toolPoints, z, radius);
      const a = phase + turns * Math.PI * 2 * u;
      const rr = Math.max(localR - grooveR * 0.35, 0.02);
      pts.push(new THREE.Vector3(rr * Math.cos(a), rr * Math.sin(a), z));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    geoms.push(new THREE.TubeGeometry(curve, steps, grooveR, 6, false));
  }

  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms);
  geoms.forEach((g) => g.dispose());
  return merged;
}

/** Radius of a silhouette at height z. */
function radiusAt(points, z, fallback) {
  let best = fallback;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const lo = Math.min(a.z, b.z);
    const hi = Math.max(a.z, b.z);
    if (z < lo - 1e-6 || z > hi + 1e-6) continue;
    const t = hi - lo < 1e-9 ? 0 : (z - lo) / (hi - lo);
    const r = a.z <= b.z ? a.r + (b.r - a.r) * t : b.r + (a.r - b.r) * t;
    best = Math.max(0.02, r);
  }
  return best;
}

/** Minimal geometry merge for the non-indexed tube geometries above. */
function mergeGeometries(geoms) {
  let total = 0;
  for (const g of geoms) total += g.attributes.position.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const index = [];
  let vo = 0;
  for (const g of geoms) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    position.set(p, vo * 3);
    normal.set(n, vo * 3);
    const idx = g.getIndex();
    if (idx) for (let i = 0; i < idx.count; i++) index.push(idx.getX(i) + vo);
    else for (let i = 0; i < g.attributes.position.count; i++) index.push(i + vo);
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setIndex(index);
  return out;
}

export class ToolView {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'tool-assembly';
    this.built = null;
    this.parts = [];

    this.toolMaterial = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.9, roughness: 0.26 });
    this.fluteMaterial = new THREE.MeshStandardMaterial({ color: 0x4a5364, metalness: 0.8, roughness: 0.5 });
    this.holderMaterial = new THREE.MeshStandardMaterial({ color: 0x8d97a8, metalness: 0.75, roughness: 0.4 });
    this.spindleMaterial = new THREE.MeshStandardMaterial({ color: 0x5d6577, metalness: 0.6, roughness: 0.55 });
    this.alertMaterial = new THREE.MeshStandardMaterial({ color: 0xff4d4f, emissive: 0x5a0000, metalness: 0.4, roughness: 0.5 });
  }

  /** @param {ReturnType<import('../tools/assembly.js').buildAssembly>} built */
  setAssembly(built) {
    this.clear();
    this.built = built;
    if (!built) return;

    this.toolMaterial.color.set(built.tool.def.color || '#b9c2cf');
    if (built.holder) this.holderMaterial.color.set(built.holder.def.color || '#8d97a8');

    const addPart = (geometry, material, name) => {
      if (!geometry || !geometry.attributes.position || geometry.attributes.position.count === 0) return null;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      this.group.add(mesh);
      this.parts.push(mesh);
      return mesh;
    };

    addPart(latheFrom(built.toolPoints), this.toolMaterial, 'cutter');
    const flutes = fluteGeometry(built);
    if (flutes) addPart(flutes, this.fluteMaterial, 'flutes');
    if (built.holderPoints.length > 1) addPart(latheFrom(built.holderPoints), this.holderMaterial, 'holder');
    if (built.spindlePoints.length > 1) {
      addPart(latheFrom(built.spindlePoints, 40), this.spindleMaterial, 'spindle');
    }
  }

  /** Position the assembly by its tool tip. */
  setPosition(x, y, z) {
    this.group.position.set(x, y, z);
  }

  setVisible(v) { this.group.visible = v; }

  setOpacity(alpha) {
    const transparent = alpha < 0.999;
    for (const m of [this.toolMaterial, this.fluteMaterial, this.holderMaterial, this.spindleMaterial]) {
      m.transparent = transparent;
      m.opacity = alpha;
      m.depthWrite = !transparent;
      m.needsUpdate = true;
    }
  }

  /** Swap in the alert material while a crash is being reported. */
  setAlert(on) {
    for (const part of this.parts) {
      if (on) {
        if (!part.userData.baseMaterial) part.userData.baseMaterial = part.material;
        part.material = this.alertMaterial;
      } else if (part.userData.baseMaterial) {
        part.material = part.userData.baseMaterial;
        part.userData.baseMaterial = null;
      }
    }
  }

  /** Hide the holder so a deep pocket stays visible. */
  setHolderVisible(v) {
    for (const p of this.parts) if (p.name === 'holder' || p.name === 'spindle') p.visible = v;
  }

  clear() {
    for (const p of this.parts) {
      p.geometry.dispose();
      this.group.remove(p);
    }
    this.parts = [];
    this.built = null;
  }

  dispose() {
    this.clear();
    for (const m of [this.toolMaterial, this.fluteMaterial, this.holderMaterial, this.spindleMaterial, this.alertMaterial]) m.dispose();
  }
}

/** Build a standalone mesh of an assembly, for the tool-library preview. */
export function assemblyPreviewMesh(built) {
  const group = new THREE.Group();
  const tool = new THREE.Mesh(latheFrom(built.toolPoints), new THREE.MeshStandardMaterial({ color: built.tool.def.color || '#b9c2cf', metalness: 0.9, roughness: 0.25 }));
  group.add(tool);
  const flutes = fluteGeometry(built);
  if (flutes) group.add(new THREE.Mesh(flutes, new THREE.MeshStandardMaterial({ color: 0x4a5364, metalness: 0.8, roughness: 0.5 })));
  if (built.holderPoints.length > 1) {
    group.add(new THREE.Mesh(latheFrom(built.holderPoints), new THREE.MeshStandardMaterial({ color: (built.holder && built.holder.def.color) || '#8d97a8', metalness: 0.75, roughness: 0.4 })));
  }
  return group;
}
