// A zip file, written and read without a library.
//
// A machine is not one file. It is a kinematic chain, a controller, a set
// of macros and however many STL castings somebody imported — and those
// belong together, because a chain that says "the saddle is on Y" is worth
// nothing without the saddle. A folder would be the obvious answer, but a
// web page cannot hand out a folder; a zip is the same thing in one file,
// and every operating system opens it as a folder anyway.
//
// Only what that needs is implemented: store and deflate entries, no
// encryption, no zip64, no multi-disk. Deflate comes from the browser's own
// CompressionStream, so there is still nothing to install.

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** CRC-32, the one every zip entry carries. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const asBytes = (data) => (typeof data === 'string' ? enc.encode(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength ?? data.length));

async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  } catch {
    return null;
  }
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot read compressed zip entries.');
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/** MS-DOS date and time, which is what a zip directory stores. */
function dosStamp(date = new Date()) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

/**
 * Write a zip.
 *
 * @param {Array<{name:string, data:string|Uint8Array|ArrayBuffer}>} files
 *   Names may contain "/" — that is what makes the folders inside.
 * @returns {Promise<Uint8Array>}
 */
export async function writeZip(files, { compress = true } = {}) {
  const stamp = dosStamp();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const raw = asBytes(file.data);
    const crc = crc32(raw);
    let body = raw;
    let method = 0;
    if (compress && raw.length > 256) {
      const packed = await deflateRaw(raw);
      if (packed && packed.length < raw.length) {
        body = packed;
        method = 8;
      }
    }

    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, LOCAL, true);
    head.setUint16(4, 20, true);            // version needed
    head.setUint16(6, 0, true);             // flags
    head.setUint16(8, method, true);
    head.setUint16(10, stamp.time, true);
    head.setUint16(12, stamp.day, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, body.length, true);
    head.setUint32(22, raw.length, true);
    head.setUint16(26, nameBytes.length, true);
    head.setUint16(28, 0, true);            // extra field length
    parts.push(new Uint8Array(head.buffer), nameBytes, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, CENTRAL, true);
    dir.setUint16(4, 20, true);             // version made by
    dir.setUint16(6, 20, true);             // version needed
    dir.setUint16(8, 0, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, stamp.time, true);
    dir.setUint16(14, stamp.day, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Read a zip, walking the central directory so entry order does not matter.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<Map<string, Uint8Array>>} path within the zip -> bytes
 */
export async function readZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end record is last, but a comment may follow it, so it is hunted
  // backwards from the end.
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) {
    if (view.getUint32(i, true) === END) { end = i; break; }
  }
  if (end < 0) throw new Error('That file is not a zip.');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map();

  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('The zip directory is damaged.');
    const method = view.getUint16(at + 10, true);
    const packedSize = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;                 // a folder entry
    const localNameLen = view.getUint16(local + 26, true);
    const localExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + localNameLen + localExtraLen;
    const body = bytes.subarray(start, start + packedSize);
    out.set(name, method === 8 ? await inflateRaw(body) : body.slice());
  }
  return out;
}

/** Everything in the zip under `folder/`, keyed by the rest of the path. */
export function folderOf(entries, folder) {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  const out = new Map();
  for (const [name, data] of entries) {
    if (name.startsWith(prefix)) out.set(name.slice(prefix.length), data);
  }
  return out;
}
