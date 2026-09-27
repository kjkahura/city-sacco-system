'use strict';

const zlib = require('zlib');

/**
 * ZIP files, written and read with Node's own zlib: the backup is a ZIP of
 * CSVs and an .xlsx workbook is a ZIP of XML, and neither is worth a
 * dependency. Deflate and stored entries only, no ZIP64 (a SACCO's backup
 * is far below 4 GB and 65,535 files), no encryption.
 *
 * Reading is for workbooks people upload, so it is defensive: the total
 * uncompressed size and the number of entries are capped, each entry is
 * inflated with an output limit, and the sizes a file claims are checked
 * against what it holds. A small file that inflates to gigabytes (a zip
 * bomb) is refused rather than exhausting memory.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a ZIP from [{ name, data }]. `data` is a Buffer or a string (UTF-8).
 * Entries are deflated unless deflating does not make them smaller.
 */
function zip(entries, { date = new Date(), compress = true } = {}) {
  if (entries.length > 0xFFFF) throw new Error('ZIP_TOO_MANY_ENTRIES');
  const { time, date: dd } = dosDateTime(date);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (compress && raw.length > 64) {
      const def = zlib.deflateRawSync(raw, { level: 6 });
      if (def.length < raw.length) { method = 8; body = def; }
    }
    if (offset + body.length > 0xFFFFFFFF) throw new Error('ZIP_TOO_LARGE');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(dd, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(dd, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const bad = (m) => Object.assign(new Error(`INVALID_ZIP: ${m}`), { status: 400 });

/**
 * Read a ZIP into a Map of name -> Buffer.
 * @param {{maxEntries?: number, maxTotal?: number}} limits
 */
function unzip(buf, { maxEntries = 500, maxTotal = 50 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw bad('too short');
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw bad(`more than ${maxEntries} entries`);
  if (cdOffset + cdSize > buf.length) throw bad('central directory out of range');

  const out = new Map();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw bad(`encrypted entry ${name}`);
    if (name.endsWith('/')) continue;
    total += usize;
    if (total > maxTotal) throw bad(`uncompressed size over ${maxTotal} bytes`);
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw bad(`bad local header for ${name}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw bad(`entry ${name} out of range`);
    const body = buf.slice(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(usize, 1) });
      } catch (e) {
        throw bad(`entry ${name} does not inflate to its stated size`);
      }
    } else throw bad(`entry ${name} uses compression method ${method}`);
    if (data.length !== usize) throw bad(`entry ${name} size mismatch`);
    if (crc32(data) !== crc) throw bad(`entry ${name} checksum mismatch`);
    out.set(name, data);
  }
  return out;
}

module.exports = { zip, unzip, crc32 };
