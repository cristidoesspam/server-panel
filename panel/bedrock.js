'use strict';
const dgram = require('dgram');
const net = require('net');
const { fail, getJson } = require('./common');

const API = process.env.BEDROCK_API || 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
const WORLD_DEFAULT = 'Bedrock level';

async function bedrockLink() {
  const r = await getJson(API);
  const type = process.platform === 'win32' ? 'serverBedrockWindows' : 'serverBedrockLinux';
  const l = (r.result?.links || []).find(x => x.downloadType === type);
  const m = l && /bedrock-server-(\d+(?:\.\d+){2,3})\.zip$/.exec(String(l.downloadUrl));
  if (!m || !/^https?:\/\//.test(l.downloadUrl)) fail(502, 'Mojang sent no usable Bedrock server download');
  return { url: l.downloadUrl, version: m[1] };
}

const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
function pingBedrock(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise(resolve => {
    let s;
    try { s = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4'); } catch { return resolve(null); }
    let timer;
    const done = v => { clearTimeout(timer); try { s.close(); } catch { } resolve(v); };
    timer = setTimeout(() => done(null), timeoutMs);
    s.on('error', () => done(null));
    s.on('message', msg => {
      if (msg[0] !== 0x1c || msg.length < 36) return done(null);
      const f = msg.toString('utf8', 35, 35 + msg.readUInt16BE(33)).split(';');
      done({ online: Number(f[4]) || 0, max: Number(f[5]) || 0, names: [], version: f[3] || '' });
    });
    const pkt = Buffer.alloc(33);
    pkt[0] = 0x01;
    pkt.writeBigUInt64BE(BigInt(Date.now()), 1);
    MAGIC.copy(pkt, 9);
    pkt.writeBigUInt64BE(2n, 25);
    s.send(pkt, port, host, e => { if (e) done(null); });
  });
}

const tcpAlive = (port, host = '127.0.0.1') => new Promise(resolve => {
  const s = net.connect(port, host);
  s.setTimeout(800, () => { s.destroy(); resolve(false); });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

function parseList(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /There are (\d+)\/(\d+) players online/.exec(lines[i]);
    if (!m) continue;
    const next = (lines[i + 1] || '').trim();
    const names = next && !/^\[\d{4}-/.test(next) ? next.split(/,\s*/).filter(Boolean) : [];
    return { online: Number(m[1]), max: Number(m[2]), names, version: '' };
  }
  return null;
}

const udpFree = port => new Promise(resolve => {
  const s = dgram.createSocket('udp4');
  s.once('error', () => { try { s.close(); } catch { } resolve(false); });
  s.bind(port, () => s.close(() => resolve(true)));
});

const BEDROCK_OPTIONS = [
  { group: 'Gameplay', key: 'gamemode', label: 'Default game mode', type: 'enum', values: ['survival', 'creative', 'adventure'], def: 'survival' },
  { group: 'Gameplay', key: 'difficulty', label: 'Difficulty', type: 'enum', values: ['peaceful', 'easy', 'normal', 'hard'], def: 'easy' },
  { group: 'Gameplay', key: 'force-gamemode', label: 'Put everyone in that game mode when they join', type: 'bool', def: 'false' },
  { group: 'Gameplay', key: 'allow-cheats', label: 'Cheats and commands allowed', type: 'bool', def: 'false' },
  { group: 'Gameplay', key: 'default-player-permission-level', label: 'What new players may do', type: 'enum', values: ['visitor', 'member', 'operator'], def: 'member' },
  { group: 'Gameplay', key: 'player-idle-timeout', label: 'Kick idle players after (minutes, 0 = never)', type: 'int', min: 0, max: 1440, def: '30' },
  { group: 'World', key: 'level-seed', label: 'World seed (only used when a new world is made)', type: 'text', max: 64, def: '' },
  { group: 'Players', key: 'max-players', label: 'Most players at once', type: 'int', min: 1, max: 200, def: '10' },
  { group: 'Players', key: 'online-mode', label: 'Players must be signed in to Xbox (turn off only for a local network)', type: 'bool', def: 'true' },
  { group: 'Players', key: 'texturepack-required', label: 'Players must accept the resource packs', type: 'bool', def: 'false' },
  { group: 'Speed', key: 'view-distance', label: 'View distance (chunks)', type: 'int', min: 5, max: 96, def: '10' },
  { group: 'Speed', key: 'tick-distance', label: 'Simulation distance (chunks)', type: 'int', min: 4, max: 12, def: '4' },
];

module.exports = { bedrockLink, pingBedrock, tcpAlive, parseList, udpFree, BEDROCK_OPTIONS, WORLD_DEFAULT };
