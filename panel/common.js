'use strict';
const fs = require('fs');
const fsp = fs.promises;
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const zip = require('./zip');

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const run = (cmd, args, opt = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 15000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opt }, (err, stdout, stderr) => {
    if (err) return reject(Object.assign(new Error(err.code === 'ENOENT' ? `the "${path.basename(cmd)}" program is not installed on this computer` : (stderr || err.message).trim().split('\n')[0]), { status: 502 }));
    resolve(stdout);
  });
});

const getProp = (text, key, def) => { const m = text.match(new RegExp('^' + key + '=(.*)$', 'm')); return m ? m[1].trim() : def; };
const setProp = (text, key, val) => {
  const re = new RegExp('^' + key + '=.*$', 'm');
  return re.test(text) ? text.replace(re, () => key + '=' + val) : text.trimEnd() + '\n' + key + '=' + val + '\n';
};
const levelName = text => path.basename(getProp(text, 'level-name', 'world')) || 'world';

async function readBuffer(req, max) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > max) fail(413, 'request too big'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  try { return (req.parsed = JSON.parse((await readBuffer(req, 65536)).toString('utf8') || '{}')); } catch (e) { if (e.status) throw e; fail(400, 'bad request'); }
}

async function receive(req, dest, max, needZip) {
  const tmp = dest + '.part-' + crypto.randomBytes(4).toString('hex');
  let n = 0, head = Buffer.alloc(0);
  const count = new Transform({
    transform(chunk, enc, cb) {
      n += chunk.length;
      if (n > max) return cb(Object.assign(new Error('file too big'), { status: 413 }));
      if (head.length < 4) head = Buffer.concat([head, chunk]).subarray(0, 4);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, count, fs.createWriteStream(tmp, { flags: 'wx' }));
    if (needZip === 'gzip') { if (head[0] !== 0x1f || head[1] !== 0x8b) fail(400, 'that is not a .tar.gz file'); }
    else if (needZip && head.toString('latin1') !== 'PK\x03\x04') fail(400, 'that is not a .jar (zip) file');
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

function varint(n) {
  const b = [];
  do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n);
  return Buffer.from(b);
}
function readVarint(buf, off) {
  let v = 0, shift = 0;
  for (let i = off; i < buf.length && shift < 35; i++, shift += 7) {
    v |= (buf[i] & 0x7f) << shift;
    if (!(buf[i] & 0x80)) return { value: v, end: i + 1 };
  }
  return null;
}
function ping(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.connect(port, host);
    let buf = Buffer.alloc(0);
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(2500, () => done(null));
    s.on('error', () => done(null));
    s.on('connect', () => {
      const hostB = Buffer.from(host);
      const p = Buffer.alloc(2); p.writeUInt16BE(port);
      const handshake = Buffer.concat([varint(0), varint(-1), varint(hostB.length), hostB, p, varint(1)]);
      s.write(Buffer.concat([varint(handshake.length), handshake, varint(1), varint(0)]));
    });
    s.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      const len = readVarint(buf, 0);
      if (!len || buf.length < len.end + len.value) return;
      try {
        const id = readVarint(buf, len.end);
        const str = readVarint(buf, id.end);
        const j = JSON.parse(buf.toString('utf8', str.end, str.end + str.value));
        done({
          online: j.players?.online ?? 0,
          max: j.players?.max ?? 0,
          names: (j.players?.sample || []).map(p => p.name),
          version: j.version?.name || '',
        });
      } catch { done(null); }
    });
  });
}

const UA = 'minecraft-panel/1.0 (personal server panel)';

async function getJson(url, { headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }), ...headers },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch { fail(502, 'could not reach the site (is this computer online?)'); }
  if (res.status === 404) fail(404, 'not found on the site');
  if (res.status === 401 || res.status === 403) fail(502, 'the site refused the request (is the API key right?)');
  if (!res.ok) fail(502, 'the site answered ' + res.status);
  return res.json();
}

async function downloadVerified(url, dest, { hash, hostOk, max, allowHttp = false }) {
  let u;
  try { u = new URL(url); } catch { fail(502, 'bad download link'); }
  if (!hostOk(u.hostname) || (u.protocol !== 'https:' && !allowHttp)) fail(502, 'the download link points to an unexpected place (' + u.hostname + '), refused');
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20 * 60 * 1000) }); } catch { fail(502, 'the download failed'); }
  if (!res.ok || !res.body) fail(502, 'the download failed (' + res.status + ')');
  if (!hostOk(new URL(res.url).hostname)) fail(502, 'the download was redirected to an unexpected place, refused');
  const sum = crypto.createHash(hash?.algo || 'sha1');
  const sha1 = crypto.createHash('sha1');
  let n = 0;
  const count = new Transform({
    transform(chunk, enc, cb) {
      n += chunk.length;
      if (n > max) return cb(Object.assign(new Error('file too big'), { status: 413 }));
      sum.update(chunk);
      sha1.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(require('stream').Readable.fromWeb(res.body), count, fs.createWriteStream(dest, { flags: 'wx' }));
    if (hash && sum.digest('hex') !== String(hash.hex).toLowerCase()) fail(502, 'the download does not match its checksum, thrown away');
  } catch (e) { await fsp.rm(dest, { force: true }); throw e; }
  return sha1.digest('hex');
}

async function lookupUuid(name) {
  const api = process.env.MOJANG_API || 'https://api.mojang.com';
  let r;
  try { r = await fetch(`${api}/users/profiles/minecraft/${encodeURIComponent(name)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }); } catch { fail(502, 'could not reach Mojang to look the name up (is this computer online?). Start the server and try again, or check the connection.'); }
  if (r.status === 404 || r.status === 204) fail(404, `no Minecraft account is called "${name}"`);
  if (!r.ok) fail(502, 'Mojang answered ' + r.status + ' when looking up the name');
  const j = await r.json().catch(() => ({}));
  if (!/^[0-9a-f]{32}$/i.test(String(j.id)) || !/^\w{3,16}$/.test(String(j.name))) fail(502, 'Mojang sent an answer I do not understand');
  return { uuid: dashed(j.id), name: j.name };
}
const dashed = id => id.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return dashed(h.toString('hex'));
}

async function dirSize(dir) {
  let n = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? await dirSize(p) : (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return n;
}

async function shareLog(text) {
  const api = process.env.MCLOGS_API || 'https://api.mclo.gs';
  const lines = text.split('\n');
  const body = new URLSearchParams({ content: lines.slice(-20000).join('\n').slice(-5 * 1024 * 1024) });
  let r;
  try { r = await fetch(api + '/1/log', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20000) }); } catch { fail(502, 'could not reach mclo.gs (is this computer online?)'); }
  const j = await r.json().catch(() => ({}));
  if (!j.success || typeof j.url !== 'string') fail(502, 'mclo.gs did not take the log' + (j.error ? ': ' + j.error : ''));
  if (!process.env.MCLOGS_API && new URL(j.url).hostname !== 'mclo.gs') fail(502, 'mclo.gs sent an unexpected address, ignored');
  return j.url;
}

const vnum = s => (String(s).match(/^(\d+)\.(\d+)(?:\.(\d+))?/) || []).slice(1).map(x => Number(x || 0));
const vcmp = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

async function modInfo(jar) {
  let names;
  try { names = (await zip.list(jar)).map(e => e.name); } catch { return { kind: 'broken' }; }
  if (names.includes('fabric.mod.json')) {
    try {
      const j = JSON.parse((await zip.read(jar, 'fabric.mod.json')).toString('utf8'));
      return { kind: 'fabric', id: String(j.id || ''), name: String(j.name || j.id || '') };
    } catch { return { kind: 'fabric', id: '', name: '' }; }
  }
  if (names.includes('META-INF/neoforge.mods.toml')) return { kind: 'neoforge' };
  if (names.includes('META-INF/mods.toml')) return { kind: 'forge' };
  const yml = ['plugin.yml', 'paper-plugin.yml'].find(n => names.includes(n));
  if (yml) {
    let id = '';
    try { id = (/^name:\s*['"]?([^'"\r\n]+)/m.exec((await zip.read(jar, yml)).toString('utf8')) || [])[1] || ''; } catch { }
    return { kind: 'plugin', id: id.trim().toLowerCase(), name: id.trim() };
  }
  return { kind: 'unknown' };
}

const infoCache = new Map();
async function installedIds(dir) {
  const out = new Map();
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!/\.jar(\.disabled)?$/.test(f)) continue;
    const st = await fsp.stat(path.join(dir, f));
    const key = path.join(dir, f) + ':' + st.size + ':' + st.mtimeMs;
    let info = infoCache.get(key);
    if (!info) { info = await modInfo(path.join(dir, f)); infoCache.set(key, info); }
    if (info.id) out.set(info.id, f);
  }
  return out;
}

module.exports = { fail, run, TAR, getProp, setProp, levelName, readBuffer, readJson, receive, ping, varint, readVarint, getJson, downloadVerified, vnum, vcmp, modInfo, installedIds, lookupUuid, offlineUuid, dirSize, shareLog };
