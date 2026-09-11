// Proxy castings for a machine that has no STLs hung on it yet.
//
// These are not decoration. A machine you cannot read is a machine you
// cannot check a program against: you need to see which lump moves in Y,
// where the table face is, and which way the trunnion swings. So each part
// is built to the shape the real thing has — a plinth with a chip skirt, a
// column with ways down its front face, a table with T-slots, bellows on
// the slideways, a trunnion with two cheeks and a cradle between them —
// and coloured by what it does rather than all one grey.
//
// A preset describes its own castings as plain data (see machine/presets.js)
// so that file stays free of three.js and keeps running under the tests.
// Anything without a description falls back to a generic slab or disc,
// which is what a user-built axis gets until they import their own.

import * as THREE from 'three';

/**
 * Machine-tool palette. Tones are named for the job a part does, so the
 * eye can group them: everything that slides is one colour, everything
 * that rotates is another, and the spindle is bright because it is the bit
 * you are watching.
 */
export const TONES = {
  // Painted machine enamel. Deliberately a good deal darker than the
  // backdrop: a pale casting on a pale ground has no edges, and the first
  // version of these was unreadable for exactly that reason.
  body:   { color: 0x67717f, metalness: 0.06, roughness: 0.76 },
  base:   { color: 0x2f353e, metalness: 0.10, roughness: 0.84 },  // the painted base
  slide:  { color: 0xa8b0bc, metalness: 0.38, roughness: 0.44 },  // bright moving castings
  table:  { color: 0x6d7783, metalness: 0.58, roughness: 0.30 },  // machined cast iron
  way:    { color: 0x1b1e24, metalness: 0.22, roughness: 0.90 },  // bellows and covers
  steel:  { color: 0xe2e8ef, metalness: 0.90, roughness: 0.20 },  // spindle, ground bar
  rotary: { color: 0xc08a3c, metalness: 0.64, roughness: 0.34 },  // anything that turns
  accent: { color: 0x1f6fb4, metalness: 0.28, roughness: 0.42 },  // the machine's colour
};

/** A box whose local origin is the centre of its base. */
function box(w, d, h, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(w), Math.abs(d), Math.abs(h)), material);
  mesh.position.set(x, y, z + Math.abs(h) / 2);
  return mesh;
}

/** A cylinder lying along a unit axis, centred on the origin. */
function cyl(rTop, rBottom, len, axis, material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, len, 40, 1), material);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(axis[0], axis[1], axis[2]).normalize(),
  );
  return mesh;
}

const at = (spec) => spec.at || [0, 0, 0];

/**
 * Build one described casting.
 *
 * @param {object} spec   `{ part, size, at, tone, ... }` from a preset
 * @param {(tone:string) => THREE.Material} mat
 * @returns {THREE.Object3D[]}
 */
export function buildCasting(spec, mat) {
  const [x, y, z] = at(spec);
  const s = spec.size || [100, 100, 100];
  const parts = [];
  const push = (m, tone) => { if (tone) m.material = mat(tone); parts.push(m); return m; };
  const tone = spec.tone;

  switch (spec.part) {
    // A floor-standing base: a wide chip skirt with a narrower pedestal on
    // top, which is the shape every C-frame mill has under the saddle.
    case 'plinth': {
      const [w, d, h] = s;
      push(box(w, d, h * 0.62, mat(tone || 'base'), x, y, z));
      push(box(w * 0.78, d * 0.8, h * 0.4, mat(tone || 'base'), x, y, z + h * 0.58));
      // A pale sill where the casting meets the floor reads as a machined face.
      push(box(w * 1.02, d * 1.02, 26, mat('body'), x, y, z - 6));
      break;
    }

    // The column behind the table: a deep casting that tapers forward as it
    // rises, with a flat front face for the Z ways.
    case 'column': {
      const [w, d, h] = s;
      push(box(w, d, h, mat(tone || 'body'), x, y, z));
      push(box(w * 1.06, d * 0.42, h * 0.16, mat(tone || 'body'), x, y + d * 0.24, z + h * 0.86));
      // Front face plate: where the head actually rides. Sunk a millimetre
      // into the column so the two faces never land on the same plane.
      push(box(w * 0.62, 26, h * 0.82, mat('slide'), x, y - d / 2 - 12, z + h * 0.08));
      break;
    }

    case 'saddle': {
      const [w, d, h] = s;
      push(box(w, d, h, mat(tone || 'slide'), x, y, z));
      push(box(w * 0.86, d * 1.04, h * 0.36, mat('body'), x, y, z + h * 0.64));
      break;
    }

    // A T-slotted table: a plate with slots cut across it, drawn as dark
    // grooves so the work surface reads at a glance.
    case 'table': {
      const [w, d, h] = s;
      push(box(w, d, h, mat(tone || 'table'), x, y, z));
      const n = spec.slots || 5;
      for (let i = 0; i < n; i++) {
        const sy = y - d / 2 + (d * (i + 0.5)) / n;
        push(box(w * 0.98, Math.max(d * 0.028, 12), 14, mat('way'), x, sy, z + h - 12));
      }
      // Machined edge rails along the long sides, standing a little proud
      // of the face so they are not coplanar with it.
      push(box(w, 20, h * 0.34, mat('steel'), x, y - d / 2 + 9, z + h * 0.7));
      push(box(w, 20, h * 0.34, mat('steel'), x, y + d / 2 - 9, z + h * 0.7));
      break;
    }

    // Telescoping way cover or bellows: stepped plates, each a little
    // smaller than the last, which is what makes them read as a cover
    // rather than a block.
    case 'ways': {
      const [w, d, h] = s;
      const steps = spec.steps || 4;
      const along = spec.axis === 'y' ? 1 : 0;
      const span = Math.abs(along === 0 ? w : d);
      const len = span / steps;
      // Plates get shorter the further they are from the saddle, which is
      // the taper that makes a telescoping cover read as one.
      const outward = spec.from === 'far' ? -1 : 1;
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const shrink = 1 - t * 0.2;
        const p = [x, y, z];
        p[along] = (along === 0 ? x : y) + outward * (-span / 2 + len * (i + 0.5));
        push(box(
          along === 0 ? len * 0.96 : Math.abs(w) * shrink,
          along === 0 ? Math.abs(d) * shrink : len * 0.96,
          h * (1 - t * 0.12),
          mat(tone || 'way'), p[0], p[1], p[2],
        ));
      }
      break;
    }

    // The Z slide and head: a box on the column face with a shoulder that
    // carries the spindle cartridge.
    case 'headSlide': {
      const [w, d, h] = s;
      push(box(w, d, h, mat(tone || 'accent'), x, y, z));
      push(box(w * 1.08, d * 0.3, h * 0.9, mat('slide'), x, y + d * 0.42, z + h * 0.05));
      push(box(w * 0.7, d * 0.72, h * 0.18, mat('body'), x, y - d * 0.06, z - h * 0.16));
      break;
    }

    // The spindle cartridge, nose down: a ground column with a tapered
    // nose so which end the tool comes out of is never in doubt.
    case 'spindle': {
      const [r, h] = s;
      const nose = push(cyl(r, r * 0.62, h * 0.24, [0, 0, 1], mat('steel')));
      nose.position.set(x, y, z + h * 0.12);
      const body = push(cyl(r * 1.12, r * 1.12, h * 0.76, [0, 0, 1], mat(tone || 'body')));
      body.position.set(x, y, z + h * 0.24 + h * 0.38);
      const ring = push(cyl(r * 1.22, r * 1.22, h * 0.07, [0, 0, 1], mat('steel')));
      ring.position.set(x, y, z + h * 0.26);
      break;
    }

    // A rotary axis: a faced platter with a raised location boss, plus a
    // housing behind it so the drive end is visible.
    case 'rotary': {
      const [r, h] = s;
      const axis = spec.axis || [0, 0, 1];
      const face = push(cyl(r, r, h, axis, mat(tone || 'rotary')));
      face.position.set(x, y, z);
      // The housing sits behind the face, on the far side from the work,
      // overlapping it rather than butting against it.
      const housing = push(cyl(r * 0.8, r * 0.9, h * 1.5, axis, mat('body')));
      housing.position.set(
        x - axis[0] * h * 1.1,
        y - axis[1] * h * 1.1,
        z - axis[2] * h * 1.1,
      );
      const boss = push(cyl(r * 0.26, r * 0.26, h * 1.25, axis, mat('steel')));
      boss.position.set(x + axis[0] * h * 0.2, y + axis[1] * h * 0.2, z + axis[2] * h * 0.2);
      // T-slots across the platter face, so it reads as a work surface.
      // `?? 4` rather than `|| 4`, or a bearing asking for none gets four.
      const n = spec.slots ?? 4;
      for (let i = 0; i < n; i++) {
        const slot = push(box(r * 1.62, Math.max(r * 0.075, 8), h * 0.42, mat('way'), 0, 0, 0));
        slot.position.set(x, y, z + (axis[2] > 0 ? h * 0.6 : 0));
        slot.rotation.z = (i / n) * Math.PI;
      }
      break;
    }

    // A trunnion: two cheeks standing off the table with the cradle
    // between them, one cheek carrying the drive.
    case 'trunnion': {
      const [w, d, h] = s;
      const span = spec.span || w;
      for (const sign of [-1, 1]) {
        const cheek = push(box(w * 0.26, d, h, mat(tone || 'body'), x + (sign * span) / 2, y, z));
        cheek.name = 'trunnion cheek';
      }
      // A pale rib across the back ties the two cheeks together.
      push(box(span, d * 0.32, h * 0.3, mat('slide'), x, y - d * 0.3, z));
      break;
    }

    // The cradle slung between the cheeks, which the rotary table sits in.
    case 'cradle': {
      const [w, d, h] = s;
      push(box(w, d, h, mat(tone || 'slide'), x, y, z));
      push(box(w * 0.92, d * 0.88, h * 0.4, mat('body'), x, y, z + h - 4));
      break;
    }

    // A tilting fork: two arms with the spindle carried between them.
    case 'fork': {
      const [w, d, h] = s;
      const span = spec.span || w;
      push(box(span * 1.05, d * 0.9, h * 0.26, mat(tone || 'accent'), x, y, z + h * 0.74));
      for (const sign of [-1, 1]) {
        push(box(w * 0.3, d, h * 0.8, mat(tone || 'accent'), x + (sign * span) / 2, y, z));
      }
      break;
    }

    case 'ram': {
      const [w, d, h] = s;
      push(box(w, d, h, mat(tone || 'slide'), x, y, z));
      push(box(w * 0.62, d * 0.62, h * 1.02, mat('steel'), x, y, z - 6));
      break;
    }

    case 'bridge': {
      const [w, d, h] = s;
      push(box(w, d, h, mat(tone || 'body'), x, y, z));
      push(box(w * 0.99, d * 0.3, h * 1.15, mat('slide'), x, y - d * 0.34, z - 4));
      break;
    }

    case 'leg': {
      const [w, d, h] = s;
      push(box(w, d, h, mat(tone || 'body'), x, y, z));
      push(box(w * 1.25, d * 1.25, h * 0.1, mat('base'), x, y, z - 8));
      break;
    }

    case 'box':
    default: {
      const [w, d, h] = s;
      push(box(w, d, h, mat(tone || 'body'), x, y, z));
      break;
    }
  }

  return parts;
}
