'use strict';

const $ = s => document.querySelector(s);

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter(k => k != null && k !== false));
  return n;
}
const small = (label, onclick, cls = '') => h('button', { class: ('small ' + cls).trim(), type: 'button', onclick }, label);
const svg = markup => { const t = document.createElement('template'); t.innerHTML = markup; return t.content.firstChild; };

const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const fmtMB = mb => mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
const fmtDur = s => s >= 86400 ? Math.floor(s / 86400) + ' d ' + Math.floor(s % 86400 / 3600) + ' h' : s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.floor(s % 3600 / 60) + ' min' : s >= 60 ? Math.floor(s / 60) + ' min' : s + ' s';
const fmtDate = ms => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const join = (dir, name) => dir ? dir + '/' + name : name;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { } },
};

const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>';
const CHECK = '<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="square" aria-hidden="true"><path d="M4 13l5 5L20 6"/></svg>';
const CUBES = { bedrock: ['#8f9bff', '#6772e0', '#444fb0'], vanilla: ['#a8a8a8', '#7d7d7d', '#5a5a5a'], fabric: ['#e3c98f', '#b89a62', '#8a7243'], forge: ['#f08a50', '#c4622a', '#8f4419'], neoforge: ['#f2bd57', '#cf9528', '#986c15'], paper: ['#ffffff', '#d8d8d8', '#a9a9a9'], purpur: ['#c48be8', '#9a5ec7', '#6e3f94'] };
const cube = id => { const c = CUBES[id] || CUBES.vanilla; return svg(`<svg class="cube" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 4.5-9 4.5-9-4.5z" fill="${c[0]}"/><path d="M3 7.5l9 4.5v9l-9-4.5z" fill="${c[1]}"/><path d="M21 7.5l-9 4.5v9l9-4.5z" fill="${c[2]}"/></svg>`); };
const GRASS = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="#8a5a33"/><rect y="2" width="8" height="1" fill="#6e4526"/><rect x="1" y="4" width="2" height="1" fill="#a06b3f"/><rect x="5" y="5" width="2" height="1" fill="#6e4526"/><rect x="3" y="7" width="2" height="1" fill="#a06b3f"/><rect width="8" height="2" fill="#5d9c3a"/><rect x="2" width="2" height="1" fill="#7bc152"/><rect x="6" y="1" width="1" height="1" fill="#7bc152"/></svg>');
let iconStamp = Date.now();
const iconSrc = (id, has) => has ? '/api/icon?server=' + encodeURIComponent(id) + '&t=' + iconStamp : GRASS;

const TABS = ['overview', 'console', 'players', 'worlds', 'mods', 'files', 'backups', 'look', 'settings', 'access', 'import'];
const BEHIND_MORE = ['worlds', 'mods', 'backups', 'look', 'settings', 'access', 'import'];
const NEEDS = { console: 'console', players: 'players', worlds: 'backups', mods: 'mods', files: 'files', backups: 'backups', look: 'options', settings: 'options', access: 'access' };
let me = null;
const can = p => !!me && me.perms.includes(p);
const tabAllowed = name => name === 'import' ? can('files') || can('create') : !NEEDS[name] || can(NEEDS[name]);
let server = store.get('server') || 'main';
let servers = [];
let tab = 'overview';
let sources = { curseforge: false };
let last = null;
let timer = null;
let beat = 0;
const noun = () => last?.modKind === 'plugin' ? 'plugin' : 'mod';
const withServer = url => url + (url.includes('?') ? '&' : '?') + 'server=' + encodeURIComponent(server);

function toast(text, bad = false) {
  const t = h('div', { class: bad ? 'bad' : '' }, text);
  $('#toast').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3500);
}

function ask(text, ok = 'OK', withInput = false) {
  const dlg = $('#dlg'), input = $('#dlgInput');
  $('#dlgText').textContent = text;
  $('#dlgOk').textContent = ok;
  input.hidden = !withInput;
  input.value = '';
  dlg.returnValue = '';
  return new Promise(resolve => {
    dlg.addEventListener('close', () => {
      const yes = dlg.returnValue === 'yes';
      resolve(withInput ? (yes ? input.value.trim() : null) : yes);
    }, { once: true });
    dlg.showModal();
    if (withInput) input.focus();
  });
}

async function api(method, url, body) {
  const opt = { method, headers: { 'X-Panel': '1' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(withServer(url), opt);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { boot(); throw new Error('You no longer have access'); }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', withServer(url));
    x.setRequestHeader('X-Panel', '1');
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let body = {};
      try { body = JSON.parse(x.responseText); } catch { }
      if (x.status < 300) return resolve(body);
      reject(new Error(body.error || 'upload failed'));
    };
    x.onerror = () => reject(new Error('upload failed'));
    x.send(file);
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = h('textarea', { value: text });
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  toast('Copied ' + text);
}

const deviceName = () => { const u = navigator.userAgent; return /Android/.test(u) ? 'Android phone' : /iPhone|iPad/.test(u) ? 'iPhone' : /Windows/.test(u) ? 'Windows PC' : /Mac/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux PC' : 'My device'; };
const nameParam = () => last?.name ? '&n=' + encodeURIComponent(last.name.slice(0, 40)) : '';
async function postRaw(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

async function boot() {
  let r, d = {};
  try { r = await fetch('/api/me', { headers: { 'X-Panel': '1' } }); d = await r.json().catch(() => ({})); } catch { return showGate({ offline: true }); }
  if (r.ok) { me = d; return showApp(); }
  showGate(d);
}

let gateTimer = null, gateWantsCode = false, gateAsk = false, asKey = '';
function showGate(d) {
  clearInterval(timer);
  clearInterval(gateTimer);
  $('#app').hidden = true;
  $('#gate').hidden = false;
  const fromLink = /^#(?:claim|join)=([A-Za-z0-9-]+)/.exec(location.hash);
  const asName = /^#as=([^&]+)(?:&k=([A-Za-z0-9-]+))?(?:&n=([^&]*))?$/.exec(location.hash);
  const inviteQs = (() => {
    const j = /^#join=([A-Za-z0-9-]+)(?:&n=([^&]*))?$/.exec(location.hash);
    if (!j && !asName) return '';
    let n = ''; try { n = decodeURIComponent((j ? j[2] : asName[3]) || ''); } catch { }
    const q = new URLSearchParams(); q.append('a', location.host); if (n) q.set('n', n.slice(0, 40));
    if (j) q.set('join', j[1]); else { try { q.set('as', decodeURIComponent(asName[1])); } catch { } if (asName[2]) q.set('k', asName[2]); }
    return q.toString();
  })();
  const canApp = !!inviteQs && /Android/.test(navigator.userAgent) && !/ServerPanelApp/.test(navigator.userAgent);
  $('#gateApp').hidden = !canApp || !!d.offline;
  if (canApp) $('#gateApp').href = 'intent://add?' + inviteQs + '#Intent;scheme=serverpanel;end'
  if (asName) { try { $('#gateAskName').value = decodeURIComponent(asName[1]).slice(0, 30); } catch { } }
  asKey = asName ? asName[2] || '' : asKey;
  const setup = !!d.setup, pending = d.state === 'pending';
  const usePw = !!d.password && !setup && !pending && !d.offline && !gateWantsCode && !gateAsk && !fromLink && !asName;
  const wantsCode = setup || gateWantsCode || !!fromLink;
  $('#gateTitle').textContent = d.offline ? 'Cannot reach the panel' : usePw ? 'Sign in' : setup ? 'Set up this panel' : pending ? 'Waiting for the owner' : 'Ask for access';
  $('#gateText').textContent = d.offline ? 'Check that the computer is on and that this device is on its network (or on Tailscale), then reload.'
    : usePw ? 'Type the panel password. You only do this once on each device.'
      : setup ? 'Nobody owns this panel yet, and the first person in becomes the owner. Enter the setup code: the installer shows it, and it is in the file setup-code.txt next to servers.json on the computer.'
        : pending ? `${d.name ? d.name + ', your' : 'Your'} request was sent. The owner has to say yes on the Access tab. This page goes on by itself.`
          : 'Say who you are and the owner lets you in, or use an invite code.';
  $('#gatePwForm').hidden = !usePw;
  $('#gateUsePw').hidden = !(d.password && !setup && !pending && !d.offline && !usePw);
  $('#gateCodeForm').hidden = !!d.offline || pending || usePw || !wantsCode;
  $('#gateAskForm').hidden = !!d.offline || pending || usePw || wantsCode;
  $('#gateBack').hidden = setup;
  $('#gateHere').hidden = !d.here;
  $('#gateRetry').hidden = !pending;
  $('#gateErr').textContent = '';
  if (fromLink) $('#gateCode').value = fromLink[1];
  for (const id of ['#gateCodeName', '#gateAskName']) if (!$(id).value) $(id).value = store.get('deviceName') || deviceName();
  if (pending) gateTimer = setInterval(boot, 3000);
}
$('#gateHaveCode').addEventListener('click', () => { gateWantsCode = true; boot(); });
$('#gatePwAsk').addEventListener('click', () => { gateAsk = true; boot(); });
$('#gatePwCode').addEventListener('click', () => { gateWantsCode = true; boot(); });
$('#gateUsePw').addEventListener('click', () => { gateAsk = false; gateWantsCode = false; boot(); });
$('#gatePwForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    me = await postRaw('/api/access/login', { password: $('#gatePw').value, device: deviceName() });
    $('#gatePw').value = '';
    gateAsk = false;
    showApp();
  } catch (err) { $('#gateErr').textContent = err.message; $('#gatePw').select(); }
});
$('#gateBack').addEventListener('click', () => { gateWantsCode = false; history.replaceState(null, '', location.pathname); boot(); });
$('#gateCodeForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const name = $('#gateCodeName').value.trim();
    store.set('deviceName', name);
    me = await postRaw('/api/access/redeem', { code: $('#gateCode').value, name });
    history.replaceState(null, '', location.pathname);
    gateWantsCode = false;
    showApp();
  } catch (err) { $('#gateErr').textContent = err.message; }
});
$('#gateHere').addEventListener('click', async () => {
  try { me = await postRaw('/api/access/claim-here', { name: $('#gateCodeName').value.trim() || deviceName() }); showApp(); } catch (err) { $('#gateErr').textContent = err.message; }
});
$('#gateAskForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const name = $('#gateAskName').value.trim();
    store.set('deviceName', name);
    const r = await postRaw('/api/access/ask', { name, key: asKey });
    if (r.state === 'active') { history.replaceState(null, '', location.pathname); return boot(); }
    showGate({ state: r.state, name });
  } catch (err) { $('#gateErr').textContent = err.message; }
});
$('#gateRetry').addEventListener('click', async () => { await postRaw('/api/access/cancel').catch(() => {}); boot(); });

async function showApp() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
  clearInterval(gateTimer);
  clearInterval(timer);
  applyAccess();
  api('GET', '/api/sources').then(s => { sources = s; }).catch(() => {});
  await loadServers().catch(e => toast(e.message, true));
  await refreshStatus().catch(() => {});
  setTab(location.hash.slice(1));
  timer = setInterval(tick, 2000);
}

function applyAccess() {
  for (const b of document.querySelectorAll('[data-tab]')) {
    const ok = tabAllowed(b.dataset.tab);
    b.dataset.denied = ok ? '' : '1';
    if (b.dataset.tab !== 'mods') (b.closest('li') || b).toggleAttribute('hidden', !ok);
  }
  $('#srvNew').hidden = $('#welcomeNew').hidden = !can('create');
  $('#welcomeImport').hidden = !tabAllowed('import');
  const n = me?.pending || 0;
  $('#accBadge').hidden = !n;
  $('#accBadge').textContent = n;
}
async function refreshMe() { me = await api('GET', '/api/me'); applyAccess(); }

const TITLES = { overview: 'Overview', console: 'Console', players: 'Players', worlds: 'Worlds', mods: 'Mods', files: 'Files', backups: 'Backups', look: 'Look', settings: 'Settings', access: 'Access', import: 'Move a server here' };

function setTab(name) {
  if (!TABS.includes(name) || !tabAllowed(name)) name = 'overview';
  if (!server && name !== 'import' && name !== 'access') { tab = 'overview'; return applyEmpty(); }
  if (name === 'mods' && last && !last.modsDir) name = 'overview';
  tab = name;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
  $('#btnMore').classList.toggle('on', BEHIND_MORE.includes(name));
  for (const s of document.querySelectorAll('[id^=tab-]')) s.hidden = s.id !== 'tab-' + name;
  $('#welcome').hidden = true;
  $('#pageHead').hidden = name === 'overview';
  $('#phTitle').textContent = name === 'mods' ? (noun() === 'plugin' ? 'Plugins' : 'Mods') : TITLES[name];
  $('#phSub').textContent = last?.name || '';
  history.replaceState(null, '', '#' + name);
  window.scrollTo(0, 0);
  refreshStatus().catch(() => {});
  const load = { overview: refreshJoin, import: () => 0, console: refreshConsole, players: refreshPlayers, worlds: refreshWorlds, mods: refreshMods, files: () => refreshFiles(cwd), backups: refreshBackups, look: refreshLook, settings: refreshSettings, access: () => refreshAccess(true) };
  load[name]()?.catch?.(e => toast(e.message, true));
}
function tick() {
  if (document.hidden) return;
  if (tab === 'console' && !logFile) refreshLog().catch(() => {});
  if (beat++ % 2 === 0) refreshStatus().catch(() => setPill('Offline', 'bad'));
  if (beat % 6 === 0) loadServers().catch(() => {});
  if (tab === 'overview' && beat % 15 === 0) refreshGraphs().catch(() => {});
  if (tab === 'worlds' && beat % 5 === 0) refreshPregen().catch(() => {});
  if (beat % 3 === 0) refreshMe().then(() => { if (tab === 'access') return refreshAccess(); }).catch(() => {});
}

if (/ServerPanelApp/.test(navigator.userAgent)) {
  $('#appServers').hidden = false;
  $('#appServers').addEventListener('click', () => { location.href = 'serverpanel://servers'; });
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
$('#btnMore').addEventListener('click', () => $('#moreSheet').showModal());
$('#moreSheet').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b) { $('#moreSheet').close(); setTab(b.dataset.tab); } else if (e.target === $('#moreSheet')) $('#moreSheet').close();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) tick(); });

function serverEntry(s, current) {
  const state = s.install === 'running' ? 'installing' : s.install === 'failed' ? 'install failed' : s.state === 'active' ? 'running' : 'stopped';
  const m1 = h('span', { class: 'mo' }), m2 = h('span', { class: 'mo' });
  renderMotd(m1, s.motd1 || '');
  renderMotd(m2, s.motd2 || '');
  return h('button', { class: 'ent px' + (current ? ' on' : ''), type: 'button', onclick: () => { $('#srvSheet').close(); if (s.id !== server) switchServer(s.id); } },
    h('img', { class: 'ico', alt: '', width: 48, height: 48, src: iconSrc(s.id, s.hasIcon) }),
    h('span', { class: 'tx' }, h('span', { class: 'tp' }, h('span', {}, s.name), h('span', { class: 'cnt' }, state)), m1, m2));
}

function renderHeader() {
  const s = servers.find(x => x.id === server);
  if (!s) return;
  $('#enName').textContent = s.name;
  $('#enIcon').src = iconSrc(s.id, s.hasIcon);
  renderMotd($('#enMotd1'), s.motd1 || '');
  renderMotd($('#enMotd2'), s.motd2 || '');
  const g = last && last.id === server ? last.game : null;
  $('#enCount').textContent = g ? `${g.online}/${g.max}` : '–';
  $('#enBars').classList.toggle('off', !g);
}

async function loadServers() {
  const r = await api('GET', '/api/servers');
  servers = r.servers;
  if (!servers.some(s => s.id === server)) server = servers[0]?.id || '';
  $('#srvList').replaceChildren(...servers.map(s => h('li', {}, serverEntry(s, s.id === server))));
  renderHeader();
  applyEmpty();
}
function applyEmpty() {
  const none = servers.length === 0;
  const standalone = tab === 'import' || tab === 'access';
  $('#welcome').hidden = !none || standalone;
  $('#srvEntry').hidden = $('#srvSwitch').hidden = none;
  if (!none || standalone) return;
  setPill('');
  for (const s of document.querySelectorAll('[id^=tab-]')) s.hidden = true;
  $('#pageHead').hidden = true;
}
$('#welcomeNew').addEventListener('click', () => openCreate());
$('#welcomeImport').addEventListener('click', () => setTab('import'));
async function switchServer(id) {
  server = id;
  store.set('server', id);
  last = null;
  cwd = '';
  $('#log').dataset.t = '';
  $('#log').textContent = '';
  $('#editor').hidden = true;
  $('#findList').replaceChildren();
  $('#findNote').hidden = true;
  $('#impPlan').hidden = true;
  $('#packList').replaceChildren();
  renderHeader();
  await refreshStatus().catch(() => {});
  setTab(tab);
}
for (const b of ['#srvEntry', '#srvSwitch']) $(b).addEventListener('click', () => { loadServers().catch(() => {}); $('#srvSheet').showModal(); });
$('#srvSheet').addEventListener('click', e => { if (e.target === $('#srvSheet')) $('#srvSheet').close(); });
$('#srvNew').addEventListener('click', () => { $('#srvSheet').close(); openCreate(); });

function setPill(text, cls) {
  const p = $('#pill');
  p.hidden = !text;
  p.textContent = text;
  p.className = 'pill ' + (cls || '');
}

let onlineKey = '';
async function refreshStatus() {
  if (!server) return;
  const s = await api('GET', '/api/status');
  if (s.id !== server) return;
  last = s;
  const g = s.game;
  const active = s.state === 'active';
  const installing = s.install.state === 'running', broken = s.install.state === 'failed';
  let word = 'Stopped', tone = '';
  if (installing) [word, tone] = ['Installing', 'warn'];
  else if (broken) [word, tone] = ['Install failed', 'bad'];
  else if (active) [word, tone] = g ? ['Running', 'ok'] : [s.uptime < 300 ? 'Starting' : 'Not answering', 'warn'];
  else if (s.state === 'activating') [word, tone] = ['Starting', 'warn'];
  else if (s.state === 'deactivating') [word, tone] = ['Stopping', 'warn'];
  else if (s.state === 'failed') [word, tone] = ['Crashed', 'bad'];
  $('#stBig').textContent = word;
  $('#stDot').className = 'dot ' + tone;
  $('#stSub').textContent = `${s.softwareLabel} ${s.mc}` + (active ? ` · up ${fmtDur(s.uptime)}` : '');
  setPill(s.fake ? 'TEST MODE' : '', 'warn');

  $('#installCard').hidden = !(installing || broken);
  $('#installText').textContent = installing ? `Installing ${s.softwareLabel} ${s.mc}: ${s.install.step || 'working'}…` : `The install failed: ${s.install.error || 'unknown error'}.`;
  $('#installRetry').hidden = !broken;
  $('#otherBanner').hidden = !s.other;
  if (s.other) { $('#otherText').textContent = `"${s.other.name}" is running. This computer is set to run ${s.limit === 1 ? 'one server' : s.limit + ' servers'} at a time.`; $('#otherSwitch').dataset.id = s.other.id; }
  const job = s.job;
  $('#jobCard').hidden = !job;
  if (job) $('#jobCard').textContent = job.state === 'running' ? 'Modpack: ' + job.step + '…' : job.state === 'failed' ? 'The modpack download failed: ' + job.error : job.messages.join(' ');
  $('#restartBanner').hidden = !s.restartNeeded;
  $('#restartText').textContent = `${noun()[0].toUpperCase() + noun().slice(1)}s changed since the server started. Restart it to load them.`;

  const mods = document.querySelectorAll('[data-tab=mods]');
  for (const el of mods) { const hide = !s.modsDir || el.dataset.denied === '1'; el.hidden = hide; el.closest('li')?.toggleAttribute('hidden', hide); const l = el.querySelector('.lbl'); if (l) l.textContent = s.modKind === 'plugin' ? 'Plugins' : 'Mods'; }
  if (tab === 'mods') $('#phTitle').textContent = s.modKind === 'plugin' ? 'Plugins' : 'Mods';
  $('#phSub').textContent = s.name;

  const canStart = !active && s.state !== 'activating' && s.state !== 'deactivating';
  const mayPower = can('power');
  $('#btnStart').hidden = !canStart || !mayPower;
  $('#btnStart').disabled = installing || broken || !!s.other || job?.state === 'running';
  $('#btnStop').hidden = !active || !mayPower;
  $('#btnRestart').hidden = !active || !mayPower;
  $('#btnRestart').disabled = installing;

  $('#stPlayers').textContent = g ? `${g.online} of ${g.max}` : '–';
  $('#stNames').textContent = g ? g.names.join(', ') : '';
  $('#stMem').textContent = s.memMB != null ? fmtMB(s.memMB) : '–';
  $('#stHost').textContent = `${fmtMB(s.host.freeMB)} of ${fmtMB(s.host.totalMB)}`;
  $('#stWl').textContent = s.whitelist ? 'On' : 'Off · anyone can join';
  $('#stAcc').textContent = s.onlineMode ? 'Real Minecraft accounts only' : 'Cracked: no bought Minecraft needed';
  $('#dlBackup').href = withServer('/api/backup');
  $('#dlBackup').closest('.drow').hidden = !can('backups');
  renderHeader();

  const key = (g?.names || []).join(',');
  if (tab === 'players' && key !== onlineKey) renderOnline();
  onlineKey = key;
}

async function power(action) {
  const n = last?.game?.online || 0;
  if (action !== 'start' && n > 0 && !(await ask(`${n} player${n > 1 ? 's are' : ' is'} online. ${action === 'stop' ? 'Stop' : 'Restart'} the server anyway?`, action === 'stop' ? 'Stop' : 'Restart'))) return;
  try {
    await api('POST', '/api/power', { action });
    toast(action === 'stop' ? 'Stopping…' : action === 'start' ? 'Starting… the world takes a minute or two to load' : 'Restarting…');
    setTimeout(() => { refreshStatus().catch(() => {}); loadServers().catch(() => {}); }, 1500);
  } catch (e) { toast(e.message, true); }
}
$('#btnStart').addEventListener('click', () => power('start'));
$('#btnStop').addEventListener('click', () => power('stop'));
$('#btnRestart').addEventListener('click', () => power('restart'));
$('#bannerRestart').addEventListener('click', () => power('restart'));
$('#otherSwitch').addEventListener('click', e => { const id = e.currentTarget.dataset.id; if (id) switchServer(id); });
$('#installRetry').addEventListener('click', async () => {
  try { await api('POST', '/api/software', { software: last.software, mc: last.mc }); toast('Trying the install again…'); refreshStatus().catch(() => {}); } catch (e) { toast(e.message, true); }
});

async function refreshGraphs() {
  const { points } = await api('GET', '/api/stats');
  const box = $('#graphs');
  box.replaceChildren();
  if (points.length < 2) { box.append(h('p', { class: 'muted' }, 'The graphs fill in while the panel watches the server (a point every minute).')); return; }
  const W = 300, H = 60, t0 = points[0][0], span = Math.max(1, points[points.length - 1][0] - t0);
  const line = (title, idx, fmt) => {
    const vals = points.map(p => p[idx]).filter(v => v != null);
    const top = Math.max(1, ...vals);
    let d = '', pen = false;
    for (const p of points) {
      if (p[idx] == null) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + (((p[0] - t0) / span) * W).toFixed(1) + ' ' + (H - (p[idx] / top) * (H - 4) - 2).toFixed(1) + ' ';
      pen = true;
    }
    const now = points[points.length - 1][idx];
    return h('div', { class: 'graph' }, h('div', { class: 'row' }, h('strong', {}, title), h('span', { class: 'meta' }, (now == null ? 'not running' : fmt(now) + ' now') + ' · highest ' + fmt(top))),
      svg(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark" aria-hidden="true"><path d="${d || 'M0 0'}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`));
  };
  box.append(line('Memory', 1, fmtMB), line('Players', 2, String));
}

async function refreshJoin() {
  refreshGraphs().catch(() => {});
  const a = await api('GET', '/api/appearance');
  const box = $('#joinList');
  box.replaceChildren();
  if (!a.addresses.length) box.append(h('div', { class: 'drow' }, h('span', { class: 'k' }, 'Join address'), h('span', { class: 'v' }, 'No network address found')));
  if (a.edition === 'bedrock') {
    for (const x of a.addresses) {
      const host = x.host || x.address.replace(/:\d+$/, ''), port = x.port || (/:(\d+)$/.exec(x.address) || [])[1];
      box.append(h('div', { class: 'drow' }, h('span', { class: 'k' }, 'Address'), h('span', { class: 'v' }, h('button', { class: 'copy', type: 'button', onclick: () => copyText(host) }, host, svg(COPY)), h('small', {}, x.label))),
        port ? h('div', { class: 'drow' }, h('span', { class: 'k' }, 'Port'), h('span', { class: 'v' }, h('button', { class: 'copy', type: 'button', onclick: () => copyText(String(port)) }, String(port), svg(COPY)))) : null);
    }
    box.append(h('p', { class: 'muted' }, 'In Minecraft Bedrock: Play, Servers, Add Server. Type the address and the port in their two boxes.'));
    return;
  }
  a.addresses.forEach((x, i) => box.append(h('div', { class: 'drow' }, h('span', { class: 'k' }, i === 0 ? 'Join address' : ''),
    h('span', { class: 'v' }, h('button', { class: 'copy', type: 'button', onclick: () => copyText(x.address) }, x.address, svg(COPY)), h('small', {}, x.label)))));
}

let logFile = '';
const hist = [];
let histAt = 0;

function renderLog(text) {
  const box = $('#log');
  if (box.dataset.t === text) return;
  const keep = box.scrollTop, follow = $('#logFollow').checked;
  const frag = document.createDocumentFragment();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const cls = /\/(ERROR|FATAL)\]|Exception|\bERROR\b/.test(line) ? 'e' : /\/WARN\]|\bWARN\b/.test(line) ? 'w' : '';
    frag.append(h('span', { class: cls }, line + '\n'));
  }
  box.replaceChildren(frag);
  box.dataset.t = text;
  box.scrollTop = follow ? box.scrollHeight : keep;
}
async function refreshLog() {
  const text = logFile ? (await api('GET', '/api/logs/read?name=' + encodeURIComponent(logFile))).text : (await api('GET', '/api/log?n=300')).text;
  renderLog(text);
}
async function refreshLogList() {
  const { logs } = await api('GET', '/api/logs');
  const sel = $('#logSel');
  sel.replaceChildren(h('option', { value: '' }, 'Live console'), ...logs.map(l => h('option', { value: l.name }, `${l.name} · ${fmtSize(l.size)}`)));
  sel.value = logs.some(l => l.name === logFile) ? logFile : '';
  logFile = sel.value;
}
async function refreshConsole() {
  await refreshLogList().catch(() => {});
  await refreshLog();
}
$('#logSel').addEventListener('change', e => { logFile = e.target.value; $('#log').dataset.t = ''; $('#logFollow').checked = !logFile; refreshLog().catch(err => toast(err.message, true)); });
$('#log').addEventListener('scroll', e => { const b = e.currentTarget; $('#logFollow').checked = b.scrollHeight - b.scrollTop - b.clientHeight < 40; });
$('#logShare').addEventListener('click', async () => {
  if (!await ask(`Upload ${logFile || 'the current console log'} to mclo.gs? Anyone with the link can read it. mclo.gs hides IP addresses, but player names stay in it.`, 'Upload')) return;
  try { const { url } = await api('POST', '/api/log/share', logFile ? { name: logFile } : {}); copyText(url); } catch (e) { toast(e.message, true); }
});
async function sendCommand(line) {
  try {
    await api('POST', '/api/command', { line });
    setTimeout(() => { if (!logFile) refreshLog().catch(() => {}); }, 700);
    return true;
  } catch (e) { toast(e.message, true); return false; }
}
$('#cmdForm').addEventListener('submit', async e => {
  e.preventDefault();
  const line = $('#cmd').value.trim();
  if (line && await sendCommand(line)) {
    if (hist[hist.length - 1] !== line) hist.push(line);
    histAt = hist.length;
    $('#cmd').value = '';
  }
});
$('#cmd').addEventListener('keydown', e => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  histAt = Math.max(0, Math.min(hist.length, histAt + (e.key === 'ArrowUp' ? -1 : 1)));
  $('#cmd').value = hist[histAt] || '';
});
for (const b of document.querySelectorAll('[data-cmd]')) b.addEventListener('click', () => sendCommand(b.dataset.cmd));

function emptyRow(text) { return h('li', {}, h('span', { class: 'empty' }, text)); }

function renderOnline() {
  const names = last?.game?.names || [];
  const ul = $('#listOnline');
  ul.replaceChildren();
  if (!names.length) return ul.append(emptyRow(last?.game ? 'Nobody is online.' : 'The server is not running.'));
  for (const name of names) {
    ul.append(h('li', {}, h('span', { class: 'name' }, name),
      small('Make operator', () => playerAction('op', name)),
      small('Kick', () => playerAction('kick', name), 'danger'),
      small('Ban', async () => { if (await ask(`Ban ${name}? They cannot join until you pardon them.`, 'Ban')) playerAction('ban', name); }, 'danger')));
  }
}

let plTab = 'white', plData = null;
const NAME_PATTERN = '\\.?\\w{3,16}';
const PL_FORM = {
  white: { btn: 'Add to whitelist', ph: 'Minecraft name', pattern: NAME_PATTERN },
  ops: { btn: 'Make operator', ph: 'Minecraft name', pattern: NAME_PATTERN, level: true },
  banned: { btn: 'Ban', ph: 'Minecraft name', pattern: NAME_PATTERN, reason: true },
  ips: { btn: 'Ban address', ph: 'IP address, like 203.0.113.7', pattern: '[0-9a-fA-F.:]{3,45}', reason: true },
};

async function refreshPlayers() {
  plData = await api('GET', '/api/players');
  $('#wlToggle').checked = plData.whitelistOn;
  $('#crackedToggle').checked = !plData.onlineMode;
  const be = plData.edition === 'bedrock';
  $('#crackedRow').hidden = be || !can('options');
  for (const b of document.querySelectorAll('#plTabs button')) b.hidden = be && b.dataset.pl !== 'white';
  if (be) plTab = 'white';
  document.querySelector('#plTabs [data-pl=white]').textContent = be ? 'Allow list' : 'Whitelist';
  $('#wlToggle').closest('label').lastElementChild.textContent = be ? 'Allow list' : 'Whitelist';
  $('#plNote').textContent = be ? (plData.running ? 'The server is running: changes go through its console and apply at once. Type the player\'s Xbox gamertag.' : 'The server is stopped: the allow list is saved in its files and applies at the next start. Operators can only be made while it runs (use the Console: op "Name").')
    : plData.running
    ? 'The server is running: changes go through its console and apply at once.'
    : 'The server is stopped: changes are saved in its files and apply at the next start.' + (plData.onlineMode ? ' Names are checked with Mojang, so this computer needs internet.' : '');
  renderOnline();
  renderPl();
}
function renderPl() {
  const f = PL_FORM[plTab], p = plData;
  for (const b of document.querySelectorAll('#plTabs button')) b.classList.toggle('on', b.dataset.pl === plTab);
  $('#plName').placeholder = f.ph;
  $('#plName').pattern = p?.edition === 'bedrock' ? '[A-Za-z0-9_ ]{1,15}' : f.pattern;
  $('#plLevel').hidden = !f.level;
  $('#plReason').hidden = !f.reason;
  $('#plAddBtn').textContent = f.btn;
  const ul = $('#plList');
  ul.replaceChildren();
  if (!p) return;
  const ops = new Set(p.ops.map(o => o.name.toLowerCase()));
  if (plTab === 'white') {
    if (!p.whitelist.length) ul.append(emptyRow(p.whitelistOn ? 'Nobody is whitelisted yet.' : 'The list is empty (and the whitelist is off).'));
    for (const name of p.whitelist) {
      ul.append(h('li', {}, h('span', { class: 'name' }, name),
        ops.has(name.toLowerCase()) ? h('span', { class: 'meta' }, 'operator') : small('Make operator', () => playerAction('op', name)),
        small('Remove', () => playerAction('whitelist-remove', name), 'danger')));
    }
  } else if (plTab === 'ops') {
    if (!p.ops.length) ul.append(emptyRow('No operators.'));
    for (const o of p.ops) ul.append(h('li', {}, h('span', { class: 'name' }, o.name), h('span', { class: 'meta' }, 'level ' + o.level), small('Remove operator', () => playerAction('deop', o.name), 'danger')));
  } else if (plTab === 'banned') {
    if (!p.banned.length) ul.append(emptyRow('Nobody is banned.'));
    for (const b of p.banned) ul.append(h('li', {}, h('span', { class: 'name' }, b.name, b.reason ? h('span', { class: 'meta block' }, b.reason) : null), small('Pardon', () => playerAction('pardon', b.name))));
  } else {
    if (!p.bannedIps.length) ul.append(emptyRow('No banned addresses.'));
    for (const b of p.bannedIps) ul.append(h('li', {}, h('span', { class: 'name' }, b.ip, b.reason ? h('span', { class: 'meta block' }, b.reason) : null), small('Pardon', () => playerAction('pardon-ip', '', { ip: b.ip }))));
  }
}
for (const b of document.querySelectorAll('#plTabs button')) b.addEventListener('click', () => { plTab = b.dataset.pl; $('#plName').value = ''; renderPl(); });
$('#plAddForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#plName').value.trim(), reason = $('#plReason').value.trim(), level = Number($('#plLevel').value);
  const body = plTab === 'white' ? { action: 'whitelist-add', name: v } : plTab === 'ops' ? { action: 'op', name: v, level } : plTab === 'banned' ? { action: 'ban', name: v, reason } : { action: 'ban-ip', ip: v, reason };
  if (await playerAction(body.action, body.name, body)) { $('#plName').value = ''; $('#plReason').value = ''; }
});

async function playerAction(action, name, extra = {}) {
  try {
    await api('POST', '/api/player', { ...extra, action, name });
    toast('Done: ' + action.replace('-', ' ') + ' ' + (name || extra.ip || ''));
    setTimeout(() => refreshPlayers().catch(() => {}), plData?.running ? 900 : 0);
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

$('#crackedToggle').addEventListener('change', async e => {
  const on = e.target.checked;
  if (on && !await ask('Turn on cracked mode? Players without a bought Minecraft can join, but anyone can join under any name, even as an operator, so keep the whitelist on. The server must be stopped.', 'Turn on')) { e.target.checked = false; return; }
  try {
    toast((await api('POST', '/api/cracked', { on })).message);
    refreshPlayers().catch(() => {});
    refreshStatus().catch(() => {});
  } catch (err) { e.target.checked = !on; toast(err.message, true); }
});
$('#wlToggle').addEventListener('change', async e => {
  const on = e.target.checked;
  try {
    await api('POST', '/api/whitelist', { on });
    toast(on ? 'Whitelist on: only listed names can join' : 'Whitelist off: anyone with the address can join');
    refreshStatus().catch(() => {});
  } catch (err) { e.target.checked = !on; toast(err.message, true); }
});

async function refreshRules() {
  const d = await api('GET', '/api/gamerules');
  $('#grNote').textContent = d.rules.length
    ? (d.running ? `World "${d.world}". A change applies at once.` : 'The server is stopped. Start it to change rules (they are changed through its console).')
    : 'No rules found yet: start the server once so the world exists. You can always use the console: /gamerule.';
  const ul = $('#grList');
  ul.replaceChildren();
  for (const r of d.rules) {
    const off = !d.running || r.type === 'text';
    const control = r.type === 'bool' ? h('input', { type: 'checkbox', checked: r.value === 'true', disabled: off, onchange: ev => setRule(r.name, String(ev.target.checked)) })
      : h('input', { type: r.type === 'int' ? 'number' : 'text', value: r.value, disabled: off, class: 'auto', onchange: ev => setRule(r.name, ev.target.value) });
    ul.append(h('li', {}, h('span', { class: 'name' }, r.name), control));
  }
}
async function setRule(name, value) {
  try { await api('POST', '/api/gamerule', { name, value }); toast(`${name} = ${value}`); } catch (e) { toast(e.message, true); refreshRules().catch(() => {}); }
}
async function refreshMap() {
  const d = await api('GET', '/api/map');
  $('#mapCard').hidden = !d.supported;
  $('#mapNote').textContent = !d.installed ? 'Draws your world as a map you can browse in the browser (BlueMap, from Modrinth).'
    : d.accepted ? 'BlueMap is installed. After a restart it draws the map; the first drawing takes a while.' : 'BlueMap is installed. Start the server once so it writes its settings, then press "Accept and turn on" (it may download the Minecraft files it needs).';
  $('#mapInstall').hidden = d.installed;
  $('#mapEnable').hidden = !d.installed || d.accepted;
  const links = $('#mapLinks');
  links.replaceChildren();
  if (d.installed && d.accepted) {
    for (const x of (await api('GET', '/api/appearance')).addresses.filter(x => !x.label.startsWith('From anywhere'))) {
      const url = 'http://' + x.address.replace(/:\d+$/, '') + ':' + d.port;
      links.append(h('p', {}, h('a', { class: 'link', href: url, target: '_blank', rel: 'noopener noreferrer' }, url), ' ', h('span', { class: 'meta' }, x.label)));
    }
  }
}
$('#mapInstall').addEventListener('click', async e => {
  e.currentTarget.disabled = true;
  toast('Installing BlueMap…');
  try { const r = await api('POST', '/api/map/install'); toast('Installed: ' + r.done.map(d => d.name).join(', ')); } catch (err) { toast(err.message, true); }
  e.currentTarget.disabled = false;
  refreshMap().catch(() => {});
});
$('#mapEnable').addEventListener('click', async () => {
  try { toast((await api('POST', '/api/map/enable')).message); } catch (err) { toast(err.message, true); }
  refreshMap().catch(() => {});
});

async function refreshWorlds() {
  const be = last?.edition === 'bedrock';
  $('#grCard').hidden = $('#dpCard').hidden = be;
  for (const el of [document.querySelector('label[for=wnType]'), $('#wnType'), $('#wnStruct').closest('label')]) el.hidden = be;
  $('#wlZip').accept = be ? '.mcworld,.zip' : '.zip';
  $('#wlAddNote').textContent = be ? 'Upload a .mcworld file or a .zip with a Bedrock world in it, for example one you exported from the game or downloaded from the Worlds page on Aternos.'
    : 'Upload a .zip with a world in it, for example the one you download from the Worlds page on Aternos. The world is found inside the zip; other files in it are left out.';
  if (be) $('#mapCard').hidden = $('#pgCard').hidden = true;
  else { refreshRules().catch(() => {}); refreshMap().catch(() => {}); refreshPregen().catch(() => {}); }
  const d = await api('GET', '/api/worlds');
  const ul = $('#listWorlds');
  ul.replaceChildren();
  for (const w of d.worlds) {
    const use = small('Use this world', async () => {
      try { toast((await api('POST', '/api/worlds/use', { name: w.name })).message); } catch (e) { toast(e.message, true); }
      refreshWorlds().catch(() => {});
    });
    use.disabled = d.running;
    ul.append(h('li', {},
      h('span', { class: 'name' }, h('strong', {}, w.name), ' ', w.active ? h('span', { class: 'tag ok' }, 'in use') : null, w.dimension ? h('span', { class: 'tag' }, 'Nether or End folder') : null, w.kept ? h('span', { class: 'tag' }, 'kept as a backup') : null,
        h('span', { class: 'meta block' }, w.missing ? 'Not made yet: it is created when the server starts.' : [w.version && 'Minecraft ' + w.version, fmtSize(w.size), w.lastPlayed && 'played ' + fmtDate(w.lastPlayed)].filter(Boolean).join(' · '))),
      w.missing || w.active ? null : use,
      w.missing ? null : h('a', { class: 'btn small', href: withServer('/api/worlds/download?name=' + encodeURIComponent(w.name)), download: w.name + (be ? '.mcworld' : '.zip') }, 'Download'),
      w.missing || w.active ? null : small('Delete', async () => {
        if (!await ask(`Delete the world folder "${w.name}" for good?`, 'Delete')) return;
        try { await api('POST', '/api/worlds/delete', { name: w.name }); toast('Deleted ' + w.name); } catch (e) { toast(e.message, true); }
        refreshWorlds().catch(() => {});
      }, 'danger')));
  }
  if (!be) await refreshDatapacks();
}
$('#wlZip').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const prog = $('#wlProg');
  prog.hidden = false;
  prog.value = 0;
  try {
    const r = await upload('/api/worlds/upload?use=' + ($('#wlUse').checked ? 1 : 0), f, v => { prog.value = v; });
    toast(`Added "${r.name}"` + (r.used ? ' and switched to it' : ''));
  } catch (err) { toast(err.message, true); }
  prog.hidden = true;
  e.target.value = '';
  refreshWorlds().catch(() => {});
});
$('#wlNewForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    toast((await api('POST', '/api/worlds/new', { name: $('#wnName').value, seed: $('#wnSeed').value, type: $('#wnType').value, structures: $('#wnStruct').checked })).message);
    refreshWorlds().catch(() => {});
  } catch (err) { toast(err.message, true); }
});

async function refreshDatapacks() {
  const d = await api('GET', '/api/datapacks');
  $('#dpNow').textContent = `In the world "${d.world}".`;
  const ul = $('#dpList');
  ul.replaceChildren();
  if (!d.packs.length) ul.append(emptyRow('No data packs.'));
  for (const p of d.packs) {
    ul.append(h('li', {}, h('span', { class: 'name' }, p.name), h('span', { class: 'meta' }, fmtSize(p.size)),
      small('Delete', async () => {
        if (!await ask(`Delete ${p.name}?`, 'Delete')) return;
        try { await api('DELETE', '/api/datapacks?name=' + encodeURIComponent(p.name)); } catch (e) { toast(e.message, true); }
        refreshDatapacks().catch(() => {});
      }, 'danger')));
  }
}
$('#dpFile').addEventListener('change', async e => {
  for (const f of e.target.files) {
    try { await upload('/api/datapacks?name=' + encodeURIComponent(f.name), f, () => {}); toast('Added ' + f.name); } catch (err) { toast(f.name + ': ' + err.message, true); }
  }
  e.target.value = '';
  refreshDatapacks().catch(() => {});
});
$('#dpFindForm').addEventListener('submit', async e => {
  e.preventDefault();
  const list = $('#dpResults');
  list.replaceChildren(emptyRow('Searching…'));
  try {
    const { results } = await api('GET', '/api/datapacks/find?q=' + encodeURIComponent($('#dpQ').value.trim()));
    list.replaceChildren();
    if (!results.length) list.append(emptyRow(`No data packs for Minecraft ${last?.mc} found.`));
    for (const r of results) {
      list.append(resultRow(r, h('button', { class: 'small primary', type: 'button', onclick: async ev => {
        const b = ev.currentTarget;
        b.disabled = true;
        try { const out = await api('POST', '/api/datapacks/install', { id: r.id }); toast('Added ' + out.name + '. It loads with the world (or /reload).'); refreshDatapacks().catch(() => {}); } catch (err) { toast(err.message, true); }
        b.disabled = false;
      } }, 'Add')));
    }
  } catch (err) { list.replaceChildren(); toast(err.message, true); }
});

const ago = ms => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'; };
let accData = null, invitePicker = null, addPicker = null;
const permName = k => (accData?.perms[k] || k).split(/[:(]/)[0].trim();
const summary = perms => perms.length ? perms.map(permName).join(', ') : 'looking only';
const presetOf = (d, perms) => Object.values(d.presets).find(p => p.perms.length === perms.length && p.perms.every(x => perms.includes(x)))?.label || 'Custom';

function permPicker(presetSel, grid, d, initial) {
  const mine = new Set(d.me.perms);
  const boxes = {};
  grid.replaceChildren(...Object.entries(d.perms).map(([k, label]) => {
    boxes[k] = h('input', { type: 'checkbox', checked: initial.includes(k) && mine.has(k), disabled: !mine.has(k) });
    return h('label', { class: 'check' }, boxes[k], h('span', {}, label));
  }));
  const get = () => Object.keys(boxes).filter(k => boxes[k].checked);
  presetSel.replaceChildren(...Object.entries(d.presets).map(([k, p]) => h('option', { value: k }, p.label)), h('option', { value: 'custom' }, 'Custom'));
  const match = () => Object.entries(d.presets).find(([, p]) => p.perms.length === get().length && p.perms.every(x => get().includes(x)))?.[0] || 'custom';
  presetSel.value = match();
  presetSel.onchange = () => {
    if (presetSel.value === 'custom') return;
    const want = d.presets[presetSel.value].perms;
    for (const [k, b] of Object.entries(boxes)) b.checked = want.includes(k) && !b.disabled;
  };
  grid.onchange = () => { presetSel.value = match(); };
  return { get };
}

function askPerms(d, title, okLabel, person) {
  const dlg = $('#permDlg');
  $('#permTitle').textContent = title;
  $('#permOk').textContent = okLabel;
  const picker = permPicker($('#permPreset'), $('#permGrid'), d, person.perms);
  const all = $('#permAll'), box = $('#permServers');
  all.checked = person.servers === 'all';
  box.replaceChildren(...servers.map(s => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: s.id, checked: Array.isArray(person.servers) && person.servers.includes(s.id) }), h('span', {}, s.name))));
  all.onchange = () => { box.hidden = all.checked; };
  box.hidden = all.checked;
  dlg.returnValue = '';
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'
      ? { perms: picker.get(), servers: all.checked ? 'all' : [...box.querySelectorAll('input:checked')].map(i => i.value) } : null), { once: true });
    dlg.showModal();
  });
}

async function accessAct(url, body) {
  try { await api('POST', url, body); } catch (e) { toast(e.message, true); }
  refreshAccess().catch(() => {});
  refreshMe().catch(() => {});
}

async function refreshAccess(full = false) {
  const d = accData = await api('GET', '/api/access');
  me = { ...me, ...d.me };
  applyAccess();
  $('#acMe').textContent = `${d.me.name} · ${d.me.owner ? 'the owner, who can do everything' : 'may do: ' + summary(d.me.perms)}`;
  $('#acLeave').hidden = d.me.owner;
  $('#acReqCard').hidden = !d.requests.length;
  $('#acReqs').replaceChildren(...d.requests.map(p => h('li', {},
    h('span', { class: 'name' }, h('strong', {}, p.name), h('span', { class: 'meta block' }, `asked ${ago(p.created)} · from ${p.ip}` + (p.suggest ? ' · you added this name: ' + summary(p.suggest.perms) : ''))),
    small('Let in…', async () => {
      const r = await askPerms(d, `Let ${p.name} in`, 'Let in', p.suggest || { perms: d.presets.helper.perms, servers: 'all' });
      if (r) accessAct('/api/access/approve', { id: p.id, ...r });
    }, 'primary'),
    small('Deny', () => accessAct('/api/access/remove', { id: p.id }), 'danger'))));
  $('#acPeople').replaceChildren(...d.people.map(p => {
    const only = p.servers === 'all' ? '' : ' · only ' + p.servers.map(id => servers.find(s => s.id === id)?.name || id).join(', ');
    const mine = p.id === d.me.id;
    return h('li', {},
      h('span', { class: 'name' }, h('strong', {}, p.name), mine ? ' (you)' : '', ' ', h('span', { class: 'tag' + (p.owner ? ' ok' : '') }, p.owner ? 'owner' : presetOf(d, p.perms)),
        h('span', { class: 'meta block' }, (p.owner ? 'everything' : summary(p.perms)) + only + ' · last seen ' + ago(p.seen))),
      p.owner || mine ? null : small('Change…', async () => {
        const r = await askPerms(d, `What may ${p.name} do?`, 'Save', p);
        if (r) accessAct('/api/access/update', { id: p.id, ...r });
      }),
      (p.owner && !p.viaPassword) || mine ? null : small('Remove', async () => {
        if (await ask(`Take ${p.name}'s access away? Their device is locked out at once.`, 'Remove')) accessAct('/api/access/remove', { id: p.id });
      }, 'danger'));
  }));
  $('#acInvites').replaceChildren(...d.invites.map(i => h('li', {},
    h('span', { class: 'name' }, 'Invite for ' + i.name, h('span', { class: 'meta block' }, `${summary(i.perms)} · open until ${fmtDate(i.expires)}`)),
    small('Cancel', () => accessAct('/api/access/revoke', { id: i.id }), 'danger'))));
  $('#acExpected').replaceChildren(...d.expected.map(e => h('li', {},
    h('span', { class: 'name' }, 'Waiting for ' + e.name, h('span', { class: 'meta block' }, `${summary(e.perms)} · until ${fmtDate(e.expires)}`)),
    small('New link', async () => {
      try { const r = await api('POST', '/api/access/relink', { id: e.id }); copyText(location.origin + '/#as=' + encodeURIComponent(r.name) + '&k=' + r.key + nameParam()); } catch (err) { toast(err.message, true); }
    }),
    small('Remove', () => accessAct('/api/access/forget', { id: e.id }), 'danger'))));
  refreshActivity().catch(() => {});
  $('#alertCard').hidden = $('#doctorCard').hidden = !d.me.owner;
  refreshPasswords(d, full);
  if (d.me.owner && full) refreshAlerts().catch(() => {});
  if (full || !invitePicker) invitePicker = permPicker($('#acInvPreset'), $('#acInvPerms'), d, d.presets.helper.perms);
  if (full || !addPicker) addPicker = permPicker($('#acAddPreset'), $('#acAddPerms'), d, d.presets.helper.perms);
}
let pwPicker = null;
function refreshPasswords(d, full) {
  $('#pwCard').hidden = !d.me.owner;
  if (!d.me.owner) return;
  const p = d.passwords;
  $('#pwOwnerLbl').textContent = p.owner ? 'Change the owner password' : 'Owner password';
  $('#pwOwnerSave').textContent = p.owner ? 'Change it' : 'Set the owner password';
  $('#pwOwnerClear').hidden = !p.owner;
  $('#pwGuestSave').textContent = p.guest ? 'Save' : 'Set the friends password';
  $('#pwGuestClear').hidden = !p.guest;
  $('#pwGuest').placeholder = p.guest ? 'Leave empty to keep it and change only what it allows' : '8 or more characters, different from the owner\'s';
  if (full || !pwPicker) pwPicker = permPicker($('#pwGuestPreset'), $('#pwGuestPerms'), d, p.guest ? p.guest.perms : d.presets.helper.perms);
}
$('#pwOwnerForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('POST', '/api/access/password', { kind: 'owner', password: $('#pwOwner').value });
    $('#pwOwner').value = '';
    toast('The owner password is saved. Type it on any new device.');
    refreshAccess(true).catch(() => {});
  } catch (err) { toast(err.message, true); }
});
$('#pwOwnerClear').addEventListener('click', async () => {
  if (!await ask('Remove the owner password? Devices that are already in stay in. Nobody can sign in with it any more.', 'Remove it')) return;
  try { await api('POST', '/api/access/password/clear', { kind: 'owner' }); refreshAccess(true).catch(() => {}); } catch (err) { toast(err.message, true); }
});
$('#pwGuestForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('#pwGuest').value;
  try {
    if (pw) await api('POST', '/api/access/password', { kind: 'guest', password: pw, perms: pwPicker.get() });
    else await api('POST', '/api/access/password/friends', { perms: pwPicker.get() });
    $('#pwGuest').value = '';
    toast('Saved');
    refreshAccess(true).catch(() => {});
  } catch (err) { toast(err.message, true); }
});
$('#pwGuestClear').addEventListener('click', async () => {
  if (!await ask('Remove the friends password? Friends who are already in stay in until you remove them above.', 'Remove it')) return;
  try { await api('POST', '/api/access/password/clear', { kind: 'guest' }); refreshAccess(true).catch(() => {}); } catch (err) { toast(err.message, true); }
});
$('#acAddForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const name = $('#acAddName').value.trim();
    const r = await api('POST', '/api/access/add', { name, perms: addPicker.get(), servers: 'all', days: Number($('#acAddDays').value) });
    $('#acAddName').value = '';
    const link = location.origin + '/#as=' + encodeURIComponent(name) + '&k=' + r.key + nameParam();
    const out = $('#acAddOut');
    out.hidden = false;
    out.replaceChildren(h('p', {}, r.joined ? name + ' was already waiting at the door and is in now.' : `${name} is added. Send them this link: it fills their name in and lets them straight in. (If they just type the name instead, they wait and you say yes with one tap.)`),
      ...(r.joined ? [] : [h('div', { class: 'row' }, small('Copy the link', () => copyText(link), 'primary')), h('p', { class: 'muted' }, link)]));
    refreshAccess().catch(() => {});
  } catch (err) { toast(err.message, true); }
});
let docText = '';
$('#docRun').addEventListener('click', async e => {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = 'Checking…';
  try {
    const d = await api('GET', '/api/doctor');
    docText = d.text;
    $('#docList').replaceChildren(...d.checks.map(c => h('li', {}, h('span', { class: 'name' }, h('strong', {}, (c.ok ? '✓ ' : '✗ ') + c.name), h('span', { class: 'meta block' }, c.detail)))));
    $('#docCopy').hidden = false;
  } catch (err) { toast(err.message, true); }
  b.disabled = false;
  b.textContent = 'Run the check again';
});
$('#docCopy').addEventListener('click', () => copyText(docText));
async function refreshActivity() {
  const { items } = await api('GET', '/api/activity');
  $('#actList').replaceChildren(...(items.length ? items.slice(0, 80).map(x => h('li', {},
    h('span', { class: 'name' }, h('strong', {}, x.who), ' ' + x.what, x.server ? h('span', { class: 'meta' }, ' · ' + x.server) : null), h('span', { class: 'meta' }, ago(x.t)))) : [emptyRow('Nothing yet.')]));
}
let alertBoxes = null;
async function refreshAlerts() {
  const d = await api('GET', '/api/alerts');
  $('#alNtfy').value = d.ntfy;
  $('#alDiscord').value = '';
  $('#alDiscord').placeholder = d.discord ? '(saved: paste a new one to replace it)' : 'https://discord.com/api/webhooks/...';
  $('#alClear').hidden = !d.discord;
  alertBoxes = {};
  $('#alEvents').replaceChildren(...Object.entries(d.labels).map(([k, label]) => {
    alertBoxes[k] = h('input', { type: 'checkbox', checked: d.events[k] });
    return h('label', { class: 'check' }, alertBoxes[k], h('span', {}, label));
  }));
}
$('#alForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = { ntfy: $('#alNtfy').value.trim(), events: Object.fromEntries(Object.entries(alertBoxes || {}).map(([k, el]) => [k, el.checked])) };
  if ($('#alDiscord').value.trim()) body.discord = $('#alDiscord').value.trim();
  try { await api('PUT', '/api/alerts', body); toast('Saved'); refreshAlerts().catch(() => {}); } catch (err) { toast(err.message, true); }
});
$('#alTest').addEventListener('click', async () => { try { await api('POST', '/api/alerts/test'); toast('Test message sent (if anything is set up)'); } catch (err) { toast(err.message, true); } });
$('#alClear').addEventListener('click', async () => { try { await api('PUT', '/api/alerts', { clearDiscord: true }); refreshAlerts().catch(() => {}); } catch (err) { toast(err.message, true); } });
$('#acInviteForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const name = $('#acInvName').value.trim() || 'Friend';
    const r = await api('POST', '/api/access/invite', { name, perms: invitePicker.get(), servers: 'all', hours: Number($('#acInvHours').value) });
    const link = location.origin + '/#join=' + r.code + nameParam();
    $('#acInviteOut').hidden = false;
    $('#acInviteOut').replaceChildren(h('p', {}, 'Send this to ', h('strong', {}, name), '. It works once, for one device.'), h('p', {}, h('code', {}, r.code)),
      h('div', { class: 'row' }, small('Copy the link', () => copyText(link), 'primary'), small('Copy the code', () => copyText(r.code))), h('p', { class: 'muted' }, link));
    refreshAccess().catch(() => {});
  } catch (err) { toast(err.message, true); }
});
$('#acLeave').addEventListener('click', async () => {
  if (!await ask('Sign this device out? To get back in you have to ask the owner again.', 'Sign out')) return;
  try { await api('POST', '/api/access/leave'); } catch { }
  me = null;
  boot();
});

async function refreshMods() {
  const n = noun(), N = n[0].toUpperCase() + n.slice(1);
  $('#findTitle').textContent = `Find ${n}s`;
  $('#addTitle').textContent = `Add ${n}s`;
  $('#findDesc').textContent = `Searches for ${last?.softwareLabel || ''} ${n}s that work with Minecraft ${last?.mc || ''}. Installing also adds what they need, and replaces an older copy of the same ${n}.`;
  const cf = document.querySelector('#findSrc option[value=curseforge]');
  cf.disabled = cf.hidden = n === 'plugin';
  if (cf.disabled && $('#findSrc').value === 'curseforge') $('#findSrc').value = 'modrinth';
  const { mods } = await api('GET', '/api/mods');
  const ul = $('#listMods');
  ul.replaceChildren();
  if (!mods.length) ul.append(emptyRow(`No ${n}s yet.`));
  for (const m of mods) {
    ul.append(h('li', {},
      h('label', { class: 'switch', title: m.enabled ? 'Turn off' : 'Turn on' },
        h('input', { type: 'checkbox', checked: m.enabled, onchange: () => toggleMod(m.name) }),
        h('span', { class: 'track' }),
        h('span', { class: 'sr' }, m.name + ' enabled')),
      h('span', { class: 'name' }, m.name),
      h('span', { class: 'meta' }, fmtSize(m.size) + (m.enabled ? '' : ' · off')),
      small('Delete', async () => {
        if (!await ask(`Delete ${m.name}?`, 'Delete')) return;
        try { await api('DELETE', '/api/mods?name=' + encodeURIComponent(m.name)); toast('Deleted ' + m.name); } catch (e) { toast(e.message, true); }
        refreshMods().catch(() => {});
      }, 'danger')));
  }
  return N;
}
async function toggleMod(name) {
  try { await api('POST', '/api/mods/toggle', { name }); } catch (e) { toast(e.message, true); }
  refreshMods().catch(() => {});
}
$('#modFile').addEventListener('change', async e => {
  const prog = $('#modProg');
  for (const f of e.target.files) {
    if (!/\.jar$/i.test(f.name)) { toast(f.name + ' is not a .jar file', true); continue; }
    prog.hidden = false;
    prog.value = 0;
    try { await upload('/api/mods?name=' + encodeURIComponent(f.name), f, v => { prog.value = v; }); toast('Added ' + f.name); }
    catch (err) { toast(f.name + ': ' + err.message, true); }
  }
  prog.hidden = true;
  e.target.value = '';
  refreshMods().catch(() => {});
  refreshStatus().catch(() => {});
});

function renderUpdates(list) {
  $('#updAll').hidden = !list.length;
  const ul = $('#updList');
  ul.replaceChildren();
  if (!list.length) ul.append(emptyRow('Everything Modrinth knows about is up to date.'));
  for (const u of list) {
    ul.append(h('li', {}, h('span', { class: 'name' }, u.file, h('span', { class: 'meta block' }, '→ ' + u.to + (u.version ? ' (' + u.version + ')' : ''))), small('Update', () => runUpdate([u.file]), 'primary')));
  }
}
async function runUpdate(names) {
  toast('Updating…');
  try {
    const r = await api('POST', '/api/mods/update', names ? { names } : {});
    toast(r.done.length ? 'Updated: ' + r.done.map(d => d.name).join(', ') + '. Restart the server to load them.' : r.warnings[0] || 'Nothing to update');
    refreshMods().catch(() => {});
    refreshStatus().catch(() => {});
    $('#updCheck').click();
  } catch (e) { toast(e.message, true); }
}
$('#updCheck').addEventListener('click', async e => {
  const b = e.currentTarget;
  b.disabled = true;
  try { renderUpdates((await api('GET', '/api/mods/updates')).updates); } catch (err) { toast(err.message, true); }
  b.disabled = false;
});
$('#updAll').addEventListener('click', () => runUpdate(null));

const countFmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0);

function findNote(text) {
  const n = $('#findNote');
  n.hidden = !text;
  n.textContent = text || '';
}

async function installFromSite(src, id, button) {
  if (button) button.disabled = true;
  findNote('Installing… this can take a moment.');
  try {
    const r = await api('POST', '/api/find/install', { src, id });
    findNote(r.done.map(d => `${d.name}: ${d.status}`).join(' · ') + '.' + (r.warnings.length ? ' ' + r.warnings.join(' ') : '') + ' Restart the server to load it.');
    const news = r.done.filter(d => d.status !== 'already installed').map(d => d.name);
    toast(news.length ? 'Installed: ' + news.join(', ') : 'Everything was already installed');
    refreshMods().catch(() => {});
    refreshStatus().catch(() => {});
  } catch (e) { findNote(''); toast(e.message, true); }
  if (button) button.disabled = false;
}

function resultRow(r, button) {
  return h('li', {},
    h('span', { class: 'name' }, h('strong', {}, r.title), ' ', h('span', { class: 'meta' }, `${r.author} · ${countFmt(r.downloads)} downloads`),
      h('span', { class: 'muted block' }, r.description || ''),
      r.note ? h('span', { class: 'meta block' }, 'Note: ' + r.note) : null),
    button);
}

$('#findForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#findQ').value.trim();
  let src = $('#findSrc').value;
  const list = $('#findList');
  if (/^https?:\/\//i.test(q)) {
    src = /curseforge\.com/i.test(q) ? 'curseforge' : /modrinth\.com/i.test(q) ? 'modrinth' : '';
    if (!src) return toast('Paste a link from modrinth.com or curseforge.com', true);
    return installFromSite(src, q);
  }
  list.replaceChildren();
  if (src === 'curseforge' && !sources.curseforge) {
    return findNote('CurseForge needs your own free API key (console.curseforge.com). Run the panel installer again and add it (see the README).');
  }
  findNote('Searching…');
  try {
    const { results } = await api('GET', `/api/find?src=${src}&q=${encodeURIComponent(q)}`);
    findNote(results.length ? '' : `Nothing found for ${last?.softwareLabel} on Minecraft ${last?.mc}.`);
    for (const r of results) list.append(resultRow(r, h('button', { class: 'small primary', type: 'button', onclick: ev => installFromSite(src, r.id, ev.currentTarget) }, 'Add')));
  } catch (err) { findNote(''); toast(err.message, true); }
});

let cwd = '';

async function refreshFiles(dir = cwd) {
  const r = await api('GET', '/api/files?path=' + encodeURIComponent(dir));
  cwd = r.path;
  const crumbs = $('#crumbs');
  crumbs.replaceChildren(h('button', { type: 'button', onclick: () => refreshFiles('').catch(err => toast(err.message, true)) }, 'server'));
  let acc = '';
  for (const part of cwd ? cwd.split('/') : []) {
    acc = join(acc, part);
    const target = acc;
    crumbs.append(h('span', {}, '/'), h('button', { type: 'button', onclick: () => refreshFiles(target).catch(err => toast(err.message, true)) }, part));
  }
  const ul = $('#listFiles');
  ul.replaceChildren();
  if (!r.entries.length) ul.append(emptyRow('This folder is empty.'));
  for (const f of r.entries) {
    const p = join(cwd, f.name);
    ul.append(h('li', { class: f.dir ? 'dir' : '' },
      h('span', { class: 'name' }, f.dir
        ? h('button', { type: 'button', onclick: () => refreshFiles(p).catch(err => toast(err.message, true)) }, f.name + '/')
        : f.name),
      h('span', { class: 'meta' }, (f.dir ? '' : fmtSize(f.size) + ' · ') + fmtDate(f.mtime)),
      f.dir ? null : small('Edit', () => openEditor(p)),
      f.dir ? null : h('a', { class: 'btn small', href: withServer('/api/download?path=' + encodeURIComponent(p)), download: f.name }, 'Download'),
      small('Delete', async () => {
        if (!await ask(`Delete ${p}${f.dir ? ' and everything in it' : ''}? This cannot be undone.`, 'Delete')) return;
        try { await api('DELETE', '/api/file?path=' + encodeURIComponent(p)); toast('Deleted ' + f.name); } catch (e) { toast(e.message, true); }
        refreshFiles().catch(() => {});
      }, 'danger')));
  }
}

let editing = '';
async function openEditor(p) {
  try {
    const r = await api('GET', '/api/file?path=' + encodeURIComponent(p));
    editing = r.path;
    $('#editName').textContent = r.path;
    $('#editText').value = r.text;
    $('#editor').hidden = false;
    $('#editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast(e.message, true); }
}
$('#editClose').addEventListener('click', () => { $('#editor').hidden = true; editing = ''; });
$('#editSave').addEventListener('click', async () => {
  try {
    const r = await fetch(withServer('/api/file?path=' + encodeURIComponent(editing)), { method: 'PUT', headers: { 'X-Panel': '1' }, body: $('#editText').value });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'could not save');
    toast('Saved ' + editing);
    refreshFiles().catch(() => {});
  } catch (e) { toast(e.message, true); }
});
$('#btnMkdir').addEventListener('click', async () => {
  const name = await ask('Name of the new folder', 'Create', true);
  if (!name) return;
  try { await api('POST', '/api/mkdir', { path: join(cwd, name) }); } catch (e) { toast(e.message, true); }
  refreshFiles().catch(() => {});
});
$('#upFile').addEventListener('change', async e => {
  const prog = $('#upProg');
  for (const f of e.target.files) {
    prog.hidden = false;
    prog.value = 0;
    try { await upload('/api/file?path=' + encodeURIComponent(join(cwd, f.name)), f, v => { prog.value = v; }); toast('Uploaded ' + f.name); }
    catch (err) { toast(f.name + ': ' + err.message, true); }
  }
  prog.hidden = true;
  e.target.value = '';
  refreshFiles().catch(() => {});
});

async function refreshBackups() {
  const { backups, keep } = await api('GET', '/api/backups');
  const ul = $('#listBackups');
  ul.replaceChildren();
  if (!backups.length) ul.append(emptyRow('No backups yet.'));
  for (const b of backups) {
    ul.append(h('li', {},
      h('span', { class: 'name' }, b.name),
      h('span', { class: 'meta' }, `${fmtSize(b.size)} · ${fmtDate(b.mtime)}`),
      small('Restore', async () => {
        if (!await ask(`Restore ${b.name}? Your current world is kept in a folder next to it. The server must be stopped.`, 'Restore')) return;
        try { toast((await api('POST', '/api/backups/restore', { name: b.name })).message); } catch (e) { toast(e.message, true); }
        refreshBackups().catch(() => {});
      }),
      h('a', { class: 'btn small', href: withServer('/api/backups/download?name=' + encodeURIComponent(b.name)), download: b.name }, 'Download'),
      small('Delete', async () => {
        if (!await ask(`Delete ${b.name}?`, 'Delete')) return;
        try { await api('DELETE', '/api/backups?name=' + encodeURIComponent(b.name)); } catch (e) { toast(e.message, true); }
        refreshBackups().catch(() => {});
      }, 'danger')));
  }
  if (backups.length) ul.append(h('li', {}, h('span', { class: 'muted' }, `The newest ${keep} are kept.`)));
  refreshOffsite().catch(() => {});
}
async function refreshOffsite() {
  $('#offCard').hidden = !me?.owner;
  if (!me?.owner) return;
  const d = await api('GET', '/api/offsite');
  $('#offFolder').value = d.folder;
  $('#offCloud').value = d.rclone;
  $('#offKeep').value = d.keep;
  $('#offLast').textContent = d.last.at ? `${d.last.ok ? 'Last copy' : 'The last try FAILED'}, ${fmtDate(d.last.at)}: ${d.last.message}` : d.folder || d.rclone ? 'Nothing has been copied yet.' : 'Not set up: backups only exist on this computer.';
}
$('#offForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('PUT', '/api/offsite', { folder: $('#offFolder').value, rclone: $('#offCloud').value, keep: Number($('#offKeep').value) }); toast('Saved'); } catch (err) { toast(err.message, true); }
  refreshOffsite().catch(() => {});
});
$('#offSend').addEventListener('click', async () => {
  try { const r = await api('POST', '/api/offsite/send'); toast(`Copying ${r.sent} backup${r.sent === 1 ? '' : 's'} in the background`); setTimeout(() => refreshOffsite().catch(() => {}), 4000); } catch (err) { toast(err.message, true); }
});

async function refreshPregen() {
  const d = await api('GET', '/api/pregen');
  $('#pgCard').hidden = !d.supported;
  if (!d.supported) return;
  $('#pgNote').textContent = !d.installed ? 'Exploring new land is what makes a weak computer lag. Chunky makes the land around the middle in advance, so exploring later is smooth. It works while the server runs and can take a long time for a big radius.'
    : d.running ? 'Pick how far from the middle to prepare, in blocks. 1000 is a good start; bigger takes much longer.' : 'Chunky is installed. Start the server, then press Start here.';
  $('#pgInstall').hidden = d.installed;
  $('#pgForm').hidden = $('#pgCtl').hidden = !d.installed;
  $('#pgStart').disabled = !d.running;
  $('#pgLine').textContent = d.line || '';
}
$('#pgInstall').addEventListener('click', async e => {
  e.currentTarget.disabled = true;
  toast('Downloading Chunky…');
  try { const r = await api('POST', '/api/pregen/install'); toast('Installed: ' + r.done.map(x => x.name).join(', ') + '. Restart the server.'); } catch (err) { toast(err.message, true); }
  e.currentTarget.disabled = false;
  refreshPregen().catch(() => {});
});
$('#pgForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('POST', '/api/pregen/start', { radius: Number($('#pgRadius').value) }); toast('Started. The progress shows below.'); setTimeout(() => refreshPregen().catch(() => {}), 3000); } catch (err) { toast(err.message, true); }
});
for (const [id, action] of [['#pgPause', 'pause'], ['#pgContinue', 'continue'], ['#pgCancel', 'cancel']]) {
  $(id).addEventListener('click', async () => { try { await api('POST', '/api/pregen/control', { action }); setTimeout(() => refreshPregen().catch(() => {}), 2000); } catch (err) { toast(err.message, true); } });
}
$('#btnBackup').addEventListener('click', async e => {
  e.currentTarget.disabled = true;
  toast('Backing up… a big world takes a minute');
  try { toast('Saved ' + (await api('POST', '/api/backups')).name); } catch (err) { toast(err.message, true); }
  e.currentTarget.disabled = false;
  refreshBackups().catch(() => {});
});
$('#btnReset').addEventListener('click', async () => {
  if (!await ask('Start a fresh world? The current one is kept in a folder, and a new one is made the next time you start the server. The server must be stopped.', 'Start fresh')) return;
  try { toast((await api('POST', '/api/world/reset')).message); } catch (e) { toast(e.message, true); }
});

const COLORS = { 0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA', 8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF' };
const NO_ICON = GRASS;

function renderMotd(el, text) {
  el.replaceChildren();
  let st = { color: '#AAAAAA' }, buf = '';
  const flush = () => { if (!buf) return; const s = h('span', {}, buf); s.style.color = st.color; if (st.bold) s.style.fontWeight = '700'; if (st.italic) s.style.fontStyle = 'italic'; s.style.textDecoration = [st.under && 'underline', st.strike && 'line-through'].filter(Boolean).join(' '); el.append(s); buf = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], code = (text[i + 1] || '').toLowerCase();
    if (c === '&' && /[0-9a-fk-or]/.test(code)) {
      flush();
      if (COLORS[code]) st = { color: COLORS[code] };
      else if (code === 'r') st = { color: '#AAAAAA' };
      else if (code === 'l') st.bold = true;
      else if (code === 'o') st.italic = true;
      else if (code === 'n') st.under = true;
      else if (code === 'm') st.strike = true;
      i++;
    } else buf += c;
  }
  flush();
}

let pendingIcon = null, hasIcon = false, lastMotd = null;

function updatePreview() {
  $('#pvName').textContent = $('#lkName').value || 'Server';
  renderMotd($('#pvMotd1'), $('#lkMotd1').value);
  renderMotd($('#pvMotd2'), $('#lkMotd2').value);
  const img = $('#pvIcon');
  if (pendingIcon) { img.src = URL.createObjectURL(pendingIcon); return; }
  img.src = hasIcon ? withServer('/api/icon') + '&t=' + iconStamp : NO_ICON;
}

async function toIcon64(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const side = Math.min(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 64, 64);
  return new Promise(resolve => c.toBlob(resolve, 'image/png'));
}
async function putIcon(blob, id = server) {
  const r = await fetch('/api/icon?server=' + encodeURIComponent(id), { method: 'PUT', headers: { 'X-Panel': '1' }, body: blob });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'could not save the picture');
}

(function buildSwatches() {
  const box = $('#swatches');
  const add = (code, style) => box.append(h('button', { type: 'button', title: '&' + code, style, onclick: () => insertCode(code) }, '&' + code));
  for (const [c, hex] of Object.entries(COLORS)) add(c, `color:${hex === '#000000' ? '#888' : hex}`);
  for (const c of ['l', 'o', 'n', 'm', 'r']) add(c, '');
})();
function insertCode(code) {
  const el = lastMotd || $('#lkMotd1');
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
  el.value = el.value.slice(0, a) + '&' + code + el.value.slice(b);
  el.focus();
  el.setSelectionRange(a + 2, a + 2);
  updatePreview();
}
for (const id of ['#lkMotd1', '#lkMotd2']) $(id).addEventListener('focus', e => { lastMotd = e.target; });
for (const id of ['#lkName', '#lkMotd1', '#lkMotd2']) $(id).addEventListener('input', updatePreview);

async function refreshLook() {
  const a = await api('GET', '/api/appearance');
  $('#lkName').value = a.name;
  $('#lkPort').value = a.port;
  $('#lkMotd1').value = a.motd1;
  $('#lkMotd2').value = a.motd2;
  hasIcon = a.hasIcon;
  pendingIcon = null;
  $('#lkIcon').value = '';
  updatePreview();
  const be = a.edition === 'bedrock';
  for (const el of [$('#preview'), $('#preview').nextElementSibling, $('#lkMotd2'), document.querySelector('label[for=lkMotd2]'), $('#swatches'), $('#swatches').nextElementSibling, document.querySelector('label[for=lkIcon]'), $('#lkIcon').closest('.row'), $('#packCard')]) el.hidden = be;
  document.querySelector('label[for=lkMotd1]').textContent = be ? 'Server name in the game' : 'Text, first line';
  if (!be) await refreshPack();
}
$('#lkIcon').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try { pendingIcon = await toIcon64(f); updatePreview(); } catch { toast('I could not read that picture', true); }
});
$('#lkIconClear').addEventListener('click', () => { pendingIcon = null; hasIcon = false; $('#lkIcon').value = ''; $('#pvIcon').src = NO_ICON; $('#lkIconClear').dataset.clear = '1'; });
$('#lookForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('PUT', '/api/appearance', { name: $('#lkName').value, port: Number($('#lkPort').value), motd1: $('#lkMotd1').value, motd2: $('#lkMotd2').value });
    if (pendingIcon) await putIcon(pendingIcon);
    else if ($('#lkIconClear').dataset.clear) await api('DELETE', '/api/icon');
    delete $('#lkIconClear').dataset.clear;
    iconStamp = Date.now();
    toast('Saved. Restart the server to show the changes in Minecraft.');
    loadServers().catch(() => {});
    refreshLook().catch(() => {});
  } catch (err) { toast(err.message, true); }
});

async function refreshPack() {
  const p = await api('GET', '/api/resourcepack');
  const now = $('#packNow');
  now.replaceChildren(p.url ? h('span', {}, 'Current pack: ', h('strong', {}, p.url), p.required ? ' (required)' : ' (optional for players)') : 'No resource pack is set.');
  $('#packReq').checked = p.url ? p.required : true;
  $('#packPrompt').value = p.prompt;
}
async function setPack(body, what) {
  try {
    await api('PUT', '/api/resourcepack', { ...body, required: $('#packReq').checked, prompt: $('#packPrompt').value });
    toast(`Resource pack set (${what}). Restart the server to apply it.`);
    $('#packList').replaceChildren();
    refreshPack().catch(() => {});
  } catch (e) { toast(e.message, true); }
}
$('#packFindForm').addEventListener('submit', async e => {
  e.preventDefault();
  const list = $('#packList');
  list.replaceChildren(emptyRow('Searching…'));
  try {
    const { results } = await api('GET', '/api/packs/find?q=' + encodeURIComponent($('#packQ').value.trim()));
    list.replaceChildren();
    if (!results.length) list.append(emptyRow(`No resource packs for Minecraft ${last?.mc} found.`));
    for (const r of results) list.append(resultRow(r, small('Use as required pack', () => setPack({ modrinth: r.id }, r.title), 'primary')));
  } catch (err) { list.replaceChildren(); toast(err.message, true); }
});
$('#packUrlForm').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('#packUrl').value.trim();
  if (!url) return toast('Paste the link to the pack first', true);
  toast('Downloading the pack once to check it…');
  await setPack({ url }, 'link');
});
$('#packClear').addEventListener('click', async () => {
  try { await api('DELETE', '/api/resourcepack'); toast('Resource pack removed. Restart the server to apply it.'); refreshPack().catch(() => {}); } catch (e) { toast(e.message, true); }
});

let softwareList = null;

async function fillVersions(softSel, verSel, wanted) {
  verSel.replaceChildren(h('option', {}, 'Loading…'));
  try {
    const { versions } = await api('GET', '/api/software/versions?software=' + encodeURIComponent(softSel.value));
    verSel.replaceChildren(...versions.map(v => h('option', { value: v }, v)));
    verSel.value = versions.includes(wanted) ? wanted : versions[0];
  } catch (e) { verSel.replaceChildren(h('option', {}, 'Could not load')); toast(e.message, true); }
}
const SOFT_SHORT = {
  bedrock: 'Phones, consoles, Windows 10',
  vanilla: 'The official game',
  fabric: 'Light mods',
  forge: 'Classic mods',
  neoforge: 'Modern mods',
  paper: 'Plugins · good default',
  purpur: 'Paper, more options',
};
async function loadSoftware() {
  if (!softwareList) softwareList = (await api('GET', '/api/software')).software;
  return softwareList;
}

async function refreshSettings() {
  const { options } = await api('GET', '/api/options');
  const form = $('#optForm');
  const kids = [];
  let group = '';
  for (const o of options) {
    if (o.group !== group) { group = o.group; kids.push(h('h3', { class: 'optGroup' }, group)); }
    const control = o.type === 'bool' ? h('input', { type: 'checkbox', checked: o.value === 'true', name: o.key })
      : o.type === 'enum' ? h('select', { name: o.key }, ...o.values.map(v => h('option', { value: v, selected: v === o.value }, v)))
        : o.type === 'int' ? h('input', { type: 'number', min: o.min, max: o.max, value: o.value, name: o.key })
          : h('input', { type: 'text', value: o.value, maxlength: o.max, name: o.key });
    kids.push(h('label', { class: 'optRow' }, h('span', {}, o.label), control));
  }
  form.replaceChildren(...kids, h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save'), h('span', { class: 'muted' }, 'Options apply after a restart.')));

  const s = await api('GET', '/api/settings');
  $('#auBackupEvery').value = s.backupEveryHours;
  $('#auBackupKeep').value = s.backupKeep;
  $('#auIdle').value = s.idleMinutes;
  $('#auRestart').value = s.restartAt || '';
  $('#auStart').value = s.startAt || '';
  $('#auStop').value = s.stopAt || '';
  memoryManaged = s.memoryManaged;
  $('#auMemLbl').hidden = $('#auMem').hidden = !s.memoryManaged;
  $('#auMem').value = s.memoryMB || '';
  $('#auMem').placeholder = 'automatic (' + s.defaultMemoryMB + ')';
  $('#auMemNote').textContent = s.memoryManaged ? `Now: ${s.memoryNowMB ? fmtMB(s.memoryNowMB) : 'not set up yet'}. This computer has ${fmtMB(s.hostMB)}, leave some for everything else. It applies at the next start.` : "The main server's memory is set by the installer.";
  $('#auCrash').checked = s.restartOnCrash !== false;
  refreshLag().catch(() => {});
  $('#pubAddr').value = s.publicAddress || '';
  $('#pubMsg').textContent = '';
  api('GET', '/api/appearance').then(ap => { $('#pubPort').textContent = ap.port + (ap.edition === 'bedrock' ? ' (Bedrock: the tunnel must carry both TCP and UDP on this port)' : ''); }).catch(() => {});
  refreshBedrock().catch(() => {});
  $('#dupCard').hidden = server === 'main';

  const isMain = server === 'main';
  $('#swCard').querySelector('#swForm').hidden = isMain;
  $('#swNow').textContent = isMain
    ? `${last?.softwareLabel || ''} ${last?.mc || ''}. The main server is managed by the installer; create a new server to use other software or versions.`
    : `Now: ${last?.softwareLabel || ''} ${last?.mc || ''}`;
  $('#delCard').hidden = isMain;
  if (!isMain) {
    const list = await loadSoftware();
    const kind = last.edition === 'bedrock' ? 'bedrock' : 'java';
    $('#swSel').replaceChildren(...list.filter(x => x.edition === kind).map(x => h('option', { value: x.id }, x.label)));
    $('#swSel').value = last.software;
    await fillVersions($('#swSel'), $('#swVer'), last.mc);
  }
}
$('#optForm').addEventListener('submit', async e => {
  e.preventDefault();
  const values = {};
  for (const el of e.currentTarget.querySelectorAll('[name]')) values[el.name] = el.type === 'checkbox' ? String(el.checked) : el.value;
  try { await api('PUT', '/api/options', { values }); toast('Saved. Restart the server to apply the options.'); } catch (err) { toast(err.message, true); }
});
let memoryManaged = false;
$('#autoForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('PUT', '/api/settings', { restartOnCrash: $('#auCrash').checked, ...memoryManaged && { memoryMB: $('#auMem').value.trim() }, backupEveryHours: Number($('#auBackupEvery').value), backupKeep: Number($('#auBackupKeep').value), idleMinutes: Number($('#auIdle').value), restartAt: $('#auRestart').value.trim(), startAt: $('#auStart').value.trim(), stopAt: $('#auStop').value.trim() });
    toast('Saved');
  } catch (err) { toast(err.message, true); }
});
$('#pubForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('PUT', '/api/settings', { publicAddress: $('#pubAddr').value.trim() }); toast('Saved. It is shown with the join addresses on the Overview.'); } catch (err) { toast(err.message, true); }
});
$('#pubTest').addEventListener('click', async () => {
  $('#pubMsg').textContent = 'Testing from this computer…';
  try {
    await api('PUT', '/api/settings', { publicAddress: $('#pubAddr').value.trim() });
    const r = await api('POST', '/api/public-address/test');
    $('#pubMsg').textContent = r.online ? `It answers: ${r.players} players. Friends can join with this address.` : 'Nothing answers on that address. Is the server running, and is the tunnel running on this computer?';
  } catch (err) { $('#pubMsg').textContent = err.message; }
});
async function refreshLag() {
  const d = await api('GET', '/api/lag');
  $('#lagCard').hidden = d.supported === false;
  $('#lagInstall').hidden = d.spark || !d.installable;
  $('#lagProfile').hidden = !d.spark;
  $('#lagCheck').disabled = !d.running;
  $('#lagLink').replaceChildren(...d.profile ? ['The recording is ready: ', h('a', { href: d.profile, target: '_blank', rel: 'noopener noreferrer' }, d.profile)] : []);
}
const LAG_SAYS = { good: 'Running well.', ok: 'A little slow.', bad: 'Lagging.', unknown: 'I could not read the numbers.' };
$('#lagCheck').addEventListener('click', async e => {
  const b = e.currentTarget;
  b.disabled = true;
  $('#lagVerdict').textContent = 'Measuring…';
  try {
    const r = await api('POST', '/api/lag/check');
    $('#lagVerdict').textContent = LAG_SAYS[r.level] + (r.tps != null ? ` ${r.tps} ticks per second (20 is perfect).` : '') + (r.mspt != null ? ` ${r.mspt} ms per tick (under 50 is fine).` : '');
    $('#lagHints').replaceChildren(...r.hints.map(x => h('li', {}, h('span', { class: 'name' }, x))));
    $('#lagText').textContent = r.text;
    $('#lagText').hidden = !r.text;
  } catch (err) { $('#lagVerdict').textContent = ''; toast(err.message, true); }
  b.disabled = false;
});
$('#lagInstall').addEventListener('click', async e => {
  e.currentTarget.disabled = true;
  toast('Downloading spark…');
  try { const r = await api('POST', '/api/lag/install'); toast('Installed: ' + r.done.map(x => x.name).join(', ') + '. Restart the server.'); } catch (err) { toast(err.message, true); }
  e.currentTarget.disabled = false;
  refreshLag().catch(() => {});
});
$('#lagProfile').addEventListener('click', async () => {
  try { await api('POST', '/api/lag/profile'); toast('Recording for 60 seconds. The link shows up here when it is done.'); setTimeout(() => refreshLag().catch(() => {}), 70000); } catch (err) { toast(err.message, true); }
});
async function refreshBedrock() {
  const d = await api('GET', '/api/bedrock');
  $('#bedCard').hidden = !d.supported;
  const both = d.geyser && d.floodgate;
  $('#bedNote').textContent = !both ? 'Lets people on Bedrock (phones, consoles, Windows 10 edition) join this Java server, with Geyser and Floodgate from GeyserMC. They connect to the same address on UDP port ' + d.port + '.'
    : d.ready ? 'Geyser and Floodgate are installed and Bedrock players sign in through Floodgate. Open UDP port ' + d.port + ' on this computer. Their names start with a dot: whitelist them as ".Name".'
      : 'Installed. Start the server once so Geyser writes its settings, then press the second button.';
  $('#bedInstall').hidden = both;
  $('#bedEnable').hidden = !both || d.ready;
}
$('#bedInstall').addEventListener('click', async e => {
  e.currentTarget.disabled = true;
  toast('Downloading Geyser and Floodgate…');
  try { const r = await api('POST', '/api/bedrock/install'); toast('Installed: ' + r.done.map(d => d.name).join(', ') + '. Restart the server.'); } catch (err) { toast(err.message, true); }
  e.currentTarget.disabled = false;
  refreshBedrock().catch(() => {});
});
$('#bedEnable').addEventListener('click', async () => {
  try { toast((await api('POST', '/api/bedrock/enable')).message); } catch (err) { toast(err.message, true); }
  refreshBedrock().catch(() => {});
});
$('#btnDup').addEventListener('click', async () => {
  const name = await ask(`Name for the copy of "${last?.name}"? The server must be stopped.`, 'Copy', true);
  if (!name) return;
  toast('Copying… a big world takes a minute');
  try {
    const { id } = await api('POST', '/api/servers/duplicate', { id: server, name });
    await loadServers();
    await switchServer(id);
    setTab('overview');
    toast('Copied as ' + name);
  } catch (e) { toast(e.message, true); }
});
$('#swSel').addEventListener('change', () => fillVersions($('#swSel'), $('#swVer')));
$('#swGo').addEventListener('click', async () => {
  const software = $('#swSel').value, mc = $('#swVer').value;
  if (!await ask(`Change this server to ${$('#swSel').selectedOptions[0].textContent} ${mc}? The server must be stopped. A backup first is a good idea.`, 'Change')) return;
  try { const r = await api('POST', '/api/software', { software, mc }); toast(r.backup ? `Your world was backed up first (${r.backup}). Installing the new software…` : 'Installing the new software…'); await refreshStatus(); setTab('overview'); } catch (e) { toast(e.message, true); }
});
$('#btnDelete').addEventListener('click', async () => {
  const name = last?.name;
  const typed = await ask(`This deletes "${name}" and everything in it for good. Type its name to confirm.`, 'Delete it', true);
  if (typed === null) return;
  try {
    await api('POST', '/api/servers/delete', { id: server, confirm: typed });
    toast('Deleted ' + name);
    await loadServers();
    await switchServer(server);
  } catch (e) { toast(e.message, true); }
});

async function openCreate() {
  const form = $('#createForm');
  form.reset();
  const list = await loadSoftware().catch(e => { toast(e.message, true); return null; });
  if (!list) return;
  $('#cSoftList').replaceChildren(...list.map(x => h('label', { class: 'soft' },
    h('input', { type: 'radio', name: 'csoft', value: x.id, checked: x.id === 'paper', onchange: () => { fillVersions(cSoft, $('#cVer')); createKind(); } }),
    cube(x.id), x.label, h('small', {}, SOFT_SHORT[x.id] || ''), svg(CHECK))));
  createKind();
  $('#createDlg').showModal();
  fillVersions(cSoft, $('#cVer'));
}
function createKind() {
  $('#cLists').closest('label').hidden = !servers.some(s => s.id === 'main') || cSoft.value === 'bedrock';
}
const cSoft = { get value() { return document.querySelector('input[name=csoft]:checked')?.value || 'paper'; } };
$('#createForm').addEventListener('submit', async e => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  if (!$('#cEula').checked) return toast('You need to accept the Minecraft EULA to create a server', true);
  const go = $('#cGo');
  go.disabled = true;
  try {
    const { id } = await api('POST', '/api/servers', {
      name: $('#cName').value, software: cSoft.value, mc: $('#cVer').value, port: $('#cPort').value ? Number($('#cPort').value) : undefined,
      motd1: $('#cMotd1').value || $('#cName').value, motd2: $('#cMotd2').value, seed: $('#cSeed').value, copyLists: $('#cLists').checked, eula: true,
    });
    const icon = $('#cIcon').files[0];
    if (icon) await putIcon(await toIcon64(icon), id).catch(err => toast('Created, but the picture was not saved: ' + err.message, true));
    $('#createDlg').close();
    await loadServers();
    await switchServer(id);
    setTab('overview');
    toast('Created. The software is being downloaded; Start unlocks when it is done.');
  } catch (err) { toast(err.message, true); }
  go.disabled = false;
});

const KIND_OF = { vanilla: null, fabric: 'fabric', forge: 'forge', neoforge: 'neoforge', paper: 'plugin', purpur: 'plugin' };
const KIND_TEXT = { fabric: 'a Fabric mod', forge: 'a Forge mod', neoforge: 'a NeoForge mod', plugin: 'a plugin', broken: 'a damaged file', unknown: 'not a mod or plugin' };
const vnums = s => (String(s).match(/^(\d+)\.(\d+)(?:\.(\d+))?/) || []).slice(1).map(Number);
const vcmpClient = (a, b) => { const x = vnums(a), y = vnums(b); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
const isRelease = v => /^(1|2\d)\.\d/.test(String(v));

function searchFor(file) {
  const name = file.replace(/\.jar$/i, '').split(/[-_ +](?=v?\d|mc|forge|fabric)/i)[0];
  setTab('mods');
  $('#findSrc').value = 'modrinth';
  $('#findQ').value = name;
  $('#findForm').requestSubmit();
}

async function renderPlan(p) {
  const list = await loadSoftware();
  const label = id => list.find(x => x.id === id)?.label || id;
  const box = $('#impPlan');
  box.hidden = false;
  if (p.modpack) {
    const m = p.modpack;
    const nameIn = h('input', { maxlength: 40, autocomplete: 'off', value: m.name.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40) || 'Modpack' });
    const eula = h('input', { type: 'checkbox' });
    const label0 = 'Create the server and download the modpack';
    const go = h('button', { class: 'primary', type: 'button' }, label0);
    go.addEventListener('click', async () => {
      if (!eula.checked) return toast('You need to accept the Minecraft EULA to create a server', true);
      go.disabled = true;
      go.textContent = 'Starting…';
      try {
        const r = await api('POST', '/api/import/create', { id: p.id, name: nameIn.value, software: p.suggest.software, mc: p.suggest.mc, eula: true });
        await loadServers().catch(() => {});
        box.hidden = true;
        await switchServer(r.id);
        setTab('overview');
        toast(r.messages[0]);
      } catch (e) { toast(e.message, true); go.disabled = false; go.textContent = label0; loadServers().catch(() => {}); }
    });
    const cancel0 = h('button', { type: 'button', onclick: async () => { await api('DELETE', '/api/import?id=' + p.id).catch(() => {}); box.hidden = true; } }, 'Cancel');
    box.replaceChildren(h('h2', {}, 'Found in ' + p.zipName),
      h('p', {}, `Modrinth modpack "${m.name}" ${m.version}: ${m.files} files (${fmtSize(m.bytes)}) for ${label(p.detected.software)} on Minecraft ${p.detected.mc}.` + (m.clientOnly ? ` ${m.clientOnly} client-only file(s) are left out.` : '')),
      ...(p.suggest.notes.length ? [h('ul', { class: 'warnbox' }, ...p.suggest.notes.map(w => h('li', {}, w)))] : []),
      h('div', { class: 'fields' }, h('label', {}, 'Name of the new server'), nameIn,
        h('label', { class: 'check' }, eula, h('span', {}, 'I accept the ', h('a', { href: 'https://aka.ms/MinecraftEULA', target: '_blank', rel: 'noopener noreferrer' }, 'Minecraft EULA')))),
      h('div', { class: 'row mt10' }, go, cancel0));
    return;
  }
  const canNew = can('create'), canInto = can('files') && servers.length > 0;
  let target = canNew ? 'new' : 'into';

  const nameIn = h('input', { maxlength: 40, autocomplete: 'off', value: (p.world?.name || p.zipName.replace(/\.zip$/i, '')).replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40) || 'Moved server' });
  const softSel = h('select', { class: 'auto' }, ...list.filter(x => x.edition !== 'bedrock').map(x => h('option', { value: x.id }, x.label)));
  const verSel = h('select', { class: 'auto' });
  const eula = h('input', { type: 'checkbox' });
  const intoSel = h('select', { class: 'auto' }, ...servers.filter(s => s.edition !== 'bedrock').map(s => h('option', { value: s.id, selected: s.id === server }, s.name)));
  softSel.value = p.suggest.software;
  const picks = {};
  const pickBox = h('div');
  const newBox = h('div', { class: 'fields' },
    h('label', {}, 'Name of the new server'), nameIn, h('label', {}, 'Software'), softSel, h('label', {}, 'Minecraft version'), verSel,
    h('label', { class: 'check' }, eula, h('span', {}, 'I accept the ', h('a', { href: 'https://aka.ms/MinecraftEULA', target: '_blank', rel: 'noopener noreferrer' }, 'Minecraft EULA'))));
  const intoBox = h('div', { class: 'fields' }, h('label', {}, 'Which server'), intoSel);
  const go = h('button', { class: 'primary', type: 'button' });

  const info = () => {
    if (target === 'new') return { kind: KIND_OF[softSel.value], label: label(softSel.value), mc: verSel.value, dir: KIND_OF[softSel.value] === 'plugin' ? 'plugins' : 'mods' };
    const s = servers.find(x => x.id === intoSel.value) || {};
    return { kind: KIND_OF[s.software], label: s.softwareLabel || '', mc: s.mc || '', dir: KIND_OF[s.software] === 'plugin' ? 'plugins' : 'mods', running: s.state === 'active' };
  };

  function draw() {
    const t = info();
    newBox.hidden = target !== 'new';
    intoBox.hidden = target !== 'into';
    go.textContent = target === 'new' ? 'Create the server and move it in' : 'Move it into ' + (servers.find(s => s.id === intoSel.value)?.name || 'the server');
    const keep = Object.fromEntries(Object.entries(picks).map(([k, el]) => [k, el.checked]));
    for (const k of Object.keys(picks)) delete picks[k];
    const opt = (key, title, detail, on, disabled = false) => {
      picks[key] = h('input', { type: 'checkbox', checked: !disabled && (key in keep ? keep[key] : on), disabled });
      return h('label', { class: 'opt' }, picks[key], h('span', {}, h('strong', {}, title), h('span', { class: 'muted block' }, detail)));
    };
    const rows = [h('h2', {}, 'What to bring')];
    if (p.world) {
      const tooNew = isRelease(p.world.version) && isRelease(t.mc) && vcmpClient(p.world.version, t.mc) > 0;
      rows.push(opt('world', `World "${p.world.name}"`, `${p.world.version ? 'Minecraft ' + p.world.version : 'unknown version'} · ${fmtSize(p.world.size)}`
        + (p.dims.nether || p.dims.end ? ' · with its Nether and End folders' : '') + (target === 'into' ? '. A world you have is kept as a backup folder.' : '.')
        + (tooNew ? ` This is newer than ${t.mc}: choose that version or a newer one.` : ''), true, tooNew));
    }
    const keys = Object.keys(p.settings);
    if (keys.length || p.pack['resource-pack']) rows.push(opt('settings', 'Game settings', [...keys.map(k => `${k}: ${p.settings[k]}`), p.pack['resource-pack'] ? 'resource pack' : ''].filter(Boolean).join(', '), true));
    if (p.motd !== null || p.icon) rows.push(opt('appearance', 'Text and picture in the server list', [p.motd !== null && 'the text', p.icon && 'the picture'].filter(Boolean).join(' and '), true));
    if (p.whitelist.length || p.ops.length || p.banned.length || p.bannedIps) {
      rows.push(opt('lists', 'Players', `Whitelist ${p.whitelist.length}, operators ${p.ops.length}, banned ${p.banned.length}${p.bannedIps ? ', banned addresses ' + p.bannedIps : ''}. `
        + (p.onlineMode === false ? 'Copied only if you keep offline mode (next).' : 'Added to what you have, nothing is removed.'), true));
    }
    if (p.onlineMode === false) rows.push(opt('offline', 'Keep offline mode', 'The old server let in players without a bought Minecraft. This keeps their names and lists working, but it also lets anyone join under any name, so keep the whitelist on.', false));
    const jars = p.jars.filter(j => j.dir === t.dir);
    if (t.kind && jars.length) {
      const ok = jars.filter(j => j.kind === t.kind).length;
      rows.push(opt('mods', t.kind === 'plugin' ? 'Plugins' : 'Mods', `${ok} of ${jars.length} fit ${t.label}${t.kind === 'plugin' ? ', with their data and settings' : ''}.`, ok > 0, ok === 0));
      rows.push(h('ul', { class: 'list modlist' }, ...jars.map(j => h('li', {},
        h('span', { class: 'name' }, (j.kind === t.kind ? '✓ ' : '✗ ') + j.file, j.kind === t.kind ? '' : h('span', { class: 'meta block' }, `${KIND_TEXT[j.kind] || 'not a mod or plugin'}, but this server runs ${t.label}`)),
        j.kind !== t.kind && j.kind !== 'plugin' && target === 'into' && intoSel.value === server ? small('Find a version that fits', () => searchFor(j.file)) : null))));
    } else if (!t.kind && p.jars.length) rows.push(h('p', { class: 'muted' }, `${t.label} servers have no mods or plugins, so the ${p.jars.length} file(s) in the zip are left out.`));
    else if (t.kind && p.jars.length) rows.push(h('p', { class: 'muted' }, `The ${p.jars.length} file(s) in the zip are for another kind of server and are left out.`));
    if (p.configRel || p.extraRel.length || p.serverYml) rows.push(opt('config', 'Config files', `${p.configFiles + p.serverYml} file${p.configFiles + p.serverYml === 1 ? '' : 's'}. Files you already have are left alone.`, target === 'new'));
    if (target === 'into' && t.running) rows.push(h('p', { class: 'warnbox' }, 'This server is running. Stop it before moving the world, settings or player lists in.'));
    pickBox.replaceChildren(...rows);
  }

  const radio = (value, text, disabled) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'imptarget', value, checked: target === value, disabled, onchange: () => { target = value; draw(); } }), h('span', {}, text));
  const notes = [...p.warnings, ...p.suggest.notes];
  softSel.addEventListener('change', async () => { await fillVersions(softSel, verSel, p.detected.mc); draw(); });
  verSel.addEventListener('change', draw);
  intoSel.addEventListener('change', draw);

  go.addEventListener('click', async () => {
    const choice = Object.fromEntries(Object.entries(picks).map(([k, el]) => [k, el.checked]));
    if (!Object.values(choice).some(Boolean)) return toast('Tick at least one thing to bring', true);
    if (target === 'new' && !eula.checked) return toast('You need to accept the Minecraft EULA to create a server', true);
    go.disabled = true;
    try {
      const r = target === 'new'
        ? await api('POST', '/api/import/create', { id: p.id, name: nameIn.value, software: softSel.value, mc: verSel.value, eula: true, ...choice })
        : await api('POST', '/api/import/apply', { id: p.id, server: intoSel.value, ...choice });
      const dest = r.id || intoSel.value;
      await loadServers().catch(() => {});
      box.replaceChildren(h('h2', {}, 'Done'), h('ul', { class: 'list' }, ...r.messages.map(m => h('li', {}, m))),
        h('p', { class: 'muted' }, target === 'new'
          ? 'The server software is being downloaded; Start unlocks when that is done. To add another zip (the mods, say), come back here and choose "A server I already have".'
          : 'Start (or restart) the server to use it. If something looks wrong your old world is still in its backup folder (Files tab).'),
        h('div', { class: 'row' }, small('Open the server', async () => { await switchServer(dest); setTab('overview'); }, 'primary')));
    } catch (e) { toast(e.message, true); go.disabled = false; loadServers().catch(() => {}); }
  });
  const cancel = h('button', { type: 'button', onclick: async () => { await api('DELETE', '/api/import?id=' + p.id).catch(() => {}); box.hidden = true; } }, 'Cancel');

  box.replaceChildren(h('h2', {}, 'Found in ' + p.zipName),
    h('p', {}, `It looks like a ${label(p.detected.software)} server` + (p.detected.mc ? ` on Minecraft ${p.detected.mc}` : '') + '.'),
    ...(notes.length ? [h('ul', { class: 'warnbox' }, ...notes.map(w => h('li', {}, w)))] : []),
    h('h2', {}, 'Where to put it'), radio('new', 'A new server like the old one (recommended: mods and plugins keep working)', !canNew), newBox,
    radio('into', 'A server I already have', !canInto), intoBox, pickBox, h('div', { class: 'row mt10' }, go, cancel));
  await fillVersions(softSel, verSel, p.suggest.mc);
  draw();
}

$('#impFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const prog = $('#impProg'), status = $('#impStatus');
  $('#impPlan').hidden = true;
  prog.hidden = false;
  prog.value = 0;
  status.hidden = false;
  status.textContent = 'Uploading…';
  try {
    const plan = await upload('/api/import?name=' + encodeURIComponent(f.name), f, v => {
      prog.value = v;
      if (v >= 1) status.textContent = 'Unpacking and checking, a big world takes a minute or two…';
    });
    await renderPlan(plan);
  } catch (err) { toast(err.message, true); }
  prog.hidden = true;
  status.hidden = true;
  e.target.value = '';
});

boot();
