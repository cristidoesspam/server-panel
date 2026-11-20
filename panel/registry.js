'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const net = require('net');
const { fail, getProp, setProp, dirSize } = require('./common');
const makeInstance = require('./instance');
const makeSoftware = require('./software');
const { udpFree, WORLD_DEFAULT } = require('./bedrock');

const { SOFTWARE } = makeSoftware;
const RESERVED_PORTS = new Set([22, 80, 443, 8787, 8790]);
const MAX_SERVERS = 8;
const DEFAULT_SETTINGS = { backupKeep: 5, backupEveryHours: 0, idleMinutes: 0, restartAt: '', startAt: '', stopAt: '', publicAddress: '', memoryMB: 0, restartOnCrash: true };
const exists = p => fsp.stat(p).then(() => true, () => false);

function encodeMotd(l1, l2) {
  const line = s => {
    s = String(s ?? '').replace(/[\r\n\0]/g, ' ').slice(0, 90);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '&' && /[0-9a-fk-orA-FK-OR]/.test(s[i + 1] || '')) out += '\\u00A7';
      else if (c === '\\') out += '\\\\';
      else if (c.charCodeAt(0) > 126) out += '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
      else out += c;
    }
    return out;
  };
  const a = line(l1), b = line(l2);
  return b ? `${a}\\n${b}` : a;
}
function decodeMotd(raw) {
  const text = String(raw).replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\\/g, '\\').replace(/§/g, '&');
  const [a, ...rest] = text.split('\\n');
  return [a || '', rest.join(' ')];
}

const cleanName = s => {
  s = String(s ?? '').trim();
  if (!s || s.length > 40 || /[\u0000-\u001f]/.test(s)) fail(400, 'give the server a name (1 to 40 characters)');
  return s;
};

function joinAddresses(port) {
  const out = [];
  for (const [ifName, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|vEthernet|vboxnet|VirtualBox|VMware|Loopback)|^lo$/i.test(ifName)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      const label = x === 100 && y >= 64 && y <= 127 ? 'Tailscale (Tailscale must be on)' : x === 192 && y === 168 || x === 10 || (x === 172 && y >= 16 && y <= 31) ? 'Home network' : '';
      if (label) out.push({ label, address: port === 25565 ? a.address : `${a.address}:${port}`, host: a.address, port });
    }
  }
  return out;
}

const listening = port => new Promise(resolve => {
  const s = net.connect(port, '127.0.0.1');
  s.setTimeout(400, () => { s.destroy(); resolve(false); });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

module.exports = function makeRegistry({ dataDir, baseDir, mainDir, panelPort, mc, heapMB, javaDir, fake, curseKey, maxRunning = 1, extra = {}, extraHosts = [], onBackup }) {
  const file = path.join(dataDir, 'servers.json');
  const software = makeSoftware({ javaDir, knownJava: { 25: path.join(mainDir, 'java', 'bin', 'java') }, fake, extraHosts });
  let entries = [];
  const instances = new Map();

  const save = () => fsp.mkdir(dataDir, { recursive: true }).then(() => fsp.writeFile(file, JSON.stringify({ servers: entries }, null, 1)));

  function build(entry) {
    const inst = makeInstance({ entry, sw: SOFTWARE[entry.software], fake, curseKey, extra, save, heapMB, onBackup });
    instances.set(entry.id, inst);
    return inst;
  }

  (function load() {
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).servers || []; } catch { }
    const main = saved.find(e => e.id === 'main') || {};
    const hasMain = fake || fs.existsSync(path.join(mainDir, 'server.properties'));
    entries = [...hasMain ? [{ id: 'main', name: main.name || 'Main server', dir: mainDir, software: 'fabric', mc, settings: { ...DEFAULT_SETTINGS, ...main.settings } }] : [],
      ...saved.filter(e => e.id !== 'main' && SOFTWARE[e.software] && e.dir && path.dirname(path.resolve(e.dir)) === path.resolve(baseDir))
        .map(e => ({ ...e, settings: { ...DEFAULT_SETTINGS, ...e.settings } }))];
    for (const e of entries) {
      build(e);
      const f = path.join(e.dir, '.install.json');
      try { if (JSON.parse(fs.readFileSync(f, 'utf8')).state === 'running') fs.writeFileSync(f, JSON.stringify({ state: 'failed', error: 'the panel was restarted during the install, delete this server and create it again' })); } catch { }
    }
  })();

  const get = id => instances.get(id) || fail(404, 'no such server');
  const defaultId = () => instances.has('main') ? 'main' : entries[0]?.id || fail(404, 'there is no server yet, create one first');
  const all = () => [...instances.values()];

  async function portsInUse(exceptId) {
    const used = new Set();
    for (const i of all()) if (i.id !== exceptId) { const p = await i.portOf(); used.add(p); if (i.sw.edition === 'bedrock') used.add(p + 1); }
    return used;
  }
  async function choosePort(wanted, exceptId, bedrock = false) {
    const used = await portsInUse(exceptId);
    const ok = p => Number.isInteger(p) && p >= 1024 && p <= 65534 && !RESERVED_PORTS.has(p) && p !== panelPort && !used.has(p) && (!bedrock || !used.has(p + 1));
    const busy = async p => bedrock ? await listening(p) || !(await udpFree(p) && await udpFree(p + 1)) : listening(p);
    if (wanted !== undefined && wanted !== null && wanted !== '') {
      const p = Number(wanted);
      if (!Number.isInteger(p) || p < 1024 || p > 65534) fail(400, 'the port must be a whole number from 1024 to 65534');
      if (!ok(p)) fail(409, `port ${p} is already used by another server or by this panel`);
      if (await busy(p)) fail(409, `something on this computer is already using port ${p}`);
      return p;
    }
    if (bedrock) { for (let p = 19132; p < 19300; p += 2) if (ok(p) && !await busy(p)) return p; }
    else for (let p = 25566; p < 25700; p++) if (ok(p) && !await busy(p)) return p;
    return fail(409, 'no free port found');
  }

  function freshId(name) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'server';
    let id = base === 'main' ? 'server' : base;
    for (let i = 2; instances.has(id); i++) id = `${base}-${i}`.slice(0, 24);
    return id;
  }

  async function freeBytes(p) {
    try { const s = await fsp.statfs(p); return s.bavail * s.bsize; } catch { return Infinity; }
  }

  async function create(o) {
    if (o.eula !== true) fail(400, 'you need to accept the Minecraft EULA to create a server');
    const name = cleanName(o.name);
    if (!SOFTWARE[o.software]) fail(400, 'pick the server software');
    if (entries.length >= MAX_SERVERS) fail(409, `that is enough servers for this computer (${MAX_SERVERS})`);
    const mcVersion = String(o.mc || '');
    if (!(await software.versions(o.software)).includes(mcVersion)) fail(400, `${SOFTWARE[o.software].label} has no version ${mcVersion || '(none chosen)'}`);
    await fsp.mkdir(baseDir, { recursive: true });
    const minFreeGB = process.env.PANEL_MIN_FREE_GB !== undefined ? Number(process.env.PANEL_MIN_FREE_GB) : 2;
    if (await freeBytes(baseDir) < minFreeGB * 1024 ** 3) fail(507, `less than ${minFreeGB} GB of free disk space on this computer, not creating another server`);
    const bedrock = SOFTWARE[o.software].edition === 'bedrock';
    const port = await choosePort(o.port, undefined, bedrock);
    const seed = String(o.seed ?? '').trim();
    if (seed.length > 64 || /[\\\r\n\0]/.test(seed)) fail(400, 'the seed can be at most 64 characters, no backslashes');
    const id = freshId(name);
    const dir = path.join(baseDir, id);
    await fsp.mkdir(dir);
    const entry = { id, name, dir, software: o.software, mc: mcVersion, settings: { ...DEFAULT_SETTINGS } };
    try {
      if (!bedrock) await fsp.writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
      let props = '';
      for (const [k, v] of Object.entries(bedrock ? {
        'server-name': String(o.motd1 ?? name).replace(/[;\r\n=\\]/g, ' ').trim().slice(0, 60) || name, 'server-port': port, 'server-portv6': port + 1, 'allow-list': 'true',
        'max-players': 10, 'view-distance': 10, 'level-name': WORLD_DEFAULT, 'level-seed': seed, 'server-udp-ports': port,
      } : {
        'motd': encodeMotd(o.motd1 ?? name, o.motd2 ?? ''), 'server-port': port, 'white-list': 'true', 'enforce-whitelist': 'true', 'online-mode': 'true',
        'max-players': 10, 'view-distance': 8, 'simulation-distance': 6, 'level-seed': seed,
      })) props = setProp(props, k, v);
      await fsp.writeFile(path.join(dir, 'server.properties'), props);
      if (!bedrock && o.copyLists !== false) for (const f of ['whitelist.json', 'ops.json']) await fsp.copyFile(path.join(mainDir, f), path.join(dir, f)).catch(() => {});
      await fsp.writeFile(path.join(dir, '.install.json'), JSON.stringify({ state: 'running', step: 'Starting' }));
    } catch (e) { await fsp.rm(dir, { recursive: true, force: true }); throw e; }
    entries.push(entry);
    const inst = build(entry);
    await save();
    install(inst, false).catch(() => {});
    return { id };
  }

  async function install(inst, reinstall) {
    const { entry } = inst;
    const set = (state, step, error) => inst.setInstall({ state, step, error });
    try {
      await set('running', 'Starting');
      await software.install(entry.dir, entry.software, entry.mc, { heapMB: entry.settings.memoryMB || heapMB, report: step => set('running', step) });
      if (entry.software === 'fabric' && !fake) {
        await set('running', 'Adding Fabric API');
        await inst.sources.modrinthInstall('fabric-api').catch(e => console.log(`[${entry.id}] Fabric API not added:`, e.message));
      }
      await set('done', '');
      console.log(`[${entry.id}] ${reinstall ? 'reinstalled' : 'installed'}: ${entry.software} ${entry.mc}`);
    } catch (e) {
      console.log(`[${entry.id}] install failed:`, e.message);
      await set('failed', '', e.message).catch(() => {});
    }
  }

  async function changeSoftware(id, o) {
    if (id === 'main') fail(400, 'the main server is managed by the installer; create a new server to use other software');
    const inst = get(id);
    if (!SOFTWARE[o.software]) fail(400, 'pick the server software');
    if ((SOFTWARE[o.software].edition === 'bedrock') !== (inst.sw.edition === 'bedrock')) fail(400, 'A Java server cannot become a Bedrock server (or the other way round): the worlds are not the same kind. Create a new server instead.');
    if (await inst.isActive()) fail(409, 'stop the server first');
    if ((await inst.getInstall()).state === 'running') fail(409, 'an install is already running');
    if (!(await software.versions(o.software)).includes(String(o.mc))) fail(400, `${SOFTWARE[o.software].label} has no version ${o.mc}`);
    const backup = await inst.safetyBackup('changing the software');
    inst.entry.software = o.software;
    inst.entry.mc = String(o.mc);
    await save();
    const fresh = build(inst.entry);
    await fresh.setInstall({ state: 'running', step: 'Starting' });
    install(fresh, true).catch(() => {});
    return { backup };
  }

  async function duplicate(id, nameIn) {
    if (id === 'main') fail(400, 'the main server was made by the installer and cannot be copied; create a new server and move its world over instead');
    const src = get(id);
    const name = cleanName(nameIn);
    if (entries.length >= MAX_SERVERS) fail(409, `that is enough servers for this computer (${MAX_SERVERS})`);
    if (await src.isActive()) fail(409, 'stop the server first, so its files are not copied half-way');
    if ((await src.getInstall()).state === 'running') fail(409, 'wait until the software is installed');
    const skip = new Set(['backups', 'logs', 'crash-reports']);
    const skipped = p => { const first = path.relative(src.root, p).split(path.sep)[0]; return skip.has(first) || first.startsWith('.upload-') || first === '.import'; };
    let size = 0;
    for (const e of await fsp.readdir(src.root, { withFileTypes: true })) if (!skipped(path.join(src.root, e.name))) size += e.isDirectory() ? await dirSize(path.join(src.root, e.name)) : (await fsp.stat(path.join(src.root, e.name))).size;
    if (size * 1.1 > await freeBytes(baseDir)) fail(507, 'not enough free disk space on this computer to copy this server');
    const bedrock = src.sw.edition === 'bedrock';
    const port = await choosePort(undefined, undefined, bedrock);
    const nid = freshId(name);
    const dir = path.join(baseDir, nid);
    try {
      await fsp.cp(src.root, dir, { recursive: true, filter: s => !skipped(s) && !/\.part-/.test(s) });
      await fsp.rm(path.join(dir, 'world', 'session.lock'), { force: true });
      const props = path.join(dir, 'server.properties');
      let ptext = setProp(await fsp.readFile(props, 'utf8').catch(() => ''), 'server-port', port);
      if (bedrock) ptext = setProp(setProp(ptext, 'server-portv6', port + 1), 'server-udp-ports', port);
      await fsp.writeFile(props, ptext);
    } catch (e) { await fsp.rm(dir, { recursive: true, force: true }); throw e; }
    const entry = { id: nid, name, dir, software: src.entry.software, mc: src.entry.mc, settings: { ...src.entry.settings } };
    entries.push(entry);
    build(entry);
    await save();
    console.log(`[${nid}] copied from ${id}`);
    return { id: nid };
  }

  async function remove(id, confirm) {
    if (id === 'main') fail(400, 'the main server cannot be deleted here');
    const inst = get(id);
    if (confirm !== inst.entry.name) fail(400, 'type the exact server name to confirm');
    const st = (await inst.sys.state()).active;
    if (st !== 'inactive' && st !== 'failed') fail(409, 'stop the server first');
    if (path.dirname(path.resolve(inst.entry.dir)) !== path.resolve(baseDir)) fail(500, 'refusing to delete outside the servers folder');
    await fsp.rm(inst.entry.dir, { recursive: true, force: true });
    entries = entries.filter(e => e.id !== id);
    instances.delete(id);
    await save();
    console.log(`[${id}] server deleted`);
  }

  async function othersActive(id) {
    const running = [];
    for (const i of all()) {
      if (i.id === id) continue;
      const st = (await i.sys.state()).active;
      if (st === 'active' || st === 'activating') running.push({ id: i.id, name: i.entry.name });
    }
    return running.length >= maxRunning ? running[0] : null;
  }

  const iconFile = id => path.join(get(id).root, 'server-icon.png');
  const motdOf = (inst, props) => inst.sw.edition === 'bedrock' ? [getProp(props, 'server-name', 'Dedicated Server'), ''] : decodeMotd(getProp(props, 'motd', 'A Minecraft Server'));

  async function overview() {
    return Promise.all(all().map(async i => {
      const [st, props, install] = await Promise.all([i.sys.state(), i.readProps(), i.getInstall()]);
      const [motd1, motd2] = motdOf(i, props);
      return {
        id: i.id, name: i.entry.name, state: st.active, software: i.entry.software, softwareLabel: i.sw.label, edition: i.sw.edition || 'java', mc: i.entry.mc, motd1, motd2,
        port: Number(getProp(props, 'server-port', '25565')) || 25565, install: install.state, hasIcon: await exists(iconFile(i.id)),
      };
    }));
  }

  async function appearance(id) {
    const inst = get(id);
    const props = await inst.readProps();
    const port = Number(getProp(props, 'server-port', '25565')) || 25565;
    const [motd1, motd2] = motdOf(inst, props);
    const pub = inst.entry.settings.publicAddress;
    return { id, name: inst.entry.name, edition: inst.sw.edition || 'java', port, motd1, motd2, hasIcon: await exists(iconFile(id)), isMain: id === 'main', addresses: [...joinAddresses(port), ...pub ? [{ label: 'From anywhere (tunnel)', address: pub }] : []] };
  }

  async function setAppearance(id, b) {
    const inst = get(id);
    let props = await inst.readProps();
    if (b.name !== undefined) inst.entry.name = cleanName(b.name);
    const bedrock = inst.sw.edition === 'bedrock';
    if (b.motd1 !== undefined || b.motd2 !== undefined) {
      props = bedrock ? setProp(props, 'server-name', String(b.motd1 ?? '').replace(/[;\r\n=\\]/g, ' ').trim().slice(0, 60) || inst.entry.name) : setProp(props, 'motd', encodeMotd(b.motd1, b.motd2));
    }
    if (b.port !== undefined) {
      const current = Number(getProp(props, 'server-port', bedrock ? '19132' : '25565'));
      if (Number(b.port) !== current) {
        const p = await choosePort(b.port, id, bedrock);
        props = setProp(props, 'server-port', p);
        if (bedrock) props = setProp(setProp(props, 'server-portv6', p + 1), 'server-udp-ports', p);
      }
    }
    await inst.writeProps(props);
    await save();
  }

  function validIcon(buf) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 33 || buf.length > 1024 * 1024 || !buf.subarray(0, 8).equals(sig) || buf.toString('latin1', 12, 16) !== 'IHDR') fail(400, 'that is not a PNG picture');
    if (buf.readUInt32BE(16) !== 64 || buf.readUInt32BE(20) !== 64) fail(400, 'the picture must be exactly 64 by 64 pixels (the page resizes it for you)');
  }
  async function setIcon(id, buf) { validIcon(buf); await fsp.writeFile(iconFile(id), buf); }
  const clearIcon = id => fsp.rm(iconFile(id), { force: true });

  const emptySince = new Map();
  const lastAuto = new Map();
  const crashes = new Map();
  const doneOn = new Map();

  const history = new Map();
  const statsFile = path.join(dataDir, 'stats.json');
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(statsFile, 'utf8')))) history.set(k, v); } catch { }
  let ticks = 0;
  function sample(i, st, g) {
    const a = history.get(i.id) || [];
    a.push([Date.now(), st.active === 'active' ? st.memMB : null, g ? g.online : null]);
    if (a.length > 1440) a.splice(0, a.length - 1440);
    history.set(i.id, a);
  }
  const stats = id => history.get(id) || [];

  async function backupData(ymd) {
    const root = path.join(dataDir, 'backup');
    await fsp.mkdir(path.join(root, ymd), { recursive: true });
    for (const f of ['servers.json', 'access.json', 'alerts.json', 'stats.json']) await fsp.copyFile(path.join(dataDir, f), path.join(root, ymd, f)).catch(() => {});
    const days = (await fsp.readdir(root)).filter(n => /^\d{4}-\d\d-\d\d$/.test(n)).sort();
    for (const old of days.slice(0, -7)) await fsp.rm(path.join(root, old), { recursive: true, force: true });
  }

  async function tick() {
    const d = new Date();
    const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const today = d.toDateString();
    const once = (what, id) => { const k = what + ':' + id; if (doneOn.get(k) === today) return false; doneOn.set(k, today); return true; };
    if (once('data-backup', 'panel')) backupData(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`).catch(() => {});
    for (const i of all()) {
      try {
        const st = await i.sys.state();
        const s = i.entry.settings;
        const g = st.active === 'active' ? await i.sys.ping() : null;
        sample(i, st, g);
        if (st.active === 'failed' && s.restartOnCrash && (await i.getInstall()).state === 'done') {
          const recent = (crashes.get(i.id) || []).filter(t => Date.now() - t < 30 * 60e3);
          if (recent.length < 3 && !await othersActive(i.id)) {
            crashes.set(i.id, [...recent, Date.now()]);
            console.log(`[${i.id}] crashed, starting it again (${recent.length + 1} of 3)`);
            await i.sys.power('start');
            continue;
          }
          if (recent.length === 3 && once('crash-giveup', i.id)) console.log(`[${i.id}] crashed 3 times in 30 minutes, leaving it stopped`);
        }
        if (st.active !== 'active') {
          emptySince.delete(i.id);
          if (s.startAt && hhmm === s.startAt && once('start', i.id) && !await othersActive(i.id) && (await i.getInstall()).state === 'done') {
            console.log(`[${i.id}] scheduled start`);
            await i.sys.power('start');
          }
          continue;
        }
        for (const [what, at, text, action] of [['stop', s.stopAt, 'stops', 'stop'], ['restart', s.restartAt, 'restarts', 'restart']]) {
          if (at && hhmm === at && once(what, i.id)) {
            console.log(`[${i.id}] daily ${what} in 30 seconds`);
            await i.sys.command(`say The server ${text} in 30 seconds.`).catch(() => {});
            setTimeout(() => i.sys.power(action).catch(() => {}), 30000).unref();
          }
        }
        if (s.restartAt === hhmm || s.stopAt === hhmm) continue;
        if (s.backupEveryHours > 0) {
          const newest = (await i.listBackups())[0];
          const last = Math.max(newest?.mtime || 0, lastAuto.get(i.id) || 0);
          if (Date.now() - last > s.backupEveryHours * 3600e3) { lastAuto.set(i.id, Date.now()); await i.createBackup(); }
        }
        if (s.idleMinutes > 0) {
          if (!g || g.online > 0) emptySince.delete(i.id);
          else if (!emptySince.has(i.id)) emptySince.set(i.id, Date.now());
          else if (Date.now() - emptySince.get(i.id) > s.idleMinutes * 60e3) {
            emptySince.delete(i.id);
            console.log(`[${i.id}] nobody online for ${s.idleMinutes} minutes, stopping`);
            await i.sys.power('stop');
          }
        }
      } catch (e) { console.log(`[${i.id}] timer:`, e.message); }
    }
    if (++ticks % 10 === 0) fsp.mkdir(dataDir, { recursive: true }).then(() => fsp.writeFile(statsFile, JSON.stringify(Object.fromEntries(history)))).catch(() => {});
  }

  return { get, defaultId, all, create, duplicate, remove, changeSoftware, othersActive, stats, overview, appearance, setAppearance, setIcon, clearIcon, iconFile, tick, versions: software.versions, SOFTWARE, encodeMotd, decodeMotd, joinAddresses };
};
module.exports.encodeMotd = encodeMotd;
module.exports.decodeMotd = decodeMotd;
