'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32js(buf, prev = 0) {
  let c = ~prev >>> 0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev = 0) => zlib.crc32(buf, prev) : crc32js;

function dos(ms) {
  const d = new Date(ms);
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

async function walk(dir, skip, rel = '', out = []) {
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (skip(r, e)) continue;
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dir, r);
    if (e.isDirectory()) {
      out.push({ rel: r + '/', abs, dir: true, mtime: (await fsp.stat(abs)).mtimeMs });
      await walk(dir, skip, r, out);
    } else if (e.isFile()) out.push({ rel: r, abs, dir: false, mtime: (await fsp.stat(abs)).mtimeMs });
  }
  return out;
}

async function* generate(dir, rootName, skip) {
  const files = await walk(dir, skip);
  let offset = 0;
  const central = [];
  const out = b => { offset += b.length; return b; };
  const items = rootName ? [{ rel: rootName + '/', dir: true, mtime: Date.now() }, ...files.map(f => ({ ...f, rel: rootName + '/' + f.rel }))] : files;
  for (const f of items) {
    const name = Buffer.from(f.rel, 'utf8');
    const { time, date } = dos(f.mtime);
    const start = offset;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(f.dir ? 0x0800 : 0x0808, 6);
    lh.writeUInt16LE(f.dir ? 0 : 8, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt16LE(name.length, 26);
    yield out(Buffer.concat([lh, name]));
    let crc = 0, size = 0, csize = 0;
    if (!f.dir) {
      const raw = fs.createReadStream(f.abs);
      const deflate = zlib.createDeflateRaw({ level: 1 });
      raw.on('data', c => { crc = crc32(c, crc); size += c.length; });
      raw.on('error', e => deflate.destroy(e));
      raw.pipe(deflate);
      for await (const c of deflate) { csize += c.length; yield out(c); }
      if (size >= 0xffffffff || csize >= 0xffffffff) throw new Error(f.rel + ' is too big for this zip writer');
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(size, 12);
      yield out(dd);
    }
    central.push({ name, time, date, crc, csize, size, offset: start, dir: f.dir });
  }
  const cdStart = offset;
  for (const c of central) {
    const big = c.offset >= 0xffffffff;
    const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
    if (big) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(c.offset), 4); }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(big ? 45 : 20, 4); ch.writeUInt16LE(big ? 45 : 20, 6); ch.writeUInt16LE(c.dir ? 0x0800 : 0x0808, 8);
    ch.writeUInt16LE(c.dir ? 0 : 8, 10); ch.writeUInt16LE(c.time, 12); ch.writeUInt16LE(c.date, 14);
    ch.writeUInt32LE(c.crc, 16); ch.writeUInt32LE(c.csize, 20); ch.writeUInt32LE(c.size, 24); ch.writeUInt16LE(c.name.length, 28); ch.writeUInt16LE(extra.length, 30);
    if (c.dir) ch.writeUInt32LE(0x10, 38);
    ch.writeUInt32LE(big ? 0xffffffff : c.offset, 42);
    yield out(Buffer.concat([ch, c.name, extra]));
  }
  const cdSize = offset - cdStart;
  const n = central.length;
  if (n >= 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(n), 24); z.writeBigUInt64LE(BigInt(n), 32); z.writeBigUInt64LE(BigInt(cdSize), 40); z.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(offset), 8); loc.writeUInt32LE(1, 16);
    yield out(Buffer.concat([z, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(n, 0xffff), 8); end.writeUInt16LE(Math.min(n, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdSize, 0xffffffff), 12); end.writeUInt32LE(Math.min(cdStart, 0xffffffff), 16);
  yield out(end);
}

const zipFolder = (dir, rootName, skip = () => false) => Readable.from(generate(dir, rootName, skip));

module.exports = { zipFolder, crc32 };
