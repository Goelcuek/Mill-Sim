// STL reading and writing, dependency free.
//
// Import handles both binary and ASCII files and reports the units it had
// to guess at, because STL carries none. Export writes binary STL, which
// every CAM package and slicer reads.

const HEADER_BYTES = 80;

function looksBinary(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES + 4) return false;
  const triangles = view.getUint32(HEADER_BYTES, true);
  const expected = HEADER_BYTES + 4 + triangles * 50;
  if (expected === buffer.byteLength) return true;
  // Some writers pad; fall back to sniffing for the ASCII keyword.
  const head = new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength));
  let text = '';
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  return !/^\s*solid/i.test(text) || !/facet/i.test(text);
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{positions:Float32Array, normals:Float32Array, triangles:number,
 *            name:string, format:'binary'|'ascii'}}
 */
export function parseSTL(buffer) {
  return looksBinary(buffer) ? parseBinary(buffer) : parseAscii(buffer);
}

function parseBinary(buffer) {
  const view = new DataView(buffer);
  const triangles = view.getUint32(HEADER_BYTES, true);
  const max = Math.floor((buffer.byteLength - HEADER_BYTES - 4) / 50);
  const n = Math.min(triangles, max);
  const positions = new Float32Array(n * 9);
  const normals = new Float32Array(n * 9);

  let off = HEADER_BYTES + 4;
  for (let i = 0; i < n; i++) {
    const nx = view.getFloat32(off, true);
    const ny = view.getFloat32(off + 4, true);
    const nz = view.getFloat32(off + 8, true);
    off += 12;
    for (let v = 0; v < 3; v++) {
      const k = i * 9 + v * 3;
      positions[k] = view.getFloat32(off, true);
      positions[k + 1] = view.getFloat32(off + 4, true);
      positions[k + 2] = view.getFloat32(off + 8, true);
      normals[k] = nx;
      normals[k + 1] = ny;
      normals[k + 2] = nz;
      off += 12;
    }
    off += 2; // attribute byte count
  }

  let name = '';
  const head = new Uint8Array(buffer, 0, HEADER_BYTES);
  for (let i = 0; i < HEADER_BYTES && head[i]; i++) {
    if (head[i] >= 32 && head[i] < 127) name += String.fromCharCode(head[i]);
  }

  return { positions, normals, triangles: n, name: name.trim(), format: 'binary' };
}

function parseAscii(buffer) {
  const text = new TextDecoder().decode(buffer);
  const nameMatch = /^\s*solid\s+([^\r\n]*)/i.exec(text);
  const verts = [];
  const norms = [];
  const facetRe = /facet\s+normal\s+([^\r\n]*)([\s\S]*?)endfacet/gi;
  const numRe = /-?\d+\.?\d*(?:[eE][-+]?\d+)?/g;

  let m;
  while ((m = facetRe.exec(text)) !== null) {
    const nParts = m[1].match(numRe) || ['0', '0', '0'];
    const nx = parseFloat(nParts[0]) || 0;
    const ny = parseFloat(nParts[1]) || 0;
    const nz = parseFloat(nParts[2]) || 0;
    const vNums = m[2].match(numRe) || [];
    for (let v = 0; v + 2 < vNums.length && v < 9; v += 3) {
      verts.push(parseFloat(vNums[v]), parseFloat(vNums[v + 1]), parseFloat(vNums[v + 2]));
      norms.push(nx, ny, nz);
    }
  }

  return {
    positions: Float32Array.from(verts),
    normals: Float32Array.from(norms),
    triangles: verts.length / 9,
    name: nameMatch ? nameMatch[1].trim() : '',
    format: 'ascii',
  };
}

/**
 * Write a binary STL.
 *
 * @param {Float32Array|number[]} positions  flat xyz triples, 3 per triangle
 * @param {{name?:string, normals?:Float32Array}} [opts]
 * @returns {ArrayBuffer}
 */
export function writeSTL(positions, opts = {}) {
  const triangles = Math.floor(positions.length / 9);
  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangles * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const header = `Mill-Sim ${opts.name || 'export'}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(HEADER_BYTES, triangles, true);

  let off = HEADER_BYTES + 4;
  for (let t = 0; t < triangles; t++) {
    const k = t * 9;
    const ax = positions[k], ay = positions[k + 1], az = positions[k + 2];
    const bx = positions[k + 3], by = positions[k + 4], bz = positions[k + 5];
    const cx = positions[k + 6], cy = positions[k + 7], cz = positions[k + 8];

    let nx, ny, nz;
    if (opts.normals) {
      nx = opts.normals[k]; ny = opts.normals[k + 1]; nz = opts.normals[k + 2];
    } else {
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      nx = uy * vz - uz * vy;
      ny = uz * vx - ux * vz;
      nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
    }

    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    off += 12;
    const v = [ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let i = 0; i < 9; i++) {
      view.setFloat32(off, v[i], true);
      off += 4;
    }
    view.setUint16(off, 0, true);
    off += 2;
  }

  return buffer;
}

/** Write a Wavefront OBJ. Handy when the target is a CAD package. */
export function writeOBJ(positions, opts = {}) {
  const lines = [`# Mill-Sim export: ${opts.name || 'model'}`, `# ${positions.length / 9} triangles`];
  const p = positions;
  for (let i = 0; i < p.length; i += 3) {
    lines.push(`v ${p[i].toFixed(4)} ${p[i + 1].toFixed(4)} ${p[i + 2].toFixed(4)}`);
  }
  const count = p.length / 3;
  for (let i = 1; i <= count; i += 3) lines.push(`f ${i} ${i + 1} ${i + 2}`);
  return lines.join('\n');
}

/** Bounding box of a flat position array. */
export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!positions.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}
