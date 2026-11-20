'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fail, setProp, levelName, modInfo, installedIds, vcmp, dirSize, downloadVerified, TAR } = require('./common');
const zipfile = require('./zip');

const MAX_UNZIPPED = 8 * 1024 ** 3;
const WORD = /^[\w.:/-]{1,60}$/;
const FREE = /^[^\r\n]{0,400}$/;
const SETTINGS = {
  difficulty: WORD, gamemode: WORD, 'force-gamemode': WORD, hardcore: WORD, pvp: WORD, 'allow-flight': WORD, 'allow-nether': WORD,
  'spawn-animals': WORD, 'spawn-monsters': WORD, 'spawn-npcs': WORD, 'enable-command-block': WORD, 'spawn-protection': WORD,
  'max-players': WORD, 'view-distance': WORD, 'simulation-distance': WORD, 'player-idle-timeout': WORD, 'generate-structures': WORD,
  'max-world-size': WORD, 'op-permission-level': WORD, 'function-permission-level': WORD, 'entity-broadcast-range-percentage': WORD,
  'hide-online-players': WORD, 'enforce-secure-profile': WORD, 'network-compression-threshold': WORD,
};
const PACK = ['resource-pack', 'resource-pack-sha1', 'require-resource-pack', 'resource-pack-prompt'];
const ID = /^[a-f0-9]{16}$/;
const KIND_TEXT = { fabric: 'a Fabric mod', forge: 'a Forge mod', neoforge: 'a NeoForge mod', plugin: 'a Bukkit/Paper plugin' };
const EXTRA_DIRS = ['defaultconfigs', 'kubejs'];
const SERVER_YML = /^(bukkit|spigot|paper|purpur|commands|permissions|help)(-global|-world-defaults)?\.yml$/;

function readNbt(buf) {
  let p = 0;
  const str = () => { const n = buf.readUInt16BE(p); p += 2; const s = buf.toString('utf8', p, p + n); p += n; return s; };
  const val = t => {
    switch (t) {
      case 1: return buf.readInt8(p++);
      case 2: p += 2; return buf.readInt16BE(p - 2);
      case 3: p += 4; return buf.readInt32BE(p - 4);
      case 4: p += 8; return Number(buf.readBigInt64BE(p - 8));
      case 5: p += 4; return buf.readFloatBE(p - 4);
      case 6: p += 8; return buf.readDoubleBE(p - 8);
      case 7: { const n = buf.readInt32BE(p); p += 4 + n; return null; }
      case 8: return str();
      case 9: { const t2 = buf.readInt8(p++); const n = buf.readInt32BE(p); p += 4; const a = []; for (let i = 0; i < n; i++) a.push(val(t2)); return a; }
      case 10: { const o = {}; for (;;) { const t2 = buf.readInt8(p++); if (t2 === 0) return o; o[str()] = val(t2); } }
      case 11: { const n = buf.readInt32BE(p); p += 4 + 4 * n; return null; }
      case 12: { const n = buf.readInt32BE(p); p += 4 + 8 * n; return null; }
      default: throw new Error('bad NBT');
    }
  };
  if (buf.readInt8(p++) !== 10) throw new Error('bad NBT');
  str();
  return val(10);
}
function worldInfo(levelDat) {
  try {
    const d = readNbt(zlib.gunzipSync(levelDat)).Data || {};
    return { name: String(d.LevelName || ''), version: String(d.Version?.Name || ''), lastPlayed: Number(d.LastPlayed) || 0 };
  } catch { return { name: '', version: '', lastPlayed: 0 }; }
}

async function walk(dir, max, rel = '', depth = 1, out = []) {
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    out.push({ rel: r, abs: path.join(dir, r), dir: e.isDirectory(), name: e.name, depth });
    if (e.isDirectory() && depth < max) await walk(dir, max, r, depth + 1, out);
  }
  return out;
}
const shallowest = list => list.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel))[0];

async function dropLinks(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) await fsp.rm(p);
    else if (e.isDirectory()) await dropLinks(p);
  }
}
const exists = p => fsp.stat(p).then(() => true, () => false);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
async function move(src, dest) {
  try { await fsp.rename(src, dest); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(src, dest, { recursive: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
}
async function readJsonList(file) {
  try { const a = JSON.parse(await fsp.readFile(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
const validPlayer = p => p && /^[0-9a-f-]{32,36}$/i.test(String(p.uuid)) && /^\w{3,16}$/.test(String(p.name));
const isPng64 = b => b.length > 33 && b.length < 1048576 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.readUInt32BE(16) === 64 && b.readUInt32BE(20) === 64;
const release = v => /^(1\.\d{1,2}(\.\d{1,2})?|2\d\.\d{1,2}(\.\d{1,2})?)$/.test(v);

module.exports = function makeImporter({ stage }) {
  const dirOf = id => { if (!ID.test(String(id))) fail(400, 'bad import id'); return path.join(stage, id); };

  async function freeBytes() {
    try { const s = await fsp.statfs(stage); return s.bavail * s.bsize; } catch { return Infinity; }
  }
  async function newStage(kind = 'zip') {
    const id = crypto.randomBytes(8).toString('hex');
    await fsp.mkdir(path.join(stage, id), { recursive: true });
    return { id, zip: path.join(stage, id, kind === 'tgz' ? 'upload.tgz' : 'upload.zip') };
  }

  const tarRun = (args, source, quiet) => new Promise((resolve, reject) => {
    const tar = spawn(TAR, args, { windowsHide: true });
    let out = '', err = '';
    tar.stdout.on('data', d => { if (!quiet) out += d; });
    tar.stderr.on('data', d => { err += d; });
    tar.on('error', reject);
    tar.on('close', code => code === 0 ? resolve(out) : reject(Object.assign(new Error(err.trim().split('\n')[0] || 'tar failed'), { status: 400 })));
    fs.createReadStream(source).on('error', reject).pipe(tar.stdin);
    tar.stdin.on('error', () => {});
  });
  async function unpackTar(tgz, dir) {
    if ((await fsp.stat(tgz)).size * 4 > await freeBytes()) fail(507, 'not enough free disk space on this computer to unpack this archive');
    const names = (await tarRun(['-tzf', '-'], tgz)).split(/\r?\n/).filter(Boolean);
    if (!names.length) fail(400, 'the archive is empty');
    if (names.length > 300000) fail(400, 'too many files in the archive');
    for (const n of names) if (n.startsWith('/') || n.includes('\\') || /(^|\/)\.\.(\/|$)/.test(n) || /^[A-Za-z]:/.test(n)) fail(400, 'the archive contains unsafe file names, nothing was imported');
    await fsp.mkdir(dir, { recursive: true });
    await tarRun(['-xzf', '-', '-C', dir], tgz, true);
  }

  function pickWorld(cands, wanted) {
    const named = wanted && cands.filter(c => c.name === wanted);
    if (named && named.length) return shallowest(named);
    const main = cands.filter(c => !/_(nether|the_end)$/.test(c.name));
    return shallowest(main.length ? main : cands);
  }

  async function detect(plan, dir, serverRoot, all) {
    const rootNames = new Set((await fsp.readdir(serverRoot).catch(() => [])));
    const configNames = new Set((await fsp.readdir(path.join(serverRoot, 'config')).catch(() => [])));
    const kinds = {};
    for (const j of plan.jars) kinds[j.kind] = (kinds[j.kind] || 0) + 1;
    const modKinds = ['fabric', 'forge', 'neoforge'].sort((a, b) => (kinds[b] || 0) - (kinds[a] || 0));
    const notes = [];
    let software = '';
    if (rootNames.has('purpur.yml')) software = 'purpur';
    else if (rootNames.has('paper.yml') || rootNames.has('paper-global.yml') || configNames.has('paper-global.yml')) software = 'paper';
    else if (rootNames.has('spigot.yml') || rootNames.has('bukkit.yml') || kinds.plugin) { software = 'paper'; if (rootNames.has('spigot.yml') && !kinds.plugin) notes.push('It was a Spigot server; Paper runs everything Spigot does.'); }
    if (!software && kinds[modKinds[0]]) software = modKinds[0];
    if (!software) {
      const lib = n => exists(path.join(serverRoot, 'libraries', ...n.split('/')));
      if (rootNames.has('.fabric') || [...rootNames].some(f => /^fabric-server/.test(f))) software = 'fabric';
      else if (await lib('net/neoforged')) software = 'neoforge';
      else if (await lib('net/minecraftforge')) software = 'forge';
    }
    if (!software) software = plan.dims.nether || plan.dims.end ? 'paper' : 'vanilla';
    if (kinds.plugin && modKinds.some(k => kinds[k])) notes.push('It has both plugins and mods, which no single server software runs. The ' + (software === 'paper' || software === 'purpur' ? 'mods' : 'plugins') + ' will be left out.');

    const found = [];
    const add = (v, why) => { if (v && release(v)) found.push({ v, why }); };
    try { add((/\(MC: ([\d.]+)\)/.exec(await fsp.readFile(path.join(serverRoot, 'version_history.json'), 'utf8')) || [])[1], 'version_history.json'); } catch { }
    try { add((/Starting minecraft server version ([\d.]+)/.exec((await fsp.readFile(path.join(serverRoot, 'logs', 'latest.log'), 'utf8')).slice(0, 60000)) || [])[1], 'the log'); } catch { }
    for (const f of await fsp.readdir(path.join(serverRoot, 'cache')).catch(() => [])) add((/^(?:mojang|patched)_([\d.]+)\.jar$/.exec(f) || [])[1], 'cache');
    for (const f of rootNames) add((/^(?:minecraft_server\.|paper-|purpur-|spigot-|fabric-server-mc\.)([\d.]+?)(?:[-.]\D|\.jar|-\d)/.exec(f) || [])[1], f);
    for (const f of await fsp.readdir(path.join(serverRoot, 'libraries', 'net', 'minecraftforge', 'forge')).catch(() => [])) add((/^([\d.]+)-/.exec(f) || [])[1], 'Forge files');
    add(plan.world?.version, 'the world');
    found.sort((a, b) => vcmp(b.v, a.v));
    return { software, mc: found[0]?.v || '', mcFrom: found[0]?.why || '', notes };
  }

  async function analyze(id, zipName, depth = 0) {
    const base = dirOf(id);
    const zip = path.join(base, 'upload.zip');
    const tgz = path.join(base, 'upload.tgz');
    const dir = path.join(base, 'x');
    if (await exists(tgz)) {
      await unpackTar(tgz, dir);
    } else {
      const entries = await zipfile.list(zip).catch(e => fail(400, e.message));
      const names = entries.map(e => e.name);
      if (!names.length) fail(400, 'the zip is empty');
      if (names.length > 300000) fail(400, 'too many files in the zip');
      for (const n of names) {
        if (n.startsWith('/') || n.includes('\\') || /(^|\/)\.\.(\/|$)/.test(n) || /^[A-Za-z]:/.test(n)) fail(400, 'the zip contains unsafe file names, nothing was imported');
      }
      const loose = entries.filter(e => !e.dir);
      if (depth === 0 && loose.length === 1 && /\.(zip|mrpack)$/i.test(loose[0].name)) {
        const inner = path.join(base, 'inner');
        await zipfile.extract(zip, inner).catch(e => fail(400, e.message));
        await fsp.rename(path.join(inner, ...loose[0].name.split('/')), path.join(base, 'unwrapped.zip'));
        await fsp.rm(inner, { recursive: true, force: true });
        await fsp.rename(path.join(base, 'unwrapped.zip'), zip);
        return analyze(id, zipName, 1);
      }
      const unpacked = entries.reduce((n, e) => n + e.size, 0);
      if (unpacked > MAX_UNZIPPED) fail(413, 'the zip is too big to unpack (8 GB limit)');
      if (unpacked * 1.2 > await freeBytes()) fail(507, 'not enough free disk space on this computer to unpack this zip');
      if (names.includes('modrinth.index.json')) return analyzeModpack(id, zipName, zip, names);
      await fsp.mkdir(dir, { recursive: true });
      await zipfile.extract(zip, dir).catch(e => fail(400, e.message));
    }
    await dropLinks(dir);

    const all = await walk(dir, 5);
    const rel = p => path.relative(dir, p).split(path.sep).join('/');
    const warnings = [];
    if (all.some(e => !e.dir && e.name === 'levelname.txt') || all.some(e => e.dir && e.name === 'db' && e.depth <= 2 && all.some(f => f.rel === e.rel + '/CURRENT'))) {
      fail(400, 'This is a Bedrock Edition world, and Move a server here makes Java servers. Create a Bedrock server, then upload the world on its Worlds tab (a .mcworld file or a .zip).');
    }
    const propsFile = shallowest(all.filter(e => !e.dir && e.name === 'server.properties'));
    const props = propsFile ? Object.fromEntries((await fsp.readFile(propsFile.abs, 'utf8')).split(/\r?\n/)
      .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; })) : {};
    const cands = all.filter(e => !e.dir && e.name === 'level.dat').map(e => ({ ...e, dirAbs: path.dirname(e.abs), name: path.basename(path.dirname(e.abs)) }));
    const pick = cands.length ? pickWorld(cands.map(c => ({ ...c, depth: c.depth })), props['level-name']) : null;
    const worldAbs = pick && pick.dirAbs;
    const serverRoot = propsFile ? path.dirname(propsFile.abs) : (worldAbs && worldAbs !== dir ? path.dirname(worldAbs) : dir);

    const plan = { id, zipName, warnings, worldRel: null, world: null, dims: { nether: null, end: null }, settings: {}, pack: {}, motd: null, icon: false,
      onlineMode: null, whitelist: [], ops: [], banned: [], bannedIps: 0, jars: [], pluginsRel: null, configRel: null, configFiles: 0, extraRel: [], detected: null };

    if (worldAbs) {
      const info = worldInfo(await fsp.readFile(path.join(worldAbs, 'level.dat')));
      plan.worldRel = rel(worldAbs);
      plan.world = { name: info.name || path.basename(worldAbs), version: info.version, size: await dirSize(worldAbs) };
      if (!info.version) warnings.push('I could not read which Minecraft version this world is from.');
      const parent = path.dirname(worldAbs), wname = path.basename(worldAbs);
      for (const [key, suffix, inner] of [['nether', '_nether', 'DIM-1'], ['end', '_the_end', 'DIM1']]) {
        const d = path.join(parent, wname + suffix);
        if (await exists(path.join(d, inner))) plan.dims[key] = rel(d);
      }
    }

    for (const k of Object.keys(SETTINGS)) if (SETTINGS[k].test(props[k] ?? '\0')) plan.settings[k] = props[k];
    for (const k of PACK) if (props[k]) plan.pack[k] = props[k];
    if (plan.pack['resource-pack'] && !/^https:\/\/[^\s\\"]{4,400}$/.test(plan.pack['resource-pack'])) plan.pack = {};
    plan.onlineMode = props['online-mode'] === undefined ? null : props['online-mode'] !== 'false';
    plan.whitelistOn = props['white-list'] === 'true';
    if (props.motd !== undefined && FREE.test(props.motd)) plan.motd = props.motd;
    const iconFile = path.join(serverRoot, 'server-icon.png');
    plan.icon = (await exists(iconFile)) && isPng64(await fsp.readFile(iconFile));

    const wl = (await readJsonList(path.join(serverRoot, 'whitelist.json'))).filter(validPlayer);
    const ops = (await readJsonList(path.join(serverRoot, 'ops.json'))).filter(validPlayer);
    const bans = (await readJsonList(path.join(serverRoot, 'banned-players.json'))).filter(validPlayer);
    plan.whitelist = wl.map(p => p.name);
    plan.ops = ops.map(p => p.name);
    plan.banned = bans.map(p => p.name);
    plan.bannedIps = (await readJsonList(path.join(serverRoot, 'banned-ips.json'))).filter(b => b && /^[\da-f.:]{3,45}$/i.test(String(b.ip))).length;
    if ((wl.length || ops.length || bans.length) && plan.onlineMode === false) {
      warnings.push('This server ran in offline ("cracked") mode, so its player IDs only fit an offline-mode server. The whitelist, operators and bans can be copied if you keep offline mode (below); otherwise add the names again.');
    }

    for (const [dirName, kind] of [['mods', 'mods'], ['plugins', 'plugins']]) {
      const d = path.join(serverRoot, dirName);
      if (!await exists(d)) continue;
      if (kind === 'plugins') plan.pluginsRel = rel(d);
      for (const f of (await fsp.readdir(d)).filter(f => /\.jar$/i.test(f)).sort()) {
        const info = await modInfo(path.join(d, f));
        plan.jars.push({ file: f, rel: rel(path.join(d, f)), dir: dirName, kind: info.kind, name: info.name || f, text: KIND_TEXT[info.kind] || '' });
      }
    }
    const configAbs = path.join(serverRoot, 'config');
    if (await exists(configAbs)) {
      plan.configRel = rel(configAbs);
      plan.configFiles = all.filter(e => !e.dir && e.abs.startsWith(configAbs + path.sep)).length;
    }
    for (const d of EXTRA_DIRS) if (await exists(path.join(serverRoot, d))) plan.extraRel.push(rel(path.join(serverRoot, d)));
    plan.serverYml = (await fsp.readdir(serverRoot).catch(() => [])).filter(f => SERVER_YML.test(f)).length;
    plan.serverRel = rel(serverRoot);
    if (!plan.world && !propsFile && !plan.jars.length && !plan.configRel) fail(400, 'I found no world, settings, mods, plugins or config in this zip. For Aternos: download the world from its Worlds page, or select all on its Files page and download.');

    plan.detected = await detect(plan, dir, serverRoot, all);
    if (/^1\./.test(plan.world?.version || '')) warnings.push(`This world is from Minecraft ${plan.world.version}. A newer Minecraft upgrades it when it loads, and you cannot go back, so a world you already have is kept as a backup.`);
    await fsp.writeFile(path.join(base, 'plan.json'), JSON.stringify(plan));
    return plan;
  }

  const LOADERS = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge' };
  async function readIndex(zip) {
    try { return JSON.parse((await zipfile.read(zip, 'modrinth.index.json', 5 * 1024 * 1024)).toString('utf8')); } catch { return fail(400, 'this modpack file is damaged'); }
  }
  const serverFiles = ix => (Array.isArray(ix.files) ? ix.files : []).filter(f => f && typeof f.path === 'string' && Array.isArray(f.downloads) && f.hashes?.sha512 && (f.env?.server || 'required') !== 'unsupported');
  async function analyzeModpack(id, zipName, zip, names) {
    const ix = await readIndex(zip);
    const dep = ix.dependencies || {};
    const key = Object.keys(LOADERS).find(k => dep[k]);
    if (!key) fail(400, dep['quilt-loader'] ? 'This modpack needs Quilt, which this panel cannot run. Choose a Fabric, Forge or NeoForge pack.' : 'This modpack has no mod loader I recognise (Fabric, Forge or NeoForge).');
    if (!release(String(dep.minecraft || ''))) fail(400, 'I could not tell which Minecraft version the modpack needs.');
    const files = serverFiles(ix);
    if (files.length > 500) fail(400, 'that modpack has too many files');
    const plan = {
      id, zipName, warnings: [],
      modpack: { name: String(ix.name || 'Modpack').slice(0, 60), version: String(ix.versionId || '').slice(0, 30), files: files.length, bytes: files.reduce((n, f) => n + (Number(f.fileSize) || 0), 0), clientOnly: (ix.files || []).length - files.length, overrides: names.some(n => /^(server-)?overrides\//.test(n)) },
      detected: { software: LOADERS[key], mc: dep.minecraft, notes: [] },
    };
    await fsp.writeFile(path.join(dirOf(id), 'plan.json'), JSON.stringify(plan));
    return plan;
  }
  const unsafePath = rel => rel.startsWith('/') || rel.includes('\\') || /(^|\/)\.\.(\/|$)/.test(rel) || /^[A-Za-z]:/.test(rel) || rel.includes('\0');
  async function validateModpack(id) {
    const plan = await loadPlan(id);
    if (!plan.modpack) return;
    for (const f of serverFiles(await readIndex(path.join(dirOf(id), 'upload.zip')))) if (unsafePath(f.path)) fail(400, 'the modpack has an unsafe file path, nothing was made');
  }
  const MOD_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
  async function applyModpack(id, t, extraHosts = [], report = () => {}) {
    const plan = await loadPlan(id);
    if (!plan.modpack) fail(400, 'this is not a modpack');
    const zip = path.join(dirOf(id), 'upload.zip');
    const ix = await readIndex(zip);
    const hostOk = h => MOD_HOSTS.includes(h) || extraHosts.includes(h);
    let got = 0;
    const failed = [];
    const list = serverFiles(ix);
    for (const f of list) {
      const rel = f.path;
      if (unsafePath(rel)) fail(400, 'the modpack has an unsafe file path, nothing more was downloaded');
      report(`downloading file ${got + failed.length + 1} of ${list.length}: ${rel}`);
      const dest = path.join(t.root, ...rel.split('/'));
      const url = f.downloads.find(u => { try { return new URL(u).protocol === 'https:' || extraHosts.length > 0; } catch { return false; } });
      try {
        if (!url) throw new Error('no https download link');
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.rm(dest, { force: true });
        await downloadVerified(url, dest, { hash: { algo: 'sha512', hex: f.hashes.sha512 }, hostOk, max: 300 * 1024 * 1024, allowHttp: extraHosts.length > 0 });
        got++;
      } catch (e) { failed.push(`${rel} (${e.message})`); }
    }
    const entries = await zipfile.list(zip);
    for (const p of ['overrides/', 'server-overrides/']) if (entries.some(e => e.name.startsWith(p))) await zipfile.extract(zip, t.root, { prefix: p });
    await fsp.rm(dirOf(id), { recursive: true, force: true });
    const out = [`Modpack "${plan.modpack.name}": ${got} of ${got + failed.length} files downloaded and checked` + (plan.modpack.overrides ? ', and its settings copied' : '') + '.'];
    if (plan.modpack.clientOnly) out.push(`${plan.modpack.clientOnly} client-only file(s) were left out.`);
    if (failed.length) out.push(`Not downloaded: ${failed.slice(0, 8).join('; ')}${failed.length > 8 ? '...' : ''}. The server may not start without them.`);
    return out;
  }

  async function loadPlan(id) {
    try { return JSON.parse(await fsp.readFile(path.join(dirOf(id), 'plan.json'), 'utf8')); } catch { return fail(404, 'this import has expired, upload the zip again'); }
  }

  async function apply(id, ch, t) {
    const base = dirOf(id);
    const dir = path.join(base, 'x');
    const plan = await loadPlan(id);
    if (plan.modpack) fail(400, 'A modpack always makes a new server: choose "A new server" instead.');
    const at = p => path.join(dir, p);
    const out = [];
    const touches = ch.world || ch.settings || ch.appearance || ch.lists || ch.offline;
    if (touches && await t.running()) fail(409, 'stop the server first: it is using the world and its settings');
    let props = await t.readProps();
    let propsChanged = false;
    const setP = (k, v) => { props = setProp(props, k, v); propsChanged = true; };
    const paperLike = t.sw.dir === 'plugins';

    if (ch.world) {
      if (plan.worldRel === null) fail(400, 'there is no world in this zip');
      if (plan.world.version && vcmp(plan.world.version, t.mc) > 0 && /^(1|2\d)\./.test(plan.world.version) && /^(1|2\d)\./.test(t.mc)) fail(409, `this world was last saved with Minecraft ${plan.world.version}, which is newer than this server (${t.mc}), so it cannot be loaded. Make a new server with a newer version instead.`);
      const level = levelName(props);
      const dest = path.join(t.root, level);
      let kept = '';
      if (await exists(dest)) {
        kept = `${level}.before-import-${stamp()}`;
        for (let i = 2; await exists(path.join(t.root, kept)); i++) kept = `${level}.before-import-${stamp()}-${i}`;
        await fsp.rename(dest, path.join(t.root, kept));
      }
      try {
        const src = at(plan.worldRel);
        const notWorld = new Set(['mods', 'config', 'plugins', 'logs', 'libraries', 'cache', 'versions', 'crash-reports', 'server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json', 'usercache.json', 'eula.txt']);
        const atTop = !plan.worldRel;
        await fsp.cp(src, dest, { recursive: true, filter: s => !(atTop && path.dirname(s) === src && notWorld.has(path.basename(s))) });
        await fsp.rm(path.join(dest, 'session.lock'), { force: true });
        const dimsNote = [];
        for (const [key, inner, suffix] of [['nether', 'DIM-1', '_nether'], ['end', 'DIM1', '_the_end']]) {
          const sep = plan.dims[key] && path.join(at(plan.dims[key]), inner);
          const merged = path.join(dest, inner);
          if (sep && !await exists(merged)) { await fsp.cp(sep, merged, { recursive: true }); dimsNote.push(key); }
          if (paperLike && await exists(merged)) {
            const own = path.join(t.root, level + suffix);
            if (!await exists(own)) await fsp.cp(merged, path.join(own, inner), { recursive: true });
          }
        }
        if (dimsNote.length) out.push(`The ${dimsNote.join(' and ')} folder${dimsNote.length > 1 ? 's' : ''} from the old server ${dimsNote.length > 1 ? 'were' : 'was'} joined into the world.`);
      } catch (e) {
        await fsp.rm(dest, { recursive: true, force: true });
        if (kept) await fsp.rename(path.join(t.root, kept), dest);
        throw e;
      }
      out.push(`World "${plan.world.name}" imported.` + (kept ? ` The world you had is kept as "${kept}" (delete it on the Files tab when you no longer need it).` : ''));
    }
    if (ch.settings && (Object.keys(plan.settings).length || Object.keys(plan.pack).length)) {
      for (const [k, v] of Object.entries(plan.settings)) setP(k, v);
      for (const [k, v] of Object.entries(plan.pack)) setP(k, v);
      out.push(`Game settings copied (${[...Object.keys(plan.settings), ...Object.keys(plan.pack).slice(0, 1)].join(', ')}).`);
    }
    if (ch.appearance) {
      if (plan.motd !== null) { setP('motd', plan.motd); out.push('The text in the server list was copied.'); }
      if (plan.icon) {
        await fsp.copyFile(path.join(dir, plan.serverRel, 'server-icon.png'), path.join(t.root, 'server-icon.png'));
        out.push('The server picture was copied.');
      }
    }
    const offlineOk = plan.onlineMode !== false || !!ch.offline;
    if (ch.offline && plan.onlineMode === false) { setP('online-mode', 'false'); out.push('Offline mode kept: players without a bought Minecraft can join. Keep the whitelist on, offline mode lets anyone use any name.'); }
    if (ch.lists && offlineOk) {
      const src = name => path.join(dir, plan.serverRel, name);
      for (const [file, label] of [['whitelist.json', 'whitelist'], ['ops.json', 'operators'], ['banned-players.json', 'banned players']]) {
        const incoming = (await readJsonList(src(file))).filter(validPlayer);
        if (!incoming.length) continue;
        const ours = await t.readList(file);
        const have = new Set(ours.flatMap(p => [String(p.uuid).toLowerCase(), String(p.name).toLowerCase()]));
        const added = incoming.filter(p => !have.has(String(p.uuid).toLowerCase()) && !have.has(String(p.name).toLowerCase()));
        await t.writeList(file, [...ours, ...added.map(p => file === 'ops.json' ? { uuid: p.uuid, name: p.name, level: Number(p.level) || 4, bypassesPlayerLimit: false }
          : file === 'banned-players.json' ? { uuid: p.uuid, name: p.name, created: p.created || new Date().toISOString(), source: String(p.source || 'import').slice(0, 40), expires: 'forever', reason: String(p.reason || 'Banned').slice(0, 100) }
            : { uuid: p.uuid, name: p.name })]);
        out.push(`${added.length} name(s) added to the ${label}.`);
      }
      const ips = (await readJsonList(src('banned-ips.json'))).filter(b => b && /^[\da-f.:]{3,45}$/i.test(String(b.ip)));
      if (ips.length) {
        const ours = await t.readList('banned-ips.json');
        const have = new Set(ours.map(b => b.ip));
        const added = ips.filter(b => !have.has(b.ip));
        await t.writeList('banned-ips.json', [...ours, ...added.map(b => ({ ip: b.ip, created: b.created || new Date().toISOString(), source: 'import', expires: 'forever', reason: String(b.reason || 'Banned').slice(0, 100) }))]);
        out.push(`${added.length} address(es) added to the banned addresses.`);
      }
      if (plan.whitelist.length || plan.whitelistOn) {
        setP('white-list', String(plan.whitelistOn));
        setP('enforce-whitelist', String(plan.whitelistOn));
        out.push(`The whitelist is ${plan.whitelistOn ? 'on, like on the old server' : 'off, like on the old server (anyone with the address can join)'}.`);
      }
    }
    if (ch.mods && t.sw.dir) {
      const modsDir = path.join(t.root, t.sw.dir);
      await fsp.mkdir(modsDir, { recursive: true });
      const ids = await installedIds(modsDir);
      let added = 0;
      const skipped = [];
      for (const j of plan.jars.filter(j => j.dir === t.sw.dir)) {
        if (j.kind !== t.sw.kind) { skipped.push(`${j.file} (${j.text || 'not a mod or plugin'})`); continue; }
        const src = at(j.rel);
        const info = await modInfo(src);
        const name = j.file.replace(/[^\w.+() -]/g, '_');
        if (info.id && ids.has(info.id) && ids.get(info.id).replace(/\.disabled$/, '') !== name) { skipped.push(`${j.file} (a copy with the same id is already installed)`); continue; }
        await fsp.copyFile(src, path.join(modsDir, name));
        if (info.id) ids.set(info.id, name);
        added++;
      }
      let data = 0;
      if (paperLike && plan.pluginsRel) {
        for (const e of await fsp.readdir(at(plan.pluginsRel), { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith('.')) continue;
          const dest = path.join(modsDir, e.name);
          if (await exists(dest)) continue;
          await fsp.cp(path.join(at(plan.pluginsRel), e.name), dest, { recursive: true });
          data++;
        }
      }
      out.push(`${added} ${t.sw.kind === 'plugin' ? 'plugin' : 'mod'}(s) copied` + (data ? `, with the data of ${data} plugin(s)` : '') + '.' + (skipped.length ? ` Left out: ${skipped.join(', ')}.` : ''));
    }
    if (ch.config) {
      let n = 0;
      const copyDir = async (rel, to) => { await fsp.cp(at(rel), path.join(t.root, to), { recursive: true, force: false, errorOnExist: false }); n++; };
      if (plan.configRel) await copyDir(plan.configRel, 'config');
      if (!paperLike) for (const r of plan.extraRel) await copyDir(r, path.basename(r));
      if (paperLike) {
        for (const f of await fsp.readdir(path.join(dir, plan.serverRel)).catch(() => [])) {
          if (SERVER_YML.test(f)) { await fsp.copyFile(path.join(dir, plan.serverRel, f), path.join(t.root, f)).catch(() => {}); n++; }
        }
      }
      out.push(n ? 'Config files copied (files that already existed were left alone).' : 'There were no config files to copy.');
    }
    if (propsChanged) await t.writeProps(props);
    if (!out.length) fail(400, 'nothing was selected');
    await fsp.rm(base, { recursive: true, force: true });
    return out;
  }

  const discard = id => fsp.rm(dirOf(id), { recursive: true, force: true });

  async function cleanup() {
    for (const d of await fsp.readdir(stage).catch(() => [])) {
      const st = await fsp.stat(path.join(stage, d)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 24 * 3600 * 1000) await fsp.rm(path.join(stage, d), { recursive: true, force: true });
    }
  }

  return { newStage, analyze, apply, applyModpack, validateModpack, discard, cleanup, loadPlan, freeBytes, worldInfo, dirOf, stage };
};
module.exports.worldInfo = worldInfo;
module.exports.readNbt = readNbt;
