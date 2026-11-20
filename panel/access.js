'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { fail } = require('./common');
const { hashPassword, checkPassword } = require('./password');

const PERMS = {
  power: 'Start, stop and restart',
  console: 'Console and logs',
  players: 'Players: whitelist, operators, bans',
  options: 'Settings, look and software',
  backups: 'Backups and worlds',
  files: 'Files and importing (full control of the server folder)',
  mods: 'Mods and plugins (they run code on this computer)',
  create: 'Create, copy and delete servers',
  access: 'Manage who has access',
};
const PRESETS = {
  viewer: { label: 'Look only', perms: [] },
  helper: { label: 'Helper', perms: ['power', 'console', 'players'] },
  manager: { label: 'Manager', perms: ['power', 'console', 'players', 'options', 'backups'] },
  full: { label: 'Full access', perms: Object.keys(PERMS) },
};
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY = 24 * 3600 * 1000;
const MAX_PEOPLE = 60, MAX_PENDING = 20, MAX_PENDING_PER_IP = 3;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const makeCode = () => Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')).join('-');

function cleanName(s, what = 'name') {
  s = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 30 || /[\u0000-\u001f<>]/.test(s)) fail(400, `give a ${what} (1 to 30 characters)`);
  return s;
}
const cleanPerms = (list, mine) => {
  if (!Array.isArray(list)) fail(400, 'bad permissions');
  const out = [...new Set(list.map(String))].filter(p => PERMS[p]);
  if (mine && out.some(p => !mine.includes(p))) fail(403, 'you cannot give permissions you do not have yourself');
  return out;
};
const cleanServers = v => {
  if (v === 'all' || v === undefined) return 'all';
  if (!Array.isArray(v) || v.length > 20 || v.some(x => typeof x !== 'string' || x.length > 40)) fail(400, 'bad server list');
  return [...new Set(v)];
};

module.exports = function makeAccess({ dir, now = Date.now, log = console.log }) {
  const file = path.join(dir, 'access.json');
  let data = { people: {}, codes: {}, names: {}, password: {} };
  let dirty = false;
  const byToken = new Map();
  const tries = new Map();
  let setupCode = '';

  try { data = { people: {}, codes: {}, names: {}, password: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { }
  for (const p of Object.values(data.people)) byToken.set(p.hash, p.id);

  let writing = Promise.resolve();
  const save = () => {
    dirty = false;
    return (writing = writing.then(async () => {
      await fsp.mkdir(dir, { recursive: true });
      const tmp = file + '.tmp-' + crypto.randomBytes(3).toString('hex');
      await fsp.writeFile(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
      await fsp.rename(tmp, file);
    }).catch(e => log('could not save access.json:', e.message)));
  };
  setInterval(() => { if (dirty) save(); }, 60 * 1000).unref();

  const nameKey = n => String(n).trim().replace(/\s+/g, ' ').toLowerCase();
  const owner = () => Object.values(data.people).find(p => p.owner);
  const tokenOf = req => (/(?:^|; )mcd=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1] || '';
  const cookie = token => `mcd=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  const record = req => { const t = tokenOf(req); return t ? data.people[byToken.get(sha(t))] || null : null; };
  const isLoopback = (ip, req) => /^(127\.|::1$)/.test(ip.replace(/^::ffff:/, '')) && !req.headers['x-forwarded-for'] && !req.headers.forwarded && !req.headers['x-real-ip'];

  function limited(ip) {
    const t = tries.get(ip);
    if (t && t.until > now()) fail(429, 'too many tries, wait a few minutes');
  }
  function wrong(ip, message = 'that code is not right (or it has been used or has expired)') {
    const t = tries.get(ip) || { n: 0, until: 0 };
    if (++t.n >= 8) { t.until = now() + 10 * 60 * 1000; t.n = 0; }
    tries.set(ip, t);
    fail(403, message);
  }

  function addPerson(res, existing, fields) {
    if (Object.keys(data.people).length >= MAX_PEOPLE && !existing) fail(409, 'that is enough people');
    const token = crypto.randomBytes(32).toString('hex');
    const p = existing || { id: crypto.randomBytes(4).toString('hex'), created: now() };
    if (existing) byToken.delete(existing.hash);
    Object.assign(p, { hash: sha(token), state: 'active', seen: now() }, fields);
    data.people[p.id] = p;
    byToken.set(p.hash, p.id);
    res.setHeader('Set-Cookie', cookie(token));
    return p;
  }

  const passwordFile = path.join(dir, 'set-password.json');
  function pickUp() {
    if (!fs.existsSync(passwordFile)) return;
    try {
      const w = JSON.parse(fs.readFileSync(passwordFile, 'utf8'));
      if ((w.kind === 'owner' || w.kind === 'guest') && /^[0-9a-f]{32}$/.test(w.s) && /^[0-9a-f]{128}$/.test(w.h)) {
        data.password[w.kind] = w.kind === 'guest' ? { s: w.s, h: w.h, perms: data.password.guest?.perms || PRESETS.helper.perms, servers: data.password.guest?.servers || 'all' } : { s: w.s, h: w.h };
        for (const [k, c] of Object.entries(data.codes)) if (w.kind === 'owner' && c.kind === 'owner') delete data.codes[k];
        if (w.kind === 'owner') fs.rmSync(path.join(dir, 'setup-code.txt'), { force: true });
        log(`the ${w.kind} password was set from the computer`);
        save();
      }
    } catch { }
    fs.rmSync(passwordFile, { force: true });
  }

  function ensureSetupCode() {
    for (const [k, c] of Object.entries(data.codes)) if (c.kind === 'owner') delete data.codes[k];
    if (owner() || data.password.owner) { fs.rmSync(path.join(dir, 'setup-code.txt'), { force: true }); return ''; }
    setupCode = makeCode();
    data.codes[sha(cleanCode(setupCode))] = { kind: 'owner', expires: 0 };
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'setup-code.txt'), setupCode + '\n', { mode: 0o600 }); } catch { }
    log(`SETUP: nobody owns this panel yet. Open it in a browser and enter the setup code ${setupCode} (also saved in ${path.join(dir, 'setup-code.txt')}).`);
    save();
    return setupCode;
  }
  pickUp();
  ensureSetupCode();

  function who(req) {
    pickUp();
    const p = record(req);
    if (p && p.state === 'active') {
      if (now() - p.seen > 5 * 60 * 1000) { p.seen = now(); dirty = true; }
      return p;
    }
    return null;
  }
  function door(req, ip) {
    pickUp();
    const p = record(req);
    return { state: p ? p.state : 'none', setup: !owner() && !data.password.owner, here: !owner() && isLoopback(ip, req), name: p?.name || '', password: !!(data.password.owner || data.password.guest) };
  }
  const can = (p, perm) => !!p && (p.owner || (p.perms.includes(perm) && (perm !== 'create' || p.servers === 'all')));
  const canServer = (p, id) => !!p && (p.owner || p.servers === 'all' || p.servers.includes(id));
  const mine = p => p.owner ? Object.keys(PERMS) : p.perms;
  const refresh = (req, res) => { const t = tokenOf(req); if (t) res.setHeader('Set-Cookie', cookie(t)); };

  function me(p) {
    return { id: p.id, name: p.name, owner: !!p.owner, perms: mine(p).filter(x => can(p, x)), servers: p.owner ? 'all' : p.servers, pending: can(p, 'access') ? pendingList().length : 0 };
  }

  function ask(req, res, ip, name, key) {
    if (owner() === undefined) fail(409, data.password.owner ? 'this panel has no owner yet: sign in with the password first' : 'this panel has no owner yet: use the setup code');
    const have = record(req);
    if (have) return have;
    const pending = Object.values(data.people).filter(p => p.state === 'pending');
    if (pending.length >= MAX_PENDING || pending.filter(p => p.ip === ip).length >= MAX_PENDING_PER_IP) fail(429, 'too many requests are waiting, ask the owner to look at them first');
    name = cleanName(name, 'name so the owner knows who you are');
    let added = data.names[nameKey(name)];
    if (added && added.expires && added.expires < now()) { delete data.names[nameKey(name)]; added = null; }
    if (added && key && added.kh === sha(cleanCode(key))) {
      delete data.names[nameKey(name)];
      const p = addPerson(res, null, { name: added.name, owner: false, perms: added.perms, servers: added.servers, ip });
      log(`"${p.name}" came in with the link ${added.by} made`);
      save();
      return p;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const p = { id: crypto.randomBytes(4).toString('hex'), name, hash: sha(token), state: 'pending', perms: [], servers: 'all', created: now(), seen: now(), ip };
    if (added) p.suggest = { perms: added.perms, servers: added.servers };
    data.people[p.id] = p;
    byToken.set(p.hash, p.id);
    res.setHeader('Set-Cookie', cookie(token));
    log(`access requested by "${name}" from ${ip}`);
    save();
    return p;
  }

  function redeem(req, res, ip, rawCode, name) {
    limited(ip);
    const key = sha(cleanCode(rawCode));
    const c = data.codes[key];
    if (!c || (c.expires && c.expires < now())) wrong(ip);
    tries.delete(ip);
    const have = record(req);
    let p;
    if (c.kind === 'owner') {
      if (owner()) { delete data.codes[key]; fail(409, 'this panel already has an owner'); }
      p = addPerson(res, have, { name: cleanName(name || have?.name || 'Owner'), owner: true, perms: Object.keys(PERMS), servers: 'all', ip });
      delete data.codes[key];
      fs.rmSync(path.join(dir, 'setup-code.txt'), { force: true });
      log(`${p.name} is now the owner of this panel`);
    } else {
      p = addPerson(res, have, { name: cleanName(name || c.name || have?.name), owner: false, perms: c.perms, servers: c.servers, ip });
      if (--c.uses <= 0) delete data.codes[key];
      log(`"${p.name}" joined with an invite`);
    }
    save();
    return p;
  }

  function claimHere(req, res, ip, name) {
    if (owner()) fail(409, 'this panel already has an owner');
    if (!isLoopback(ip, req)) fail(403, 'only a browser on the computer that runs the panel can do this; use the setup code');
    const p = addPerson(res, record(req), { name: cleanName(name || 'Owner'), owner: true, perms: Object.keys(PERMS), servers: 'all', ip });
    for (const [k, c] of Object.entries(data.codes)) if (c.kind === 'owner') delete data.codes[k];
    fs.rmSync(path.join(dir, 'setup-code.txt'), { force: true });
    log(`${p.name} is now the owner of this panel (from this computer)`);
    save();
    return p;
  }

  const deviceLabel = s => String(s || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 16) || 'device';
  function login(req, res, ip, password, device) {
    pickUp();
    limited(ip);
    if (!data.password.owner && !data.password.guest) fail(409, 'no password has been set for this panel');
    const asOwner = checkPassword(data.password.owner, password);
    const asGuest = !asOwner && checkPassword(data.password.guest, password);
    if (!asOwner && !asGuest) wrong(ip, 'that password is not right');
    tries.delete(ip);
    const have = record(req);
    if (have && have.state === 'active' && have.owner && !asOwner) return have;
    const g = data.password.guest;
    const fields = asOwner ? { owner: true, perms: Object.keys(PERMS), servers: 'all' } : { owner: false, perms: g.perms, servers: g.servers };
    const keep = have && have.state === 'active' && (asOwner ? have.owner : have.viaPassword === 'guest');
    const reuse = keep || (have && have.state === 'pending') ? have : null;
    if (have && have.state === 'active' && !keep) { byToken.delete(have.hash); delete data.people[have.id]; }
    const p = addPerson(res, reuse, { ...fields, ip, viaPassword: asOwner ? 'owner' : 'guest', name: reuse && reuse.state === 'active' ? reuse.name : `${asOwner ? 'Owner' : 'Friend'} (${deviceLabel(device)})` });
    if (asOwner) {
      for (const [k, c] of Object.entries(data.codes)) if (c.kind === 'owner') delete data.codes[k];
      fs.rmSync(path.join(dir, 'setup-code.txt'), { force: true });
    }
    log(`${p.name} signed in with the ${asOwner ? 'owner' : 'friends'} password`);
    save();
    return p;
  }

  function setPassword(by, b) {
    if (!by.owner) fail(403, 'only the owner can set passwords');
    const kind = b.kind === 'guest' ? 'guest' : 'owner';
    const h = hashPassword(b.password);
    if (kind === 'owner' && checkPassword(data.password.guest, b.password)) fail(400, 'the owner password and the friends password must be different');
    if (kind === 'guest' && checkPassword(data.password.owner, b.password)) fail(400, 'the owner password and the friends password must be different');
    data.password[kind] = kind === 'guest'
      ? { ...h, perms: cleanPerms(b.perms ?? data.password.guest?.perms ?? PRESETS.helper.perms, mine(by)), servers: cleanServers(b.servers ?? data.password.guest?.servers) }
      : h;
    log(`${by.name} set the ${kind === 'owner' ? 'owner' : 'friends'} password`);
    save();
  }
  function changeGuest(by, b) {
    if (!by.owner) fail(403, 'only the owner can change this');
    if (!data.password.guest) fail(409, 'there is no friends password');
    data.password.guest.perms = cleanPerms(b.perms ?? data.password.guest.perms, mine(by));
    data.password.guest.servers = cleanServers(b.servers ?? data.password.guest.servers);
    save();
  }
  function clearPassword(by, kind) {
    if (!by.owner) fail(403, 'only the owner can remove passwords');
    if (kind !== 'owner' && kind !== 'guest') fail(400, 'which password?');
    delete data.password[kind];
    log(`${by.name} removed the ${kind === 'owner' ? 'owner' : 'friends'} password`);
    save();
  }

  const pendingList = () => Object.values(data.people).filter(p => p.state === 'pending').sort((a, b) => a.created - b.created);
  const view = p => ({ id: p.id, name: p.name, owner: !!p.owner, viaPassword: p.viaPassword || '', perms: p.perms, servers: p.servers, seen: p.seen, created: p.created, ip: p.ip, suggest: p.suggest });
  function list(by) {
    return {
      requests: pendingList().map(view),
      people: Object.values(data.people).filter(p => p.state === 'active').sort((a, b) => (b.owner ? 1 : 0) - (a.owner ? 1 : 0) || a.created - b.created).map(view),
      expected: Object.entries(data.names).filter(([, e]) => !e.expires || e.expires > now()).map(([k, e]) => ({ id: k, name: e.name, perms: e.perms, servers: e.servers, expires: e.expires, by: e.by })),
      invites: Object.entries(data.codes).filter(([, c]) => c.kind === 'invite' && (!c.expires || c.expires > now())).map(([k, c]) => ({ id: k.slice(0, 10), name: c.name, perms: c.perms, servers: c.servers, expires: c.expires, by: c.by })),
      perms: PERMS, presets: PRESETS, me: me(by),
      passwords: { owner: !!data.password.owner, guest: data.password.guest ? { perms: data.password.guest.perms, servers: data.password.guest.servers } : null },
    };
  }
  const target = (by, id) => {
    const p = data.people[String(id)];
    if (!p) fail(404, 'no such person');
    if (p.owner && !by.owner) fail(403, 'only the owner can change the owner');
    return p;
  };
  function approve(by, b) {
    const p = target(by, b.id);
    if (p.state !== 'pending') fail(409, 'that request was already answered');
    p.perms = cleanPerms(b.perms ?? PRESETS.helper.perms, mine(by));
    p.servers = cleanServers(b.servers);
    p.state = 'active';
    delete p.suggest;
    delete data.names[nameKey(p.name)];
    if (b.name) p.name = cleanName(b.name);
    log(`"${p.name}" was given access by ${by.name}`);
    save();
  }
  function update(by, b) {
    const p = target(by, b.id);
    if (p.owner) fail(400, 'the owner always has full access');
    if (b.perms !== undefined) p.perms = cleanPerms(b.perms, mine(by));
    if (b.servers !== undefined) p.servers = cleanServers(b.servers);
    if (b.name !== undefined) p.name = cleanName(b.name);
    save();
  }
  function remove(by, id) {
    const p = target(by, id);
    if (p.owner && !p.viaPassword) fail(400, 'the owner cannot be removed (to start over, delete access.json next to servers.json and restart the panel)');
    byToken.delete(p.hash);
    delete data.people[p.id];
    log(`"${p.name}" lost access`);
    save();
  }
  function invite(by, b) {
    const hours = Math.min(24 * 14, Math.max(1, Number(b.hours) || 24));
    const code = makeCode();
    const name = b.name ? cleanName(b.name, 'name for this invite') : 'Friend';
    data.codes[sha(cleanCode(code))] = { kind: 'invite', name, perms: cleanPerms(b.perms ?? PRESETS.helper.perms, mine(by)), servers: cleanServers(b.servers), uses: 1, expires: now() + hours * 3600e3, by: by.name };
    save();
    return { code };
  }
  function addByName(by, b) {
    const name = cleanName(b.name, 'name for this person');
    const key = nameKey(name);
    if (Object.values(data.people).some(p => p.state === 'active' && nameKey(p.name) === key) || (data.names[key] && (!data.names[key].expires || data.names[key].expires > now()))) fail(409, 'somebody with that name is already in, or already added');
    const perms = cleanPerms(b.perms ?? PRESETS.helper.perms, mine(by));
    const servers = cleanServers(b.servers);
    const waiting = Object.values(data.people).find(p => p.state === 'pending' && nameKey(p.name) === key);
    if (waiting) {
      Object.assign(waiting, { state: 'active', perms, servers });
      log(`"${waiting.name}" was waiting and got access from ${by.name}`);
      save();
      return { joined: true };
    }
    for (const [k, e] of Object.entries(data.names)) if (e.expires && e.expires < now()) delete data.names[k];
    if (Object.keys(data.names).length >= 30) fail(409, 'too many names are waiting to join, remove some first');
    const link = makeCode();
    data.names[key] = { name, perms, servers, expires: now() + Math.min(30, Math.max(1, Number(b.days) || 7)) * DAY, by: by.name, kh: sha(cleanCode(link)) };
    save();
    return { joined: false, key: link };
  }
  function relink(id) {
    const e = data.names[String(id)];
    if (!e) fail(404, 'that name is not waiting any more');
    const link = makeCode();
    e.kh = sha(cleanCode(link));
    save();
    return { key: link, name: e.name };
  }
  function forget(id) { if (data.names[String(id)]) { delete data.names[String(id)]; save(); } }
  function revoke(id) {
    const k = Object.keys(data.codes).find(x => x.startsWith(String(id)) && data.codes[x].kind === 'invite');
    if (k) { delete data.codes[k]; save(); }
  }
  function cancel(req, res) {
    const p = record(req);
    if (p && p.state === 'pending') { byToken.delete(p.hash); delete data.people[p.id]; save(); }
    res.setHeader('Set-Cookie', 'mcd=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  }
  function leave(p) {
    if (p.owner && !p.viaPassword) fail(400, 'the owner cannot leave (that would lock everyone out)');
    remove(p, p.id);
  }

  return { who, door, can, canServer, me, refresh, ask, cancel, redeem, claimHere, login, setPassword, changeGuest, clearPassword, list, approve, update, remove, invite, addByName, relink, forget, revoke, leave, ensureSetupCode, isLoopback, owner, flush: save, PERMS, PRESETS };
};
module.exports.PERMS = PERMS;
module.exports.PRESETS = PRESETS;
