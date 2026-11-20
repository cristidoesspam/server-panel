'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { fail, readJson, readBuffer, receive, ping, vcmp } = require('./common');

const envAt = process.argv.indexOf('--env');
if (envAt > 0) {
  for (const line of fs.readFileSync(process.argv[envAt + 1], 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
const makeRegistry = require('./registry');
const makeAccess = require('./access');
const makeImporter = require('./importer');
const makeActivity = require('./activity');
const makeAlerts = require('./alerts');
const makeDoctor = require('./doctor');
const makeOffsite = require('./offsite');
const { stopAll } = require('./runner');

const PORT = Number(process.env.PORT) || 8790;
const ROOT = path.resolve(process.env.MC_DIR || path.join(os.homedir(), 'minecraft-server'));
const BASE = path.resolve(process.env.MC_SERVERS_DIR || path.join(os.homedir(), 'minecraft-servers'));
const DATA = path.resolve(process.env.PANEL_DATA || path.join(os.homedir(), '.minecraft-panel'));
const JAVA_DIR = path.resolve(process.env.MC_JAVA_DIR || path.join(os.homedir(), 'minecraft-java'));
const FAKE = process.env.PANEL_FAKE === '1';
const WEB = path.join(__dirname, 'web');
const MC_VERSION = process.env.MC_VERSION || '26.3';
const CF_KEY = process.env.CURSEFORGE_KEY || '';
const MAX_RUNNING = Math.max(1, Math.min(8, Number(process.env.PANEL_MAX_RUNNING) || 1));
const MAX_IMPORT = 4 * 1024 * 1024 * 1024;

const offsite = makeOffsite({ dir: DATA });
const registry = makeRegistry({
  onBackup: (sid, file, name) => offsite.send(sid, file, name),
  dataDir: DATA, baseDir: BASE, mainDir: ROOT, panelPort: PORT, mc: MC_VERSION, javaDir: JAVA_DIR, fake: FAKE, curseKey: CF_KEY, maxRunning: MAX_RUNNING,
  heapMB: Number(process.env.JAVA_HEAP_MB) || 1536,
  extra: {
    ...(process.env.MODRINTH_API && { modrinthApi: process.env.MODRINTH_API }),
    ...(process.env.CURSEFORGE_API && { curseApi: process.env.CURSEFORGE_API }),
    ...(process.env.GEYSER_API && { geyserApi: process.env.GEYSER_API }),
    extraHosts: (process.env.PANEL_TEST_HOSTS || '').split(',').filter(Boolean),
  },
  extraHosts: (process.env.PANEL_TEST_HOSTS || '').split(',').filter(Boolean),
});
const importer = makeImporter({ stage: path.join(DATA, 'import') });
const activity = makeActivity({ dir: DATA });
const access = makeAccess({ dir: DATA, log: (...a) => { console.log(...a); activity.record({ t: Date.now(), who: 'Access', server: '', what: a.join(' ') }); } });
const alerts = makeAlerts({ dir: DATA });
const jobs = new Map();
const doctor = makeDoctor({ registry, dataDir: DATA, panelPort: PORT, version: 3, owner: () => access.owner() });
const liveJob = id => {
  const j = jobs.get(id);
  if (j && j.state !== 'running' && Date.now() - j.at > 10 * 60 * 1000) { jobs.delete(id); return null; }
  return j ? { state: j.state, step: j.step, error: j.error, messages: j.messages } : null;
};

function allowedIp(ip) {
  ip = ip.replace(/^::ffff:/, '');
  const m = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return ip === '::1';
  const a = +m[1], b = +m[2];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

const NEED = {
  'GET /api/sources': null, 'GET /api/servers': null, 'GET /api/software': null, 'GET /api/software/versions': null,
  'POST /api/access/leave': null,
  'GET /api/access': 'access', 'POST /api/access/approve': 'access', 'POST /api/access/update': 'access', 'POST /api/access/remove': 'access',
  'POST /api/access/invite': 'access', 'POST /api/access/revoke': 'access', 'POST /api/access/add': 'access', 'POST /api/access/relink': 'access', 'POST /api/access/forget': 'access',
  'POST /api/servers': 'create', 'POST /api/servers/delete': 'create', 'POST /api/servers/duplicate': 'create',
  'PUT /api/import': ['files', 'create'], 'POST /api/import/apply': 'files', 'POST /api/import/create': 'create', 'DELETE /api/import': ['files', 'create'],

  'GET /api/activity': 'access',
  'GET /api/status': null, 'GET /api/appearance': null, 'GET /api/icon': null, 'GET /api/stats': null,
  'GET /api/mods/updates': 'mods', 'POST /api/mods/update': 'mods', 'GET /api/map': 'mods', 'POST /api/map/install': 'mods', 'POST /api/map/enable': 'mods',
  'GET /api/bedrock': 'mods', 'POST /api/bedrock/install': 'mods', 'POST /api/bedrock/enable': 'mods',
  'GET /api/gamerules': 'options', 'POST /api/gamerule': 'options', 'POST /api/public-address/test': 'options',
  'POST /api/power': 'power',
  'GET /api/pregen': 'options', 'POST /api/pregen/install': 'mods', 'POST /api/pregen/start': 'options', 'POST /api/pregen/control': 'options',
  'GET /api/lag': 'options', 'POST /api/lag/install': 'mods', 'POST /api/lag/check': 'options', 'POST /api/lag/profile': 'options',
  'POST /api/software': 'options', 'PUT /api/appearance': 'options', 'PUT /api/icon': 'options', 'DELETE /api/icon': 'options',
  'POST /api/command': 'console', 'GET /api/log': 'console', 'GET /api/logs': 'console', 'GET /api/logs/read': 'console', 'POST /api/log/share': 'console',
  'GET /api/players': 'players', 'POST /api/cracked': 'options', 'POST /api/whitelist': 'players', 'POST /api/player': 'players',
  'GET /api/mods': 'mods', 'PUT /api/mods': 'mods', 'POST /api/mods/toggle': 'mods', 'DELETE /api/mods': 'mods', 'GET /api/find': 'mods', 'POST /api/find/install': 'mods',
  'GET /api/files': 'files', 'GET /api/file': 'files', 'GET /api/download': 'files', 'PUT /api/file': 'files', 'DELETE /api/file': 'files', 'POST /api/mkdir': 'files',
  'GET /api/backup': 'backups', 'GET /api/backups': 'backups', 'POST /api/backups': 'backups', 'POST /api/backups/restore': 'backups', 'DELETE /api/backups': 'backups',
  'GET /api/backups/download': 'backups', 'POST /api/world/reset': 'backups',
  'GET /api/worlds': 'backups', 'POST /api/worlds/use': 'backups', 'POST /api/worlds/new': 'backups', 'POST /api/worlds/delete': 'backups',
  'GET /api/worlds/download': 'backups', 'PUT /api/worlds/upload': 'backups',
  'GET /api/datapacks': 'backups', 'PUT /api/datapacks': 'backups', 'DELETE /api/datapacks': 'backups', 'GET /api/datapacks/find': 'backups', 'POST /api/datapacks/install': 'backups',
  'GET /api/settings': 'options', 'PUT /api/settings': 'options', 'GET /api/options': 'options', 'PUT /api/options': 'options',
  'GET /api/resourcepack': 'options', 'PUT /api/resourcepack': 'options', 'DELETE /api/resourcepack': 'options', 'GET /api/packs/find': 'options',
};
const allowed = (who, need) => need === null || (Array.isArray(need) ? need.some(n => access.can(who, n)) : access.can(who, need));

const SAID = { start: 'started', stop: 'stopped', restart: 'restarted' };
function describe(key, b, q) {
  const t = (x, n = 70) => String(x ?? '').slice(0, n);
  switch (key) {
    case 'POST /api/power': return `${SAID[b.action] || t(b.action)} the server`;
    case 'POST /api/command': return `ran /${t(String(b.line).replace(/^[/]/, ''))}`;
    case 'POST /api/player': return `${t(b.action)} ${t(b.name || b.ip)}`;
    case 'POST /api/whitelist': return `turned the whitelist ${b.on ? 'on' : 'off'}`;
    case 'POST /api/cracked': return `turned cracked mode ${b.on ? 'on' : 'off'}`;
    case 'PUT /api/options': return 'changed the game options';
    case 'PUT /api/settings': return 'changed the automatic settings';
    case 'POST /api/software': return `changed the software to ${t(b.software)} ${t(b.mc)}`;
    case 'PUT /api/file': return `saved the file ${t(q.get('path'))}`;
    case 'DELETE /api/file': return `deleted ${t(q.get('path'))}`;
    case 'PUT /api/mods': return `uploaded ${t(q.get('name'))}`;
    case 'DELETE /api/mods': return `deleted ${t(q.get('name'))}`;
    case 'POST /api/servers': return `created the server "${t(b.name)}"`;
    case 'POST /api/servers/delete': return `deleted the server ${t(b.id)}`;
    case 'POST /api/servers/duplicate': return `copied the server ${t(b.id)} as "${t(b.name)}"`;
    case 'POST /api/backups': return 'made a backup';
    case 'POST /api/access/password': return `set the ${b.kind === 'guest' ? 'friends' : 'owner'} password`;
    case 'POST /api/access/password/clear': return `removed the ${b.kind === 'guest' ? 'friends' : 'owner'} password`;
    case 'POST /api/access/password/friends': return 'changed what the friends password allows';
    case 'PUT /api/offsite': return 'changed where backups are copied to';
    case 'POST /api/pregen/start': return `started pre-generating the world (radius ${t(b.radius)})`;
    case 'POST /api/lag/profile': return 'started a 60 second lag recording';
    case 'POST /api/backups/restore': return `restored ${t(b.name)}`;
    default: return key.replace(/^(POST|PUT|DELETE) [/]api[/]/, '').replace(/[/]/g, ' ');
  }
}

function nearest(list, want) {
  if (!want || !list.length) return { mc: list[0] || '', exact: false };
  if (list.includes(want)) return { mc: want, exact: true };
  const minor = v => v.split('.').slice(0, 2).join('.');
  const newer = list.filter(v => vcmp(v, want) >= 0).sort(vcmp);
  return { mc: newer.find(v => minor(v) === minor(want)) || newer[0] || list[0], exact: false };
}
async function suggest(plan) {
  const d = plan.detected;
  const label = s => registry.SOFTWARE[s].label;
  const versions = await registry.versions(d.software).catch(() => null);
  const pick = versions ? nearest(versions, d.mc) : { mc: d.mc, exact: true };
  const notes = [...d.notes];
  if (d.mc && !pick.exact) notes.push(`${label(d.software)} has no ${d.mc}, so ${pick.mc} is suggested.`);
  if (!d.mc) notes.push('I could not tell which Minecraft version the old server ran, so the newest is suggested.');
  return { software: d.software, mc: pick.mc, notes };
}
const targetOf = inst => ({ root: inst.root, sw: inst.sw, mc: inst.entry.mc, running: () => inst.isActive(), readProps: inst.readProps, writeProps: inst.writeProps, readList: inst.readList, writeList: inst.writeList });
const picksOf = b => ({ world: !!b.world, settings: !!b.settings, appearance: !!b.appearance, lists: !!b.lists, offline: !!b.offline, mods: !!b.mods, config: !!b.config });

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const FONT = name => [`fonts/${name}.woff2`, 'font/woff2', 'public, max-age=604800'];
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/fonts/dm-sans-latin.woff2': FONT('dm-sans-latin'),
  '/fonts/dm-sans-latin-ext.woff2': FONT('dm-sans-latin-ext'),
  '/fonts/pixelify-latin.woff2': FONT('pixelify-latin'),
  '/fonts/pixelify-latin-ext.woff2': FONT('pixelify-latin-ext'),
};

const global = {
  'GET /api/sources': async () => ({ mc: MC_VERSION, curseforge: !!CF_KEY }),
  'GET /api/servers': async (req, res, q, who) => ({ servers: (await registry.overview()).filter(s => access.canServer(who, s.id)) }),
  'POST /api/servers': async req => {
    const out = await registry.create(await readJson(req));
    console.log('server created:', out.id);
    return out;
  },
  'POST /api/servers/delete': async (req, res, q, who) => {
    const b = await readJson(req);
    if (!access.canServer(who, String(b.id))) fail(403, 'you do not have access to this server');
    if (jobs.get(String(b.id))?.state === 'running') fail(409, 'the modpack is still downloading into this server, wait until it is done');
    await registry.remove(String(b.id), String(b.confirm));
  },
  'POST /api/servers/duplicate': async (req, res, q, who) => {
    const b = await readJson(req);
    if (!access.canServer(who, String(b.id))) fail(403, 'you do not have access to this server');
    return registry.duplicate(String(b.id), b.name);
  },
  'GET /api/activity': async () => ({ items: activity.list(200) }),
  'GET /api/doctor': async () => doctor.run(),
  'GET /api/offsite': async () => offsite.view(),
  'PUT /api/offsite': async req => { await offsite.set(await readJson(req)); return offsite.view(); },
  'POST /api/offsite/send': async () => {
    if (!offsite.enabled()) fail(409, 'Set a folder or a cloud first');
    let n = 0;
    for (const i of registry.all()) { const b = (await i.listBackups())[0]; if (b) { n++; offsite.send(i.id, path.join(i.root, 'backups', b.name), b.name); } }
    if (!n) fail(409, 'There is no backup yet: make one on the Backups tab first');
    return { sent: n };
  },
  'GET /api/alerts': async () => alerts.view(),
  'PUT /api/alerts': async req => alerts.set(await readJson(req)),
  'POST /api/alerts/test': async () => { await alerts.send(null, 'Test message from your Server Panel.'); },
  'GET /api/software': async () => ({ software: Object.entries(registry.SOFTWARE).map(([id, s]) => ({ id, label: s.label, dir: s.dir, edition: s.edition || 'java' })) }),
  'GET /api/software/versions': async (req, res, q) => ({ versions: await registry.versions(String(q.get('software'))) }),

  'PUT /api/import': async (req, res, q) => {
    const name = String(q.get('name') || '');
    if (!/\.(zip|mrpack|tar\.gz|tgz)$/i.test(name)) fail(400, 'please choose a .zip, a .tar.gz or a Modrinth .mrpack file');
    const isTgz = /\.(tar\.gz|tgz)$/i.test(name);
    if ((Number(req.headers['content-length']) || 0) * 3 > await importer.freeBytes()) fail(507, 'not enough free disk space on this computer for this zip');
    const { id, zip } = await importer.newStage(isTgz ? 'tgz' : 'zip');
    try {
      await receive(req, zip, MAX_IMPORT, isTgz ? 'gzip' : true);
      const plan = await importer.analyze(id, name.slice(0, 120));
      plan.suggest = await suggest(plan);
      console.log('import checked:', plan.zipName, `(${plan.suggest.software} ${plan.suggest.mc})`);
      return plan;
    } catch (e) { await importer.discard(id).catch(() => {}); throw e; }
  },
  'POST /api/import/apply': async (req, res, q, who) => {
    const b = await readJson(req);
    if (!access.canServer(who, String(b.server))) fail(403, 'you do not have access to this server');
    const inst = registry.get(String(b.server));
    if (inst.sw.edition === 'bedrock') fail(400, 'Move a server here brings Java servers in. For a Bedrock world use the Worlds tab of the Bedrock server: upload a .mcworld or .zip.');
    const picks = picksOf(b);
    const backup = picks.world && !await inst.isActive() ? await inst.safetyBackup('moving a server in') : null;
    const messages = await importer.apply(String(b.id), picks, targetOf(inst));
    if (backup) messages.unshift(`Your world was backed up first (${backup}), so you can go back to it on the Backups tab.`);
    console.log(`[${b.server}] import applied:`, messages.join(' '));
    return { messages };
  },
  'POST /api/import/create': async (req) => {
    const b = await readJson(req);
    if (registry.SOFTWARE[b.software]?.edition === 'bedrock') fail(400, 'Move a server here makes Java servers. For a Bedrock world, create a Bedrock server and upload the world on its Worlds tab.');
    const first = await importer.loadPlan(String(b.id));
    if (first.modpack) await importer.validateModpack(String(b.id));
    const { id } = await registry.create({ name: b.name, software: b.software, mc: b.mc, eula: b.eula === true, copyLists: false });
    console.log('server created from an import:', id);
    try {
      const target = targetOf(registry.get(id));
      if (first.modpack) {
        const job = { state: 'running', step: 'starting the download', error: '', messages: [], at: Date.now() };
        jobs.set(id, job);
        importer.applyModpack(String(b.id), target, (process.env.PANEL_TEST_HOSTS || '').split(',').filter(Boolean), step => { job.step = step; })
          .then(m => { Object.assign(job, { state: 'done', step: '', messages: m, at: Date.now() }); console.log(`[${id}] modpack done:`, m.join(' ')); },
            e => { Object.assign(job, { state: 'failed', error: e.message, at: Date.now() }); console.log(`[${id}] modpack failed:`, e.message); });
        return { id, background: true, messages: ['The modpack is downloading in the background. The Overview shows how far it is.'] };
      }
      const messages = await importer.apply(String(b.id), picksOf(b), target);
      console.log(`[${id}] import applied:`, messages.join(' '));
      return { id, messages };
    } catch (e) { fail(e.status || 500, `The server "${b.name}" was made, but moving the old one into it failed: ${e.message}. Open it and use Import to try again.`); }
  },
  'DELETE /api/import': async (req, res, q) => importer.discard(String(q.get('id'))),
};

const perServer = {
  'GET /api/status': async (inst, req, res, q, who) => {
    const st = await inst.routes['GET /api/status']();
    let other = await registry.othersActive(inst.id);
    if (other && !access.canServer(who, other.id)) other = { id: '', name: 'another server' };
    return { ...st, other, limit: MAX_RUNNING, job: liveJob(inst.id) };
  },
  'POST /api/power': async (inst, req) => {
    const { action } = await readJson(req);
    if (!['start', 'stop', 'restart'].includes(action)) fail(400, 'bad action');
    if (action !== 'stop') {
      if (jobs.get(inst.id)?.state === 'running') fail(409, 'the modpack is still downloading, wait until it is done');
      const install = await inst.getInstall();
      if (install.state === 'running') fail(409, 'the software is still being installed, wait until it is done');
      if (install.state === 'failed') fail(409, 'the install failed: ' + (install.error || 'unknown error') + '. Change the software or delete this server.');
      const other = await registry.othersActive(inst.id);
      if (other) fail(409, `Stop "${other.name}" first: this computer can only run ${MAX_RUNNING === 1 ? 'one server' : MAX_RUNNING + ' servers'} at a time.`);
    }
    console.log(`[${inst.id}] power:`, action);
    await inst.sys.power(action);
  },
  'POST /api/software': async (inst, req) => registry.changeSoftware(inst.id, await readJson(req)),
  'GET /api/appearance': async inst => registry.appearance(inst.id),
  'GET /api/stats': async inst => ({ points: registry.stats(inst.id) }),
  'PUT /api/appearance': async (inst, req) => registry.setAppearance(inst.id, await readJson(req)),
  'GET /api/icon': async (inst, req, res) => {
    const buf = await fsp.readFile(registry.iconFile(inst.id)).catch(() => fail(404, 'no icon'));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  },
  'PUT /api/icon': async (inst, req) => registry.setIcon(inst.id, await readBuffer(req, 1024 * 1024)),
  'DELETE /api/icon': async inst => registry.clearIcon(inst.id),
};

const doors = {
  'POST /api/access/ask': async (req, res, ip) => { const b = await readJson(req); const p = access.ask(req, res, ip, b.name, b.key); return { state: p.state }; },
  'POST /api/access/cancel': async (req, res) => { access.cancel(req, res); return { ok: true }; },
  'POST /api/access/redeem': async (req, res, ip) => { const b = await readJson(req); return { ok: true, ...access.me(access.redeem(req, res, ip, b.code, b.name)) }; },
  'POST /api/access/claim-here': async (req, res, ip) => ({ ok: true, ...access.me(access.claimHere(req, res, ip, (await readJson(req)).name)) }),
  'POST /api/access/login': async (req, res, ip) => { const b = await readJson(req); return { ok: true, ...access.me(access.login(req, res, ip, b.password, b.device)) }; },
};
const accessRoutes = {
  'GET /api/access': async (req, res, q, who) => access.list(who),
  'POST /api/access/approve': async (req, res, q, who) => access.approve(who, await readJson(req)),
  'POST /api/access/update': async (req, res, q, who) => access.update(who, await readJson(req)),
  'POST /api/access/remove': async (req, res, q, who) => access.remove(who, (await readJson(req)).id),
  'POST /api/access/invite': async (req, res, q, who) => access.invite(who, await readJson(req)),
  'POST /api/access/add': async (req, res, q, who) => access.addByName(who, await readJson(req)),
  'POST /api/access/relink': async (req, res, q, who) => access.relink((await readJson(req)).id),
  'POST /api/access/forget': async (req, res, q, who) => access.forget((await readJson(req)).id),
  'POST /api/access/revoke': async (req, res, q, who) => access.revoke((await readJson(req)).id),
  'POST /api/access/password': async (req, res, q, who) => access.setPassword(who, await readJson(req)),
  'POST /api/access/password/friends': async (req, res, q, who) => access.changeGuest(who, await readJson(req)),
  'POST /api/access/password/clear': async (req, res, q, who) => access.clearPassword(who, (await readJson(req)).kind),
  'POST /api/access/leave': async (req, res, q, who) => {
    access.leave(who);
    res.setHeader('Set-Cookie', 'mcd=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  },
};

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function handle(req, res) {
  const ip = req.socket.remoteAddress || '';
  if (!allowedIp(ip) || req.headers['tailscale-funnel-request']) fail(403, 'not allowed from this address');
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  const file = req.method === 'GET' && STATIC[p];
  if (file) {
    let body;
    try { body = fs.readFileSync(path.join(WEB, file[0])); } catch { fail(404, 'not found'); }
    res.writeHead(200, { 'Content-Type': file[1], 'Content-Security-Policy': CSP, 'Cache-Control': file[2] || 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    return res.end(body);
  }
  if (!p.startsWith('/api/')) fail(404, 'not found');
  if (req.method !== 'GET' && req.headers['x-panel'] !== '1') fail(403, 'missing header');

  const key = req.method + ' ' + p;
  if (key === 'GET /api/hello') return send(res, 200, { panel: 'server-panel', version: 3 });
  if (doors[key]) return send(res, 200, await doors[key](req, res, ip));

  const who = access.who(req);
  if (key === 'GET /api/me') {
    if (!who) return send(res, 401, { error: 'you do not have access yet', ...access.door(req, ip) });
    access.refresh(req, res);
    return send(res, 200, { ok: true, ...access.me(who) });
  }
  if (!who) fail(401, 'you do not have access yet');
  const need = key in NEED ? NEED[key] : 'owner';
  if (need === 'owner' ? !who.owner : !allowed(who, need)) fail(403, 'you do not have access to this');

  const q = url.searchParams;
  let out, served = '';
  if (accessRoutes[key]) out = await accessRoutes[key](req, res, q, who);
  else if (global[key]) out = await global[key](req, res, q, who);
  else {
    const inst = registry.get(q.get('server') || registry.defaultId());
    if (!access.canServer(who, inst.id)) fail(403, 'you do not have access to this server');
    served = inst.id;
    const handler = perServer[key] ? (...a) => perServer[key](inst, ...a) : inst.routes[key];
    if (!handler) fail(404, 'not found');
    out = await handler(req, res, q, who);
  }
  if (req.method !== 'GET') activity.record({ t: Date.now(), who: who.name, server: served, what: describe(key, req.parsed || {}, q) });
  if (!res.headersSent) send(res, 200, out ?? { ok: true });
}

function start() {
  importer.cleanup().catch(() => {});
  setInterval(() => registry.tick().catch(() => {}), 60 * 1000).unref();
  const look = alerts.watch(registry);
  setInterval(() => look().catch(() => {}), 10 * 1000).unref();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (!e.status) console.error(e);
      if (res.headersSent) return res.destroy();
      res.setHeader('Connection', 'close');
      send(res, e.status || 500, { error: e.status ? e.message : 'something went wrong, the details are in the panel log' });
    });
  });
  server.requestTimeout = 0;
  server.listen(PORT, '0.0.0.0', () => console.log(`Minecraft panel listening on port ${PORT}${FAKE ? ' (FAKE mode)' : ''}`));
  return server;
}

if (require.main === module) {
  process.on('unhandledRejection', e => console.error('unhandled:', e && e.stack || e));
  process.on('uncaughtException', e => console.error('uncaught:', e && e.stack || e));
  const server = start();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => { server.close(); access.flush().finally(() => stopAll()).finally(() => process.exit(0)); });
  }
}
module.exports = { start, ping, registry, access, alerts, activity };
