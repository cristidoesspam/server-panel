'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const zlib = require('zlib');
const { pingBedrock, tcpAlive, parseList, BEDROCK_OPTIONS, WORLD_DEFAULT } = require('./bedrock');
const { fail, run, TAR, getProp, setProp, levelName, readJson, receive, ping, downloadVerified, lookupUuid, offlineUuid, dirSize, shareLog, vcmp } = require('./common');
const zipfile = require('./zip');
const { zipFolder } = require('./zipwrite');
const { worldInfo, readNbt } = require('./importer');
const makeSources = require('./sources');
const makeFake = require('./fake');
const { makeProcessSys } = require('./runner');

const USE_SYSTEMD = process.env.PANEL_RUNNER ? process.env.PANEL_RUNNER === 'systemd' : process.platform === 'linux' && fs.existsSync('/run/systemd/system');

const MCCTL = '/usr/local/bin/mcctl';
const MAX_UPLOAD = 1024 * 1024 * 1024;
const MAX_MOD = 200 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_IMPORT = 4 * 1024 * 1024 * 1024;
const MAX_PACK = 250 * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
const exists = p => fsp.stat(p).then(() => true, () => false);

const OPTIONS = [
  { group: 'Gameplay', key: 'difficulty', label: 'Difficulty', type: 'enum', values: ['peaceful', 'easy', 'normal', 'hard'], def: 'easy' },
  { group: 'Gameplay', key: 'gamemode', label: 'Default game mode', type: 'enum', values: ['survival', 'creative', 'adventure', 'spectator'], def: 'survival' },
  { group: 'Gameplay', key: 'force-gamemode', label: 'Put everyone in that game mode when they join', type: 'bool', def: 'false' },
  { group: 'Gameplay', key: 'hardcore', label: 'Hardcore (one life)', type: 'bool', def: 'false' },
  { group: 'Gameplay', key: 'pvp', label: 'Players can hurt each other (PvP)', type: 'bool', def: 'true' },
  { group: 'Gameplay', key: 'allow-flight', label: 'Allow flying (survival)', type: 'bool', def: 'false' },
  { group: 'Gameplay', key: 'enable-command-block', label: 'Command blocks work', type: 'bool', def: 'false' },
  { group: 'Gameplay', key: 'spawn-protection', label: 'Spawn protection (blocks)', type: 'int', min: 0, max: 64, def: '16' },
  { group: 'Gameplay', key: 'op-permission-level', label: 'Operator level for new operators (4 = everything)', type: 'int', min: 1, max: 4, def: '4' },
  { group: 'Gameplay', key: 'player-idle-timeout', label: 'Kick idle players after (minutes, 0 = never)', type: 'int', min: 0, max: 1440, def: '0' },
  { group: 'World', key: 'allow-nether', label: 'Nether enabled', type: 'bool', def: 'true' },
  { group: 'World', key: 'spawn-animals', label: 'Animals spawn', type: 'bool', def: 'true' },
  { group: 'World', key: 'spawn-monsters', label: 'Monsters spawn', type: 'bool', def: 'true' },
  { group: 'World', key: 'spawn-npcs', label: 'Villagers spawn', type: 'bool', def: 'true' },
  { group: 'World', key: 'generate-structures', label: 'Villages, temples and other structures (new worlds)', type: 'bool', def: 'true' },
  { group: 'World', key: 'max-world-size', label: 'World border radius (blocks)', type: 'int', min: 1, max: 29999984, def: '29999984' },
  { group: 'World', key: 'level-seed', label: 'World seed (only used when a new world is made)', type: 'text', max: 64, def: '' },
  { group: 'Players', key: 'max-players', label: 'Most players at once', type: 'int', min: 1, max: 100, def: '20' },
  { group: 'Players', key: 'hide-online-players', label: 'Hide the list of who is online in the server list', type: 'bool', def: 'false' },
  { group: 'Players', key: 'enforce-secure-profile', label: 'Players must have a signed chat key (turn off for some plugins and proxies)', type: 'bool', def: 'true' },
  { group: 'Speed', key: 'view-distance', label: 'View distance (chunks)', type: 'int', min: 3, max: 32, def: '10' },
  { group: 'Speed', key: 'simulation-distance', label: 'Simulation distance (chunks)', type: 'int', min: 3, max: 32, def: '10' },
  { group: 'Speed', key: 'entity-broadcast-range-percentage', label: 'How far away animals and mobs are shown (percent)', type: 'int', min: 10, max: 1000, def: '100' },
];

function cleanOption(o, v) {
  v = String(v ?? '');
  if (o.type === 'bool') { if (v !== 'true' && v !== 'false') fail(400, `${o.label}: yes or no`); return v; }
  if (o.type === 'enum') { if (!o.values.includes(v)) fail(400, `${o.label}: pick one of ${o.values.join(', ')}`); return v; }
  if (o.type === 'int') { const n = Number(v); if (!Number.isInteger(n) || n < o.min || n > o.max) fail(400, `${o.label}: a whole number from ${o.min} to ${o.max}`); return String(n); }
  if (v.length > o.max || /[\\\r\n\0]/.test(v)) fail(400, `${o.label}: at most ${o.max} characters, no backslashes or line breaks`);
  return v;
}

function privateIp(ip) {
  if (ip.includes(':')) return !/^[23]/.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const publicHost = h => !/^[\d.]+$/.test(h) && !h.includes(':') && h !== 'localhost' && !/\.(local|internal|lan|home)$/i.test(h);

async function tarRun(args, { source, dest } = {}) {
  const tar = spawn(TAR, args, { windowsHide: true });
  let out = '', err = '';
  tar.stdout.on('data', d => { if (!dest) out += d; });
  tar.stderr.on('data', d => { err += d; });
  const exit = new Promise((resolve, reject) => { tar.on('error', reject); tar.on('close', resolve); });
  await Promise.all([
    source ? pipeline(fs.createReadStream(source), tar.stdin).catch(() => {}) : Promise.resolve(),
    dest ? pipeline(tar.stdout, fs.createWriteStream(dest)) : Promise.resolve(),
  ]);
  if (await exit !== 0) { if (dest) await fsp.rm(dest, { force: true }); fail(400, err.trim().split('\n')[0] || 'tar failed'); }
  return out;
}
const tarCreate = (dest, cwd, name) => tarRun(['-czf', '-', '-C', cwd, name], { dest });
const tarList = async file => (await tarRun(['-tzf', '-'], { source: file })).split(/\r?\n/).filter(Boolean);
const tarExtract = (file, cwd) => tarRun(['-xzf', '-', '-C', cwd], { source: file });

function realSys({ id, unit, fifo, port }) {
  return {
    async state() {
      const out = await run('/usr/bin/systemctl', ['show', unit, '-p', 'ActiveState,ActiveEnterTimestampMonotonic,MemoryCurrent']);
      const kv = Object.fromEntries(out.split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
      const mono = Number(kv.ActiveEnterTimestampMonotonic) || 0;
      const mem = Number(kv.MemoryCurrent);
      return {
        active: kv.ActiveState,
        uptime: kv.ActiveState === 'active' && mono ? Math.max(0, Math.round(os.uptime() - mono / 1e6)) : 0,
        memMB: Number.isFinite(mem) && mem < 2 ** 50 ? Math.round(mem / 1048576) : null,
      };
    },
    async power(action) {
      try { await run('sudo', ['-n', MCCTL, action, id]); }
      catch (e) { fail(502, /password|not found|No such file/i.test(e.message) ? 'the panel may not control the servers: run install-panel.sh again' : e.message); }
    },
    async command(line) {
      const st = await fsp.stat(fifo).catch(() => null);
      if (!st) fail(409, 'the server is not running');
      if (!st.isFIFO()) fail(500, 'the console pipe is missing');
      await fsp.writeFile(fifo, line + '\n', { flag: 'a' });
    },
    log: n => run('journalctl', ['-u', unit, '-n', String(n), '--no-pager', '-o', 'cat']),
    ping: async () => ping(await port()),
  };
}

module.exports = function makeInstance({ entry, sw, fake, curseKey, extra = {}, save, heapMB = 1536, onBackup }) {
  const id = entry.id;
  const ROOT = path.resolve(entry.dir);
  const BE = sw.edition === 'bedrock';
  const WORLDS = BE ? path.join(ROOT, 'worlds') : ROOT;
  const lvl = props => path.basename(getProp(props, 'level-name', BE ? WORLD_DEFAULT : 'world')) || (BE ? WORLD_DEFAULT : 'world');
  const worldRel = level => BE ? 'worlds/' + level : level;
  const MODS = sw.dir ? path.join(ROOT, sw.dir) : '';
  const unit = id === 'main' ? 'minecraft' : `minecraft@${id}`;
  const fifo = id === 'main' ? '/run/minecraft.stdin' : `/run/minecraft-${id}.stdin`;

  const readProps = () => fsp.readFile(path.join(ROOT, 'server.properties'), 'utf8').catch(() => '');
  const writeProps = text => fsp.writeFile(path.join(ROOT, 'server.properties'), text);
  const readList = name => fsp.readFile(path.join(ROOT, name), 'utf8').then(JSON.parse).catch(() => []);
  const writeList = (name, list) => fsp.writeFile(path.join(ROOT, name), JSON.stringify(list, null, 2));
  const portOf = async () => Number(getProp(await readProps(), 'server-port', BE ? '19132' : '25565')) || (BE ? 19132 : 25565);

  const sys = fake ? makeFake(ROOT, id === 'main') : USE_SYSTEMD ? realSys({ id, unit, fifo, port: portOf }) : makeProcessSys({ dir: ROOT, port: portOf });
  const sources = makeSources({ root: ROOT, mc: entry.mc, sw, curseKey, ...extra });
  if (BE && !fake) {
    let listedAt = 0;
    sys.ping = async () => {
      const port = await portOf();
      if (getProp(await readProps(), 'transport', 'nethernet') === 'raknet') return pingBedrock(port);
      if (!await tcpAlive(port)) return null;
      if (Date.now() - listedAt > 30000) { listedAt = Date.now(); sys.command('list').catch(() => {}); }
      return parseList(await sys.log(60)) || { online: 0, max: Number(getProp(await readProps(), 'max-players', '10')) || 10, names: [], version: '' };
    };
    const power = sys.power.bind(sys);
    sys.power = async action => {
      if ((action === 'stop' || action === 'restart') && (await sys.state()).active === 'active') {
        await sys.command('stop').catch(() => {});
        for (let i = 0; i < 40 && (await sys.state()).active === 'active'; i++) await sleep(500);
      }
      return power(action);
    };
  }

  const installFile = path.join(ROOT, '.install.json');
  const getInstall = async () => {
    let last;
    for (let i = 0; i < 3; i++) {
      try { return JSON.parse(await fsp.readFile(installFile, 'utf8')); } catch (e) { last = e; await sleep(15); }
    }
    return last.code === 'ENOENT' ? { state: 'done' } : { state: 'running', step: '' };
  };
  let installQueue = Promise.resolve();
  const setInstall = o => (installQueue = installQueue.then(async () => {
    const tmp = installFile + '.tmp-' + crypto.randomBytes(3).toString('hex');
    await fsp.writeFile(tmp, JSON.stringify(o));
    for (let i = 0; ; i++) {
      try { return await fsp.rename(tmp, installFile); } catch (e) {
        if (i >= 10 || !/^(EPERM|EBUSY|EACCES)$/.test(e.code)) { await fsp.rm(tmp, { force: true }); throw e; }
        await sleep(30 * (i + 1));
      }
    }
  }).catch(() => {}));

  let realRoot;
  async function within(rel) {
    rel = String(rel || '');
    if (rel.includes('\0')) fail(400, 'bad path');
    const abs = path.resolve(ROOT, rel);
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) fail(400, 'outside the server folder');
    realRoot ||= await fsp.realpath(ROOT);
    let probe = abs;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) fail(400, 'outside the server folder');
        break;
      } catch (e) {
        if (e.status) throw e;
        const up = path.dirname(probe);
        if (up === probe) fail(400, 'bad path');
        probe = up;
      }
    }
    return abs;
  }
  const relOf = abs => path.relative(ROOT, abs).split(path.sep).join('/');
  const isActive = async () => (await sys.state()).active === 'active';

  async function status() {
    const st = await sys.state();
    const running = st.active === 'active';
    const [game, props, mods, install] = await Promise.all([
      running ? sys.ping() : null,
      readProps(),
      MODS ? fsp.stat(MODS).catch(() => null) : null,
      getInstall(),
    ]);
    return {
      id, name: entry.name, software: entry.software, softwareLabel: sw.label, edition: BE ? 'bedrock' : 'java', mc: entry.mc, modsDir: sw.dir, modKind: sw.kind,
      state: st.active, uptime: st.uptime, memMB: st.memMB, game, install,
      whitelist: getProp(props, BE ? 'allow-list' : 'white-list', 'false') === 'true',
      onlineMode: getProp(props, 'online-mode', 'true') !== 'false',
      restartNeeded: running && !!mods && mods.mtimeMs > Date.now() - st.uptime * 1000,
      host: { totalMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576), load: os.loadavg()[0] },
      fake: !!fake,
    };
  }

  async function sendCommand(line) {
    line = String(line || '').replace(/^\//, '').trim();
    if (!line || line.length > 300 || /[\r\n\0]/.test(line)) fail(400, 'bad command');
    console.log(`[${id}] command:`, line);
    await sys.command(line);
  }
  const NAME = /^\.?\w{3,16}$/;
  const IP = /^[\da-fA-F.:]{3,45}$/;
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const nowText = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000';
  const reasonOf = r => String(r || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 100);
  const profile = async name => getProp(await readProps(), 'online-mode', 'true') === 'false' ? { uuid: offlineUuid(name), name } : lookupUuid(name);

  const BEDROCK_NAME = /^[\w ]{1,15}$/;
  async function bedrockPlayerAction({ action, name, reason }) {
    if (action === 'ban' || action === 'pardon' || action === 'ban-ip' || action === 'pardon-ip') fail(400, 'A Bedrock server has no ban list: take someone off the allow list instead');
    if (!BEDROCK_NAME.test(String(name))) fail(400, 'a Bedrock name is 1 to 15 letters, digits, spaces or _');
    const running = await isActive();
    if (running) {
      const cmd = { 'whitelist-add': 'allowlist add', 'whitelist-remove': 'allowlist remove', op: 'op', deop: 'deop', kick: 'kick' }[action];
      if (!cmd) fail(400, 'unknown action');
      return sendCommand(`${cmd} "${name}"${action === 'kick' && reasonOf(reason) ? ' ' + reasonOf(reason).replace(/"/g, '') : ''}`);
    }
    if (action !== 'whitelist-add' && action !== 'whitelist-remove') fail(409, 'start the server first: operators are set through its console');
    const list = (await readList('allowlist.json')).filter(p => !same(p.name, name));
    if (action === 'whitelist-add') list.push({ ignoresPlayerLimit: false, name });
    await writeList('allowlist.json', list);
    console.log(`[${id}] ${action}: ${name} (server stopped, file edited)`);
  }

  async function playerAction({ action, name, level, reason, ip }) {
    if (BE) return bedrockPlayerAction({ action, name, reason });
    const running = await isActive();
    const why = reasonOf(reason);
    if (running && (action === 'whitelist-add' || action === 'whitelist-remove') && String(name).startsWith('.') && geyserKind() && await hasJar(/floodgate/i)) {
      const out = await runAndRead(`fwhitelist ${action === 'whitelist-add' ? 'add' : 'remove'} ${String(name).slice(1)}`, fake ? 50 : 1500);
      if (!out.some(l => /unknown|incomplete/i.test(l))) return;
    }
    if (action === 'ban-ip' || action === 'pardon-ip') {
      if (!IP.test(String(ip))) fail(400, 'that is not an IP address');
      if (running) return sendCommand(action === 'ban-ip' ? `ban-ip ${ip}${why ? ' ' + why : ''}` : `pardon-ip ${ip}`);
      const bans = (await readList('banned-ips.json')).filter(b => b.ip !== ip);
      if (action === 'ban-ip') bans.push({ ip, created: nowText(), source: 'Panel', expires: 'forever', reason: why || 'Banned by an operator.' });
      return writeList('banned-ips.json', bans);
    }
    if (!NAME.test(String(name))) fail(400, 'a Minecraft name is 3 to 16 letters, digits or _');
    if (running) {
      const lv = Number(level);
      if (action === 'op' && level !== undefined && lv !== Number(getProp(await readProps(), 'op-permission-level', '4'))) fail(409, 'stop the server to give an operator level other than the default (or change the default in Settings)');
      const cmd = { 'whitelist-add': 'whitelist add', 'whitelist-remove': 'whitelist remove', op: 'op', deop: 'deop', kick: 'kick', ban: 'ban', pardon: 'pardon' }[action];
      if (!cmd) fail(400, 'unknown action');
      return sendCommand(`${cmd} ${name}${(action === 'ban' || action === 'kick') && why ? ' ' + why : ''}`);
    }
    if (action === 'kick') fail(409, 'the server is not running, nobody is online');
    const file = { 'whitelist-add': 'whitelist.json', 'whitelist-remove': 'whitelist.json', op: 'ops.json', deop: 'ops.json', ban: 'banned-players.json', pardon: 'banned-players.json' }[action];
    if (!file) fail(400, 'unknown action');
    const list = (await readList(file)).filter(p => !same(p.name, name));
    if (action === 'whitelist-add') list.push(await profile(name).then(p => ({ uuid: p.uuid, name: p.name })));
    else if (action === 'op') {
      const lv = level === undefined ? Number(getProp(await readProps(), 'op-permission-level', '4')) : Number(level);
      if (!Number.isInteger(lv) || lv < 1 || lv > 4) fail(400, 'operator level: 1 to 4');
      list.push({ ...await profile(name), level: lv, bypassesPlayerLimit: false });
    } else if (action === 'ban') list.push({ ...await profile(name), created: nowText(), source: 'Panel', expires: 'forever', reason: why || 'Banned by an operator.' });
    await writeList(file, list);
    console.log(`[${id}] ${action}: ${name} (server stopped, file edited)`);
  }

  async function setWhitelist(on) {
    let text = await readProps();
    if (BE) {
      if (await isActive()) await sys.command('allowlist ' + (on ? 'on' : 'off')).catch(() => {});
      await writeProps(setProp(text, 'allow-list', on));
      console.log(`[${id}] allow list`, on ? 'on' : 'off');
      return;
    }
    if (await isActive()) await sys.command('whitelist ' + (on ? 'on' : 'off')).catch(() => {});
    text = setProp(setProp(text, 'white-list', on), 'enforce-whitelist', on);
    await writeProps(text);
    console.log(`[${id}] whitelist`, on ? 'on' : 'off');
  }

  async function setCracked(on) {
    if (BE) fail(400, 'Bedrock players sign in with an Xbox account. There is no cracked mode for a Bedrock server.');
    if (await isActive()) fail(409, 'stop the server first: the lists are converted and the change applies when it starts');
    let text = await readProps();
    if ((getProp(text, 'online-mode', 'true') === 'false') === on) return { message: on ? 'Cracked mode was already on.' : 'Cracked mode was already off.' };
    const missing = [];
    for (const f of ['whitelist.json', 'ops.json', 'banned-players.json']) {
      const list = await readList(f);
      const keep = path.join(ROOT, f + '.online');
      if (on) {
        if (list.length && !await exists(keep)) await fsp.writeFile(keep, JSON.stringify(list, null, 2));
        await writeList(f, list.map(p => ({ ...p, uuid: offlineUuid(p.name) })));
      } else {
        const before = await fsp.readFile(keep, 'utf8').then(JSON.parse).catch(() => []);
        const out = [];
        for (const p of list) {
          const old = before.find(b => same(b.name, p.name) && b.uuid !== offlineUuid(b.name));
          if (old) { out.push({ ...p, uuid: old.uuid }); continue; }
          try { out.push({ ...p, uuid: (await lookupUuid(p.name)).uuid }); } catch (e) { out.push(p); missing.push(p.name); }
        }
        await writeList(f, out);
        await fsp.rm(keep, { force: true });
      }
    }
    text = setProp(text, 'online-mode', on ? 'false' : 'true');
    await writeProps(text);
    console.log(`[${id}] cracked mode ${on ? 'on' : 'off'}`);
    return { message: on
      ? 'Cracked mode is on. Players without a bought Minecraft can join after the next start. Keep the whitelist on: anyone can join under any name, even as an operator.'
      : 'Cracked mode is off: only real Minecraft accounts can join after the next start.' + (missing.length ? ` These names have no Minecraft account and cannot join: ${missing.join(', ')}.` : '') };
  }

  const modName = n => {
    n = String(n || '');
    if (!/^[\w.+() -]{1,120}\.jar$/.test(n) || n.startsWith('.')) fail(400, 'bad file name (letters, digits, . _ - + ( ) and space, ending in .jar)');
    return n;
  };
  const needMods = () => { if (!MODS) fail(409, `${sw.label} servers have no mods or plugins`); };
  async function listMods() {
    if (!MODS) return { mods: [] };
    await fsp.mkdir(MODS, { recursive: true });
    const out = [];
    for (const e of await fsp.readdir(MODS, { withFileTypes: true })) {
      if (!e.isFile() || !/\.jar(\.disabled)?$/.test(e.name)) continue;
      const st = await fsp.stat(path.join(MODS, e.name));
      out.push({ name: e.name.replace(/\.disabled$/, ''), enabled: !e.name.endsWith('.disabled'), size: st.size });
    }
    return { mods: out.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async function listFiles(q) {
    const abs = await within(q.get('path'));
    const st = await fsp.stat(abs).catch(() => fail(404, 'not found'));
    if (!st.isDirectory()) fail(400, 'not a folder');
    const entries = [];
    for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
      try {
        const s = await fsp.stat(path.join(abs, e.name));
        entries.push({ name: e.name, dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs });
      } catch { }
    }
    entries.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
    return { path: relOf(abs), entries };
  }
  async function readText(q) {
    const abs = await within(q.get('path'));
    const st = await fsp.stat(abs).catch(() => fail(404, 'not found'));
    if (!st.isFile()) fail(400, 'not a file');
    if (st.size > MAX_TEXT) fail(413, 'too big to edit here (1 MB), download it instead');
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) fail(415, 'this is a binary file, download it instead');
    return { path: relOf(abs), text: buf.toString('utf8') };
  }
  async function download(q, res) {
    const abs = await within(q.get('path'));
    const st = await fsp.stat(abs).catch(() => fail(404, 'not found'));
    if (!st.isFile()) fail(400, 'not a file');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(abs)),
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(fs.createReadStream(abs), res).catch(() => {});
  }
  async function saveFile(req, q) {
    const abs = await within(q.get('path'));
    if (abs === ROOT) fail(400, 'bad path');
    const parent = await fsp.stat(path.dirname(abs)).catch(() => null);
    if (!parent || !parent.isDirectory()) fail(404, 'that folder does not exist');
    const here = await fsp.stat(abs).catch(() => null);
    if (here && here.isDirectory()) fail(400, 'that is a folder');
    await receive(req, abs, MAX_UPLOAD, false);
    console.log(`[${id}] file saved:`, relOf(abs));
  }
  async function removeFile(q) {
    const abs = await within(q.get('path'));
    if (abs === ROOT) fail(400, 'cannot delete the server folder itself');
    const world = path.join(WORLDS, lvl(await readProps()));
    const touchesWorld = abs === world || abs.startsWith(world + path.sep) || world.startsWith(abs + path.sep);
    if (touchesWorld && await isActive()) fail(409, 'stop the server first, it is using the world');
    await fsp.rm(abs, { recursive: true });
    console.log(`[${id}] deleted:`, relOf(abs));
  }

  const BACKUPS = path.join(ROOT, 'backups');
  const BACKUP_NAME = /^world-\d{8}-\d{6}(-\d+)?\.tar\.gz$/;
  const countSaves = t => (t.match(/Saved the game/g) || []).length;

  async function pausedSaves(fn) {
    const running = await isActive();
    if (BE) {
      try {
        if (running) {
          await sys.command('save hold');
          for (let i = 0; i < 60; i++) {
            await sleep(500);
            await sys.command('save query');
            await sleep(300);
            if (/Files are now ready to be copied/.test(await sys.log(30))) break;
            if (i === 59) fail(504, 'the server did not get ready for the copy in 30 seconds');
          }
        }
        return await fn();
      } finally {
        if (running) await sys.command('save resume').catch(() => {});
      }
    }
    try {
      if (running) {
        await sys.command('save-off');
        const before = countSaves(await sys.log(100));
        await sys.command('save-all flush');
        for (let i = 0; i < 40 && countSaves(await sys.log(100)) === before; i++) await sleep(500);
      }
      return await fn();
    } finally {
      if (running) await sys.command('save-on').catch(() => {});
    }
  }

  let queue = Promise.resolve();
  const oneAtATime = fn => { const turn = queue.then(fn); queue = turn.catch(() => {}); return turn; };

  async function doBackupDownload(res) {
    if (res.destroyed) return;
    const level = lvl(await readProps());
    await fsp.stat(path.join(WORLDS, level)).catch(() => fail(404, 'there is no world folder yet'));
    await pausedSaves(async () => {
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="world-${new Date().toISOString().slice(0, 10)}.tar.gz"`,
      });
      const tar = spawn(TAR, ['-czf', '-', '-C', ROOT, worldRel(level)], { windowsHide: true });
      tar.stdout.pipe(res, { end: false });
      res.on('close', () => tar.kill());
      await new Promise(resolve => tar.on('close', resolve));
    });
    res.end();
    console.log(`[${id}] backup downloaded`);
  }

  async function listBackups() {
    const out = [];
    for (const f of await fsp.readdir(BACKUPS).catch(() => [])) {
      if (!BACKUP_NAME.test(f)) continue;
      const st = await fsp.stat(path.join(BACKUPS, f));
      out.push({ name: f, size: st.size, mtime: st.mtimeMs });
    }
    const key = n => { const m = /^world-(\d{8}-\d{6})(?:-(\d+))?\.tar\.gz$/.exec(n); return m[1] + '-' + String(m[2] || 1).padStart(4, '0'); };
    return out.sort((a, b) => b.mtime - a.mtime || key(b.name).localeCompare(key(a.name)));
  }
  async function pruneBackups() {
    const keep = Math.max(1, entry.settings.backupKeep);
    for (const b of (await listBackups()).slice(keep)) await fsp.rm(path.join(BACKUPS, b.name), { force: true });
  }
  const createBackup = () => oneAtATime(async () => {
    const level = lvl(await readProps());
    await fsp.stat(path.join(WORLDS, level)).catch(() => fail(404, 'there is no world folder yet'));
    await fsp.mkdir(BACKUPS, { recursive: true });
    let name = `world-${stamp()}.tar.gz`;
    for (let i = 2; await exists(path.join(BACKUPS, name)); i++) name = `world-${stamp()}-${i}.tar.gz`;
    await pausedSaves(() => tarCreate(path.join(BACKUPS, name), ROOT, worldRel(level)));
    await pruneBackups();
    console.log(`[${id}] backup saved:`, name);
    if (onBackup) onBackup(id, path.join(BACKUPS, name), name);
    return name;
  });

  async function safetyBackup(why) {
    try {
      if (!await exists(path.join(WORLDS, lvl(await readProps())))) return null;
      const name = await createBackup();
      console.log(`[${id}] backup before ${why}:`, name);
      return name;
    } catch (e) { console.log(`[${id}] backup before ${why} failed:`, e.message); return null; }
  }

  async function restoreBackup(name) {
    if (!BACKUP_NAME.test(String(name))) fail(400, 'bad backup name');
    const file = path.join(BACKUPS, name);
    if (!await exists(file)) fail(404, 'no such backup');
    if (await isActive()) fail(409, 'stop the server first: it is using the world');
    const level = lvl(await readProps());
    const rel = worldRel(level);
    const entries = await tarList(file);
    if (!entries.length || entries.some(e => e.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(e) || !(e === rel || e === rel + '/' || e.startsWith(rel + '/')))) {
      fail(400, `this backup does not hold the world folder "${level}" only, refusing to unpack it`);
    }
    const dest = path.join(WORLDS, level);
    let kept = '';
    if (await exists(dest)) { kept = `${level}.before-restore-${stamp()}`; await fsp.rename(dest, path.join(WORLDS, kept)); }
    try {
      await tarExtract(file, ROOT);
      if (!await exists(path.join(dest, 'level.dat'))) fail(400, 'the backup did not contain a world (no level.dat)');
    } catch (e) {
      await fsp.rm(dest, { recursive: true, force: true });
      if (kept) await fsp.rename(path.join(WORLDS, kept), dest);
      throw e;
    }
    console.log(`[${id}] backup restored:`, name);
    return { message: `Restored ${name}.` + (kept ? ` The world you had is kept as "${kept}" (delete it on the Files tab when you no longer need it).` : '') };
  }

  async function resetWorld() {
    if (await isActive()) fail(409, 'stop the server first: it is using the world');
    const level = lvl(await readProps());
    const dest = path.join(WORLDS, level);
    if (!await exists(dest)) fail(404, 'there is no world yet, it is made when the server starts');
    const kept = `${level}.before-reset-${stamp()}`;
    await fsp.rename(dest, path.join(WORLDS, kept));
    console.log(`[${id}] world reset, old one kept as`, kept);
    return { message: `A new world is made when you start the server. The old one is kept as "${kept}".` };
  }

  const decodePrompt = raw => { try { return String(JSON.parse(raw).text || ''); } catch { return ''; } };
  async function getPack() {
    const p = await readProps();
    return {
      url: getProp(p, 'resource-pack', ''), sha1: getProp(p, 'resource-pack-sha1', ''),
      required: getProp(p, 'require-resource-pack', 'false') === 'true', prompt: decodePrompt(getProp(p, 'resource-pack-prompt', '')),
    };
  }
  async function setPack(b) {
    let url, sha1;
    if (b.modrinth) {
      ({ url, sha1 } = await sources.packResolve(String(b.modrinth).trim()));
    } else {
      url = String(b.url || '').trim();
      if (!/^https:\/\/[^\s\\"]{4,400}$/.test(url)) fail(400, 'give a direct https:// link to the pack\'s .zip file');
      const host = new URL(url).hostname;
      if (!publicHost(host)) fail(400, 'that address is not on the public internet, players could not download it');
      const addrs = await dns.lookup(host, { all: true }).catch(() => fail(400, 'I could not look that address up'));
      if (addrs.some(a => privateIp(a.address))) fail(400, 'that address points at a private network, players could not download it');
      const tmp = path.join(ROOT, '.pack-check.zip');
      await fsp.rm(tmp, { force: true });
      try {
        sha1 = await downloadVerified(url, tmp, { hostOk: publicHost, max: MAX_PACK, allowHttp: false });
        const names = (await zipfile.list(tmp).catch(() => fail(400, 'that file is not a zip'))).map(e => e.name);
        if (!names.includes('pack.mcmeta')) fail(400, 'that file is not a resource pack (no pack.mcmeta inside)');
      } finally { await fsp.rm(tmp, { force: true }); }
    }
    const prompt = String(b.prompt || '').replace(/["\\\r\n\0]/g, ' ').trim().slice(0, 120);
    let text = await readProps();
    text = setProp(text, 'resource-pack', url);
    text = setProp(text, 'resource-pack-sha1', sha1.toLowerCase());
    text = setProp(text, 'require-resource-pack', b.required === false ? 'false' : 'true');
    text = setProp(text, 'resource-pack-prompt', prompt ? JSON.stringify({ text: prompt }) : '');
    await writeProps(text);
    console.log(`[${id}] resource pack set:`, url);
  }
  async function clearPack() {
    let text = await readProps();
    for (const [k, v] of [['resource-pack', ''], ['resource-pack-sha1', ''], ['require-resource-pack', 'false'], ['resource-pack-prompt', '']]) text = setProp(text, k, v);
    await writeProps(text);
  }

  const LOG_NAME = /^(crash-reports\/)?[\w.-]{1,100}\.(log|log\.gz|txt)$/;
  const MAX_LOG = 1024 * 1024;
  async function listLogs() {
    const out = [];
    for (const [dir, prefix] of [['logs', ''], ['crash-reports', 'crash-reports/']]) {
      for (const f of await fsp.readdir(path.join(ROOT, dir)).catch(() => [])) {
        if (!LOG_NAME.test(prefix + f)) continue;
        const st = await fsp.stat(path.join(ROOT, dir, f)).catch(() => null);
        if (st?.isFile()) out.push({ name: prefix + f, size: st.size, mtime: st.mtimeMs });
      }
    }
    return { logs: out.sort((a, b) => b.mtime - a.mtime).slice(0, 100) };
  }
  async function readLog(name) {
    name = String(name || '');
    if (!LOG_NAME.test(name)) fail(400, 'bad log name');
    const file = path.join(ROOT, name.startsWith('crash-reports/') ? name : 'logs/' + name);
    const fh = await fsp.open(file, 'r').catch(() => fail(404, 'no such log'));
    let buf;
    try {
      const size = (await fh.stat()).size;
      if (name.endsWith('.gz')) {
        if (size > 30 * 1024 * 1024) fail(413, 'that old log is too big to open here, download it from the Files tab');
        buf = zlib.gunzipSync((await fh.readFile()), { maxOutputLength: 256 * 1024 * 1024 }).subarray(-MAX_LOG);
      } else {
        const len = Math.min(size, MAX_LOG);
        buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
      }
    } catch (e) { fail(e.status || 400, e.status ? e.message : 'could not read that log'); } finally { await fh.close(); }
    return { name, text: buf.toString('utf8') };
  }

  const MAX_UNZIPPED = 8 * 1024 ** 3;
  const worldName = n => {
    n = String(n ?? '').trim();
    if (!/^[\w. -]{1,60}$/.test(n) || n.startsWith('.')) fail(400, 'a world name is 1 to 60 letters, digits, spaces, . _ -');
    return n;
  };
  const hasWorld = name => exists(path.join(WORLDS, name, 'level.dat'));
  async function listWorlds() {
    const props = await readProps();
    const level = lvl(props);
    const out = [];
    for (const e of await fsp.readdir(WORLDS, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const buf = await fsp.readFile(path.join(WORLDS, e.name, 'level.dat')).catch(() => null);
      if (!buf) continue;
      const info = BE ? { version: '', lastPlayed: (await fsp.stat(path.join(WORLDS, e.name, 'level.dat'))).mtimeMs } : worldInfo(buf);
      out.push({ name: e.name, active: e.name === level, dimension: /_(nether|the_end)$/.test(e.name), kept: /\.before-(import|restore|reset)-/.test(e.name),
        size: await dirSize(path.join(WORLDS, e.name)), version: info.version, lastPlayed: info.lastPlayed });
    }
    if (!out.some(w => w.active)) out.unshift({ name: level, active: true, missing: true, size: 0 });
    out.sort((a, b) => (b.active - a.active) || (a.dimension - b.dimension) || (a.kept - b.kept) || b.lastPlayed - a.lastPlayed);
    return { worlds: out, level, running: await isActive(), seed: getProp(props, 'level-seed', ''), type: getProp(props, 'level-type', 'minecraft:normal') };
  }
  async function useWorld(name) {
    name = worldName(name);
    if (await isActive()) fail(409, 'stop the server first: it is using the current world');
    if (!await hasWorld(name)) fail(404, 'no such world');
    await writeProps(setProp(await readProps(), 'level-name', name));
    console.log(`[${id}] world in use:`, name);
    return { message: `"${name}" is loaded the next time the server starts.` };
  }
  async function newWorld(b) {
    const name = worldName(b.name);
    if (await isActive()) fail(409, 'stop the server first');
    if (await exists(path.join(WORLDS, name))) fail(409, 'a folder with that name already exists, pick another name');
    const seed = String(b.seed ?? '').trim();
    if (seed.length > 64 || /[\\\r\n\0]/.test(seed)) fail(400, 'the seed can be at most 64 characters, no backslashes');
    if (BE) {
      await writeProps(setProp(setProp(await readProps(), 'level-name', name), 'level-seed', seed));
      console.log(`[${id}] new world planned:`, name);
      return { message: `A new world "${name}" is made the next time the server starts. Your other worlds stay in their folders.` };
    }
    const type = String(b.type || 'normal');
    if (!['normal', 'flat', 'large_biomes', 'amplified'].includes(type)) fail(400, 'unknown world type');
    const old = vcmp(entry.mc, '1.19') < 0;
    let text = await readProps();
    text = setProp(text, 'level-name', name);
    text = setProp(text, 'level-seed', seed);
    text = setProp(text, 'level-type', old ? { normal: 'default', flat: 'flat', large_biomes: 'largeBiomes', amplified: 'amplified' }[type] : 'minecraft:' + type);
    text = setProp(text, 'generate-structures', b.structures === false ? 'false' : 'true');
    await writeProps(text);
    console.log(`[${id}] new world planned:`, name);
    return { message: `A new world "${name}" is made the next time the server starts. Your other worlds stay in their folders.` };
  }
  async function deleteWorld(name) {
    name = worldName(name);
    if (!await hasWorld(name)) fail(404, 'no such world');
    if (name === lvl(await readProps())) fail(409, 'that is the world in use: switch to another world first');
    await fsp.rm(path.join(WORLDS, name), { recursive: true });
    console.log(`[${id}] world deleted:`, name);
  }
  async function downloadWorld(name, res) {
    if (res.destroyed) return;
    name = worldName(name);
    if (!await hasWorld(name)) fail(404, 'no such world');
    const active = name === lvl(await readProps());
    const send = async () => {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.${BE ? 'mcworld' : 'zip'}`, 'X-Content-Type-Options': 'nosniff' });
      const zip = zipFolder(path.join(WORLDS, name), BE ? '' : name, rel => rel === 'session.lock');
      zip.pipe(res, { end: false });
      res.on('close', () => zip.destroy());
      await new Promise(resolve => { zip.on('end', resolve); zip.on('close', resolve); zip.on('error', () => { res.destroy(); resolve(); }); });
    };
    if (active) await pausedSaves(send); else await send();
    res.end();
    console.log(`[${id}] world downloaded:`, name);
  }
  async function uploadWorld(req, q) {
    const tmpDir = path.join(ROOT, '.upload-' + crypto.randomBytes(4).toString('hex'));
    await fsp.mkdir(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, 'world.zip');
    try {
      await receive(req, zipPath, MAX_IMPORT, true);
      const entries = await zipfile.list(zipPath).catch(e => fail(400, e.message));
      const bedrockWorld = entries.some(e => /(^|\/)levelname\.txt$/.test(e.name)) || entries.some(e => /(^|\/)db\/CURRENT$/.test(e.name));
      if (!BE && bedrockWorld) fail(400, 'This is a Bedrock Edition world. This server runs Java Edition, which cannot open Bedrock worlds. Create a Bedrock server for it.');
      if (BE && !bedrockWorld) fail(400, 'This looks like a Java Edition world (no levelname.txt or db folder). A Bedrock server cannot open it: use a .mcworld file or a Bedrock world .zip.');
      if (entries.some(e => zipfile.unsafe(e.name))) fail(400, 'the zip contains unsafe file names, nothing was unpacked');
      if (entries.reduce((n, e) => n + e.size, 0) > MAX_UNZIPPED) fail(413, 'the zip is too big to unpack (8 GB limit)');
      const lv = entries.filter(e => !e.dir && /(^|\/)level\.dat$/.test(e.name) && !/(^|\/)(datapacks|playerdata)\//.test(e.name))
        .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
      if (!lv) fail(400, 'I found no world in this zip (a world has a level.dat file in its folder)');
      const prefix = lv.name.slice(0, -'level.dat'.length);
      await fsp.mkdir(WORLDS, { recursive: true });
      const free = await fsp.statfs(ROOT).then(s => s.bavail * s.bsize, () => Infinity);
      if (entries.reduce((n, e) => n + e.size, 0) * 1.1 > free) fail(507, 'not enough free disk space on this computer to unpack this world');
      let name = String(q.get('name') || '').trim() || path.basename(prefix.replace(/\/$/, ''));
      name = name.replace(/[^\w. -]/g, '_').replace(/^\.+/, '').slice(0, 60) || 'world';
      let final = name;
      for (let i = 2; await exists(path.join(WORLDS, final)); i++) final = `${name}-${i}`.slice(0, 60);
      const dest = path.join(WORLDS, final);
      try { await zipfile.extract(zipPath, dest, { prefix }); } catch (e) { await fsp.rm(dest, { recursive: true, force: true }); throw e; }
      await fsp.rm(path.join(dest, 'session.lock'), { force: true });
      if (BE && !await exists(path.join(dest, 'levelname.txt'))) await fsp.writeFile(path.join(dest, 'levelname.txt'), final);
      let used = false;
      if (q.get('use') === '1' && !await isActive()) { await writeProps(setProp(await readProps(), 'level-name', final)); used = true; }
      console.log(`[${id}] world uploaded:`, final);
      return { name: final, used };
    } finally { await fsp.rm(tmpDir, { recursive: true, force: true }); }
  }

  const dpDir = async () => path.join(ROOT, lvl(await readProps()), 'datapacks');
  const dpName = (n, zipOnly = true) => {
    n = String(n || '');
    if (!/^[\w.+() -]{1,100}$/.test(n) || n.startsWith('.') || (zipOnly && !/\.zip$/i.test(n))) fail(400, 'bad file name (letters, digits, . _ - + ( ) and space' + (zipOnly ? ', ending in .zip)' : ')'));
    return n;
  };
  async function listDatapacks() {
    const dir = await dpDir();
    const packs = [];
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || !(e.isDirectory() || /\.zip$/i.test(e.name))) continue;
      packs.push({ name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? await dirSize(path.join(dir, e.name)) : (await fsp.stat(path.join(dir, e.name))).size });
    }
    return { world: lvl(await readProps()), running: await isActive(), packs: packs.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async function gamerules() {
    const level = lvl(await readProps());
    let rules = [];
    try {
      const d = readNbt(zlib.gunzipSync(await fsp.readFile(path.join(ROOT, level, 'level.dat')))).Data || {};
      const g = d.GameRules || d.game_rules || d.gamerules;
      if (g && typeof g === 'object') {
        rules = Object.entries(g).filter(([, v]) => v !== null && typeof v !== 'object').map(([name, v]) => {
          const value = String(v);
          return { name, value, type: /^(true|false)$/.test(value) ? 'bool' : /^-?\d+$/.test(value) ? 'int' : 'text' };
        }).sort((a, b) => a.name.localeCompare(b.name));
      }
    } catch { }
    return { world: level, running: await isActive(), rules };
  }
  async function setGamerule(b) {
    const name = String(b.name || ''), value = String(b.value);
    if (!/^[A-Za-z0-9_:.]{1,64}$/.test(name) || !/^(true|false|-?\d{1,9})$/.test(value)) fail(400, 'a game rule name and true, false or a number');
    if (!await isActive()) fail(409, 'start the server first: rules are changed through its console');
    await sendCommand(`gamerule ${name} ${value}`);
  }

  const hasJar = re => MODS ? fsp.readdir(MODS).then(l => l.some(f => re.test(f) && /\.jar$/.test(f)), () => false) : Promise.resolve(false);
  const mapConfig = () => path.join(ROOT, sw.kind === 'plugin' ? 'plugins/BlueMap' : 'config/bluemap', 'core.conf');
  const geyserKind = () => sw.kind === 'plugin' ? 'plugin' : sw.kind === 'fabric' || sw.kind === 'neoforge' ? sw.kind : '';
  const geyserDir = () => path.join(ROOT, { plugin: 'plugins/Geyser-Spigot', fabric: 'config/Geyser-Fabric', neoforge: 'config/Geyser-NeoForge' }[geyserKind()] || 'plugins/Geyser-Spigot');
  const geyserConfig = () => path.join(geyserDir(), 'config.yml');
  async function editFile(file, re, to, hint) {
    const text = await fsp.readFile(file, 'utf8').catch(() => fail(409, hint));
    if (!re.test(text)) fail(409, 'I did not find the setting in ' + path.basename(file) + ': change it by hand on the Files tab');
    await fsp.writeFile(file, text.replace(re, to));
  }

  const LAUNCH = path.join(ROOT, process.platform === 'win32' ? 'launch.cmd' : 'launch.sh');
  const hostMB = () => Math.round(os.totalmem() / 1048576);
  async function memoryNow() {
    const m = /-Xmx(\d+)M/.exec(await fsp.readFile(LAUNCH, 'utf8').catch(() => ''));
    return m ? Number(m[1]) : 0;
  }
  async function setMemory(mb) {
    if (BE) fail(400, 'A Bedrock server has no memory setting.');
    if (id === 'main') fail(400, 'The main server was set up by the installer, its memory is set in the installer. Create a new server to choose memory here.');
    if (mb !== 0 && (mb < 512 || mb > hostMB() - 512)) fail(400, `Memory: 512 to ${hostMB() - 512} MB (this computer has ${hostMB()} MB), or empty for the automatic amount`);
    const text = await fsp.readFile(LAUNCH, 'utf8').catch(() => fail(409, 'This server has no start file yet: wait until its software is installed.'));
    if (!/-Xmx\d+M/.test(text)) fail(409, 'I did not find the memory setting in the start file, change it by hand on the Files tab.');
    await fsp.writeFile(LAUNCH, text.replace(/-Xmx\d+M/, `-Xmx${mb || heapMB}M`));
    entry.settings.memoryMB = mb;
  }

  const plain = s => String(s).replace(/\u001b\[[0-9;]*m/g, '').replace(/§./g, '').replace(/^\[\d\d:\d\d:\d\d\] \[[^\]]*\]: /, '').trimEnd();
  async function runAndRead(line, waitMs = 2000) {
    const before = (await sys.log(400)).split('\n').filter(Boolean);
    await sendCommand(line);
    await sleep(waitMs);
    const after = (await sys.log(400)).split('\n').filter(Boolean);
    const at = before.length ? after.lastIndexOf(before[before.length - 1]) : -1;
    return (at >= 0 ? after.slice(at + 1) : after.slice(-40)).filter(l => !/issued server command|\[panel-test\]/.test(l)).map(plain);
  }

  async function pregen() {
    const running = await isActive();
    const lines = running ? (await sys.log(400)).split('\n').map(plain).filter(l => /\bchunky\b/i.test(l)) : [];
    return { supported: !!MODS, installed: await hasJar(/chunky/i), running, line: lines.pop() || '' };
  }
  async function pregenStart(b) {
    needMods();
    const radius = Number(b.radius);
    if (!Number.isInteger(radius) || radius < 100 || radius > 5000) fail(400, 'Radius: a whole number of blocks from 100 to 5000');
    if (!await hasJar(/chunky/i)) fail(409, 'Install Chunky first');
    if (!await isActive()) fail(409, 'Start the server first: Chunky works while it runs');
    for (const c of ['chunky center 0 0', `chunky radius ${radius}`, 'chunky start']) await sendCommand(c);
  }

  let profileBefore = '';
  const SPARK_URL = /https:\/\/spark\.lucko\.me\/[A-Za-z0-9]+/g;
  const hasSpark = async () => (await hasJar(/spark/i)) || sw.kind === 'plugin';
  async function lagInfo() {
    const running = await isActive();
    const urls = running ? (await sys.log(400)).match(SPARK_URL) || [] : [];
    const url = urls.pop() || '';
    return { supported: !BE, spark: await hasSpark(), installable: !!MODS, running, profile: url && url !== profileBefore ? url : '' };
  }
  async function lagCheck() {
    if (BE) fail(400, 'The lag check is for Java servers.');
    if (!await isActive()) fail(409, 'Start the server first: it can only be measured while it runs');
    const spark = await hasSpark();
    let lines = await runAndRead(spark ? 'spark health' : 'tick query', fake ? 50 : 2000);
    if (spark && lines.some(l => /unknown|incomplete/i.test(l))) lines = await runAndRead('spark tps', fake ? 50 : 2000);
    const text = lines.join('\n');
    const nums = s => (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    const tpsLine = /TPS from last[^:]*:\s*(.*)/i.exec(text);
    const tps = tpsLine ? nums(tpsLine[1]).slice(0, 3) : [];
    const dur = /Tick durations[^:]*:\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/i.exec(text);
    const avg = /Average time per tick:\s*([\d.]+)\s*ms/i.exec(text);
    const mspt = dur ? Number(dur[2]) : avg ? Number(avg[1]) : null;
    const p95 = dur ? Number(dur[3]) : null;
    const tpsNow = tps.length ? tps.reduce((a, b) => a + b, 0) / tps.length : null;
    let level = 'unknown';
    if (tpsNow !== null || mspt !== null) {
      level = (tpsNow !== null && tpsNow < 17) || (mspt !== null && mspt >= 50) || (p95 !== null && p95 >= 80) ? 'bad'
        : (tpsNow !== null && tpsNow < 19.5) || (mspt !== null && mspt >= 35) ? 'ok' : 'good';
    }
    const hints = [];
    if (level === 'bad' || level === 'ok') {
      const props = await readProps();
      if (Number(getProp(props, 'view-distance', '10')) > 8) hints.push('Lower the view distance to 8 (Settings, Speed). It is the biggest single win.');
      if (Number(getProp(props, 'simulation-distance', '10')) > 6) hints.push('Lower the simulation distance to 6 (Settings, Speed).');
      hints.push('Pre-generate the world around the middle (Worlds tab): exploring new land is what makes a weak computer lag.');
      if (os.loadavg()[0] > os.cpus().length * 0.9) hints.push('The computer itself is busy with other programs. Close them, or stop other servers.');
      if (os.freemem() / 1048576 < 300) hints.push('The computer is almost out of free memory. Close other programs or give this server less memory.');
    }
    if (level === 'unknown') hints.push(spark || !MODS ? 'I could not read the numbers. If the game is older than 1.20.3 it has no tick command: install spark.' : 'Install spark (the button above) and try again.');
    return { level, tps: tpsNow === null ? null : Math.round(tpsNow * 10) / 10, mspt, text, hints };
  }

  const routes = {
    'GET /api/pregen': pregen,
    'POST /api/pregen/install': async () => { needMods(); return sources.modrinthInstall('chunky'); },
    'POST /api/pregen/start': async req => pregenStart(await readJson(req)),
    'POST /api/pregen/control': async req => {
      const action = String((await readJson(req)).action);
      if (!['pause', 'continue', 'cancel', 'progress'].includes(action)) fail(400, 'bad action');
      if (!await isActive()) fail(409, 'the server is not running');
      await sendCommand('chunky ' + action);
    },
    'GET /api/lag': lagInfo,
    'POST /api/lag/install': async () => { needMods(); return sources.modrinthInstall('spark'); },
    'POST /api/lag/check': lagCheck,
    'POST /api/lag/profile': async () => {
      if (!await hasSpark()) fail(409, 'Install spark first');
      if (!await isActive()) fail(409, 'Start the server first');
      profileBefore = ((await sys.log(400)).match(SPARK_URL) || []).pop() || '';
      await sendCommand('spark profiler start --timeout 60');
    },
    'GET /api/gamerules': gamerules,
    'POST /api/gamerule': async req => setGamerule(await readJson(req)),
    'GET /api/mods/updates': async () => ({ updates: await sources.modUpdates() }),
    'POST /api/mods/update': async req => { const b = await readJson(req); return sources.modUpdate(Array.isArray(b.names) ? b.names.map(String) : null); },
    'GET /api/map': async () => ({
      supported: !!MODS, installed: await hasJar(/bluemap/i), port: 8100,
      accepted: /accept-download:\s*true/.test(await fsp.readFile(mapConfig(), 'utf8').catch(() => '')),
    }),
    'POST /api/map/install': async () => sources.modrinthInstall('bluemap'),
    'POST /api/map/enable': async () => {
      await editFile(mapConfig(), /accept-download:\s*false/, 'accept-download: true', 'Start the server once with BlueMap installed (it writes its settings then), and press this again');
      return { message: 'BlueMap may download the Minecraft files it needs to draw the map. Restart the server to start it; the first drawing takes a while.' };
    },
    'GET /api/bedrock': async () => ({
      supported: !!geyserKind(), kind: geyserKind(), geyser: await hasJar(/geyser/i), floodgate: await hasJar(/floodgate/i), port: 19132,
      ready: /auth-type:\s*floodgate/.test(await fsp.readFile(geyserConfig(), 'utf8').catch(() => '')),
    }),
    'POST /api/bedrock/install': async () => {
      if (!geyserKind()) fail(409, 'Bedrock players can join Paper, Purpur, Fabric and NeoForge servers');
      if (geyserKind() === 'plugin') return sources.bedrockInstall();
      const a = await sources.modrinthInstall('geyser'), b = await sources.modrinthInstall('floodgate');
      return { done: [...a.done, ...b.done], warnings: [...(a.warnings || []), ...(b.warnings || [])] };
    },
    'POST /api/bedrock/enable': async () => {
      await editFile(geyserConfig(), /^(\s*)auth-type:\s*\S+/m, '$1auth-type: floodgate', 'Start the server once with Geyser installed (it writes its settings then), and press this again');
      if (geyserKind() !== 'plugin') {
        const key = path.join(ROOT, 'config/floodgate/key.pem');
        if (!await exists(key)) fail(409, 'Start the server once with Floodgate installed (it makes its key then), and press this again');
        await fsp.copyFile(key, path.join(geyserDir(), 'key.pem'));
      }
      return { message: 'Bedrock players now sign in through Floodgate, with no Java account needed. Restart the server. Open UDP port 19132 for them.' };
    },
    'POST /api/public-address/test': async () => {
      const a = entry.settings.publicAddress;
      if (!a) fail(409, 'save the address first');
      const [host, port] = a.split(':');
      const addrs = await dns.lookup(host, { all: true }).catch(() => fail(400, 'I could not look that address up'));
      if (!(extra.extraHosts || []).includes(host) && addrs.some(x => privateIp(x.address))) fail(400, 'that address points at a private network, a tunnel address is public');
      const g = await ping(Number(port) || 25565, host);
      return { online: !!g, players: g ? `${g.online}/${g.max}` : '' };
    },
    'GET /api/status': status,
    'POST /api/command': async req => sendCommand((await readJson(req)).line),
    'GET /api/log': async (req, res, q) => ({ text: await sys.log(Math.min(1000, Math.max(10, Number(q.get('n')) || 200))) }),
    'GET /api/players': async () => {
      if (BE) {
        const [props, allow, running] = await Promise.all([readProps(), readList('allowlist.json'), isActive()]);
        return { running, edition: 'bedrock', whitelistOn: getProp(props, 'allow-list', 'false') === 'true', onlineMode: getProp(props, 'online-mode', 'true') !== 'false', whitelist: allow.map(p => p.name), ops: [], banned: [], bannedIps: [] };
      }
      const [props, whitelist, ops, banned, bannedIps, running] = await Promise.all([readProps(), readList('whitelist.json'), readList('ops.json'), readList('banned-players.json'), readList('banned-ips.json'), isActive()]);
      return {
        running,
        whitelistOn: getProp(props, 'white-list', 'false') === 'true',
        onlineMode: getProp(props, 'online-mode', 'true') !== 'false',
        whitelist: whitelist.map(p => p.name),
        ops: ops.map(p => ({ name: p.name, level: p.level })),
        banned: banned.map(p => ({ name: p.name, reason: p.reason || '' })),
        bannedIps: bannedIps.map(b => ({ ip: b.ip, reason: b.reason || '' })),
      };
    },
    'POST /api/cracked': async req => setCracked((await readJson(req)).on === true),
    'POST /api/whitelist': async req => setWhitelist((await readJson(req)).on === true),
    'POST /api/player': async req => {
      const b = await readJson(req);
      await playerAction({ action: String(b.action), name: b.name, level: b.level, reason: b.reason, ip: b.ip });
    },

    'GET /api/logs': listLogs,
    'GET /api/logs/read': (req, res, q) => readLog(q.get('name')),
    'POST /api/log/share': async req => {
      const b = await readJson(req);
      const text = b.name ? (await readLog(b.name)).text : await sys.log(2000);
      if (!text.trim()) fail(400, 'the log is empty');
      const url = await shareLog(text);
      console.log(`[${id}] log shared:`, url);
      return { url };
    },

    'GET /api/worlds': listWorlds,
    'POST /api/worlds/use': async req => useWorld((await readJson(req)).name),
    'POST /api/worlds/new': async req => newWorld(await readJson(req)),
    'POST /api/worlds/delete': async req => deleteWorld((await readJson(req)).name),
    'GET /api/worlds/download': (req, res, q) => oneAtATime(() => downloadWorld(String(q.get('name')), res)),
    'PUT /api/worlds/upload': (req, res, q) => uploadWorld(req, q),
    'GET /api/datapacks': listDatapacks,
    'PUT /api/datapacks': async (req, res, q) => {
      const name = dpName(q.get('name'));
      await fsp.mkdir(await dpDir(), { recursive: true });
      const dest = path.join(await dpDir(), name);
      await receive(req, dest, MAX_PACK, true);
      const names = (await zipfile.list(dest).catch(() => [])).map(e => e.name);
      if (!names.includes('pack.mcmeta')) { await fsp.rm(dest, { force: true }); fail(400, 'that zip is not a data pack (no pack.mcmeta inside)'); }
    },
    'DELETE /api/datapacks': async (req, res, q) => { await fsp.rm(path.join(await dpDir(), dpName(q.get('name'), false)), { recursive: true, force: true }); },
    'GET /api/datapacks/find': async (req, res, q) => ({ results: await sources.datapackSearch(String(q.get('q') || '').trim().slice(0, 100)) }),
    'POST /api/datapacks/install': async req => sources.datapackInstall(String((await readJson(req)).id).trim(), await dpDir()),

    'GET /api/mods': listMods,
    'PUT /api/mods': async (req, res, q) => {
      needMods();
      const dest = path.join(MODS, modName(q.get('name')));
      await fsp.mkdir(MODS, { recursive: true });
      await receive(req, dest, MAX_MOD, true);
      await fsp.rm(dest + '.disabled', { force: true });
      console.log(`[${id}] ${sw.dir} uploaded:`, path.basename(dest));
    },
    'POST /api/mods/toggle': async req => {
      needMods();
      const file = path.join(MODS, modName((await readJson(req)).name));
      if (await exists(file)) await fsp.rename(file, file + '.disabled');
      else await fsp.rename(file + '.disabled', file).catch(() => fail(404, 'no such file'));
    },
    'DELETE /api/mods': async (req, res, q) => {
      needMods();
      const file = path.join(MODS, modName(q.get('name')));
      await fsp.rm(file, { force: true });
      await fsp.rm(file + '.disabled', { force: true });
      console.log(`[${id}] ${sw.dir} deleted:`, path.basename(file));
    },
    'GET /api/find': async (req, res, q) => {
      const text = String(q.get('q') || '').trim().slice(0, 100);
      return { results: await (q.get('src') === 'curseforge' ? sources.curseSearch(text) : sources.modrinthSearch(text)) };
    },
    'POST /api/find/install': async req => {
      const { src, id: what } = await readJson(req);
      const out = await (src === 'curseforge' ? sources.curseInstall(String(what).trim()) : sources.modrinthInstall(String(what).trim()));
      console.log(`[${id}] installed from`, src || 'modrinth', ':', out.done.map(d => `${d.name} (${d.status})`).join(', '));
      return out;
    },

    'GET /api/files': (req, res, q) => listFiles(q),
    'GET /api/file': (req, res, q) => readText(q),
    'GET /api/download': (req, res, q) => download(q, res),
    'PUT /api/file': (req, res, q) => saveFile(req, q),
    'DELETE /api/file': (req, res, q) => removeFile(q),
    'POST /api/mkdir': async req => {
      const abs = await within((await readJson(req)).path);
      if (abs === ROOT) fail(400, 'bad path');
      await fsp.mkdir(abs).catch(e => fail(e.code === 'EEXIST' ? 409 : 400, e.code === 'EEXIST' ? 'it already exists' : 'cannot create the folder'));
    },

    'GET /api/backup': (req, res) => oneAtATime(() => doBackupDownload(res)),
    'GET /api/backups': async () => ({ backups: await listBackups(), keep: entry.settings.backupKeep }),
    'POST /api/backups': async () => ({ name: await createBackup() }),
    'POST /api/backups/restore': async req => restoreBackup((await readJson(req)).name),
    'DELETE /api/backups': async (req, res, q) => {
      if (!BACKUP_NAME.test(String(q.get('name')))) fail(400, 'bad backup name');
      await fsp.rm(path.join(BACKUPS, q.get('name')), { force: true });
    },
    'GET /api/backups/download': async (req, res, q) => {
      const name = String(q.get('name'));
      if (!BACKUP_NAME.test(name)) fail(400, 'bad backup name');
      const st = await fsp.stat(path.join(BACKUPS, name)).catch(() => fail(404, 'no such backup'));
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff' });
      await pipeline(fs.createReadStream(path.join(BACKUPS, name)), res).catch(() => {});
    },
    'POST /api/world/reset': resetWorld,

    'GET /api/settings': async () => ({ ...entry.settings, memoryNowMB: await memoryNow(), defaultMemoryMB: heapMB, hostMB: hostMB(), memoryManaged: id !== 'main' && !BE }),
    'PUT /api/settings': async req => {
      const b = await readJson(req);
      const num = (v, min, max, label) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label}: a whole number from ${min} to ${max}`); return n; };
      if (b.restartOnCrash !== undefined) entry.settings.restartOnCrash = b.restartOnCrash === true;
      if (b.memoryMB !== undefined) await setMemory(b.memoryMB === '' ? 0 : num(b.memoryMB, 0, 1 << 20, 'Memory (MB)'));
      if (b.backupKeep !== undefined) entry.settings.backupKeep = num(b.backupKeep, 1, 30, 'Backups to keep');
      if (b.backupEveryHours !== undefined) entry.settings.backupEveryHours = num(b.backupEveryHours, 0, 168, 'Backup every (hours)');
      if (b.idleMinutes !== undefined) entry.settings.idleMinutes = num(b.idleMinutes, 0, 1440, 'Stop when empty after (minutes)');
      const clock = (v, label) => { if (v !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) fail(400, `${label}: a time like 04:30, or empty for never`); return String(v); };
      if (b.restartAt !== undefined) entry.settings.restartAt = clock(b.restartAt, 'Restart every day at');
      if (b.startAt !== undefined) entry.settings.startAt = clock(b.startAt, 'Start every day at');
      if (b.stopAt !== undefined) entry.settings.stopAt = clock(b.stopAt, 'Stop every day at');
      if (b.publicAddress !== undefined) {
        const a = String(b.publicAddress).trim().replace(/^[a-z]+:\/\//i, '');
        if (a && !/^[A-Za-z0-9.-]{3,100}(:\d{1,5})?$/.test(a)) fail(400, 'The address friends use from outside: a name or number, optionally with :port');
        entry.settings.publicAddress = a;
      }
      await save();
    },

    'GET /api/options': async () => {
      const p = await readProps();
      return { options: (BE ? BEDROCK_OPTIONS : OPTIONS).map(o => ({ ...o, value: getProp(p, o.key, o.def) })) };
    },
    'PUT /api/options': async req => {
      const { values } = await readJson(req);
      let text = await readProps();
      for (const [k, v] of Object.entries(values || {})) {
        const o = (BE ? BEDROCK_OPTIONS : OPTIONS).find(x => x.key === k);
        if (!o) fail(400, 'unknown setting ' + k);
        text = setProp(text, k, cleanOption(o, v));
      }
      await writeProps(text);
    },

    'GET /api/resourcepack': getPack,
    'PUT /api/resourcepack': async req => setPack(await readJson(req)),
    'DELETE /api/resourcepack': clearPack,
    'GET /api/packs/find': async (req, res, q) => ({ results: await sources.packSearch(String(q.get('q') || '').trim().slice(0, 100)) }),
  };

  return { id, entry, sw, root: ROOT, sys, sources, routes, readProps, writeProps, readList, writeList, portOf, getInstall, setInstall, createBackup, safetyBackup, listBackups, isActive };
};
module.exports.OPTIONS = OPTIONS;
