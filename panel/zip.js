'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { Transform, Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');

const bad = msg => Object.assign(new Error(msg), { status: 400 });

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

async function list(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const total = (await fh.stat()).size;
    const tailLen = Math.min(total, 65557 + 22);
    const tail = await readAt(fh, total - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw bad('this is not a zip file');
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOffset = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = e - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw bad('this zip is damaged');
      const z64 = await readAt(fh, Number(tail.readBigUInt64LE(loc + 8)), 56);
      if (z64.length < 56 || z64.readUInt32LE(0) !== 0x06064b50) throw bad('this zip is damaged');
      count = Number(z64.readBigUInt64LE(32)); cdSize = Number(z64.readBigUInt64LE(40)); cdOffset = Number(z64.readBigUInt64LE(48));
    }
    if (cdSize > 256 * 1024 * 1024) throw bad('this zip has too many files');
    const cd = await readAt(fh, cdOffset, cdSize);
    const out = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw bad('this zip is damaged');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + len;
      }
      out.push({ name, dir: name.endsWith('/'), size, csize, method, offset, encrypted: !!(flags & 1) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally { await fh.close(); }
}

async function dataStart(fh, entry) {
  const h = await readAt(fh, entry.offset, 30);
  if (h.length < 30 || h.readUInt32LE(0) !== 0x04034b50) throw bad('this zip is damaged');
  return entry.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

function inflater(entry) {
  if (entry.encrypted) throw bad('this zip is password protected');
  if (entry.method !== 0 && entry.method !== 8) throw bad(`this zip uses a compression method I do not know (${entry.method})`);
  let n = 0;
  const limit = new Transform({
    transform(chunk, enc, cb) {
      n += chunk.length;
      if (n > entry.size) return cb(bad('a file in the zip is bigger than the zip says'));
      cb(null, chunk);
    },
    flush(cb) { cb(n === entry.size ? null : bad('a file in the zip is shorter than the zip says')); },
  });
  return { first: entry.method === 8 ? zlib.createInflateRaw() : null, last: limit };
}

async function streamEntry(fh, file, entry, dest) {
  const { first, last } = inflater(entry);
  const start = await dataStart(fh, entry);
  const src = entry.csize === 0 ? Readable.from([]) : fs.createReadStream(file, { start, end: start + entry.csize - 1 });
  await pipeline(...[src, first, last, dest].filter(Boolean));
}

async function read(file, name, max = 1024 * 1024) {
  const entry = (await list(file)).find(e => e.name === name && !e.dir);
  if (!entry) return null;
  if (entry.size > max) throw bad(`${name} in the zip is too big`);
  const chunks = [];
  const fh = await fsp.open(file, 'r');
  try {
    await streamEntry(fh, file, entry, new Writable({ write(c, e, cb) { chunks.push(c); cb(); } }));
  } finally { await fh.close(); }
  return Buffer.concat(chunks);
}

const unsafe = n => n.startsWith('/') || n.includes('\\') || n.includes('\0') || /(^|\/)\.\.(\/|$)/.test(n) || /^[A-Za-z]:/.test(n);

async function extract(file, dir, { strip = 0, prefix = '' } = {}) {
  const entries = await list(file);
  const fh = await fsp.open(file, 'r');
  const root = path.resolve(dir);
  try {
    for (const e of entries) {
      if (unsafe(e.name)) throw bad('the zip contains unsafe file names');
      if (prefix && !e.name.startsWith(prefix)) continue;
      const parts = e.name.slice(prefix.length).split('/').filter(Boolean).slice(strip);
      if (!parts.length) continue;
      const target = path.resolve(root, ...parts);
      if (target !== root && !target.startsWith(root + path.sep)) throw bad('the zip contains unsafe file names');
      if (e.dir) { await fsp.mkdir(target, { recursive: true }); continue; }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await streamEntry(fh, file, e, fs.createWriteStream(target));
    }
  } finally { await fh.close(); }
}

module.exports = { list, read, extract, unsafe };
