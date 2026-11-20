'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-'));
fs.mkdirSync(path.join(root, 'mods'));
fs.mkdirSync(path.join(root, 'world'));
fs.writeFileSync(path.join(root, 'world', 'level.dat'), 'x');
fs.writeFileSync(path.join(root, 'server.properties'), 'level-name=world\nwhite-list=true\nenforce-whitelist=true\n');
Object.assign(process.env, {
  MC_DIR: root, MC_SERVERS_DIR: root + '-servers', PANEL_DATA: root + '-data', MC_JAVA_DIR: root + '-java', PANEL_MIN_FREE_GB: '0', PANEL_FAKE: '1', PORT: '18790',
  MODRINTH_API: 'http://127.0.0.1:18795', CURSEFORGE_API: 'http://127.0.0.1:18795/cf', CURSEFORGE_KEY: 'test-key', PANEL_TEST_HOSTS: '127.0.0.1',
  MOJANG_API: 'http://127.0.0.1:18795/mojang', MCLOGS_API: 'http://127.0.0.1:18795/mclogs', GEYSER_API: 'http://127.0.0.1:18795/geyser', BEDROCK_API: 'http://127.0.0.1:18795/bedrock/links', ALERT_TEST_BASE: 'http://127.0.0.1:18795/alerts', DOCTOR_URLS: 'http://127.0.0.1:18795/ok',
});
const { start, ping, registry } = require('./server');
const { encodeMotd, decodeMotd } = require('./registry');
const crypto = require('crypto');
const http = require('http');
const zlib = require('zlib');

const base = 'http://127.0.0.1:18790';
let cookie = '';
let stubApi;
async function call(method, url, body, headers = {}) {
  const h = { 'X-Panel': '1', ...(cookie && { Cookie: cookie }), ...headers };
  let payload = body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(base + url, { method, headers: h, body: payload });
  const buf = Buffer.from(await r.arrayBuffer());
  let json;
  try { json = JSON.parse(buf.toString()); } catch { }
  return { status: r.status, json, buf, headers: r.headers };
}
const seen = { downloads: [], search: '', cfKey: '', cfQuery: '', mojang: [], logBody: '', logFail: false, updateFor: {}, alerts: [], geyserBad: false };
let n = 0;
const ok = name => console.log('ok', ++n, name);
const vi = v => { const b = []; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; b.push(x); } while (v); return Buffer.from(b); };

async function main() {
  const server = start();
  await new Promise(r => setTimeout(r, 200));

  assert.equal((await call('GET', '/api/status')).status, 401); ok('status needs access');
  const hello = await call('GET', '/api/hello');
  assert.equal(hello.status, 200); assert.equal(hello.json.panel, 'server-panel'); assert.deepEqual(Object.keys(hello.json).sort(), ['panel', 'version']); ok('the phone app can recognise a panel before it has access (and learns nothing else)');
  const font = await call('GET', '/fonts/dm-sans-latin.woff2');
  assert.equal(font.status, 200); assert.equal(font.headers.get('content-type'), 'font/woff2'); assert.equal(font.buf.toString('latin1', 0, 4), 'wOF2'); assert.match(font.headers.get('content-security-policy'), /font-src 'self'/);
  assert.equal((await call('GET', '/fonts/nope.woff2')).status, 404); assert.equal((await call('GET', '/fonts/../server.js')).status, 404); ok('the panel serves its own fonts, and only those');
  let door = await call('GET', '/api/me');
  assert.equal(door.status, 401); assert.equal(door.json.setup, true); assert.equal(door.json.state, 'none'); assert.equal(door.json.here, true); ok('a panel nobody owns yet says so (and that this computer can claim it)');
  assert.equal((await call('POST', '/api/access/ask', { name: 'Early bird' })).status, 409); ok('nobody can ask for access before there is an owner');
  assert.equal((await call('POST', '/api/access/redeem', { code: 'AAAA-AAAA-AAAA', name: 'x' })).status, 403); ok('a wrong setup code is refused');
  assert.equal((await call('POST', '/api/access/redeem', { code: 'x', name: 'x' }, { 'X-Panel': '' })).status, 403); ok('missing X-Panel header refused');
  const setupCode = fs.readFileSync(root + '-data/setup-code.txt', 'utf8').trim();
  assert.match(setupCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const claim = await call('POST', '/api/access/redeem', { code: setupCode.toLowerCase().replace(/-/g, ' '), name: 'Owner One' });
  assert.equal(claim.status, 200, JSON.stringify(claim.json)); assert.equal(claim.json.owner, true);
  cookie = claim.headers.get('set-cookie').split(';')[0];
  assert.match(claim.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.ok(!fs.existsSync(root + '-data/setup-code.txt'));
  assert.equal((await call('POST', '/api/access/redeem', { code: setupCode, name: 'Again' }, { Cookie: '' })).status, 403); ok('the setup code makes the owner once; the cookie is strict; the code is gone');
  assert.equal((await call('GET', '/api/me')).json.owner, true);

  let st = (await call('GET', '/api/status')).json;
  assert.equal(st.state, 'active'); assert.equal(st.whitelist, true); assert.equal(st.game.online, 1); ok('status');
  assert.equal((await call('POST', '/api/command', { line: 'say hi\nstop' })).status, 400); ok('newline in command refused');
  assert.equal((await call('POST', '/api/command', { line: '/say hi' })).status, 200);
  assert.match((await call('GET', '/api/log')).json.text, /\] say hi/); ok('command reaches the console');
  await call('POST', '/api/power', { action: 'stop' });
  assert.equal((await call('POST', '/api/command', { line: 'list' })).status, 409); ok('command to a stopped server -> 409');
  assert.equal((await call('POST', '/api/power', { action: 'format' })).status, 400); ok('unknown power action refused');
  await call('POST', '/api/power', { action: 'start' });

  await call('POST', '/api/whitelist', { on: false });
  assert.match(fs.readFileSync(path.join(root, 'server.properties'), 'utf8'), /^white-list=false$/m);
  assert.equal((await call('GET', '/api/status')).json.whitelist, false); ok('whitelist off is saved');
  assert.equal((await call('POST', '/api/player', { action: 'op', name: 'x; stop' })).status, 400); ok('bad player name refused');
  await call('POST', '/api/player', { action: 'whitelist-add', name: 'Alex' });
  assert.deepEqual((await call('GET', '/api/players')).json.whitelist, ['Alex']); ok('add to whitelist');

  assert.equal((await call('PUT', '/api/mods?name=../evil.jar', Buffer.from('PK\x03\x04'))).status, 400); ok('mod name with .. refused');
  assert.equal((await call('PUT', '/api/mods?name=fake.jar', Buffer.from('hello'))).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(root, 'mods')), []); ok('non-zip mod refused, nothing left behind');
  assert.equal((await call('PUT', '/api/mods?name=cool-mod-1.0.jar', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(50)]))).status, 200);
  assert.equal((await call('GET', '/api/mods')).json.mods[0].enabled, true);
  await call('POST', '/api/mods/toggle', { name: 'cool-mod-1.0.jar' });
  assert.equal((await call('GET', '/api/mods')).json.mods[0].enabled, false);
  await call('DELETE', '/api/mods?name=cool-mod-1.0.jar');
  assert.equal((await call('GET', '/api/mods')).json.mods.length, 0); ok('mod upload, turn off, delete');

  for (const bad of ['../../etc/passwd', '/etc/hosts', 'world/../../x', ...(path.sep === '\\' ? ['..\\..\\x'] : [])]) {
    assert.equal((await call('GET', '/api/file?path=' + encodeURIComponent(bad))).status, 400);
  }
  ok('paths outside the server folder refused');
  assert.equal((await call('POST', '/api/mkdir', { path: 'config' })).status, 200);
  assert.equal((await call('PUT', '/api/file?path=config/a.txt', Buffer.from('hello'))).status, 200);
  assert.equal((await call('GET', '/api/file?path=config/a.txt')).json.text, 'hello');
  assert.equal((await call('GET', '/api/download?path=config/a.txt')).buf.toString(), 'hello');
  assert.ok((await call('GET', '/api/files?path=config')).json.entries.some(e => e.name === 'a.txt'));
  assert.equal((await call('PUT', '/api/file?path=nope/a.txt', Buffer.from('x'))).status, 404);
  assert.equal((await call('DELETE', '/api/file?path=')).status, 400); ok('files: create, read, download, list, root protected');
  assert.equal((await call('DELETE', '/api/file?path=world')).status, 409); ok('world cannot be deleted while the game runs');
  await call('DELETE', '/api/file?path=config');
  assert.equal(fs.existsSync(path.join(root, 'config')), false);
  try {
    fs.symlinkSync(os.tmpdir(), path.join(root, 'link'), 'junction');
    assert.equal((await call('GET', '/api/files?path=link')).status, 400); ok('symlink out of the folder refused');
  } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EEXIST') throw e; console.log('skip symlink test'); }

  const bk = await call('GET', '/api/backup');
  assert.equal(bk.status, 200); assert.deepEqual([...bk.buf.subarray(0, 2)], [0x1f, 0x8b]);
  assert.match((await call('GET', '/api/log')).json.text, /save-on/); ok('backup is a gzip and saving is switched back on');
  const both = await Promise.all([call('GET', '/api/backup'), call('GET', '/api/backup')]);
  assert.deepEqual(both.map(b => b.status), [200, 200]);
  let saves = [];
  for (let i = 0; i < 20; i++) {
    saves = (await call('GET', '/api/log?n=1000')).json.text.match(/save-(?:on|off)/g).slice(-4);
    if (saves.join() === 'save-off,save-on,save-off,save-on') break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.deepEqual(saves, ['save-off', 'save-on', 'save-off', 'save-on']); ok('two backups at once run one after the other');

  await extras();
  await servers();
  await bedrockTests();
  await accessTests();

  stubApi.close();
  server.close();
  for (const d of [root, root + '-servers', root + '-data']) fs.rmSync(d, { recursive: true, force: true });
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameB = Buffer.from(name), data = Buffer.from(content), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, nameB, data);
    central.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22), n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const tstr = s => { const b = Buffer.from(s); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
const tint = v => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const tag = (type, name, payload) => Buffer.concat([Buffer.from([type]), tstr(name), payload]);
const levelDat = (version, name) => zlib.gzipSync(tag(10, '', Buffer.concat([
  tag(10, 'Data', Buffer.concat([
    tag(8, 'LevelName', tstr(name)),
    tag(10, 'Version', Buffer.concat([tag(8, 'Name', tstr(version)), tag(3, 'Id', tint(3700)), Buffer.from([0])])),
    tag(7, 'Skipped', Buffer.concat([tint(3), Buffer.from([1, 2, 3])])),
    Buffer.from([0]),
  ])),
  Buffer.from([0]),
])));
const fabricJar = (id, extra = '') => makeZip({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, name: 'Mod ' + id, version: '1.0' }), 'x.txt': extra });
const pluginJar = (name, ver = '1') => makeZip({ 'plugin.yml': `name: ${name}\nmain: a.B\nversion: ${ver}` });
const UP2 = pluginJar('UpPlugin', '2');
const forgeJar = () => makeZip({ 'META-INF/mods.toml': 'modLoader="javafml"' });
const sha = (algo, buf) => crypto.createHash(algo).update(buf).digest('hex');
const player = (n, uuid) => ({ uuid, name: n });

async function extras() {
  const files = {
    '/files/cool-1.0.jar': fabricJar('cool', 'one'), '/files/cool-1.1.jar': fabricJar('cool', 'two'),
    '/files/lib-2.0.jar': fabricJar('lib'), '/files/cf-1.0.jar': fabricJar('cfmod'), '/files/forge.jar': forgeJar(), '/files/up-2.0.jar': UP2, '/files/bluemap-5.jar': pluginJar('BlueMap', '5'), '/files/chunky-1.jar': pluginJar('Chunky', '1'), '/files/spark-1.jar': fabricJar('spark'),
    '/files/geyser-fabric.jar': fabricJar('geyser'), '/files/floodgate-fabric.jar': fabricJar('floodgate'),
    '/files/bedrock-server-1.26.63.1.zip': makeZip({ 'bedrock_server': 'ELF stub', 'bedrock_server.exe': 'MZ stub', 'server.properties': 'server-name=Dedicated Server\ngamemode=survival\nview-distance=32\ntick-distance=4\nlevel-name=Bedrock level\nonline-mode=true\ntransport=nethernet\nenable-lan-visibility=true\n', 'allowlist.json': '[]', 'permissions.json': '[]', 'behavior_packs/a.txt': 'x' }),
    '/files/geyser-spigot.jar': pluginJar('Geyser-Spigot'), '/files/floodgate-spigot.jar': pluginJar('floodgate'),
    '/files/dp-1.zip': makeZip({ 'pack.mcmeta': '{"pack":{"pack_format":48,"description":"x"}}', 'data/x/function/a.mcfunction': 'say hi' }), '/files/notpack.zip': makeZip({ 'readme.txt': 'x' }),
  };
  const v = (project, name, over = {}) => ({ project_id: project, version_type: 'release', dependencies: [], files: [{ primary: true, filename: name, url: `http://127.0.0.1:18795/files/${name}`, hashes: { sha512: sha('sha512', files['/files/' + name] || Buffer.alloc(0)) } }], ...over });
  let coolVersion = 'cool-1.0.jar';
  const api = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (files[u.pathname]) { seen.downloads.push(u.pathname); res.writeHead(200); return res.end(files[u.pathname]); }
    if (u.pathname === '/files/lies.jar') { res.writeHead(200); return res.end(fabricJar('lies')); }
    if (u.pathname === '/search') { seen.search = u.search; return send({ hits: [{ slug: 'cool', project_id: 'AAA', title: 'Cool', description: 'd', author: 'me', downloads: 5 }] }); }
    const m = /^\/project\/([\w-]+)\/version$/.exec(u.pathname);
    if (u.pathname.startsWith('/mojang/users/profiles/minecraft/')) {
      const name = decodeURIComponent(u.pathname.split('/').pop());
      seen.mojang.push(name);
      if (name === 'Ghost_9') { res.writeHead(404); return res.end(); }
      return send({ id: sha('md5', name), name });
    }
    if (u.pathname === '/bedrock/links') return send({ result: { links: ['Windows', 'Linux'].map(os => ({ downloadType: 'serverBedrock' + os, downloadUrl: 'http://127.0.0.1:18795/files/bedrock-server-1.26.63.1.zip' })) } });
    if (u.pathname === '/mclogs/1/log' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { seen.logBody = new URLSearchParams(body).get('content'); send(seen.logFail ? { success: false, error: 'too big' } : { success: true, id: 'abc123', url: 'https://mclo.gs/abc123' }); });
      return;
    }
    if (u.pathname === '/version_files/update' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { const out = {}; for (const h of JSON.parse(body).hashes) if (seen.updateFor[h]) out[h] = seen.updateFor[h]; send(out); });
      return;
    }
    if (u.pathname.startsWith('/geyser/v2/projects/')) {
      const parts = u.pathname.split('/');
      const p = parts[4];
      if (parts[6] === 'latest') { res.writeHead(302, { location: '/geyser/v2/projects/' + p + '/versions/1.0/builds/5' }); return res.end(); }
      if (parts[9] === 'downloads') { res.writeHead(200); return res.end(files['/files/' + p + '-spigot.jar']); }
      return send({ project_id: p, version: '1.0', build: 5, downloads: { spigot: { name: p === 'geyser' ? 'Geyser-Spigot.jar' : 'floodgate-spigot.jar', sha256: p === 'floodgate' && seen.geyserBad ? 'ab'.repeat(32) : sha('sha256', files['/files/' + p + '-spigot.jar']) } } });
    }
    if (u.pathname.startsWith('/alerts/') && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { seen.alerts.push({ to: u.pathname.slice(8), body }); res.writeHead(204); res.end(); });
      return;
    }
    if (m) {
      if (m[1] === 'dpack' || m[1] === 'fakepack') assert.equal(u.searchParams.get('loaders'), '["datapack"]');
      else if (m[1] === 'bluemap' || m[1] === 'chunky' || m[1] === 'spark') { }
      else if (m[1] !== 'testpack') { assert.equal(u.searchParams.get('game_versions'), '["26.3"]'); assert.equal(u.searchParams.get('loaders'), '["fabric"]'); }
      const table = {
        geyser: [v('GEY', 'geyser-fabric.jar')], floodgate: [v('FLD', 'floodgate-fabric.jar')], bluemap: [v('BM1', 'bluemap-5.jar')], chunky: [v('CHK', 'chunky-1.jar')], spark: [v('SPK', 'spark-1.jar')], dpack: [v('DDD', 'dp-1.zip')], fakepack: [v('EEE', 'notpack.zip')],
        cool: [v('AAA', coolVersion, { dependencies: [{ project_id: 'BBB', dependency_type: 'required' }, { project_id: 'CCC', dependency_type: 'optional' }] })],
        BBB: [v('BBB', 'lib-2.0.jar')],
        liar: [v('LLL', 'lies.jar', { files: [{ primary: true, filename: 'lies.jar', url: 'http://127.0.0.1:18795/files/lies.jar', hashes: { sha512: 'ab'.repeat(64) } }] })],
        forgey: [v('FFF', 'forge.jar')],
        stranger: [v('SSS', 'x.jar', { files: [{ primary: true, filename: 'x.jar', url: 'https://evil.example/x.jar', hashes: { sha512: 'ab'.repeat(64) } }] })],
        nothing: [],
        testpack: [{ project_id: 'PPP', version_type: 'release', name: 'Test Pack 1.0', dependencies: [], files: [{ primary: true, filename: 'pack.zip', url: 'https://cdn.modrinth.com/data/x/pack.zip', hashes: { sha1: 'ab'.repeat(20), sha512: 'cd'.repeat(64) } }] }],
      };
      return table[m[1]] ? send(table[m[1]]) : send({ error: 'not_found' }, 404);
    }
    if (u.pathname.startsWith('/cf/')) {
      seen.cfKey = req.headers['x-api-key']; seen.cfQuery = u.search;
      if (u.pathname === '/cf/v1/mods/search') return send({ data: [{ id: 111, name: 'CF Mod', summary: 's', authors: [{ name: 'a' }], downloadCount: 9, allowModDistribution: true }] });
      if (u.pathname === '/cf/v1/mods/111/files') return send({ data: [{ id: 1, fileName: 'cf-1.0.jar', downloadUrl: 'http://127.0.0.1:18795/files/cf-1.0.jar', releaseType: 1, fileDate: '2026-01-01T00:00:00Z', hashes: [{ value: sha('sha1', files['/files/cf-1.0.jar']), algo: 1 }], dependencies: [{ modId: 222, relationType: 3 }, { modId: 223, relationType: 2 }] }] });
      if (u.pathname === '/cf/v1/mods/222/files' || u.pathname === '/cf/v1/mods/333/files') return send({ data: [{ id: 2, fileName: 'blocked.jar', downloadUrl: null, releaseType: 1, fileDate: '2026-01-01T00:00:00Z', hashes: [] }] });
      if (u.pathname === '/cf/v1/mods/222' || u.pathname === '/cf/v1/mods/333') return send({ data: { name: 'Blocked Mod', links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/blocked' } } });
    }
    send({ error: 'not_found' }, 404);
  });
  await new Promise(r => api.listen(18795, '127.0.0.1', r));
  const mods = () => fs.readdirSync(path.join(root, 'mods')).sort();
  const find = (src, id) => call('POST', '/api/find/install', { src, id });

  const s = await call('GET', '/api/find?src=modrinth&q=cool');
  assert.equal(s.json.results[0].title, 'Cool');
  assert.ok(decodeURIComponent(seen.search).includes('"versions:26.3"') && decodeURIComponent(seen.search).includes('"categories:fabric"')); ok('Modrinth search asks for Fabric + this Minecraft version');
  let r = await find('modrinth', 'https://modrinth.com/mod/cool/versions');
  assert.equal(r.status, 200);
  assert.deepEqual(mods(), ['cool-1.0.jar', 'lib-2.0.jar']); ok('Modrinth install adds the mod and the dependency it needs (not the optional one)');
  seen.downloads.length = 0;
  r = await find('modrinth', 'cool');
  assert.ok(!seen.downloads.includes('/files/lib-2.0.jar')); ok('a dependency that is already installed is not downloaded again');
  coolVersion = 'cool-1.1.jar';
  r = await find('modrinth', 'cool');
  assert.deepEqual(mods(), ['cool-1.1.jar', 'lib-2.0.jar']); assert.equal(r.json.done.find(d => d.name === 'cool-1.1.jar').status, 'updated'); ok('a newer version replaces the old file');
  assert.equal((await find('modrinth', 'liar')).status, 502);
  assert.equal((await find('modrinth', 'forgey')).status, 502);
  assert.equal((await find('modrinth', 'stranger')).status, 502);
  assert.equal((await find('modrinth', 'nothing')).status, 404);
  assert.equal((await find('modrinth', 'not a link!')).status, 400);
  assert.deepEqual(mods(), ['cool-1.1.jar', 'lib-2.0.jar']); ok('wrong checksum, non-Fabric file, unknown download host, no version, bad input: all refused, nothing left behind');
  fs.rmSync(path.join(root, 'mods'), { recursive: true }); fs.mkdirSync(path.join(root, 'mods'));

  r = await call('GET', '/api/find?src=curseforge&q=cf');
  assert.equal(r.json.results[0].title, 'CF Mod'); assert.equal(seen.cfKey, 'test-key');
  assert.match(seen.cfQuery, /gameId=432/); assert.match(seen.cfQuery, /modLoaderType=4/); assert.match(seen.cfQuery, /gameVersion=26\.3/); ok('CurseForge search sends the key, game, loader and version');
  r = await find('curseforge', '111');
  assert.deepEqual(mods(), ['cf-1.0.jar']); assert.equal(r.json.warnings.length, 1); assert.match(r.json.warnings[0], /Blocked Mod/); ok('CurseForge install checks the SHA-1; a dependency the author blocks is a warning, not a failure');
  r = await find('curseforge', '333');
  assert.equal(r.status, 409); assert.match(r.json.error, /does not allow downloads/); ok('a blocked mod says where to get it');
  assert.equal((await find('curseforge', 'hello')).status, 400);
  stubApi = api;

  const props = 'difficulty=hard\ngamemode=creative\nserver-port=1234\nonline-mode=true\nmotd=hi\nwhite-list=true\n';
  const U1 = '11111111-1111-1111-1111-111111111111';
  const good = makeZip({
    'world/level.dat': levelDat('1.20.4', 'AternosWorld'), 'world/region/r.0.0.mca': 'region', 'world/session.lock': 'lock',
    'server.properties': props, 'whitelist.json': JSON.stringify([player('Zoe', U1), player('Alex', '33333333-3333-3333-3333-333333333333')]), 'ops.json': JSON.stringify([player('Zoe', U1)]),
    'mods/okmod.jar': fabricJar('okmod'), 'mods/forgemod.jar': forgeJar(), 'config/okmod.json': '{"a":1}',
  });
  const up = (name, body) => call('PUT', '/api/import?name=' + encodeURIComponent(name), body);
  const stage = root + '-data/import';
  let plan = (await up('aternos.zip', good)).json;
  assert.equal(plan.world.version, '1.20.4'); assert.equal(plan.world.name, 'AternosWorld');
  assert.deepEqual(plan.jars.map(j => j.kind), ['forge', 'fabric']); assert.match(plan.jars[0].text, /Forge/);
  assert.deepEqual(plan.settings, { difficulty: 'hard', gamemode: 'creative' }); assert.deepEqual(plan.whitelist, ['Zoe', 'Alex']);
  assert.equal(plan.detected.software, 'fabric'); assert.equal(plan.detected.mc, '1.20.4'); assert.equal(plan.suggest.software, 'fabric'); assert.equal(plan.suggest.mc, '1.20.4');
  ok('import: the zip is unpacked and understood (world version, Fabric vs Forge mods, safe settings only, which software and version it ran)');

  assert.equal((await call('POST', '/api/power', { action: 'start' })).status, 200);
  let ap = await call('POST', '/api/import/apply', { id: plan.id, server: 'main', world: true });
  assert.equal(ap.status, 409); ok('import: the world is not touched while the server runs');
  await call('POST', '/api/power', { action: 'stop' });
  ap = await call('POST', '/api/import/apply', { id: plan.id, server: 'main', world: true, settings: true, lists: true, mods: true, config: true });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  assert.match(ap.json.messages[0], /backed up first/); assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 1); ok('import: the world is backed up before it is replaced');
  assert.ok(fs.existsSync(path.join(root, 'world', 'region', 'r.0.0.mca'))); assert.ok(!fs.existsSync(path.join(root, 'world', 'session.lock')));
  const kept = fs.readdirSync(root).find(f => f.startsWith('world.before-import-'));
  assert.ok(kept && fs.existsSync(path.join(root, kept, 'level.dat'))); ok('import: the new world is in place and the old one is kept');
  const sp = fs.readFileSync(path.join(root, 'server.properties'), 'utf8');
  assert.match(sp, /^difficulty=hard$/m); assert.doesNotMatch(sp, /1234/); assert.doesNotMatch(sp, /motd=hi/); assert.match(sp, /^white-list=true$/m); ok('import: only game settings are copied, never the port');
  const wl = JSON.parse(fs.readFileSync(path.join(root, 'whitelist.json')));
  assert.ok(wl.some(p => p.name === 'Zoe' && p.uuid === U1)); assert.equal(wl.filter(p => p.name === 'Alex').length, 1);
  assert.deepEqual(mods(), ['cf-1.0.jar', 'okmod.jar']); assert.ok(fs.existsSync(path.join(root, 'config', 'okmod.json'))); ok('import: whitelist merged, only the Fabric mod copied, config copied');
  assert.ok(!fs.existsSync(path.join(stage, plan.id)));
  assert.equal((await call('POST', '/api/import/apply', { id: plan.id, server: 'main', mods: true })).status, 404); ok('import: a finished import cannot be applied twice');

  assert.equal((await up('evil.zip', makeZip({ '../evil.txt': 'x', 'world/level.dat': 'x' }))).status, 400);
  assert.ok(!fs.existsSync(path.join(root, '..', 'evil.txt')));
  assert.deepEqual(fs.readdirSync(stage), []); ok('import: a zip with ../ paths is refused and leaves nothing behind');
  assert.equal((await up('notes.txt', Buffer.from('x'))).status, 400);
  assert.equal((await up('fake.zip', Buffer.from('not a zip'))).status, 400);
  assert.equal((await up('empty.zip', makeZip({ 'readme.txt': 'hi' }))).status, 400); ok('import: not a zip, wrong extension, nothing useful inside: refused');
  const bed = await up('bedrock.zip', makeZip({ 'My World/level.dat': 'x', 'My World/levelname.txt': 'My World', 'My World/db/CURRENT': 'x' }));
  assert.equal(bed.status, 400); assert.match(bed.json.error, /Bedrock/); ok('import: a Bedrock world is recognised and explained');
  plan = (await up('future.zip', makeZip({ 'world/level.dat': levelDat('27.0', 'Future') }))).json;
  assert.equal((await call('POST', '/api/import/apply', { id: plan.id, server: 'main', world: true })).status, 409);
  await call('DELETE', '/api/import?id=' + plan.id);
  assert.ok(!fs.existsSync(path.join(stage, plan.id))); ok('import: a world from a newer Minecraft is refused, discard cleans up');
  plan = (await up('cracked.zip', makeZip({ 'level.dat': levelDat('1.12.2', 'Old'), 'server.properties': 'online-mode=false\n', 'whitelist.json': JSON.stringify([player('Bob', U1)]) }))).json;
  assert.ok(plan.warnings.some(w => /offline/.test(w))); assert.equal(plan.worldRel, '');
  const before = fs.readFileSync(path.join(root, 'whitelist.json'), 'utf8');
  await call('POST', '/api/import/apply', { id: plan.id, server: 'main', lists: true });
  assert.equal(fs.readFileSync(path.join(root, 'whitelist.json'), 'utf8'), before); ok('import: an offline-mode server\'s player lists are not copied unless you keep offline mode');
  plan = (await up('world-only.zip', makeZip({ 'level.dat': levelDat('1.20.4', 'TopLevel'), 'region/r.0.0.mca': 'r', 'server.properties': 'x=1\n', 'mods/m.jar': fabricJar('m') }))).json;
  assert.equal((await call('POST', '/api/import/apply', { id: plan.id, server: 'main', world: true })).status, 200);
  assert.ok(fs.existsSync(path.join(root, 'world', 'region', 'r.0.0.mca')));
  assert.ok(!fs.existsSync(path.join(root, 'world', 'mods')) && !fs.existsSync(path.join(root, 'world', 'server.properties'))); ok('import: a world zip with level.dat at the top works and leaves server files out of the world');
  await call('POST', '/api/power', { action: 'start' });
}

const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
const png = (w, h) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
};
const U1 = () => '11111111-1111-1111-1111-111111111111';

async function servers() {
  const sv = id => '?server=' + id;
  const create = body => call('POST', '/api/servers', body);
  const settled = async id => {
    for (let i = 0; i < 80; i++) { const s = (await call('GET', '/api/status' + sv(id))).json; if (s.install.state !== 'running') return s; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('install did not finish');
  };
  const power = (id, action) => call('POST', '/api/power' + sv(id), { action });

  let r = await call('GET', '/api/servers');
  assert.deepEqual(r.json.servers.map(s => s.id), ['main']); assert.equal(r.json.servers[0].state, 'active'); ok('the server list starts with the main server');
  assert.deepEqual((await call('GET', '/api/software')).json.software.map(s => s.id), ['vanilla', 'fabric', 'forge', 'neoforge', 'paper', 'purpur', 'bedrock']);
  assert.ok((await call('GET', '/api/software/versions?software=paper')).json.versions.includes('1.21.1')); ok('software and versions are listed');

  const base = { name: 'Creative World', software: 'paper', mc: '1.21.1', motd1: '&aHello', motd2: '&bthere \u00e9', seed: 'abc $& 1', eula: true };
  for (const [bad, status] of [[{ eula: false }, 400], [{ software: 'spigot' }, 400], [{ mc: '1.2.3' }, 400], [{ port: 25565 }, 409], [{ port: 8790 }, 409], [{ port: 80 }, 400], [{ name: '   ' }, 400]]) {
    assert.equal((await create({ ...base, ...bad })).status, status, JSON.stringify(bad));
  }
  assert.deepEqual(fs.existsSync(root + '-servers') ? fs.readdirSync(root + '-servers') : [], []); ok('creating needs the EULA, real software and version, a free port and a name; failures leave nothing behind');
  r = await create(base);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.id;
  assert.equal(id, 'creative-world');
  let st = await settled(id);
  assert.equal(st.install.state, 'done', JSON.stringify(st.install));
  assert.equal(st.softwareLabel, 'Paper'); assert.equal(st.modsDir, 'plugins');
  const writer = registry.get(id);
  await Promise.all(Array.from({ length: 40 }, (_, i) => writer.setInstall({ state: 'running', step: 'step ' + i })));
  assert.equal((await writer.getInstall()).step, 'step 39');
  await writer.setInstall({ state: 'done', step: '' });
  assert.deepEqual(fs.readdirSync(root + '-servers/creative-world').filter(f => f.includes('.tmp')), []); ok('many install updates at once are written in order and leave no temp files');
  const dir = root + '-servers/creative-world';
  const props = fs.readFileSync(dir + '/server.properties', 'utf8');
  assert.match(props, /^motd=\\u00A7aHello\\n\\u00A7bthere \\u00E9$/m);
  assert.match(props, /^server-port=25566$/m); assert.match(props, /^level-seed=abc \$& 1$/m); assert.match(props, /^white-list=true$/m);
  assert.ok(fs.existsSync(dir + '/eula.txt') && fs.existsSync(dir + (process.platform === 'win32' ? '/launch.cmd' : '/launch.sh')), 'dir=' + dir + ' has ' + (fs.existsSync(dir) ? fs.readdirSync(dir).join(',') : 'NOTHING'));
  assert.ok(JSON.parse(fs.readFileSync(dir + '/whitelist.json')).some(p => p.name === 'Zoe'));
  assert.ok(JSON.parse(fs.readFileSync(root + '-data/servers.json')).servers.some(s => s.id === id)); ok('a new Paper server: own folder, port 25566, text with colour codes, seed, whitelist copied, installed, remembered');

  let a = (await call('GET', '/api/appearance' + sv(id))).json;
  assert.equal(a.port, 25566); assert.equal(a.motd1, '&aHello'); assert.equal(a.motd2, '&bthere \u00e9'); assert.equal(a.hasIcon, false); assert.ok(Array.isArray(a.addresses));
  assert.equal((await call('PUT', '/api/appearance' + sv(id), { port: 25565 })).status, 409);
  assert.equal((await call('PUT', '/api/appearance' + sv(id), { name: 'Build Server', motd1: 'Price: $5 \\ sale', motd2: '', port: 25570 })).status, 200);
  a = (await call('GET', '/api/appearance' + sv(id))).json;
  assert.equal(a.name, 'Build Server'); assert.equal(a.motd1, 'Price: $5 \\ sale'); assert.equal(a.motd2, ''); assert.equal(a.port, 25570);
  const ov = (await call('GET', '/api/servers')).json.servers.find(s => s.id === id);
  assert.equal(ov.name, 'Build Server'); assert.equal(ov.motd1, 'Price: $5 \\ sale'); assert.equal(ov.motd2, '');
  assert.equal(decodeMotd(encodeMotd('&l&cBold red', 'second \u00fc'))[1], 'second \u00fc'); ok('name, address and text can be changed, a taken port is refused');

  assert.equal((await call('PUT', '/api/icon' + sv(id), Buffer.from('not a png at all, just text that is long enough'))).status, 400);
  assert.equal((await call('PUT', '/api/icon' + sv(id), png(32, 32))).status, 400);
  const good = png(64, 64);
  assert.equal((await call('PUT', '/api/icon' + sv(id), good)).status, 200);
  assert.deepEqual((await call('GET', '/api/icon' + sv(id))).buf, good);
  assert.ok(fs.existsSync(dir + '/server-icon.png')); assert.equal((await call('GET', '/api/servers')).json.servers.find(s => s.id === id).hasIcon, true);
  await call('DELETE', '/api/icon' + sv(id));
  assert.equal((await call('GET', '/api/icon' + sv(id))).status, 404); ok('server icon: only a 64x64 PNG is accepted');

  assert.equal((await call('PUT', '/api/mods' + sv(id) + '&name=cool-plugin.jar', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(20)]))).status, 200);
  assert.ok(fs.existsSync(dir + '/plugins/cool-plugin.jar'));
  assert.deepEqual((await call('GET', '/api/mods' + sv(id))).json.mods.map(m => m.name), ['cool-plugin.jar']);
  assert.ok(!(await call('GET', '/api/mods?server=main')).json.mods.some(m => m.name === 'cool-plugin.jar'));
  assert.equal((await call('GET', '/api/status?server=nope')).status, 404); ok('each server has its own plugins folder; unknown server -> 404');

  const jf = f => JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'));
  const dashedMd5 = name => sha('md5', name).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const player1 = body => call('POST', '/api/player' + sv(id), body);
  assert.equal((await player1({ action: 'whitelist-add', name: 'Newbie_1' })).status, 200);
  assert.deepEqual(jf('whitelist.json').filter(p => p.name === 'Newbie_1').map(p => p.uuid), [dashedMd5('Newbie_1')]);
  assert.equal((await player1({ action: 'whitelist-add', name: 'Ghost_9' })).status, 404);
  assert.equal((await player1({ action: 'whitelist-add', name: 'bad name!' })).status, 400);
  await player1({ action: 'whitelist-add', name: 'newbie_1' });
  assert.equal(jf('whitelist.json').filter(p => p.name.toLowerCase() === 'newbie_1').length, 1); ok('players: names are looked up and added while the server is stopped, not twice');
  assert.equal((await player1({ action: 'op', name: 'Chef_2', level: 2 })).status, 200);
  assert.equal(jf('ops.json').find(p => p.name === 'Chef_2').level, 2);
  assert.equal((await player1({ action: 'op', name: 'Chef_3', level: 9 })).status, 400);
  await player1({ action: 'ban', name: 'Grief_3', reason: 'griefing' });
  assert.equal(jf('banned-players.json').find(p => p.name === 'Grief_3').reason, 'griefing');
  await player1({ action: 'ban-ip', ip: '10.1.2.3', reason: 'spam' });
  let pl = (await call('GET', '/api/players' + sv(id))).json;
  assert.deepEqual(pl.bannedIps, [{ ip: '10.1.2.3', reason: 'spam' }]); assert.ok(pl.banned.some(b => b.name === 'Grief_3' && b.reason === 'griefing')); assert.deepEqual(pl.ops.find(o => o.name === 'Chef_2'), { name: 'Chef_2', level: 2 });
  for (const b of [{ action: 'pardon-ip', ip: '10.1.2.3' }, { action: 'pardon', name: 'Grief_3' }, { action: 'deop', name: 'Chef_2' }, { action: 'whitelist-remove', name: 'Newbie_1' }]) assert.equal((await player1(b)).status, 200);
  pl = (await call('GET', '/api/players' + sv(id))).json;
  assert.deepEqual(pl.bannedIps, []); assert.ok(!pl.banned.some(b => b.name === 'Grief_3')); assert.ok(!pl.ops.some(o => o.name === 'Chef_2')); assert.ok(!pl.whitelist.some(n => n.toLowerCase() === 'newbie_1'));
  assert.equal((await player1({ action: 'ban-ip', ip: 'x; stop' })).status, 400);
  assert.equal((await player1({ action: 'kick', name: 'Steve' })).status, 409); ok('players: operator levels, bans with a reason, banned addresses, pardons; bad input and kicking nobody refused');
  fs.writeFileSync(dir + '/server.properties', fs.readFileSync(dir + '/server.properties', 'utf8').replace('online-mode=true', 'online-mode=false'));
  await player1({ action: 'whitelist-add', name: 'Notch' });
  assert.equal(jf('whitelist.json').find(p => p.name === 'Notch').uuid, 'b50ad385-829d-3141-a216-7e7d7539ba7f');
  fs.writeFileSync(dir + '/server.properties', fs.readFileSync(dir + '/server.properties', 'utf8').replace('online-mode=false', 'online-mode=true')); ok('players: an offline-mode server gets the offline id for a name (no lookup)');
  const offId = require('./common').offlineUuid;
  await registry.get(id).sys.power('start');
  assert.equal((await call('POST', '/api/cracked' + sv(id), { on: true })).status, 409);
  await registry.get(id).sys.power('stop');
  r = await call('POST', '/api/cracked' + sv(id), { on: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(fs.readFileSync(dir + '/server.properties', 'utf8'), /^online-mode=false$/m);
  assert.ok(jf('whitelist.json').length > 0 && jf('whitelist.json').every(p => p.uuid === offId(p.name)));
  assert.equal(JSON.parse(fs.readFileSync(dir + '/whitelist.json.online', 'utf8')).find(p => p.name === 'Zoe').uuid, U1());
  assert.equal((await call('GET', '/api/players' + sv(id))).json.onlineMode, false); assert.equal((await call('GET', '/api/status' + sv(id))).json.onlineMode, false);
  assert.match((await call('POST', '/api/cracked' + sv(id), { on: true })).json.message, /already on/);
  await player1({ action: 'whitelist-add', name: 'Ghost_9' }); await player1({ action: 'whitelist-add', name: 'Fresh_5' });
  seen.mojang.length = 0;
  r = await call('POST', '/api/cracked' + sv(id), { on: false });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.match(r.json.message, /Ghost_9/);
  const back = jf('whitelist.json');
  assert.equal(back.find(p => p.name === 'Zoe').uuid, U1());
  assert.equal(back.find(p => p.name === 'Fresh_5').uuid, dashedMd5('Fresh_5')); assert.equal(back.find(p => p.name === 'Notch').uuid, dashedMd5('Notch'));
  assert.equal(back.find(p => p.name === 'Ghost_9').uuid, offId('Ghost_9'));
  assert.ok(!fs.existsSync(dir + '/whitelist.json.online')); assert.match(fs.readFileSync(dir + '/server.properties', 'utf8'), /^online-mode=true$/m);
  assert.equal((await call('GET', '/api/options' + sv(id))).json.options.some(o => o.key === 'online-mode'), false); ok('cracked mode: switch on and off with the server stopped, the player lists are converted and restored');

  const mkdz = n => path.join(dir, n);
  let w = (await call('GET', '/api/worlds' + sv(id))).json;
  assert.equal(w.level, 'world'); assert.ok(w.worlds[0].active && w.worlds[0].missing);
  assert.equal((await call('POST', '/api/worlds/new' + sv(id), { name: '../x' })).status, 400);
  assert.equal((await call('POST', '/api/worlds/new' + sv(id), { name: 'Flat', seed: 'a\\b' })).status, 400);
  r = await call('POST', '/api/worlds/new' + sv(id), { name: 'Flatland', seed: '42', type: 'flat', structures: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let wp = fs.readFileSync(mkdz('server.properties'), 'utf8');
  assert.match(wp, /^level-name=Flatland$/m); assert.match(wp, /^level-type=minecraft:flat$/m); assert.match(wp, /^generate-structures=false$/m); assert.match(wp, /^level-seed=42$/m); ok('worlds: a new world (name, seed, type) is set up for the next start');
  const wz = makeZip({ 'MyWorld/level.dat': levelDat('1.21.1', 'My World'), 'MyWorld/region/r.0.0.mca': 'mca', 'MyWorld/datapacks/p.zip': 'z', 'other/readme.txt': 'not part of the world' });
  r = await call('PUT', '/api/worlds/upload' + sv(id), wz);
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.name, 'MyWorld'); assert.equal(r.json.used, false);
  assert.ok(fs.existsSync(mkdz('MyWorld/region/r.0.0.mca'))); assert.ok(!fs.existsSync(mkdz('MyWorld/readme.txt')) && !fs.existsSync(mkdz('MyWorld/other')));
  r = await call('PUT', '/api/worlds/upload' + sv(id) + '&use=1', wz);
  assert.equal(r.json.name, 'MyWorld-2'); assert.equal(r.json.used, true); assert.match(fs.readFileSync(mkdz('server.properties'), 'utf8'), /^level-name=MyWorld-2$/m);
  for (const bad of [makeZip({ 'readme.txt': 'x' }), makeZip({ '../evil/level.dat': 'x' }), makeZip({ 'W/level.dat': 'x', 'W/levelname.txt': 'bedrock' }), Buffer.from('not a zip')]) {
    assert.equal((await call('PUT', '/api/worlds/upload' + sv(id), bad)).status, 400);
  }
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('.upload-')), []); ok('worlds: upload a zip (the world is found inside, other files left out); a Bedrock world, ../ names and non-zips are refused');
  w = (await call('GET', '/api/worlds' + sv(id))).json;
  assert.deepEqual(w.worlds.map(x => x.name).sort(), ['MyWorld', 'MyWorld-2']); assert.equal(w.worlds.find(x => x.active).name, 'MyWorld-2'); assert.equal(w.worlds[0].version, '1.21.1');
  assert.equal((await call('POST', '/api/worlds/use' + sv(id), { name: 'Nope' })).status, 404);
  assert.equal((await call('POST', '/api/worlds/use' + sv(id), { name: 'MyWorld' })).status, 200);
  assert.match(fs.readFileSync(mkdz('server.properties'), 'utf8'), /^level-name=MyWorld$/m); ok('worlds: listed with version, switch to another one');
  const dl = await call('GET', '/api/worlds/download' + sv(id) + '&name=MyWorld');
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/zip');
  const dlFile = path.join(os.tmpdir(), 'mcpanel-dl-' + process.pid + '.zip');
  fs.writeFileSync(dlFile, dl.buf);
  const zipm = require('./zip');
  assert.deepEqual((await zipm.list(dlFile)).map(e => e.name).sort(), ['MyWorld/', 'MyWorld/datapacks/', 'MyWorld/datapacks/p.zip', 'MyWorld/level.dat', 'MyWorld/region/', 'MyWorld/region/r.0.0.mca']);
  await zipm.extract(dlFile, dlFile + '-x');
  assert.equal(fs.readFileSync(dlFile + '-x/MyWorld/region/r.0.0.mca', 'utf8'), 'mca');
  if (process.platform === 'win32') require('child_process').execFileSync(require('./common').TAR, ['-xf', dlFile, '-C', fs.mkdirSync(dlFile + '-t', { recursive: true }) || dlFile + '-t']);
  fs.rmSync(dlFile, { force: true }); fs.rmSync(dlFile + '-x', { recursive: true, force: true }); fs.rmSync(dlFile + '-t', { recursive: true, force: true });
  assert.equal((await call('GET', '/api/worlds/download' + sv(id) + '&name=Nope')).status, 404); ok('worlds: download is a real .zip');
  assert.equal((await call('POST', '/api/worlds/delete' + sv(id), { name: 'MyWorld' })).status, 409);
  assert.equal((await call('POST', '/api/worlds/delete' + sv(id), { name: 'MyWorld-2' })).status, 200);
  assert.ok(!fs.existsSync(mkdz('MyWorld-2'))); ok('worlds: the world in use cannot be deleted, another one can');

  assert.deepEqual((await call('GET', '/api/datapacks' + sv(id))).json.packs.map(p => p.name), ['p.zip']);
  assert.equal((await call('PUT', '/api/datapacks' + sv(id) + '&name=cool-pack.zip', makeZip({ 'pack.mcmeta': '{}' }))).status, 200);
  assert.equal((await call('PUT', '/api/datapacks' + sv(id) + '&name=bad.zip', makeZip({ 'x.txt': 'x' }))).status, 400);
  assert.ok(!fs.existsSync(mkdz('MyWorld/datapacks/bad.zip')));
  assert.equal((await call('PUT', '/api/datapacks' + sv(id) + '&name=..%2Fx.zip', makeZip({ 'pack.mcmeta': '{}' }))).status, 400);
  assert.equal((await call('PUT', '/api/datapacks' + sv(id) + '&name=notes.txt', makeZip({ 'pack.mcmeta': '{}' }))).status, 400);
  r = await call('GET', '/api/datapacks/find' + sv(id) + '&q=magic');
  assert.equal(r.json.results[0].title, 'Cool'); assert.ok(decodeURIComponent(seen.search).includes('project_type:datapack'));
  r = await call('POST', '/api/datapacks/install' + sv(id), { id: 'dpack' });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.ok(fs.existsSync(mkdz('MyWorld/datapacks/dp-1.zip')));
  assert.equal((await call('POST', '/api/datapacks/install' + sv(id), { id: 'fakepack' })).status, 502);
  assert.deepEqual(fs.readdirSync(mkdz('MyWorld/datapacks')).filter(f => /part|notpack/.test(f)), []);
  await call('DELETE', '/api/datapacks' + sv(id) + '&name=cool-pack.zip');
  assert.deepEqual((await call('GET', '/api/datapacks' + sv(id))).json.packs.map(p => p.name), ['dp-1.zip', 'p.zip']); ok('data packs: upload (must be a pack), find and install from Modrinth (checksummed), delete');

  fs.mkdirSync(mkdz('logs'), { recursive: true }); fs.mkdirSync(mkdz('crash-reports'), { recursive: true });
  fs.writeFileSync(mkdz('logs/latest.log'), '[12:00:00] [Server thread/INFO]: Hello log\n');
  fs.writeFileSync(mkdz('logs/2026-01-01-1.log.gz'), zlib.gzipSync('[old] earlier line\n'));
  fs.writeFileSync(mkdz('crash-reports/crash-1.txt'), 'crash!');
  fs.writeFileSync(mkdz('logs/big.log'), 'x'.repeat(3 * 1024 * 1024));
  const logs = (await call('GET', '/api/logs' + sv(id))).json.logs.map(l => l.name);
  for (const want of ['latest.log', '2026-01-01-1.log.gz', 'crash-reports/crash-1.txt']) assert.ok(logs.includes(want), want);
  const rl = n => call('GET', '/api/logs/read' + sv(id) + '&name=' + encodeURIComponent(n));
  assert.match((await rl('latest.log')).json.text, /Hello log/); assert.match((await rl('2026-01-01-1.log.gz')).json.text, /earlier line/); assert.equal((await rl('crash-reports/crash-1.txt')).json.text, 'crash!');
  assert.ok((await rl('big.log')).json.text.length <= 1024 * 1024);
  assert.equal((await rl('../server.properties')).status, 400); assert.equal((await rl('..%2Fx.log')).status, 400); assert.equal((await rl('nope.log')).status, 404); assert.equal((await rl('a/b.log')).status, 400); ok('logs: old and crash logs can be read (the last megabyte), no path tricks');
  r = await call('POST', '/api/log/share' + sv(id), { name: 'latest.log' });
  assert.equal(r.json.url, 'https://mclo.gs/abc123'); assert.match(seen.logBody, /Hello log/);
  r = await call('POST', '/api/log/share' + sv(id), {});
  assert.equal(r.status, 200); assert.match(seen.logBody, /Done \(3\.2s\)/);
  seen.logFail = true;
  assert.equal((await call('POST', '/api/log/share' + sv(id), { name: 'latest.log' })).status, 502); seen.logFail = false; ok('logs: sharing sends the text to mclo.gs and returns the link; a refusal is reported');

  assert.equal((await call('PUT', '/api/settings' + sv(id), { restartAt: '25:00' })).status, 400);
  assert.equal((await call('PUT', '/api/settings' + sv(id), { restartAt: '04:30' })).status, 200);
  assert.equal((await call('GET', '/api/settings' + sv(id))).json.restartAt, '04:30');
  assert.equal((await call('PUT', '/api/settings' + sv(id), { restartAt: '' })).status, 200); ok('settings: the daily restart time is checked and saved');
  assert.ok((await call('GET', '/api/options' + sv(id))).json.options.every(o => o.group) && (await call('GET', '/api/options' + sv(id))).json.options.some(o => o.key === 'max-world-size')); ok('options come in groups');
  fs.writeFileSync(mkdz('server.properties'), fs.readFileSync(mkdz('server.properties'), 'utf8').replace(/^level-name=.*$/m, 'level-name=world'));

  fs.mkdirSync(dir + '/plugins', { recursive: true });
  fs.writeFileSync(dir + '/plugins/up-1.0.jar', pluginJar('UpPlugin', '1'));
  const upHash = sha('sha512', fs.readFileSync(dir + '/plugins/up-1.0.jar'));
  seen.updateFor[upHash] = { version_number: '2.0', files: [{ primary: true, filename: 'up-2.0.jar', url: 'http://127.0.0.1:18795/files/up-2.0.jar', hashes: { sha512: sha('sha512', UP2) } }] };
  r = await call('GET', '/api/mods/updates' + sv(id));
  assert.deepEqual(r.json.updates.map(u => [u.file, u.to, u.version]), [['up-1.0.jar', 'up-2.0.jar', '2.0']]);
  r = await call('POST', '/api/mods/update' + sv(id), {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(fs.existsSync(dir + '/plugins/up-2.0.jar') && !fs.existsSync(dir + '/plugins/up-1.0.jar'));
  assert.deepEqual((await call('GET', '/api/mods/updates' + sv(id))).json.updates, []);
  assert.equal((await call('POST', '/api/mods/update' + sv(id), {})).json.warnings[0], 'Everything is up to date.'); ok('mod updates: found by file hash on Modrinth, the old file is replaced by the checked new one');

  assert.equal((await call('GET', '/api/map' + sv(id))).json.installed, false);
  r = await call('POST', '/api/map/install' + sv(id));
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.ok(fs.existsSync(dir + '/plugins/bluemap-5.jar'));
  assert.equal((await call('POST', '/api/map/enable' + sv(id))).status, 409);
  fs.mkdirSync(dir + '/plugins/BlueMap', { recursive: true }); fs.writeFileSync(dir + '/plugins/BlueMap/core.conf', 'accept-download: false\nrender-thread-count: 1\n');
  assert.equal((await call('POST', '/api/map/enable' + sv(id))).status, 200);
  assert.match(fs.readFileSync(dir + '/plugins/BlueMap/core.conf', 'utf8'), /accept-download: true\nrender-thread-count: 1/);
  r = (await call('GET', '/api/map' + sv(id))).json; assert.deepEqual([r.installed, r.accepted, r.port], [true, true, 8100]); ok('live map: BlueMap is installed and its download question answered');

  assert.equal((await call('GET', '/api/bedrock?server=main')).json.kind, 'fabric');
  seen.geyserBad = true;
  assert.equal((await call('POST', '/api/bedrock/install' + sv(id))).status, 502);
  assert.ok(!fs.readdirSync(dir + '/plugins').some(f => /floodgate|\.part-/.test(f)));
  seen.geyserBad = false;
  r = await call('POST', '/api/bedrock/install' + sv(id));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(fs.existsSync(dir + '/plugins/Geyser-Spigot.jar') && fs.existsSync(dir + '/plugins/floodgate-spigot.jar'));
  assert.equal((await call('POST', '/api/bedrock/enable' + sv(id))).status, 409);
  fs.mkdirSync(dir + '/plugins/Geyser-Spigot', { recursive: true }); fs.writeFileSync(dir + '/plugins/Geyser-Spigot/config.yml', 'remote:\n  auth-type: online\n  other: 1\n');
  assert.equal((await call('POST', '/api/bedrock/enable' + sv(id))).status, 200);
  assert.match(fs.readFileSync(dir + '/plugins/Geyser-Spigot/config.yml', 'utf8'), /  auth-type: floodgate\n  other: 1/);
  r = (await call('GET', '/api/bedrock' + sv(id))).json; assert.deepEqual([r.supported, r.geyser, r.floodgate, r.ready], [true, true, true, true]);
  {
    const launchFile = mkdz(process.platform === 'win32' ? 'launch.cmd' : 'launch.sh');
    assert.match(fs.readFileSync(launchFile, 'utf8'), /-Xmx1536M/);
    r = (await call('GET', '/api/settings' + sv(id))).json; assert.deepEqual([r.memoryManaged, r.memoryNowMB, r.defaultMemoryMB, r.restartOnCrash], [true, 1536, 1536, true]);
    assert.equal((await call('PUT', '/api/settings' + sv(id), { memoryMB: 2048 })).status, 200);
    assert.match(fs.readFileSync(launchFile, 'utf8'), /-Xmx2048M/); assert.equal((await call('GET', '/api/settings' + sv(id))).json.memoryNowMB, 2048);
    for (const bad of [100, 99999999, 'abc']) assert.equal((await call('PUT', '/api/settings' + sv(id), { memoryMB: bad })).status, 400, String(bad));
    assert.match(fs.readFileSync(launchFile, 'utf8'), /-Xmx2048M/);
    assert.equal((await call('PUT', '/api/settings' + sv(id), { memoryMB: '' })).status, 200);
    assert.match(fs.readFileSync(launchFile, 'utf8'), /-Xmx1536M/);
    assert.equal((await call('PUT', '/api/settings?server=main', { memoryMB: 2048 })).status, 400);
    assert.equal((await call('PUT', '/api/settings?server=main', { restartOnCrash: false })).status, 200);
    assert.equal((await call('GET', '/api/settings?server=main')).json.restartOnCrash, false);
    assert.equal((await call('PUT', '/api/settings?server=main', { restartOnCrash: true })).status, 200); ok('settings: memory is written into the start file (checked, empty = automatic, the installer\'s server is left alone), crash restart can be switched');

    const sleepMs = ms => new Promise(res => setTimeout(res, ms));
    const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleepMs(50); } throw new Error('timed out: ' + what); };
    const mainWas = (await registry.get('main').sys.state()).active;
    const live = registry.get(id);
    r = (await call('GET', '/api/pregen' + sv(id))).json; assert.deepEqual([r.supported, r.installed, r.running], [true, false, false]);
    assert.equal((await call('POST', '/api/pregen/start' + sv(id), { radius: 500 })).status, 409);
    r = await call('POST', '/api/pregen/install' + sv(id)); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.ok(fs.existsSync(dir + '/plugins/chunky-1.jar'));
    assert.equal((await call('POST', '/api/pregen/start' + sv(id), { radius: 500 })).status, 409);
    await live.sys.power('start');
    for (const bad of [10, 99999, 'x']) assert.equal((await call('POST', '/api/pregen/start' + sv(id), { radius: bad })).status, 400, String(bad));
    assert.equal((await call('POST', '/api/pregen/start' + sv(id), { radius: 500 })).status, 200);
    const said = await live.sys.log(50);
    assert.ok(said.indexOf('chunky center 0 0') < said.indexOf('chunky radius 500') && said.indexOf('chunky radius 500') < said.indexOf('chunky start'));
    r = (await call('GET', '/api/pregen' + sv(id))).json; assert.match(r.line, /Processed: 100 chunks/);
    assert.equal((await call('POST', '/api/pregen/control' + sv(id), { action: 'pause' })).status, 200); assert.match(await live.sys.log(5), /chunky pause/);
    assert.equal((await call('POST', '/api/pregen/control' + sv(id), { action: 'format c:' })).status, 400);
    assert.equal((await call('GET', '/api/pregen?server=main')).json.supported, true); ok('pre-generating: Chunky is installed from Modrinth, started with a checked radius, paused, and its progress line is shown');

    r = (await call('POST', '/api/lag/check' + sv(id))).json; assert.deepEqual([r.level, r.tps], ['good', 20]); assert.ok(r.text.includes('Tick durations') && !r.hints.length);
    live.sys.setSpeed(12, 70);
    r = (await call('POST', '/api/lag/check' + sv(id))).json; assert.deepEqual([r.level, r.tps, r.mspt], ['bad', 12, 70]); assert.ok(r.hints.some(x => /Pre-generate/.test(x)));
    live.sys.setSpeed(20, 4);
    assert.equal((await call('POST', '/api/lag/profile' + sv(id))).status, 200);
    r = (await call('GET', '/api/lag' + sv(id))).json; assert.deepEqual([r.spark, r.running, r.profile], [true, true, 'https://spark.lucko.me/AbCd123']);
    await live.sys.power('stop');
    assert.equal((await call('POST', '/api/lag/check' + sv(id))).status, 409);
    r = (await call('GET', '/api/lag?server=main')).json; assert.deepEqual([r.spark, r.installable], [false, true]);
    assert.equal((await call('POST', '/api/lag/install?server=main')).status, 200); assert.ok(fs.existsSync(root + '/mods/spark-1.jar'));
    await registry.get('main').sys.power('start'); registry.get('main').sys.setSpeed(20, 3);
    r = (await call('POST', '/api/lag/check?server=main')).json; assert.deepEqual([r.level, r.tps], ['good', 20]);
    ok('lag check: TPS and tick time are read from spark, "bad" comes with hints, the 60 second recording link is found, spark installs from Modrinth');
    fs.rmSync(root + '/mods/spark-1.jar', { force: true });
    if (mainWas !== 'active') await registry.get('main').sys.power('stop');

    fs.mkdirSync(mkdz('world'), { recursive: true }); fs.writeFileSync(mkdz('world/level.dat'), 'x');
    const copies = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-offsite-'));
    r = await call('GET', '/api/offsite'); assert.deepEqual([r.status, r.json.folder, r.json.rclone, r.json.keep], [200, '', '', 10]);
    for (const bad of [{ folder: 'relative/dir' }, { folder: path.join(copies, 'nope') }, { rclone: '-oops' }, { rclone: 'C:' }, { rclone: 'a b:c;d' }, { keep: 0 }, { keep: 101 }]) assert.equal((await call('PUT', '/api/offsite', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await call('PUT', '/api/offsite', { rclone: 'gdrive:backups' })).status, 400);
    assert.equal((await call('GET', '/api/offsite')).json.rclone, '');
    assert.equal((await call('POST', '/api/offsite/send')).status, 409);
    assert.equal((await call('PUT', '/api/offsite', { folder: copies, keep: 2 })).status, 200);
    assert.equal(fs.readdirSync(copies).length, 0, 'the write test leaves nothing');
    const names = [];
    for (let i = 0; i < 3; i++) names.push((await call('POST', '/api/backups' + sv(id))).json.name);
    await until(() => fs.existsSync(path.join(copies, id, names[2])) && fs.readdirSync(path.join(copies, id)).filter(n => n.endsWith('.tar.gz')).length === 2, 'copies arrive');
    assert.deepEqual(fs.readdirSync(path.join(copies, id)).sort(), names.slice(1).sort());
    r = (await call('GET', '/api/offsite')).json; assert.equal(r.last.ok, true); assert.match(r.last.message, /Copied world-/);
    fs.rmSync(path.join(copies, id), { recursive: true });
    assert.equal((await call('POST', '/api/offsite/send')).status, 200);
    await until(() => fs.existsSync(path.join(copies, id, names[2])), 'newest copied again');
    assert.equal((await call('PUT', '/api/offsite', { folder: '' })).status, 200);
    r = await call('POST', '/api/backups' + sv(id)); await sleepMs(300);
    assert.ok(!fs.existsSync(path.join(copies, id, r.json.name))); fs.rmSync(copies, { recursive: true, force: true });
    ok('offsite copies: a folder is checked and written to, only the newest few are kept, the owner only; a cloud needs rclone');

    r = await call('POST', '/api/software' + sv(id), { software: 'paper', mc: '26.2' });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.match(r.json.backup, /^world-.*\.tar\.gz$/);
    assert.ok((await call('GET', '/api/backups' + sv(id))).json.backups.some(b => b.name === r.json.backup));
    await settled(id);
    r = await call('POST', '/api/software' + sv(id), { software: 'paper', mc: '26.3' }); assert.equal(r.status, 200);
    await settled(id);
    assert.equal((await call('GET', '/api/status' + sv(id))).json.mc, '26.3');
    ok('changing the version: the world is backed up first and the answer says which backup');
    fs.rmSync(dir + '/backups', { recursive: true, force: true });
  }
  assert.equal((await call('GET', '/api/bedrock?server=main')).json.supported, true); ok('Bedrock players: Geyser and Floodgate downloaded with their SHA-256, a wrong checksum is refused, sign-in switched to Floodgate');

  const rulesDat = zlib.gzipSync(tag(10, '', Buffer.concat([tag(10, 'Data', Buffer.concat([tag(8, 'LevelName', tstr('W')),
    tag(10, 'GameRules', Buffer.concat([tag(8, 'keepInventory', tstr('false')), tag(8, 'randomTickSpeed', tstr('3')), tag(8, 'weird', tstr('abc')), Buffer.from([0])])), Buffer.from([0])])), Buffer.from([0])])));
  const keepDat = fs.readFileSync(path.join(root, 'world', 'level.dat'));
  fs.writeFileSync(path.join(root, 'world', 'level.dat'), rulesDat);
  r = await call('GET', '/api/gamerules?server=main');
  assert.deepEqual(r.json.rules.map(x => [x.name, x.value, x.type]), [['keepInventory', 'false', 'bool'], ['randomTickSpeed', '3', 'int'], ['weird', 'abc', 'text']]);
  assert.equal((await call('POST', '/api/gamerule?server=main', { name: 'keepInventory', value: true })).status, 200);
  assert.match((await call('GET', '/api/log?server=main')).json.text, /gamerule keepInventory true/);
  assert.equal((await call('POST', '/api/gamerule?server=main', { name: 'x; stop', value: true })).status, 400);
  assert.equal((await call('POST', '/api/gamerule?server=main', { name: 'keepInventory', value: 'maybe' })).status, 400);
  assert.equal((await call('POST', '/api/gamerule' + sv(id), { name: 'keepInventory', value: true })).status, 409);
  fs.writeFileSync(path.join(root, 'world', 'level.dat'), keepDat); ok('game rules: read from the world file (so the names fit the version), changed through the console of a running server');

  assert.equal((await call('PUT', '/api/settings' + sv(id), { publicAddress: 'not an address!' })).status, 400);
  assert.equal((await call('PUT', '/api/settings' + sv(id), { publicAddress: 'tcp://friends.example.net:12345' })).status, 200);
  assert.equal((await call('GET', '/api/settings' + sv(id))).json.publicAddress, 'friends.example.net:12345');
  assert.ok((await call('GET', '/api/appearance' + sv(id))).json.addresses.some(a => a.label.startsWith('From anywhere') && a.address === 'friends.example.net:12345'));
  await call('PUT', '/api/settings' + sv(id), { publicAddress: 'localhost:25999' });
  assert.equal((await call('POST', '/api/public-address/test' + sv(id))).status, 400);
  await call('PUT', '/api/settings' + sv(id), { publicAddress: '127.0.0.1:18793' });
  r = await call('POST', '/api/public-address/test' + sv(id));
  assert.equal(r.status, 200); assert.equal(r.json.online, false);
  await call('PUT', '/api/settings' + sv(id), { publicAddress: '' }); ok('tunnel address: saved, shown as a join address, and tested from the computer (private addresses refused)');
  assert.equal((await call('PUT', '/api/settings' + sv(id), { startAt: '25:61' })).status, 400);
  assert.equal((await call('PUT', '/api/settings' + sv(id), { startAt: '16:00', stopAt: '22:30' })).status, 200);
  r = (await call('GET', '/api/settings' + sv(id))).json; assert.deepEqual([r.startAt, r.stopAt], ['16:00', '22:30']);
  await call('PUT', '/api/settings' + sv(id), { startAt: '', stopAt: '' });
  ok('daily start and stop times are checked and saved');

  r = await power(id, 'start');
  assert.equal(r.status, 409); assert.match(r.json.error, /Stop "Main server" first/);
  assert.equal((await power('main', 'stop')).status, 200);
  assert.equal((await power(id, 'start')).status, 200);
  r = await power('main', 'start');
  assert.equal(r.status, 409); assert.match(r.json.error, /Stop "Build Server"/);
  assert.equal((await call('GET', '/api/status?server=main')).json.other.name, 'Build Server'); ok('only one server can run at a time');

  assert.ok((await call('GET', '/api/options' + sv(id))).json.options.some(o => o.key === 'difficulty'));
  for (const bad of [{ difficulty: 'impossible' }, { 'view-distance': 99 }, { 'level-seed': 'a\\b' }, { nope: 1 }, { pvp: 'maybe' }]) {
    assert.equal((await call('PUT', '/api/options' + sv(id), { values: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('PUT', '/api/options' + sv(id), { values: { difficulty: 'hard', pvp: 'false', 'max-players': 12 } })).status, 200);
  const p2 = fs.readFileSync(dir + '/server.properties', 'utf8');
  assert.match(p2, /^difficulty=hard$/m); assert.match(p2, /^pvp=false$/m); assert.match(p2, /^max-players=12$/m); ok('settings form: values are checked and saved');

  for (const bad of [{ url: 'http://example.com/a.zip' }, { url: 'https://127.0.0.1/a.zip' }, { url: 'https://localhost/a.zip' }, { url: 'https://192.168.1.5/a.zip' }, {}]) {
    assert.equal((await call('PUT', '/api/resourcepack' + sv(id), bad)).status, 400, JSON.stringify(bad));
  }
  r = await call('PUT', '/api/resourcepack' + sv(id), { modrinth: 'testpack', required: true, prompt: 'Use "this" \\ pack' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const pk = (await call('GET', '/api/resourcepack' + sv(id))).json;
  assert.equal(pk.url, 'https://cdn.modrinth.com/data/x/pack.zip'); assert.equal(pk.sha1, 'ab'.repeat(20)); assert.equal(pk.required, true); assert.match(pk.prompt, /^Use\s+this\s+pack$/);
  const p3 = fs.readFileSync(dir + '/server.properties', 'utf8');
  assert.match(p3, /^require-resource-pack=true$/m); assert.deepEqual(JSON.parse(/^resource-pack-prompt=(.*)$/m.exec(p3)[1]).text, pk.prompt);
  assert.equal((await call('GET', '/api/packs/find' + sv(id) + '&q=x')).json.results[0].title, 'Cool');
  await call('DELETE', '/api/resourcepack' + sv(id));
  assert.equal((await call('GET', '/api/resourcepack' + sv(id))).json.url, ''); ok('required resource pack: link and checksum saved, private addresses refused, can be removed');

  await power(id, 'stop');
  fs.mkdirSync(dir + '/world', { recursive: true }); fs.writeFileSync(dir + '/world/level.dat', 'v1');
  r = await call('POST', '/api/backups' + sv(id));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await call('GET', '/api/backups' + sv(id))).json.backups.length, 1);
  await call('PUT', '/api/settings' + sv(id), { backupKeep: 1 });
  fs.writeFileSync(dir + '/world/level.dat', 'v2');
  const second = (await call('POST', '/api/backups' + sv(id))).json.name;
  const listed = (await call('GET', '/api/backups' + sv(id))).json.backups;
  assert.deepEqual(listed.map(b => b.name), [second]); ok('stored backups: kept to the number you choose, newest first');
  assert.equal((await call('POST', '/api/backups/restore' + sv(id), { name: '../../etc/passwd' })).status, 400);
  fs.writeFileSync(dir + '/world/level.dat', 'v3');
  assert.equal((await call('POST', '/api/backups/restore' + sv(id), { name: second })).status, 200);
  assert.equal(fs.readFileSync(dir + '/world/level.dat', 'utf8'), 'v2');
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('world.before-restore-'))); ok('restore brings the backup back and keeps the world you had');
  const evil = root + '-evil'; fs.mkdirSync(evil + '/other', { recursive: true }); fs.writeFileSync(evil + '/other/x', 'x');
  fs.writeFileSync(dir + '/backups/world-20200101-000000.tar.gz', require('child_process').execFileSync('tar', ['-czf', '-', '-C', evil, 'other']));
  assert.equal((await call('POST', '/api/backups/restore' + sv(id), { name: 'world-20200101-000000.tar.gz' })).status, 400);
  fs.rmSync(evil, { recursive: true }); ok('a backup that holds anything but the world folder is refused');
  assert.equal((await call('POST', '/api/world/reset' + sv(id))).status, 200);
  assert.ok(!fs.existsSync(dir + '/world') && fs.readdirSync(dir).some(f => f.startsWith('world.before-reset-'))); ok('fresh world: the old one is kept');
  fs.mkdirSync(dir + '/world'); fs.writeFileSync(dir + '/world/level.dat', 'v4');

  await power('main', 'stop'); await power(id, 'start');
  await call('PUT', '/api/settings' + sv(id), { backupEveryHours: 1, idleMinutes: 1, backupKeep: 3 });
  assert.equal((await call('POST', '/api/backups/restore' + sv(id), { name: second })).status, 409);
  assert.equal((await call('POST', '/api/world/reset' + sv(id))).status, 409);
  const inst = registry.get(id);
  const old = new Date(Date.now() - 2 * 3600e3);
  for (const f of fs.readdirSync(dir + '/backups')) fs.utimesSync(dir + '/backups/' + f, old, old);
  const before = (await inst.listBackups()).length;
  inst.sys.setOnline(2);
  await registry.tick();
  assert.equal((await inst.listBackups()).length, before + 1); ok('automatic backup runs when the last one is older than the interval; restore and reset refuse while running');
  inst.sys.setOnline(0);
  await registry.tick();
  assert.equal((await call('GET', '/api/status' + sv(id))).json.state, 'active');
  const realNow = Date.now; Date.now = () => realNow() + 2 * 60 * 1000;
  try { await registry.tick(); } finally { Date.now = realNow; }
  assert.equal((await call('GET', '/api/status' + sv(id))).json.state, 'inactive'); ok('a server nobody has been on for the set time is stopped');

  fs.writeFileSync(root + '/banned-players.json', JSON.stringify([{ uuid: U1(), name: 'Griefer' }]));
  await power('main', 'start');
  assert.deepEqual((await call('GET', '/api/players?server=main')).json.banned.map(b => b.name), ['Griefer']);
  assert.equal((await call('POST', '/api/player?server=main', { action: 'ban', name: 'Someone_1' })).status, 200);
  assert.match((await call('GET', '/api/log?server=main')).json.text, /ban Someone_1/);
  assert.equal((await call('POST', '/api/player?server=main', { action: 'pardon', name: 'Griefer' })).status, 200); ok('ban list, ban and pardon');

  assert.equal((await call('POST', '/api/servers/duplicate', { id: 'main', name: 'Nope' })).status, 400);
  fs.mkdirSync(dir + '/backups', { recursive: true }); fs.writeFileSync(dir + '/backups/world-20200101-000000.tar.gz', 'x');
  await registry.get(id).sys.power('start');
  assert.equal((await call('POST', '/api/servers/duplicate', { id, name: 'Build Copy' })).status, 409);
  await registry.get(id).sys.power('stop');
  r = await call('POST', '/api/servers/duplicate', { id, name: 'Build Copy' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cdir = root + '-servers/' + r.json.id;
  assert.ok(fs.existsSync(cdir + '/MyWorld/level.dat')); assert.ok(!fs.existsSync(cdir + '/backups') && !fs.existsSync(cdir + '/logs'));
  assert.notEqual((await call('GET', '/api/appearance?server=' + r.json.id)).json.port, (await call('GET', '/api/appearance' + sv(id))).json.port);
  assert.equal((await call('GET', '/api/status?server=' + r.json.id)).json.name, 'Build Copy');
  assert.equal((await call('POST', '/api/servers/delete', { id: r.json.id, confirm: 'Build Copy' })).status, 200);
  assert.ok(!fs.existsSync(cdir)); ok('copy a server: world and settings copied, backups and logs left out, its own port');

  await power('main', 'stop');
  assert.equal((await call('POST', '/api/software' + sv(id), { software: 'nothing', mc: '26.3' })).status, 400);
  assert.equal((await call('POST', '/api/software?server=main', { software: 'paper', mc: '26.3' })).status, 400);
  await power(id, 'start');
  assert.equal((await call('POST', '/api/software' + sv(id), { software: 'vanilla', mc: '26.3' })).status, 409);
  await power(id, 'stop');
  assert.equal((await call('POST', '/api/software' + sv(id), { software: 'vanilla', mc: '26.3' })).status, 200);
  st = await settled(id);
  assert.equal(st.softwareLabel, 'Vanilla'); assert.equal(st.modsDir, null); assert.equal(st.install.state, 'done');
  assert.deepEqual((await call('GET', '/api/mods' + sv(id))).json.mods, []);
  assert.equal((await call('PUT', '/api/mods' + sv(id) + '&name=x.jar', Buffer.from('PK\x03\x04'))).status, 409); ok('software and version can be changed; Vanilla has no mod folder');
  assert.equal((await call('POST', '/api/servers/delete', { id, confirm: 'wrong' })).status, 400);
  assert.equal((await call('POST', '/api/servers/delete', { id: 'main', confirm: 'Main server' })).status, 400);
  await power(id, 'start');
  assert.equal((await call('POST', '/api/servers/delete', { id, confirm: 'Build Server' })).status, 409);
  await power(id, 'stop');
  assert.equal((await call('POST', '/api/servers/delete', { id, confirm: 'Build Server' })).status, 200);
  assert.ok(!fs.existsSync(dir)); assert.deepEqual((await call('GET', '/api/servers')).json.servers.map(s => s.id), ['main']); ok('deleting needs the exact name and a stopped server; main cannot be deleted');
  const U9 = U1();
  const essentialsJar = () => makeZip({ 'plugin.yml': 'name: Essentials\nmain: x.Y\nversion: 1' });
  const paperZip = makeZip({
    'world/level.dat': levelDat('1.21.1', 'Survival'), 'world/region/r.0.0.mca': 'overworld',
    'world_nether/level.dat': levelDat('1.21.1', 'Nether'), 'world_nether/DIM-1/region/r.0.0.mca': 'nether',
    'world_the_end/level.dat': levelDat('1.21.1', 'End'), 'world_the_end/DIM1/region/r.0.0.mca': 'end',
    'server.properties': 'level-name=world\nmotd=\\u00A7aOld \\u00A7rworld\ndifficulty=hard\nonline-mode=false\nwhite-list=false\nview-distance=12\nserver-port=25999\nrcon.password=secret\nresource-pack=https://example.com/p.zip\nresource-pack-sha1=abc\n',
    'whitelist.json': JSON.stringify([player('Zoe', U9)]), 'ops.json': JSON.stringify([{ uuid: U9, name: 'Zoe', level: 3 }]),
    'banned-players.json': JSON.stringify([{ uuid: '44444444-4444-4444-4444-444444444444', name: 'Troll', reason: 'rude' }]), 'banned-ips.json': JSON.stringify([{ ip: '10.9.9.9', reason: 'x' }]),
    'plugins/EssentialsX.jar': essentialsJar(), 'plugins/EssentialsX/config.yml': 'a: 1', 'plugins/.paper-remapped/x.jar': 'cache', 'bukkit.yml': 'settings: {}', 'spigot.yml': 's: 1',
    'version_history.json': '{"currentVersion":"git-Paper-196 (MC: 1.21.1)"}', 'logs/latest.log': '[10:00:00] [ServerMain/INFO]: Starting minecraft server version 1.21.1\n', 'server-icon.png': png(64, 64),
  });
  const upz = (name, body) => call('PUT', '/api/import?name=' + encodeURIComponent(name), body);
  let ip = (await upz('survival.zip', paperZip)).json;
  assert.equal(ip.detected.software, 'paper'); assert.equal(ip.detected.mc, '1.21.1'); assert.equal(ip.suggest.software, 'paper'); assert.equal(ip.suggest.mc, '1.21.1');
  assert.equal(ip.dims.nether, 'world_nether'); assert.equal(ip.dims.end, 'world_the_end'); assert.equal(ip.icon, true); assert.equal(ip.bannedIps, 1); assert.equal(ip.onlineMode, false);
  assert.equal(ip.pack['resource-pack'], 'https://example.com/p.zip'); assert.equal(ip.world.name, 'Survival'); assert.deepEqual(ip.jars.map(j => j.kind), ['plugin']);
  ok('Aternos zip: Paper 1.21.1 is recognised from the files it left (plugins, logs, version history), with Nether and End folders');
  assert.equal((await call('POST', '/api/import/create', { id: ip.id, name: 'Aternos Copy', software: 'paper', mc: '1.21.1', eula: false, world: true })).status, 400);
  assert.equal((await call('POST', '/api/import/create', { id: ip.id, name: 'Aternos Copy', software: 'paper', mc: '9.9.9', eula: true, world: true })).status, 400);
  assert.ok(fs.existsSync(root + '-data/import/' + ip.id));
  r = await call('POST', '/api/import/create', { id: ip.id, name: 'Aternos Copy', software: 'paper', mc: '1.21.1', eula: true, world: true, settings: true, appearance: true, lists: true, offline: true, mods: true, config: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ndir = root + '-servers/' + r.json.id;
  assert.equal(r.json.id, 'aternos-copy');
  for (const f of ['world/level.dat', 'world/region/r.0.0.mca', 'world/DIM-1/region/r.0.0.mca', 'world/DIM1/region/r.0.0.mca', 'world_nether/DIM-1/region/r.0.0.mca', 'world_the_end/DIM1/region/r.0.0.mca',
    'plugins/EssentialsX.jar', 'plugins/EssentialsX/config.yml', 'bukkit.yml', 'spigot.yml', 'server-icon.png']) assert.ok(fs.existsSync(ndir + '/' + f), f);
  assert.ok(!fs.existsSync(ndir + '/plugins/.paper-remapped'));
  const np = fs.readFileSync(ndir + '/server.properties', 'utf8');
  assert.match(np, /^difficulty=hard$/m); assert.match(np, /^view-distance=12$/m); assert.match(np, /^online-mode=false$/m); assert.match(np, /^white-list=false$/m); assert.match(np, /^motd=\\u00A7aOld \\u00A7rworld$/m);
  assert.match(np, /^resource-pack=https:\/\/example\.com\/p\.zip$/m); assert.doesNotMatch(np, /25999/); assert.doesNotMatch(np, /rcon|secret/);
  assert.equal(JSON.parse(fs.readFileSync(ndir + '/ops.json', 'utf8')).find(p => p.name === 'Zoe').level, 3);
  assert.equal(JSON.parse(fs.readFileSync(ndir + '/banned-players.json', 'utf8'))[0].name, 'Troll'); assert.equal(JSON.parse(fs.readFileSync(ndir + '/banned-ips.json', 'utf8'))[0].ip, '10.9.9.9');
  assert.ok(r.json.messages.some(m => /joined/.test(m)) && r.json.messages.some(m => /Offline mode kept/.test(m)));
  assert.equal((await settled(r.json.id)).install.state, 'done');
  assert.equal((await call('GET', '/api/servers')).json.servers.find(s => s.id === 'aternos-copy').softwareLabel, 'Paper'); ok('Aternos zip: one click makes a new Paper server with the world (Nether and End included), plugins and their data, settings, text, picture, lists and offline mode');
  assert.equal((await call('POST', '/api/servers/delete', { id: 'aternos-copy', confirm: 'Aternos Copy' })).status, 200);
  ip = (await upz('modded.zip', makeZip({ 'world/level.dat': levelDat('1.20.3', 'Modded'), 'mods/f.jar': forgeJar() }))).json;
  assert.equal(ip.suggest.software, 'forge'); assert.equal(ip.suggest.mc, '1.20.4'); assert.ok(ip.suggest.notes.some(n => /no 1\.20\.3/.test(n)));
  await call('DELETE', '/api/import?id=' + ip.id); ok('Aternos zip: when the exact version is not available the nearest newer one is suggested, with a note');
  const coolBytes = fabricJar('cool', 'one');
  const packFile = (p, extra = {}) => ({ path: p, hashes: { sha1: 'x', sha512: sha('sha512', coolBytes) }, downloads: ['http://127.0.0.1:18795/files/cool-1.0.jar'], fileSize: coolBytes.length, env: { client: 'required', server: 'required' }, ...extra });
  const mrpack = (files, dep = { minecraft: '1.20.4', 'fabric-loader': '0.15.0' }) => makeZip({
    'modrinth.index.json': JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'Cool Pack', versionId: '1.2', dependencies: dep, files }),
    'overrides/config/pack.json': '{"a":1}', 'server-overrides/config/server.json': '{"b":2}',
  });
  const waitJob = async sid => { for (let i = 0; i < 200; i++) { const j = (await call('GET', '/api/status?server=' + sid)).json.job; if (j && j.state !== 'running') return j; await new Promise(r => setTimeout(r, 100)); } throw new Error('the background job did not finish'); };
  ip = (await upz('Cool Pack.mrpack', mrpack([packFile('mods/cool-1.0.jar'), packFile('mods/client-only.jar', { env: { client: 'required', server: 'unsupported' } })]))).json;
  assert.equal(ip.modpack.files, 1); assert.equal(ip.modpack.clientOnly, 1); assert.equal(ip.modpack.overrides, true);
  assert.equal(ip.detected.software, 'fabric'); assert.equal(ip.suggest.software, 'fabric'); assert.equal(ip.suggest.mc, '1.20.4');
  assert.equal((await call('POST', '/api/import/apply', { id: ip.id, server: 'main', mods: true })).status, 400);
  r = await call('POST', '/api/import/create', { id: ip.id, name: 'Cool Pack', software: 'fabric', mc: '1.20.4', eula: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const pdir = root + '-servers/' + r.json.id;
  assert.equal(r.json.background, true);
  const waited = await waitJob(r.json.id);
  assert.equal(waited.state, 'done');
  assert.ok(fs.readFileSync(pdir + '/mods/cool-1.0.jar').equals(coolBytes)); assert.ok(!fs.existsSync(pdir + '/mods/client-only.jar'));
  assert.equal(fs.readFileSync(pdir + '/config/pack.json', 'utf8'), '{"a":1}'); assert.equal(fs.readFileSync(pdir + '/config/server.json', 'utf8'), '{"b":2}');
  assert.match(waited.messages[0], /1 of 1 files downloaded and checked/);
  await settled(r.json.id);
  assert.equal((await call('POST', '/api/servers/delete', { id: r.json.id, confirm: 'Cool Pack' })).status, 200); ok('modpack: files downloaded and checked, client-only files left out, overrides copied, a new server is made');
  ip = (await upz('Liar.mrpack', mrpack([packFile('mods/cool-1.0.jar'), packFile('mods/liar.jar', { hashes: { sha512: 'ab'.repeat(64) }, downloads: ['http://127.0.0.1:18795/files/lies.jar'] })]))).json;
  r = await call('POST', '/api/import/create', { id: ip.id, name: 'Liar Pack', software: 'fabric', mc: '1.20.4', eula: true });
  assert.equal(r.status, 200); assert.ok((await waitJob('liar-pack')).messages.some(m => /Not downloaded: mods\/liar\.jar/.test(m)));
  assert.ok(fs.existsSync(root + '-servers/liar-pack/mods/cool-1.0.jar') && !fs.existsSync(root + '-servers/liar-pack/mods/liar.jar') && !fs.readdirSync(root + '-servers/liar-pack/mods').some(f => f.includes('.part')));
  await settled('liar-pack');
  assert.equal((await call('POST', '/api/servers/delete', { id: 'liar-pack', confirm: 'Liar Pack' })).status, 200);
  ip = (await upz('Evil.mrpack', mrpack([packFile('../evil.jar')]))).json;
  r = await call('POST', '/api/import/create', { id: ip.id, name: 'Evil Pack', software: 'fabric', mc: '1.20.4', eula: true });
  assert.equal(r.status, 400); assert.match(r.json.error, /unsafe/); assert.ok(!fs.existsSync(root + '-servers/evil.jar') && !fs.existsSync(root + '-servers/evil-pack'));
  const quilt = await upz('Quilt.mrpack', mrpack([packFile('mods/cool-1.0.jar')], { minecraft: '1.20.4', 'quilt-loader': '0.20' }));
  assert.equal(quilt.status, 400); assert.match(quilt.json.error, /Quilt/); ok('modpack: a wrong checksum, an unsafe path and a Quilt pack are all handled');

  const tgzDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-tgz-'));
  fs.mkdirSync(path.join(tgzDir, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(tgzDir, 'world', 'level.dat'), levelDat('1.21.1', 'From Tar'));
  fs.writeFileSync(path.join(tgzDir, 'world', 'region', 'r.0.0.mca'), 'x');
  require('child_process').execFileSync(require('./common').TAR, ['-czf', path.join(tgzDir, 'w.tar.gz'), '-C', tgzDir, 'world']);
  r = await upz('server.tar.gz', fs.readFileSync(path.join(tgzDir, 'w.tar.gz')));
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.world.name, 'From Tar'); assert.equal(r.json.detected.mc, '1.21.1');
  await call('DELETE', '/api/import?id=' + r.json.id);
  assert.equal((await upz('fake.tar.gz', Buffer.from('not gzip data'))).status, 400);
  r = await upz('wrapped.zip', makeZip({ 'download/world.zip': makeZip({ 'world/level.dat': levelDat('1.20.4', 'Wrapped') }) }));
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.world.name, 'Wrapped');
  await call('DELETE', '/api/import?id=' + r.json.id);
  fs.rmSync(tgzDir, { recursive: true, force: true });
  ok('import: a .tar.gz and a zip with only a zip inside are unpacked too; a file that is not what its name says is refused');

  await registry.tick();
  const pts = (await call('GET', '/api/stats?server=main')).json.points;
  assert.ok(pts.length > 0 && pts[pts.length - 1].length === 3); ok('graphs: a sample of memory and players is recorded on every timer tick');
  await new Promise(r => setTimeout(r, 300));
  const nowD = new Date(), ymd = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  assert.ok(fs.existsSync(root + '-data/backup/' + ymd + '/servers.json') && fs.existsSync(root + '-data/backup/' + ymd + '/access.json')); ok('the panel keeps a daily copy of its own settings and access list');

  assert.equal((await call('PUT', '/api/alerts', { ntfy: 'x' })).status, 400);
  assert.equal((await call('PUT', '/api/alerts', { discord: 'https://discord.com/api/webhooks/123456/secret-token-abcdefghijklmnop', ntfy: 'my-test-topic-1' })).status, 200);
  const view = (await call('GET', '/api/alerts')).json;
  assert.equal(view.discord, true); assert.equal(view.ntfy, 'my-test-topic-1'); assert.ok(!JSON.stringify(view).includes('secret-token'));
  await call('POST', '/api/alerts/test');
  assert.deepEqual(seen.alerts.map(a => a.to).sort(), ['discord', 'ntfy/my-test-topic-1']); assert.match(seen.alerts.find(a => a.to === 'discord').body, /Test message/);
  const { alerts: alertsApi } = require('./server');
  const look = alertsApi.watch(registry);
  const mainInst = registry.get('main');
  await mainInst.sys.power('stop'); mainInst.sys.setOnline(0);
  await look(); seen.alerts.length = 0;
  await mainInst.sys.power('start'); mainInst.sys.setOnline(1);
  await look();
  assert.deepEqual(seen.alerts.map(a => JSON.parse(a.body.startsWith('{') ? a.body : '{"content":"' + a.body + '"}').content).sort(), ['Main server started.', 'Main server started.', 'Steve joined Main server.', 'Steve joined Main server.']);
  seen.alerts.length = 0; mainInst.sys.setOnline(0); await look();
  assert.equal(seen.alerts.length, 0);
  await call('PUT', '/api/alerts', { events: { leave: true } }); mainInst.sys.setOnline(1); await look(); seen.alerts.length = 0; mainInst.sys.setOnline(0); await look();
  assert.ok(seen.alerts.length === 2 && seen.alerts.every(a => /Steve left Main server\./.test(a.body)));
  seen.alerts.length = 0;
  const realState = mainInst.sys.state; mainInst.sys.state = async () => ({ active: 'failed', uptime: 0, memMB: null });
  await look(); mainInst.sys.state = realState;
  assert.ok(seen.alerts.length === 2 && seen.alerts.every(a => /Main server crashed\./.test(a.body)));
  await call('PUT', '/api/alerts', { clearDiscord: true, ntfy: '' }); seen.alerts.length = 0; await call('POST', '/api/alerts/test');
  assert.equal(seen.alerts.length, 0); ok('alerts: Discord and ntfy messages for start, stop, crash, join and leave; the webhook address stays secret; owner only');

  await power('main', 'start');
}

async function bedrockTests() {
  const sv = id => '?server=' + id;
  const sleepMs = ms => new Promise(res => setTimeout(res, ms));
  const settledB = async sid => { for (let i = 0; i < 100; i++) { const s = (await call('GET', '/api/status' + sv(sid))).json; if (s.install.state !== 'running') return s; await sleepMs(100); } throw new Error('install did not finish'); };
  const dgram = require('dgram');
  const { pingBedrock, bedrockLink } = require('./bedrock');

  const udp = dgram.createSocket('udp4');
  await new Promise(res => udp.bind(0, '127.0.0.1', res));
  udp.on('message', (msg, rinfo) => {
    if (msg[0] !== 0x01) return;
    const text = Buffer.from('MCPE;Test Server;800;1.26.63;3;10;12345;Bedrock level;Survival;1;19132;19133;');
    const out = Buffer.alloc(35 + text.length);
    out[0] = 0x1c; msg.copy(out, 1, 1, 9); out.writeBigUInt64BE(12345n, 9); Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex').copy(out, 17); out.writeUInt16BE(text.length, 33); text.copy(out, 35);
    udp.send(out, rinfo.port, rinfo.address);
  });
  assert.deepEqual(await pingBedrock(udp.address().port), { online: 3, max: 10, names: [], version: '1.26.63' });
  udp.close();
  assert.equal(await pingBedrock(9, '127.0.0.1', 300), null);
  const link = await bedrockLink();
  assert.deepEqual([link.version, /bedrock-server-1\.26\.63\.1\.zip$/.test(link.url)], ['1.26.63.1', true]);
  const { parseList, tcpAlive } = require('./bedrock');
  assert.deepEqual(parseList('[2026-11-08 12:16:25:760 INFO] There are 2/10 players online:\nSteve, Alex Smith\n[2026-11-08 12:16:26:000 INFO] x\n'), { online: 2, max: 10, names: ['Steve', 'Alex Smith'], version: '' });
  assert.deepEqual(parseList('old\n[2026-11-08 12:16:25:760 INFO] There are 0/10 players online:\n\n[2026-11-08 12:16:30:760 INFO] There are 1/10 players online:\nBob\n'), { online: 1, max: 10, names: ['Bob'], version: '' });
  assert.equal(parseList('nothing here'), null);
  const tcp = require('net').createServer(); await new Promise(res => tcp.listen(0, '127.0.0.1', res));
  assert.equal(await tcpAlive(tcp.address().port), true); const tp = tcp.address().port; tcp.close(); await sleepMs(50); assert.equal(await tcpAlive(tp), false);
  ok('bedrock: a UDP ping reads players and version, silence is "offline", the newest server comes from Mojang\'s own list');

  if (process.arch === 'x64') {
    const makeRegistry = require('./registry');
    const rdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-bedrock-'));
    const real = makeRegistry({ dataDir: path.join(rdir, 'data'), baseDir: path.join(rdir, 'servers'), mainDir: path.join(rdir, 'none'), panelPort: 18790, mc: '26.3', heapMB: 1024, javaDir: path.join(rdir, 'java'), fake: false, extraHosts: ['127.0.0.1'] });
    assert.deepEqual(await real.versions('bedrock'), ['1.26.63.1']);
    const made = await real.create({ name: 'Real Pocket', software: 'bedrock', mc: '1.26.63.1', eula: true, motd1: 'Hi; there', seed: 'abc' });
    const ri = real.get(made.id);
    const installed = async () => { for (let i = 0; i < 100 && (await ri.getInstall()).state === 'running'; i++) await sleepMs(100); return ri.getInstall(); };
    assert.equal((await installed()).state, 'done', JSON.stringify(await ri.getInstall()));
    const exe = process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server';
    const props = fs.readFileSync(path.join(ri.root, 'server.properties'), 'utf8');
    assert.ok(fs.existsSync(path.join(ri.root, exe)) && fs.existsSync(path.join(ri.root, 'behavior_packs', 'a.txt')) && !fs.existsSync(path.join(ri.root, '.bedrock.zip')) && !fs.existsSync(path.join(ri.root, 'eula.txt')));
    assert.match(props, /^server-name=Hi {2}there$/m); assert.match(props, /^view-distance=10$/m); assert.match(props, /^tick-distance=4$/m); assert.match(props, /^level-seed=abc$/m);
    assert.match(props, /^server-portv6=\d+$/m); assert.match(props, /^online-mode=true$/m); assert.match(props, /^server-udp-ports=\d+$/m); assert.match(props, /^transport=nethernet$/m);
    assert.ok(fs.readFileSync(path.join(ri.root, process.platform === 'win32' ? 'launch.cmd' : 'launch.sh'), 'utf8').includes('bedrock_server'));
    if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(ri.root, 'bedrock_server')).mode & 0o100, 'the program can be started');
    fs.writeFileSync(path.join(ri.root, 'allowlist.json'), JSON.stringify([{ name: 'Keep Me' }]));
    fs.writeFileSync(path.join(ri.root, 'server.properties'), props.replace('view-distance=10', 'view-distance=15'));
    await real.changeSoftware(made.id, { software: 'bedrock', mc: '1.26.63.1' });
    assert.equal((await installed()).state, 'done');
    assert.match(fs.readFileSync(path.join(ri.root, 'server.properties'), 'utf8'), /^view-distance=15$/m); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ri.root, 'allowlist.json'), 'utf8')), [{ name: 'Keep Me' }]);
    await assert.rejects(real.changeSoftware(made.id, { software: 'paper', mc: '26.3' }), /cannot become/);
    fs.rmSync(rdir, { recursive: true, force: true });
    ok('bedrock server: the zip is downloaded and unpacked, the program can be started, an update keeps the settings and the allow list');
  }

  let r = await call('GET', '/api/software');
  assert.deepEqual(r.json.software.find(s => s.id === 'bedrock'), { id: 'bedrock', label: 'Bedrock', dir: null, edition: 'bedrock' });
  assert.equal(r.json.software.find(s => s.id === 'paper').edition, 'java');
  assert.deepEqual((await call('GET', '/api/software/versions?software=bedrock')).json.versions, ['1.26.63.1']);
  assert.equal((await call('POST', '/api/servers', { name: 'Nope', software: 'bedrock', mc: '1.20.4', eula: true })).status, 400);
  r = await call('POST', '/api/servers', { name: 'Pocket World', software: 'bedrock', mc: '1.26.63.1', eula: true, motd1: 'Pocket' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.id, dir = root + '-servers/' + id;
  assert.equal((await settledB(id)).install.state, 'done');
  const pr = () => fs.readFileSync(dir + '/server.properties', 'utf8');
  const port1 = Number(/^server-port=(\d+)$/m.exec(pr())[1]);
  assert.match(pr(), new RegExp('^server-portv6=' + (port1 + 1) + '$', 'm')); assert.match(pr(), /^allow-list=true$/m); assert.match(pr(), /^server-name=Pocket$/m); assert.match(pr(), new RegExp('^server-udp-ports=' + port1 + '$', 'm')); assert.match(pr(), /^transport=nethernet$/m);
  r = (await call('GET', '/api/status' + sv(id))).json;
  assert.deepEqual([r.edition, r.softwareLabel, r.modsDir, r.whitelist], ['bedrock', 'Bedrock', null, true]);
  const two = (await call('POST', '/api/servers', { name: 'Pocket Two', software: 'bedrock', mc: '1.26.63.1', eula: true })).json.id;
  await settledB(two);
  assert.equal(Number(/^server-port=(\d+)$/m.exec(fs.readFileSync(root + '-servers/' + two + '/server.properties', 'utf8'))[1]), port1 + 2);
  ok('bedrock server: created from the same dialog, its own settings file, UDP ports in pairs, no eula.txt');

  r = (await call('GET', '/api/options' + sv(id))).json.options;
  assert.ok(r.some(o => o.key === 'tick-distance') && r.some(o => o.key === 'allow-cheats') && !r.some(o => o.key === 'pvp')); assert.equal(r.find(o => o.key === 'view-distance').value, '10');
  assert.equal((await call('PUT', '/api/options' + sv(id), { values: { gamemode: 'creative', 'view-distance': '12' } })).status, 200); assert.match(pr(), /^gamemode=creative$/m);
  for (const bad of [{ gamemode: 'hardcore' }, { pvp: 'true' }, { 'view-distance': '2' }]) assert.equal((await call('PUT', '/api/options' + sv(id), { values: bad })).status, 400, JSON.stringify(bad));
  r = (await call('GET', '/api/players' + sv(id))).json; assert.deepEqual([r.edition, r.whitelistOn, r.whitelist, r.ops, r.banned], ['bedrock', true, [], [], []]);
  assert.equal((await call('POST', '/api/player' + sv(id), { action: 'whitelist-add', name: 'Steve Jobs' })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(dir + '/allowlist.json', 'utf8')), [{ ignoresPlayerLimit: false, name: 'Steve Jobs' }]);
  for (const bad of [{ action: 'whitelist-add', name: '' }, { action: 'whitelist-add', name: 'x'.repeat(16) }, { action: 'whitelist-add', name: 'bad;name' }, { action: 'ban', name: 'Alex' }, { action: 'pardon', name: 'Alex' }, { action: 'ban-ip', ip: '1.2.3.4' }]) assert.equal((await call('POST', '/api/player' + sv(id), bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call('POST', '/api/player' + sv(id), { action: 'op', name: 'Alex' })).status, 409);
  assert.equal((await call('POST', '/api/cracked' + sv(id), { on: true })).status, 400);
  const live = registry.get(id);
  await live.sys.power('start');
  assert.equal((await call('POST', '/api/player' + sv(id), { action: 'whitelist-add', name: 'Alex' })).status, 200);
  assert.equal((await call('POST', '/api/player' + sv(id), { action: 'op', name: 'Alex' })).status, 200);
  assert.equal((await call('POST', '/api/player' + sv(id), { action: 'kick', name: 'Alex', reason: 'bye' })).status, 200);
  const said = await live.sys.log(30);
  assert.ok(said.includes('allowlist add "Alex"') && said.includes('op "Alex"') && said.includes('kick "Alex" bye'));
  assert.ok(JSON.parse(fs.readFileSync(dir + '/allowlist.json', 'utf8')).some(p => p.name === 'Alex'));
  assert.equal((await call('POST', '/api/whitelist' + sv(id), { on: false })).status, 200); assert.match(pr(), /^allow-list=false$/m); assert.match(await live.sys.log(5), /allowlist off/);
  assert.equal((await call('GET', '/api/status' + sv(id))).json.game.online, 1);
  ok('bedrock server: its own settings list (checked), players go on the allow list (names with spaces too), no bans or cracked mode, operators through the console');

  fs.mkdirSync(dir + '/worlds/Bedrock level/db', { recursive: true });
  fs.writeFileSync(dir + '/worlds/Bedrock level/level.dat', 'v1'); fs.writeFileSync(dir + '/worlds/Bedrock level/levelname.txt', 'Bedrock level'); fs.writeFileSync(dir + '/worlds/Bedrock level/db/CURRENT', 'x');
  r = await call('POST', '/api/backups' + sv(id));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const log = await live.sys.log(60);
  assert.ok(log.indexOf('save hold') < log.indexOf('save query') && log.indexOf('save query') < log.lastIndexOf('save resume'));
  const bname = r.json.name;
  const tarList = require('child_process').execFileSync(require('./common').TAR, ['-tzf', path.join(dir, 'backups', bname)], { encoding: 'utf8' });
  assert.match(tarList, /worlds\/Bedrock level\/level\.dat/); assert.match(tarList, /worlds\/Bedrock level\/db\/CURRENT/);
  await live.sys.power('stop');
  fs.writeFileSync(dir + '/worlds/Bedrock level/level.dat', 'v2');
  r = await call('POST', '/api/backups/restore' + sv(id), { name: bname });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(fs.readFileSync(dir + '/worlds/Bedrock level/level.dat', 'utf8'), 'v1');
  assert.ok(fs.readdirSync(dir + '/worlds').some(n => /^Bedrock level\.before-restore-/.test(n)));
  assert.equal((await call('POST', '/api/world/reset' + sv(id))).status, 200); assert.ok(fs.readdirSync(dir + '/worlds').some(n => /^Bedrock level\.before-reset-/.test(n)) && !fs.existsSync(dir + '/worlds/Bedrock level'));
  fs.renameSync(dir + '/worlds/' + fs.readdirSync(dir + '/worlds').find(n => /before-reset/.test(n)), dir + '/worlds/Bedrock level');
  ok('bedrock server: backups use "save hold / query / resume", hold the worlds folder only, restore keeps the old world, a fresh world keeps the old one');

  r = (await call('GET', '/api/worlds' + sv(id))).json;
  assert.deepEqual([r.level, r.worlds.find(w => w.active).name], ['Bedrock level', 'Bedrock level']);
  const dl = await call('GET', '/api/worlds/download' + sv(id) + '&name=' + encodeURIComponent('Bedrock level'));
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /\.mcworld/);
  const zf = path.join(os.tmpdir(), 'mcpanel-mcworld-' + process.pid + '.zip'); fs.writeFileSync(zf, dl.buf);
  assert.deepEqual((await require('./zip').list(zf)).map(e => e.name).sort(), ['db/', 'db/CURRENT', 'level.dat', 'levelname.txt']); fs.rmSync(zf, { force: true });
  const up = (name, body, q = '') => call('PUT', '/api/worlds/upload' + sv(id) + '&name=' + encodeURIComponent(name) + q, body);
  r = await up('Friend World', makeZip({ 'levelname.txt': 'Friend World', 'level.dat': 'x', 'db/CURRENT': 'x' }), '&use=1');
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual([r.json.name, r.json.used], ['Friend World', true]); assert.ok(fs.existsSync(dir + '/worlds/Friend World/db/CURRENT')); assert.match(pr(), /^level-name=Friend World$/m);
  r = await up('Java', makeZip({ 'world/level.dat': 'x', 'world/region/r.0.0.mca': 'x' })); assert.equal(r.status, 400); assert.match(r.json.error, /Java Edition/);
  assert.equal((await call('POST', '/api/worlds/new' + sv(id), { name: 'Fresh One', seed: '42', type: 'flat' })).status, 200); assert.match(pr(), /^level-name=Fresh One$/m); assert.match(pr(), /^level-seed=42$/m);
  assert.equal((await call('POST', '/api/worlds/use' + sv(id), { name: 'Bedrock level' })).status, 200);
  assert.equal((await call('POST', '/api/worlds/delete' + sv(id), { name: 'Bedrock level' })).status, 409);
  assert.equal((await call('POST', '/api/worlds/delete' + sv(id), { name: 'Friend World' })).status, 200); assert.ok(!fs.existsSync(dir + '/worlds/Friend World'));
  ok('bedrock server: worlds are listed from the worlds folder, a .mcworld comes out with the files at the top, uploads are checked, new / switch / delete work');

  assert.equal((await call('PUT', '/api/appearance' + sv(id), { motd1: 'A;B', port: port1 + 40 })).status, 200);
  assert.match(pr(), /^server-name=A B$/m); assert.match(pr(), new RegExp('^server-port=' + (port1 + 40) + '$', 'm')); assert.match(pr(), new RegExp('^server-portv6=' + (port1 + 41) + '$', 'm'));
  r = (await call('GET', '/api/appearance' + sv(id))).json; assert.deepEqual([r.edition, r.motd1, r.motd2, r.port], ['bedrock', 'A B', '', port1 + 40]);
  assert.equal((await call('PUT', '/api/appearance' + sv(id), { port: port1 + 2 })).status, 409);
  assert.equal((await call('PUT', '/api/settings' + sv(id), { memoryMB: 2048 })).status, 400); assert.equal((await call('GET', '/api/settings' + sv(id))).json.memoryManaged, false);
  assert.equal((await call('POST', '/api/lag/check' + sv(id))).status, 400); assert.equal((await call('GET', '/api/lag' + sv(id))).json.supported, false); assert.equal((await call('GET', '/api/pregen' + sv(id))).json.supported, false);
  assert.equal((await call('GET', '/api/bedrock' + sv(id))).json.supported, false);
  assert.equal((await call('POST', '/api/software' + sv(id), { software: 'paper', mc: '26.3' })).status, 400);
  const pal = (await call('POST', '/api/servers', { name: 'Java Pal', software: 'paper', mc: '26.3', eula: true })).json.id; await settledB(pal);
  assert.equal((await call('POST', '/api/software' + sv(pal), { software: 'bedrock', mc: '1.26.63.1' })).status, 400);
  assert.equal((await call('POST', '/api/servers/delete', { id: pal, confirm: 'Java Pal' })).status, 200);
  assert.equal((await call('POST', '/api/servers/duplicate', { id, name: 'Pocket Copy' })).status, 200);
  const copyId = (await call('GET', '/api/servers')).json.servers.find(s => s.name === 'Pocket Copy').id;
  const cp = fs.readFileSync(root + '-servers/' + copyId + '/server.properties', 'utf8'), cport = Number(/^server-port=(\d+)$/m.exec(cp)[1]);
  assert.ok(cport !== port1 + 40 && cport !== port1 + 2); assert.match(cp, new RegExp('^server-portv6=' + (cport + 1) + '$', 'm'));
  for (const [sid, name] of [[copyId, 'Pocket Copy'], [two, 'Pocket Two'], [id, 'Pocket World']]) assert.equal((await call('POST', '/api/servers/delete', { id: sid, confirm: name })).status, 200);
  ok('bedrock server: name and ports are changed (a taken port refused), memory, lag and Geyser are for Java only, Java and Bedrock cannot be switched, a copy gets its own ports');

  r = (await call('GET', '/api/bedrock?server=main')).json; assert.deepEqual([r.supported, r.kind, r.geyser, r.floodgate], [true, 'fabric', false, false]);
  r = await call('POST', '/api/bedrock/install?server=main'); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(fs.existsSync(root + '/mods/geyser-fabric.jar') && fs.existsSync(root + '/mods/floodgate-fabric.jar'));
  assert.equal((await call('POST', '/api/bedrock/enable?server=main')).status, 409);
  fs.mkdirSync(root + '/config/Geyser-Fabric', { recursive: true }); fs.writeFileSync(root + '/config/Geyser-Fabric/config.yml', 'remote:\n  auth-type: online\n');
  assert.equal((await call('POST', '/api/bedrock/enable?server=main')).status, 409);
  fs.mkdirSync(root + '/config/floodgate', { recursive: true }); fs.writeFileSync(root + '/config/floodgate/key.pem', 'KEY');
  assert.equal((await call('POST', '/api/bedrock/enable?server=main')).status, 200);
  assert.match(fs.readFileSync(root + '/config/Geyser-Fabric/config.yml', 'utf8'), /auth-type: floodgate/); assert.equal(fs.readFileSync(root + '/config/Geyser-Fabric/key.pem', 'utf8'), 'KEY');
  assert.equal((await call('GET', '/api/bedrock?server=main')).json.ready, true);
  const mainWas = (await registry.get('main').sys.state()).active;
  await registry.get('main').sys.power('start');
  assert.equal((await call('POST', '/api/player?server=main', { action: 'whitelist-add', name: '.Alex' })).status, 200);
  assert.ok((await registry.get('main').sys.log(10)).includes('fwhitelist add Alex'));
  assert.ok(JSON.parse(fs.readFileSync(root + '/whitelist.json', 'utf8')).some(p => p.name === '.Alex'));
  if (mainWas !== 'active') await registry.get('main').sys.power('stop');
  fs.writeFileSync(root + '/whitelist.json', JSON.stringify(JSON.parse(fs.readFileSync(root + '/whitelist.json', 'utf8')).filter(p => p.name !== '.Alex')));
  for (const f of ['mods/geyser-fabric.jar', 'mods/floodgate-fabric.jar']) fs.rmSync(path.join(root, f), { force: true });
  fs.rmSync(root + '/config/Geyser-Fabric', { recursive: true, force: true }); fs.rmSync(root + '/config/floodgate', { recursive: true, force: true });
  ok('bedrock players on Fabric: Geyser and Floodgate mods from Modrinth, the key is copied for Geyser, a Bedrock name goes on the whitelist through Floodgate');
}

async function accessTests() {
  const as = c => ({ Cookie: c });
  const jar = res => res.headers.get('set-cookie').split(';')[0];
  const ownerId = (await call('GET', '/api/me')).json.id;

  let r = await call('POST', '/api/access/ask', { name: 'Friend' }, as(''));
  assert.equal(r.status, 200); assert.equal(r.json.state, 'pending');
  const friend = jar(r);
  r = await call('GET', '/api/me', null, as(friend));
  assert.equal(r.status, 401); assert.equal(r.json.state, 'pending'); assert.equal(r.json.name, 'Friend');
  assert.equal((await call('GET', '/api/status', null, as(friend))).status, 401);
  await call('POST', '/api/access/ask', { name: 'Friend again' }, as(friend));
  let acc = (await call('GET', '/api/access')).json;
  assert.equal(acc.requests.length, 1); assert.equal(acc.me.pending, 1); assert.equal((await call('GET', '/api/me')).json.pending, 1); ok('access: a new device asks, waits outside, and asking twice makes one request');
  assert.equal((await call('POST', '/api/access/ask', { name: '' }, as(''))).status, 400); ok('access: a request needs a name');

  assert.equal((await call('POST', '/api/access/approve', { id: acc.requests[0].id, perms: ['power', 'nonsense'], servers: 'all' })).status, 200);
  let me = (await call('GET', '/api/me', null, as(friend))).json;
  assert.equal(me.owner, false); assert.deepEqual(me.perms, ['power']);
  const f = (method, url, body) => call(method, url, body, as(friend));
  assert.equal((await f('GET', '/api/status')).status, 200);
  for (const [m, u, b] of [['POST', '/api/command', { line: 'list' }], ['GET', '/api/log'], ['GET', '/api/files'], ['GET', '/api/players'], ['GET', '/api/mods'], ['GET', '/api/access'], ['POST', '/api/servers', {}], ['GET', '/api/options'], ['GET', '/api/backups'], ['GET', '/api/worlds'], ['PUT', '/api/import?name=a.zip', Buffer.alloc(4)], ['GET', '/api/nothing-here']]) {
    assert.equal((await f(m, u, b)).status, 403, m + ' ' + u);
  }
  assert.equal((await f('POST', '/api/power', { action: 'stop' })).status, 200);
  await f('POST', '/api/power', { action: 'start' }); ok('access: a person gets only what was ticked; everything else (and anything unlisted) is 403');
  const act = (await call('GET', '/api/activity')).json.items;
  assert.ok(act.length > 5 && act[0].t >= act[act.length - 1].t);
  assert.ok(act.some(a => a.who === 'Friend' && /^stopped the server/.test(a.what)) && act.some(a => a.who === 'Owner One' && /^ran \/say hi/.test(a.what)));
  assert.ok(!act.some(a => /^status/.test(a.what)) && act.every(a => a.who && a.t));
  assert.ok(act.some(a => a.who === 'Access' && /"Friend" was given access by Owner One/.test(a.what)) && act.some(a => a.who === 'Access' && /access requested by "Friend"/.test(a.what)));
  const doc = await call('GET', '/api/doctor');
  assert.equal(doc.status, 200); assert.ok(doc.json.checks.length >= 8 && doc.json.checks.every(c => typeof c.ok === 'boolean' && c.name && c.detail));
  assert.ok(doc.json.checks.find(c => c.name === 'Panel').ok && doc.json.checks.find(c => c.name === 'Panel files').ok && /Disk space/.test(doc.json.text));
  assert.equal((await f('GET', '/api/doctor')).status, 403);
  assert.equal((await f('GET', '/api/activity')).status, 403); ok('activity log: who did what, newest first, changes only, for people with access to manage access; the health check is for the owner');

  {
    const pw = (kind, password, perms) => call('POST', '/api/access/password', { kind, password, perms });
    const login = password => call('POST', '/api/access/login', { password, device: 'Test browser' }, as(''));
    assert.equal((await call('GET', '/api/me', null, as(''))).json.password, false);
    assert.equal((await login('anything at all')).status, 409);
    assert.equal((await pw('owner', 'short')).status, 400);
    assert.equal((await f('POST', '/api/access/password', { kind: 'owner', password: 'long enough pw' })).status, 403);
    assert.equal((await pw('owner', 'panel owner pw 1')).status, 200);
    assert.equal((await pw('guest', 'panel owner pw 1', ['console'])).status, 400);
    assert.equal((await pw('guest', 'panel friends pw 1', ['console'])).status, 200);
    assert.equal((await call('GET', '/api/me', null, as(''))).json.password, true);
    assert.equal((await login('nope nope nope')).status, 403);
    r = await login('panel owner pw 1'); assert.equal(r.status, 200); assert.equal(r.json.owner, true);
    assert.equal((await call('GET', '/api/doctor', null, as(jar(r)))).status, 200);
    r = await login('panel friends pw 1'); assert.equal(r.status, 200); assert.equal(r.json.owner, false);
    const friendDev = jar(r);
    assert.equal((await call('GET', '/api/log', null, as(friendDev))).status, 200);
    for (const [m, u, b] of [['GET', '/api/files'], ['GET', '/api/doctor'], ['POST', '/api/access/password', { kind: 'owner', password: 'takeover pass 9' }], ['POST', '/api/access/password/clear', { kind: 'owner' }]]) assert.equal((await call(m, u, b, as(friendDev))).status, 403, m + ' ' + u);
    const people = (await call('GET', '/api/access')).json.people.filter(p => p.viaPassword);
    assert.deepEqual(people.map(p => p.name).sort(), ['Friend (Test browser)', 'Owner (Test browser)']);
    const act2 = (await call('GET', '/api/activity')).json.items;
    assert.ok(act2.some(a => /set the owner password/.test(a.what)) && !JSON.stringify(act2).includes('panel owner pw') && !JSON.stringify(act2).includes('panel friends pw'));
    for (const p of people) assert.equal((await call('POST', '/api/access/remove', { id: p.id })).status, 200);
    assert.equal((await call('GET', '/api/me', null, as(friendDev))).status, 401);
    for (const kind of ['guest', 'owner']) assert.equal((await call('POST', '/api/access/password/clear', { kind })).status, 200);
    assert.equal((await login('panel owner pw 1')).status, 409);
    ok('passwords over HTTP: owner and friends passwords sign a device in, the friends one gets only what was ticked, passwords are owner-only and never logged');
  }

  const grant = async perms => (await call('POST', '/api/access/update', { id: me.id, perms })).status;
  assert.equal(await grant(['power', 'console']), 200);
  assert.equal((await f('POST', '/api/command', { line: 'say from friend' })).status, 200);
  assert.match((await f('GET', '/api/log')).json.text, /say from friend/); ok('access: giving another permission takes effect at once');
  assert.equal((await call('POST', '/api/access/update', { id: me.id, servers: ['nope'] })).status, 200);
  assert.equal((await f('GET', '/api/status')).status, 403); assert.deepEqual((await f('GET', '/api/servers')).json.servers, []);
  assert.equal((await f('GET', '/api/status?server=main')).status, 403);
  assert.equal((await call('POST', '/api/access/update', { id: me.id, servers: ['main'], perms: ['power', 'console', 'create'] })).status, 200);
  assert.deepEqual((await f('GET', '/api/servers')).json.servers.map(s => s.id), ['main']); assert.equal((await f('GET', '/api/status?server=main')).status, 200);
  assert.deepEqual((await f('GET', '/api/me')).json.perms, ['power', 'console']);
  assert.equal((await f('POST', '/api/servers', { name: 'x' })).status, 403); ok('access: a person can be limited to some servers; they see only those');
  assert.equal((await call('POST', '/api/access/update', { id: me.id, servers: 'all', perms: ['power', 'console', 'access'] })).status, 200);

  assert.equal((await f('POST', '/api/access/invite', { perms: ['files'] })).status, 403);
  r = await f('POST', '/api/access/invite', { name: 'Guest', perms: ['console'], hours: 1 });
  assert.equal(r.status, 200); assert.match(r.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await f('POST', '/api/access/update', { id: ownerId, perms: [] })).status, 403);
  assert.equal((await f('POST', '/api/access/remove', { id: ownerId })).status, 403); ok('access: a helper with "access" cannot give away more than they have, and cannot touch the owner');
  const guestJoin = await call('POST', '/api/access/redeem', { code: r.json.code, name: 'Guest' }, as(''));
  assert.equal(guestJoin.status, 200, JSON.stringify(guestJoin.json)); assert.deepEqual(guestJoin.json.perms, ['console']);
  const guest = jar(guestJoin);
  assert.equal((await call('GET', '/api/log', null, as(guest))).status, 200); assert.equal((await call('POST', '/api/power', { action: 'stop' }, as(guest))).status, 403);
  assert.equal((await call('POST', '/api/access/redeem', { code: r.json.code, name: 'Again' }, as(''))).status, 403); ok('access: an invite works once, for the permissions it was made with');
  r = await call('POST', '/api/access/invite', { perms: ['console'] });
  acc = (await call('GET', '/api/access')).json;
  assert.equal(acc.invites.length, 1); assert.equal(acc.people.length, 3);
  await call('POST', '/api/access/revoke', { id: acc.invites[0].id });
  assert.equal((await call('POST', '/api/access/redeem', { code: r.json.code, name: 'Late' }, as(''))).status, 403);
  assert.equal((await call('GET', '/api/access')).json.invites.length, 0); ok('access: an invite can be taken back before anyone uses it');

  assert.equal((await call('POST', '/api/access/remove', { id: guestJoin.json.id })).status, 200);
  assert.equal((await call('GET', '/api/me', null, as(guest))).status, 401); ok('access: removing a person locks their device out');
  assert.equal((await f('POST', '/api/access/leave')).status, 200);
  assert.equal((await call('GET', '/api/me', null, as(friend))).json.state, 'none'); ok('access: a person can sign their own device out');
  assert.equal((await call('POST', '/api/access/leave')).status, 400);
  assert.equal((await call('POST', '/api/access/remove', { id: ownerId })).status, 400);
  assert.equal((await call('POST', '/api/access/update', { id: ownerId, perms: [] })).status, 400); ok('access: the owner cannot leave, be removed or be limited');
  assert.equal((await call('GET', '/api/access')).json.people.length, 1);
  assert.ok(JSON.parse(fs.readFileSync(root + '-data/access.json', 'utf8')).people && !fs.readFileSync(root + '-data/access.json', 'utf8').includes(friend.split('=')[1])); ok('access: only hashes of the device keys are stored');

  r = await call('POST', '/api/access/add', { name: 'Zed Z', perms: ['console'], days: 3 });
  assert.equal(r.status, 200); assert.equal(r.json.joined, false); assert.match(r.json.key, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
  const zedKey = r.json.key;
  assert.equal((await call('POST', '/api/access/add', { name: 'zed  z', perms: [] })).status, 409);
  assert.equal((await call('POST', '/api/access/add', { name: '' })).status, 400);
  assert.deepEqual((await call('GET', '/api/access')).json.expected.map(e => e.name), ['Zed Z']);
  r = await call('POST', '/api/access/ask', { name: 'ZED z' }, as(''));
  assert.equal(r.json.state, 'pending');
  acc = (await call('GET', '/api/access')).json;
  assert.deepEqual(acc.requests.find(x => x.name === 'ZED z').suggest.perms, ['console']);
  await call('POST', '/api/access/remove', { id: acc.requests.find(x => x.name === 'ZED z').id });
  assert.equal((await call('POST', '/api/access/ask', { name: 'ZED z', key: 'AAAA-AAAA-AAAA' }, as(''))).json.state, 'pending');
  acc = (await call('GET', '/api/access')).json;
  await call('POST', '/api/access/remove', { id: acc.requests.find(x => x.name === 'ZED z').id });
  r = await call('POST', '/api/access/ask', { name: 'ZED z', key: zedKey.toLowerCase() }, as(''));
  assert.equal(r.json.state, 'active'); const zed = jar(r);
  me = (await call('GET', '/api/me', null, as(zed))).json;
  assert.equal(me.owner, false); assert.deepEqual(me.perms, ['console']); assert.equal(me.name, 'Zed Z');
  assert.equal((await call('GET', '/api/log', null, as(zed))).status, 200); assert.equal((await call('POST', '/api/power', { action: 'stop' }, as(zed))).status, 403);
  assert.deepEqual((await call('GET', '/api/access')).json.expected, []); ok('access: the link the owner made lets one device straight in with the permissions chosen; the name alone only waits');
  r = await call('POST', '/api/access/add', { name: 'Relink Me', perms: ['console'] });
  const oldKey = r.json.key;
  r = await call('POST', '/api/access/relink', { id: 'relink me' });
  assert.notEqual(r.json.key, oldKey);
  assert.equal((await call('POST', '/api/access/ask', { name: 'Relink Me', key: oldKey }, as(''))).json.state, 'pending');
  acc = (await call('GET', '/api/access')).json;
  await call('POST', '/api/access/remove', { id: acc.requests.find(x => x.name === 'Relink Me').id });
  assert.equal((await call('POST', '/api/access/ask', { name: 'Relink Me', key: r.json.key }, as(''))).json.state, 'active'); ok('access: a new link replaces the old one');
  acc = (await call('GET', '/api/access')).json;
  await call('POST', '/api/access/remove', { id: acc.people.find(x => x.name === 'Relink Me').id });
  r = await call('POST', '/api/access/ask', { name: 'Zed Z' }, as(''));
  assert.equal(r.json.state, 'pending'); const dupe = jar(r);
  r = await call('POST', '/api/access/ask', { name: 'Late Joiner' }, as(''));
  assert.equal(r.json.state, 'pending'); const late = jar(r);
  r = await call('POST', '/api/access/add', { name: 'late joiner', perms: ['power'] });
  assert.equal(r.json.joined, true);
  me = (await call('GET', '/api/me', null, as(late))).json;
  assert.equal(me.name, 'Late Joiner'); assert.deepEqual(me.perms, ['power']); ok('access: somebody already waiting is let in when the owner adds their name');
  assert.equal((await call('POST', '/api/access/add', { name: 'Nobody', perms: [] })).status, 200);
  assert.equal((await call('POST', '/api/access/forget', { id: 'nobody' })).status, 200);
  assert.deepEqual((await call('GET', '/api/access')).json.expected, []);
  assert.equal((await f('POST', '/api/access/add', { name: 'X' })).status, 401);
  acc = (await call('GET', '/api/access')).json;
  for (const p of [...acc.requests, ...acc.people.filter(x => !x.owner)]) await call('POST', '/api/access/remove', { id: p.id });
  assert.equal((await call('GET', '/api/access')).json.people.length, 1); ok('access: a name can be taken back before anyone uses it');

  const d = [];
  for (let i = 0; i < 3; i++) d.push((await call('POST', '/api/access/ask', { name: 'Spam ' + i }, as(''))).status);
  assert.deepEqual(d, [200, 200, 200]);
  assert.equal((await call('POST', '/api/access/ask', { name: 'Spam 4' }, as(''))).status, 429);
  for (const p of (await call('GET', '/api/access')).json.requests) await call('POST', '/api/access/remove', { id: p.id });
  ok('access: one address cannot pile up requests');
  let last;
  for (let i = 0; i < 9; i++) last = await call('POST', '/api/access/redeem', { code: 'ZZZZ-ZZZZ-ZZ' + (i % 10), name: 'x' }, as(''));
  assert.equal(last.status, 429);
  assert.equal((await call('GET', '/api/me')).status, 200); ok('access: too many wrong codes lock that address out for a while (owners with a device key are not affected)');
}

async function pingTest() {
  let received = Buffer.alloc(0);
  const mc = net.createServer(sock => sock.on('data', c => {
    received = Buffer.concat([received, c]);
    if (received.length < 22) return;
    const json = Buffer.from(JSON.stringify({ version: { name: '26.3' }, players: { max: 10, online: 2, sample: [{ name: 'A' }, { name: 'B' }] } }));
    const body = Buffer.concat([vi(0), vi(json.length), json]);
    const pkt = Buffer.concat([vi(body.length), body]);
    sock.write(pkt.subarray(0, 4));
    setTimeout(() => sock.write(pkt.subarray(4)), 40);
  }));
  await new Promise(r => mc.listen(18791, '127.0.0.1', r));
  const got = await ping(18791);
  assert.deepEqual(got, { online: 2, max: 10, names: ['A', 'B'], version: '26.3' });
  const expected = Buffer.concat([Buffer.from([0x13, 0x00, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x09]), Buffer.from('127.0.0.1'), Buffer.from([0x49, 0x67, 0x01, 0x01, 0x00])]);
  assert.deepEqual(received, expected); ok('ping reads players and sends a valid handshake');
  mc.close();
  assert.equal(await ping(18792), null); ok('ping of a closed port gives null');
}

async function platformTests() {
  const zip = require('./zip');
  const { makeProcessSys, stopAll } = require('./runner');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-plat-'));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, what) => { for (let i = 0; i < 300; i++) { if (await fn()) return; await sleep(50); } throw new Error('timed out: ' + what); };

  const z = path.join(tmp, 'a.zip');
  fs.writeFileSync(z, makeZip({ 'w/level.dat': 'abc', 'w/region/r.0.0.mca': 'xyz', 'empty.txt': '' }));
  assert.deepEqual((await zip.list(z)).map(e => e.name).sort(), ['empty.txt', 'w/level.dat', 'w/region/r.0.0.mca']);
  assert.equal((await zip.read(z, 'w/level.dat')).toString(), 'abc'); assert.equal(await zip.read(z, 'nope'), null);
  await zip.extract(z, path.join(tmp, 'out'), { strip: 1 });
  assert.equal(fs.readFileSync(path.join(tmp, 'out', 'region', 'r.0.0.mca'), 'utf8'), 'xyz'); assert.ok(!fs.existsSync(path.join(tmp, 'out', 'empty.txt')));
  await zip.extract(z, path.join(tmp, 'out2'));
  assert.equal(fs.readFileSync(path.join(tmp, 'out2', 'w', 'level.dat'), 'utf8'), 'abc'); assert.equal(fs.statSync(path.join(tmp, 'out2', 'empty.txt')).size, 0);
  const mods = path.join(__dirname, '..', 'mods');
  const jars = fs.existsSync(mods) ? fs.readdirSync(mods).filter(f => f.endsWith('.jar')) : [];
  for (const jar of jars) {
    const entries = await zip.list(path.join(mods, jar));
    assert.ok(entries.some(e => e.method === 8), 'a real jar is deflated');
    await zip.extract(path.join(mods, jar), path.join(tmp, 'jar-' + jar));
    assert.ok(fs.existsSync(path.join(tmp, 'jar-' + jar, 'fabric.mod.json')));
    assert.equal(JSON.parse((await zip.read(path.join(mods, jar), 'fabric.mod.json')).toString()).schemaVersion, 1);
  }
  const evil = path.join(tmp, 'evil.zip');
  fs.writeFileSync(evil, makeZip({ '../escape.txt': 'x' }));
  await assert.rejects(zip.extract(evil, path.join(tmp, 'out3')), /unsafe/); assert.ok(!fs.existsSync(path.join(tmp, 'escape.txt')));
  fs.writeFileSync(path.join(tmp, 'text.zip'), 'definitely not a zip');
  await assert.rejects(zip.list(path.join(tmp, 'text.zip')), /not a zip/);
  const bytes = makeZip({ 'f.txt': 'hello' });
  bytes.writeUInt32LE(2, bytes.indexOf(Buffer.from('PK\x01\x02')) + 24);
  fs.writeFileSync(path.join(tmp, 'lie.zip'), bytes);
  await assert.rejects(zip.extract(path.join(tmp, 'lie.zip'), path.join(tmp, 'out4')), /bigger than the zip says/);
  ok('zip reader: list, read, unpack (stored and deflated), ../ names, lying sizes and non-zips refused');

  const dir = path.join(tmp, 'srv');
  fs.mkdirSync(dir);
  const sys = makeProcessSys({ dir, port: async () => 18799 });
  await assert.rejects(sys.power('start'), /no start file/);
  fs.writeFileSync(path.join(dir, 'fake-mc.js'), [
    "console.log('Done (1s)! For help, type \"help\"');",
    "require('readline').createInterface({ input: process.stdin }).on('line', l => { console.log('got: ' + l); if (l === 'stop') process.exit(0); if (l === 'crash') process.exit(3); });",
  ].join('\n'));
  if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'launch.cmd'), `@echo off\r\ncd /d "%~dp0"\r\n"${process.execPath}" fake-mc.js\r\n`);
  else fs.writeFileSync(path.join(dir, 'launch.sh'), `#!/bin/sh\ncd "$(dirname "$0")"\nexec '${process.execPath}' fake-mc.js\n`, { mode: 0o755 });
  assert.equal((await sys.state()).active, 'inactive');
  await sys.power('start');
  assert.equal((await sys.state()).active, 'active');
  await assert.rejects(sys.power('start'), /already running/);
  await until(async () => /Done/.test(await sys.log(20)), 'server output');
  await sys.command('say hi');
  await until(async () => /got: say hi/.test(await sys.log(20)), 'command answered');
  await sys.power('restart');
  assert.equal((await sys.state()).active, 'active');
  await sys.power('stop');
  assert.equal((await sys.state()).active, 'inactive');
  await assert.rejects(sys.command('list'), /not running/);
  await sys.power('start');
  await sys.command('crash');
  await until(async () => (await sys.state()).active === 'failed', 'crash noticed');
  await sys.power('start');
  await stopAll();
  assert.equal((await sys.state()).active, 'inactive');
  ok('child-process runner: start, console in and out, restart, stop, crash shows as failed, stopAll');

  const makeRegistry = require('./registry');
  const bare = makeRegistry({ dataDir: path.join(tmp, 'data'), baseDir: path.join(tmp, 'servers'), mainDir: path.join(tmp, 'nothing-here'), panelPort: 18790, mc: '26.3', heapMB: 1024, javaDir: path.join(tmp, 'java'), fake: false });
  assert.deepEqual(await bare.overview(), []); assert.throws(() => bare.defaultId(), /no server yet/);
  ok('registry without a main server starts empty and asks for a first server');
  const two = makeRegistry({ dataDir: path.join(tmp, 'data2'), baseDir: path.join(tmp, 'servers2'), mainDir: path.join(tmp, 'nothing-here'), panelPort: 18790, mc: '26.3', heapMB: 1024, javaDir: path.join(tmp, 'java'), fake: true, maxRunning: 2 });
  assert.equal(two.defaultId(), 'main');
  const a = (await two.create({ name: 'A', software: 'vanilla', mc: '26.3', eula: true })).id;
  const b = (await two.create({ name: 'B', software: 'vanilla', mc: '26.3', eula: true })).id;
  await until(async () => (await two.get(a).getInstall()).state === 'done' && (await two.get(b).getInstall()).state === 'done', 'fake installs');
  await two.get('main').sys.power('stop');
  await two.get(a).sys.power('start');
  assert.equal(await two.othersActive(b), null, 'one running, two allowed: B may start');
  await two.get(b).sys.power('start');
  assert.equal((await two.othersActive('main')).id, a, 'two running, two allowed: a third must wait');
  ok('more than one server can run at once when the limit says so');
  const makeAccess = require('./access');
  const adir = path.join(tmp, 'access');
  let clock = 1.7e12;
  const A = makeAccess({ dir: adir, now: () => clock, log: () => {} });
  const rq = (cookie = '', headers = {}) => ({ headers: { cookie, ...headers } });
  const rs = () => { const h = {}; return { h, setHeader: (k, v) => { h[k] = v; } }; };
  const tok = r => /mcd=([a-f0-9]{64})/.exec(r.h['Set-Cookie'])[1];
  assert.ok(fs.existsSync(path.join(adir, 'setup-code.txt')));
  assert.throws(() => A.claimHere(rq(), rs(), '192.168.1.5', 'X'), /only a browser on the computer/);
  assert.throws(() => A.claimHere(rq('', { 'x-forwarded-for': '1.2.3.4' }), rs(), '127.0.0.1', 'X'), /only a browser on the computer/);
  const r1 = rs();
  const boss = A.claimHere(rq(), r1, '::ffff:127.0.0.1', 'Boss');
  assert.ok(boss.owner && boss.perms.length === Object.keys(A.PERMS).length);
  assert.ok(!fs.existsSync(path.join(adir, 'setup-code.txt')));
  assert.throws(() => A.claimHere(rq(), rs(), '127.0.0.1', 'X'), /already has an owner/);
  assert.throws(() => A.redeem(rq(), rs(), '127.0.0.1', 'AAAA-AAAA-AAAA', 'X'), /not right/);
  const bossCookie = 'mcd=' + tok(r1);
  assert.equal(A.who(rq(bossCookie)).id, boss.id); assert.equal(A.who(rq('mcd=' + 'a'.repeat(64))), null); assert.equal(A.who(rq('mcd=short')), null);
  const { code } = A.invite(boss, { name: 'Pal', perms: ['console'], hours: 1 });
  await A.flush();
  const saved = fs.readFileSync(path.join(adir, 'access.json'), 'utf8');
  assert.ok(!saved.includes(tok(r1)) && !saved.includes(code.replace(/-/g, '')) && !saved.includes(code));
  const A2 = makeAccess({ dir: adir, now: () => clock, log: () => {} });
  assert.equal(A2.who(rq(bossCookie)).name, 'Boss'); assert.ok(!fs.existsSync(path.join(adir, 'setup-code.txt')));
  const pal = A2.redeem(rq(), rs(), '10.0.0.7', code, 'Pal'); assert.deepEqual(pal.perms, ['console']);
  const old = A2.invite(boss, { name: 'Late', perms: [], hours: 1 });
  clock += 2 * 3600e3;
  assert.throws(() => A2.redeem(rq(), rs(), '10.0.0.8', old.code, 'x'), /not right/); ok('access book: claiming from this computer only, hashed keys and codes, survives a restart, invites expire');
  const tempKey = A2.addByName(boss, { name: 'Temp', perms: ['console'], days: 1 }).key;
  clock += 2 * 86400e3;
  assert.equal(A2.ask(rq(), rs(), '10.0.0.20', 'Temp', tempKey).state, 'pending'); ok('access book: an added name stops working after the days you gave');
  for (let i = 0; i < 7; i++) assert.throws(() => A2.redeem(rq(), rs(), '10.0.0.9', 'BBBB-BBBB-BB' + i + 'B', 'x'), /not right/);
  assert.throws(() => A2.redeem(rq(), rs(), '10.0.0.9', 'BBBB-BBBB-BBBB', 'x'), /not right/);
  assert.throws(() => A2.redeem(rq(), rs(), '10.0.0.9', old.code, 'x'), /too many tries/);
  clock += 11 * 60e3;
  assert.throws(() => A2.redeem(rq(), rs(), '10.0.0.9', old.code, 'x'), /not right/); ok('access book: 8 wrong codes lock an address out for 10 minutes');

  const sk = A2.addByName(boss, { name: 'Alex  Moss', perms: ['console'], days: 1 }).key;
  assert.equal(A2.ask(rq(), rs(), '10.0.0.30', 'alex moss', sk).state, 'active'); ok('access book: added names match whatever the spacing and capitals');

  const { execFileSync } = require('child_process');
  const pdir = path.join(tmp, 'access-pw');
  const P = makeAccess({ dir: pdir, now: () => clock, log: () => {} });
  assert.ok(fs.existsSync(path.join(pdir, 'setup-code.txt')) && P.door(rq(), '10.0.0.5').setup === true && P.door(rq(), '10.0.0.5').password === false);
  assert.throws(() => P.login(rq(), rs(), '10.0.0.5', 'whatever', 'Phone'), /no password has been set/);
  const cli = (args, input) => execFileSync(process.execPath, [path.join(__dirname, 'set-password.js'), ...args], { input, env: { ...process.env, PANEL_DATA: pdir }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const needed = () => { try { cli(['--needed']); return 0; } catch (e) { return e.status; } };
  assert.equal(needed(), 0, 'no owner and no password yet: the installer should ask');
  assert.throws(() => cli(['owner', '--stdin'], 'short'), /needs 8 to 100/); assert.ok(!fs.existsSync(path.join(pdir, 'set-password.json')));
  assert.match(cli(['owner', '--stdin'], 'correct horse battery'), /owner password is set/);
  assert.ok(fs.existsSync(path.join(pdir, 'set-password.json')));
  assert.ok(!fs.readFileSync(path.join(pdir, 'set-password.json'), 'utf8').includes('correct horse'), 'only a hash is written');
  const door = P.door(rq(), '10.0.0.5');
  assert.deepEqual([door.setup, door.password, door.state], [false, true, 'none']);
  assert.ok(!fs.existsSync(path.join(pdir, 'set-password.json')) && !fs.existsSync(path.join(pdir, 'setup-code.txt')), 'the password replaces the setup code');
  assert.throws(() => P.ask(rq(), rs(), '10.0.0.5', 'Friend'), /sign in with the password first/);
  assert.throws(() => P.login(rq(), rs(), '10.0.0.5', 'wrong password!', 'Phone'), /not right/);
  const pr = rs();
  const phone = P.login(rq(), pr, '10.0.0.5', 'correct horse battery', 'Android phone');
  assert.deepEqual([phone.owner, phone.name, phone.viaPassword, phone.perms.length], [true, 'Owner (Android phone)', 'owner', Object.keys(P.PERMS).length]);
  assert.equal(P.who(rq('mcd=' + tok(pr))).id, phone.id); assert.ok(P.owner());
  const pr2 = rs();
  const again = P.login(rq('mcd=' + tok(pr)), pr2, '10.0.0.5', 'correct horse battery', 'Android phone');
  const phoneCk = 'mcd=' + tok(pr2);
  assert.equal(again.id, phone.id); assert.equal(P.list(phone).people.filter(x => x.viaPassword === 'owner').length, 1);
  const pc = P.login(rq(), rs(), '10.0.0.6', 'correct horse battery', 'Windows PC');
  assert.notEqual(pc.id, phone.id); assert.equal(pc.name, 'Owner (Windows PC)');
  P.remove(phone, pc.id); assert.throws(() => P.remove(phone, 'nobody'), /no such person/);
  assert.throws(() => P.setPassword(phone, { kind: 'guest', password: 'correct horse battery' }), /must be different/);
  assert.throws(() => P.setPassword(phone, { kind: 'guest', password: 'tiny' }), /needs 8 to 100/);
  P.setPassword(phone, { kind: 'guest', password: 'friends only 2026', perms: ['console', 'power', 'nonsense'] });
  assert.deepEqual(P.list(phone).passwords, { owner: true, guest: { perms: ['console', 'power'], servers: 'all' } });
  const fr = rs();
  const friend = P.login(rq(), fr, '10.0.0.7', 'friends only 2026', 'iPhone');
  assert.deepEqual([friend.owner, friend.name, friend.perms, friend.viaPassword], [false, 'Friend (iPhone)', ['console', 'power'], 'guest']);
  assert.ok(P.can(friend, 'console') && !P.can(friend, 'files') && !P.can(friend, 'access'));
  assert.throws(() => P.setPassword(friend, { kind: 'owner', password: 'takeover password' }), /only the owner/);
  assert.throws(() => P.clearPassword(friend, 'owner'), /only the owner/);
  assert.throws(() => P.changeGuest(friend, { perms: [] }), /only the owner/);
  assert.equal(P.login(rq(phoneCk), rs(), '10.0.0.5', 'friends only 2026', 'Android phone').owner, true);
  P.changeGuest(phone, { perms: ['console'] }); assert.deepEqual(P.list(phone).passwords.guest.perms, ['console']);
  P.leave(friend); assert.equal(P.who(rq('mcd=' + tok(fr))), null);
  P.clearPassword(phone, 'guest'); assert.throws(() => P.login(rq(), rs(), '10.0.0.7', 'friends only 2026', 'iPhone'), /not right/);
  await P.flush();
  assert.ok(!fs.readFileSync(path.join(pdir, 'access.json'), 'utf8').includes('correct horse'), 'passwords are never stored, only salted hashes');
  const P2 = makeAccess({ dir: pdir, now: () => clock, log: () => {} });
  assert.equal(P2.who(rq(phoneCk)).name, 'Owner (Android phone)'); assert.equal(P2.login(rq(), rs(), '10.0.0.8', 'correct horse battery', 'Mac').name, 'Owner (Mac)');
  for (let i = 0; i < 8; i++) assert.throws(() => P2.login(rq(), rs(), '10.0.0.9', 'guess number ' + i, 'x'), /not right/);
  assert.throws(() => P2.login(rq(), rs(), '10.0.0.9', 'correct horse battery', 'x'), /too many tries/);
  clock += 11 * 60e3;
  assert.equal(P2.login(rq(), rs(), '10.0.0.9', 'correct horse battery', 'x').owner, true);
  await P2.flush();
  assert.equal(needed(), 1, 'there is an owner now: the installer need not ask');
  ok('passwords: set from the computer, picked up by the panel, hashed, owner and friends, one entry per device, 8 wrong tries lock an address out');

  const { zipFolder } = require('./zipwrite');
  const { pipeline } = require('stream/promises');
  const src = path.join(tmp, 'zsrc');
  fs.mkdirSync(path.join(src, 'sub', 'deep'), { recursive: true }); fs.mkdirSync(path.join(src, 'emptydir'));
  const bigData = Buffer.concat([crypto.randomBytes(300000), Buffer.alloc(3000000, 'minecraft ')]);
  fs.writeFileSync(path.join(src, 'a.txt'), 'hello'); fs.writeFileSync(path.join(src, 'sub', 'big.bin'), bigData);
  fs.writeFileSync(path.join(src, 'sub', 'deep', 'é ü.txt'), 'unicode'); fs.writeFileSync(path.join(src, 'empty.txt'), ''); fs.writeFileSync(path.join(src, 'session.lock'), 'x');
  const zout = path.join(tmp, 'w.zip');
  await pipeline(zipFolder(src, 'W', rel => rel === 'session.lock'), fs.createWriteStream(zout));
  assert.deepEqual((await zip.list(zout)).map(e => e.name).sort(), ['W/', 'W/a.txt', 'W/empty.txt', 'W/emptydir/', 'W/sub/', 'W/sub/big.bin', 'W/sub/deep/', 'W/sub/deep/é ü.txt'].sort());
  await zip.extract(zout, path.join(tmp, 'zx'));
  assert.ok(fs.readFileSync(path.join(tmp, 'zx', 'W', 'sub', 'big.bin')).equals(bigData)); assert.equal(fs.readFileSync(path.join(tmp, 'zx', 'W', 'sub', 'deep', 'é ü.txt'), 'utf8'), 'unicode');
  assert.ok(fs.statSync(path.join(tmp, 'zx', 'W', 'emptydir')).isDirectory()); assert.ok(!fs.existsSync(path.join(tmp, 'zx', 'W', 'session.lock')));
  if (process.platform === 'win32') {
    fs.mkdirSync(path.join(tmp, 'zt'));
    require('child_process').execFileSync(require('./common').TAR, ['-xf', zout, '-C', path.join(tmp, 'zt')]);
    assert.ok(fs.readFileSync(path.join(tmp, 'zt', 'W', 'sub', 'big.bin')).equals(bigData));
  }
  ok('zip writer: folders, empty files, unicode names and big files come out right (checked by our reader and by tar)');
  const many = path.join(tmp, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i < 65600; i++) fs.writeFileSync(path.join(many, 'f' + i), '');
  const mout = path.join(tmp, 'many.zip');
  await pipeline(zipFolder(many, 'M'), fs.createWriteStream(mout));
  assert.equal((await zip.list(mout)).length, 65601); ok('zip writer: more than 65535 files get a zip64 directory');

  const sch = (await two.create({ name: 'Sched', software: 'vanilla', mc: '26.3', eula: true })).id;
  await until(async () => (await two.get(sch).getInstall()).state === 'done', 'fake install');
  const now = new Date();
  two.get(sch).entry.settings.restartAt = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  await two.get(sch).sys.power('start');
  await two.tick(); await two.tick();
  assert.equal(((await two.get(sch).sys.log(50)).match(/restarts in 30 seconds/g) || []).length, 1); ok('a daily restart time warns the players once, then restarts');

  for (const x of [a, b, sch]) await two.get(x).sys.power('stop');
  const s2 = (await two.create({ name: 'Sched2', software: 'vanilla', mc: '26.3', eula: true })).id;
  await until(async () => (await two.get(s2).getInstall()).state === 'done', 'fake install');
  if (new Date().getSeconds() > 54) await sleep(6000);
  const when = new Date();
  const hh = String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
  two.get(s2).entry.settings.startAt = hh;
  await two.tick();
  assert.equal((await two.get(s2).sys.state()).active, 'active');
  two.get(s2).entry.settings.stopAt = hh;
  await two.tick();
  assert.match(await two.get(s2).sys.log(50), /The server stops in 30 seconds/); ok('a daily start time starts a stopped server, a daily stop time warns and stops it');
  const cr = (await two.create({ name: 'Crashy', software: 'vanilla', mc: '26.3', eula: true })).id;
  await until(async () => (await two.get(cr).getInstall()).state === 'done', 'fake install');
  const ci = two.get(cr);
  await ci.sys.power('start');
  ci.entry.settings.restartOnCrash = false;
  ci.sys.crash(); await two.tick();
  assert.equal((await ci.sys.state()).active, 'failed');
  ci.entry.settings.restartOnCrash = true;
  for (let i = 1; i <= 3; i++) { if (i > 1) ci.sys.crash(); await two.tick(); assert.equal((await ci.sys.state()).active, 'active', 'restart ' + i); }
  ci.sys.crash(); await two.tick();
  assert.equal((await ci.sys.state()).active, 'failed'); ok('a crashed server is started again up to 3 times in half an hour, and never when that is switched off');
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().then(pingTest).then(platformTests).then(() => { console.log('all passed'); process.exit(0); }, e => { console.error(e); process.exit(1); });
