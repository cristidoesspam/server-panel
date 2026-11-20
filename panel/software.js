'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fail, run, TAR, getJson, downloadVerified, vcmp, getProp, setProp } = require('./common');
const zipfile = require('./zip');
const { bedrockLink } = require('./bedrock');

const SOFTWARE = {
  vanilla: { label: 'Vanilla', kind: null, dir: null, loaders: [], min: '1.14' },
  fabric: { label: 'Fabric', kind: 'fabric', dir: 'mods', loaders: ['fabric'], min: '1.14' },
  forge: { label: 'Forge', kind: 'forge', dir: 'mods', loaders: ['forge'], min: '1.17' },
  neoforge: { label: 'NeoForge', kind: 'neoforge', dir: 'mods', loaders: ['neoforge'], min: '1.20.2' },
  paper: { label: 'Paper', kind: 'plugin', dir: 'plugins', loaders: ['paper', 'spigot', 'bukkit'], min: '1.16' },
  purpur: { label: 'Purpur', kind: 'plugin', dir: 'plugins', loaders: ['purpur', 'paper', 'spigot', 'bukkit'], min: '1.16' },
  bedrock: { label: 'Bedrock', kind: null, dir: null, loaders: [], min: '1.0', edition: 'bedrock' },
};
const MOJANG = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const META = 'https://meta.fabricmc.net/v2/versions';
const PAPER = 'https://fill.papermc.io/v3';
const PURPUR = 'https://api.purpurmc.org/v2/purpur';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEO_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'meta.fabricmc.net', 'maven.fabricmc.net', 'fill.papermc.io', 'fill-data.papermc.io',
  'api.purpurmc.org', 'files.minecraftforge.net', 'maven.minecraftforge.net', 'maven.neoforged.net', 'api.adoptium.net', 'github.com', 'githubusercontent.com', 'www.minecraft.net'];
const FAKE_VERSIONS = ['26.3', '26.2', '1.21.1', '1.20.4'];
const FAKE_BEDROCK = '1.26.63.1';

const exists = p => fsp.stat(p).then(() => true, () => false);
const isRelease = v => /^\d+\.\d+(\.\d+)?$/.test(v);

async function getText(url) {
  try { const r = await fetch(url, { headers: { 'User-Agent': 'minecraft-panel/1.0 (personal server panel)' }, signal: AbortSignal.timeout(20000) }); if (r.ok) return r.text(); } catch { }
  return fail(502, 'could not reach ' + new URL(url).hostname + ' (is this computer online?)');
}

function neoToMc(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(-[\w.]+)?$/.exec(v);
  if (!m) return '';
  const [a, b, c] = [+m[1], +m[2], +m[3]];
  if (a >= 26 && m[4] !== undefined) return `${a}.${b}` + (c ? '.' + c : '');
  if (a < 26 && m[4] === undefined) return `1.${a}` + (b ? '.' + b : '');
  return '';
}
const neoKey = s => s.replace(/-.*/, '').split('.').map(Number);
function neoBetter(v, cur) {
  const vb = v.includes('-'), cb = cur.includes('-');
  if (vb !== cb) return !vb;
  const x = neoKey(v), y = neoKey(cur);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}

module.exports = function makeSoftware({ javaDir, knownJava = {}, fake = false, extraHosts = [] }) {
  const hostOk = h => HOSTS.some(x => h === x || h.endsWith('.' + x)) || extraHosts.includes(h);
  const cache = new Map();
  const cached = async (key, fn) => {
    const c = cache.get(key);
    if (c && Date.now() - c.t < 10 * 60 * 1000) return c.v;
    const v = await fn();
    cache.set(key, { v, t: Date.now() });
    return v;
  };

  const manifest = () => cached('mojang', () => getJson(MOJANG));
  const neoMap = () => cached('neomap', async () => {
    const xml = await getText(NEO_MAVEN + '/maven-metadata.xml');
    const best = new Map();
    for (const m of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
      const mc = neoToMc(m[1]);
      if (mc && (!best.has(mc) || neoBetter(m[1], best.get(mc)))) best.set(mc, m[1]);
    }
    return best;
  });

  const lists = {
    vanilla: async () => (await manifest()).versions.filter(v => v.type === 'release').map(v => v.id),
    fabric: async () => (await getJson(META + '/game')).filter(v => v.stable).map(v => v.version),
    paper: async () => Object.values((await getJson(PAPER + '/projects/paper')).versions).flat(),
    purpur: async () => (await getJson(PURPUR)).versions,
    forge: async () => Object.keys((await getJson(FORGE_PROMOS)).promos).map(k => (/^(.+)-latest$/.exec(k) || [])[1]),
    neoforge: async () => [...(await neoMap()).keys()],
  };

  async function versions(software) {
    if (!SOFTWARE[software]) fail(400, 'unknown software');
    if (software === 'bedrock') return fake ? [FAKE_BEDROCK] : cached('v-bedrock', async () => [(await bedrockLink()).version]);
    if (fake) return FAKE_VERSIONS;
    return cached('v-' + software, async () =>
      [...new Set(await lists[software]())].filter(v => v && isRelease(v) && vcmp(v, SOFTWARE[software].min) >= 0).sort((a, b) => vcmp(b, a)));
  }

  async function mojangInfo(mc) {
    if (fake) return { java: 25, server: null };
    return cached('mc-' + mc, async () => {
      const e = (await manifest()).versions.find(v => v.id === mc);
      if (!e) fail(404, `Minecraft ${mc} is not known to Mojang`);
      const j = await getJson(e.url);
      return { java: j.javaVersion?.majorVersion || 21, server: j.downloads?.server || null };
    });
  }

  const javaJobs = new Map();
  const JAVA_OS = { win32: 'windows', linux: 'linux' }[process.platform];
  const JAVA_ARCH = { x64: 'x64', arm64: 'aarch64' }[process.arch];
  async function ensureJava(major) {
    if (fake) return '/usr/bin/java';
    if (knownJava[major] && await exists(knownJava[major])) return knownJava[major];
    const bin = path.join(javaDir, String(major), 'bin', JAVA_OS === 'windows' ? 'java.exe' : 'java');
    if (await exists(bin)) return bin;
    if (!JAVA_OS || !JAVA_ARCH) fail(501, `I cannot download Java for ${process.platform} on ${process.arch}; install Java ${major} yourself`);
    if (!javaJobs.has(major)) {
      javaJobs.set(major, (async () => {
        const meta = await getJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${JAVA_ARCH}&image_type=jre&os=${JAVA_OS}`);
        const pkg = meta[0]?.binary?.package;
        if (!pkg) fail(502, `no Java ${major} download found`);
        await fsp.mkdir(javaDir, { recursive: true });
        const isZip = JAVA_OS === 'windows';
        const tmp = path.join(javaDir, `java-${major}.${isZip ? 'zip' : 'tar.gz'}`);
        await fsp.rm(tmp, { force: true });
        await downloadVerified(pkg.link, tmp, { hash: { algo: 'sha256', hex: pkg.checksum }, hostOk, max: 400 * 1024 * 1024 });
        const dest = path.join(javaDir, String(major));
        await fsp.rm(dest, { recursive: true, force: true });
        await fsp.mkdir(dest);
        if (isZip) await zipfile.extract(tmp, dest, { strip: 1 });
        else await run(TAR, ['-xzf', tmp, '-C', dest, '--strip-components=1'], { timeout: 5 * 60 * 1000 });
        await fsp.rm(tmp, { force: true });
      })().finally(() => javaJobs.delete(major)));
    }
    await javaJobs.get(major);
    return bin;
  }

  async function installBedrock(dir, mc, report) {
    const win = process.platform === 'win32';
    if (!fake && !((win || process.platform === 'linux') && process.arch === 'x64')) fail(501, 'Mojang\'s Bedrock server runs on Windows and on Linux with a 64-bit Intel or AMD processor only, not on this computer.');
    const exe = win ? 'bedrock_server.exe' : 'bedrock_server';
    const keep = {};
    for (const f of ['server.properties', 'allowlist.json', 'permissions.json']) keep[f] = await fsp.readFile(path.join(dir, f), 'utf8').catch(() => null);
    if (fake) {
      await fsp.writeFile(path.join(dir, exe), 'stub bedrock server');
      await fsp.writeFile(path.join(dir, 'server.properties'), 'server-name=Dedicated Server\ngamemode=survival\ndifficulty=easy\nallow-list=true\nmax-players=10\nserver-port=19132\nserver-portv6=19133\nlevel-name=Bedrock level\nview-distance=32\ntick-distance=4\ntransport=nethernet\nenable-lan-visibility=true\n');
    } else {
      report('Looking up the Bedrock server');
      const link = await bedrockLink();
      if (link.version !== mc) fail(409, `Mojang's newest Bedrock server is ${link.version}, not ${mc}. Pick that version.`);
      report('Downloading the Bedrock server (about 100 MB)');
      const zip = path.join(dir, '.bedrock.zip');
      await fsp.rm(zip, { force: true });
      await downloadVerified(link.url, zip, { hash: null, hostOk, max: 500 * 1024 * 1024, allowHttp: extraHosts.includes(new URL(link.url).hostname) });
      report('Unpacking');
      try { await zipfile.extract(zip, dir); } finally { await fsp.rm(zip, { force: true }); }
      if (!await exists(path.join(dir, exe))) fail(502, 'the download did not contain the Bedrock server program');
    }
    if (!win) await fsp.chmod(path.join(dir, exe), 0o755);
    for (const f of ['allowlist.json', 'permissions.json']) if (keep[f] !== null) await fsp.writeFile(path.join(dir, f), keep[f]);
    if (keep['server.properties'] !== null) {
      let text = await fsp.readFile(path.join(dir, 'server.properties'), 'utf8').catch(() => '');
      for (const line of keep['server.properties'].split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i > 0 && !line.startsWith('#')) text = setProp(text, line.slice(0, i), line.slice(i + 1));
      }
      await fsp.writeFile(path.join(dir, 'server.properties'), text);
    }
    if (win) await fsp.writeFile(path.join(dir, 'launch.cmd'), `@echo off\r\nrem Written by the panel. Starts this Bedrock server.\r\ncd /d "%~dp0"\r\n${exe}\r\n`);
    else await fsp.writeFile(path.join(dir, 'launch.sh'), '#!/bin/sh\n# Written by the panel. Starts this Bedrock server.\ncd "$(dirname "$0")"\nexec env LD_LIBRARY_PATH=. ./bedrock_server\n', { mode: 0o755 });
    return { java: 0 };
  }

  async function install(dir, software, mc, { heapMB, report = () => {} }) {
    const def = SOFTWARE[software];
    if (!def) fail(400, 'unknown software');
    if (!(await versions(software)).includes(mc)) fail(400, `${def.label} has no version ${mc}`);
    if (def.edition === 'bedrock') return installBedrock(dir, mc, report);
    report(`Looking up Minecraft ${mc}`);
    const info = await mojangInfo(mc);
    report(`Getting Java ${info.java}`);
    const java = await ensureJava(info.java);
    const dl = async (url, name, hash, max = 300 * 1024 * 1024) => {
      await fsp.rm(path.join(dir, name), { force: true });
      await downloadVerified(url, path.join(dir, name), { hash, hostOk, max });
    };
    let args;
    if (fake) {
      await fsp.writeFile(path.join(dir, 'server.jar'), 'stub ' + software);
      args = '-jar server.jar nogui';
    } else if (software === 'vanilla') {
      report('Downloading the Minecraft server');
      await dl(info.server.url, 'server.jar', { algo: 'sha1', hex: info.server.sha1 });
      args = '-jar server.jar nogui';
    } else if (software === 'fabric') {
      report('Downloading Fabric');
      const loaders = await getJson(`${META}/loader/${encodeURIComponent(mc)}`);
      const loader = (loaders.find(l => l.loader.stable) || loaders[0])?.loader.version;
      const installers = await getJson(META + '/installer');
      const installer = (installers.find(i => i.stable) || installers[0])?.version;
      if (!loader || !installer) fail(404, `Fabric has no loader for ${mc}`);
      await dl(`${META}/loader/${encodeURIComponent(mc)}/${loader}/${installer}/server/jar`, 'fabric-server-launch.jar', null);
      args = '-jar fabric-server-launch.jar nogui';
    } else if (software === 'paper') {
      report('Downloading Paper');
      const d = (await getJson(`${PAPER}/projects/paper/versions/${encodeURIComponent(mc)}/builds/latest`)).downloads?.['server:default'];
      if (!d) fail(404, `Paper has no build for ${mc}`);
      await dl(d.url, 'server.jar', { algo: 'sha256', hex: d.checksums.sha256 });
      args = '-jar server.jar nogui';
    } else if (software === 'purpur') {
      report('Downloading Purpur');
      const b = await getJson(`${PURPUR}/${encodeURIComponent(mc)}/latest`);
      if (!b.build || !b.md5) fail(404, `Purpur has no build for ${mc}`);
      await dl(`${PURPUR}/${encodeURIComponent(mc)}/${b.build}/download`, 'server.jar', { algo: 'md5', hex: b.md5 });
      args = '-jar server.jar nogui';
    } else {
      report(`Downloading the ${def.label} installer`);
      let url;
      if (software === 'forge') {
        const promos = (await getJson(FORGE_PROMOS)).promos;
        const fv = promos[`${mc}-recommended`] || promos[`${mc}-latest`];
        if (!fv) fail(404, `Forge has no version for ${mc}`);
        url = `${FORGE_MAVEN}/${mc}-${fv}/forge-${mc}-${fv}-installer.jar`;
      } else {
        const nv = (await neoMap()).get(mc);
        if (!nv) fail(404, `NeoForge has no version for ${mc}`);
        url = `${NEO_MAVEN}/${nv}/neoforge-${nv}-installer.jar`;
      }
      const sha1 = (await getText(url + '.sha1')).trim().split(/\s/)[0];
      await dl(url, 'installer.jar', { algo: 'sha1', hex: sha1 });
      report(`Running the ${def.label} installer (this takes a few minutes)`);
      await run(java, ['-jar', 'installer.jar', '--installServer'], { cwd: dir, timeout: 20 * 60 * 1000 });
      const start = /@(libraries\/\S+(?:unix|win)_args\.txt)/.exec(await fsp.readFile(path.join(dir, process.platform === 'win32' ? 'run.bat' : 'run.sh'), 'utf8').catch(() => ''));
      if (!start) fail(502, `the ${def.label} installer did not produce a start file`);
      await fsp.rm(path.join(dir, 'installer.jar'), { force: true });
      await fsp.rm(path.join(dir, 'installer.jar.log'), { force: true });
      args = `${await exists(path.join(dir, 'user_jvm_args.txt')) ? '@user_jvm_args.txt ' : ''}@${start[1]} nogui`;
    }
    const jvm = `-Xms512M -Xmx${heapMB}M -XX:+DisableExplicitGC`;
    if (process.platform === 'win32') {
      const pct = s => s.replace(/%/g, '%%');
      await fsp.writeFile(path.join(dir, 'launch.cmd'), `@echo off\r\nrem Written by the panel. Starts this server.\r\ncd /d "%~dp0"\r\n"${pct(java)}" ${jvm} ${pct(args)}\r\n`);
    } else {
      await fsp.writeFile(path.join(dir, 'launch.sh'), `#!/bin/sh\n# Written by the panel. Starts this server.\ncd "$(dirname "$0")"\nexec '${java}' ${jvm} ${args}\n`, { mode: 0o755 });
    }
    return { java: info.java };
  }

  return { SOFTWARE, versions, install, ensureJava, mojangInfo };
};
module.exports.SOFTWARE = SOFTWARE;
module.exports.neoToMc = neoToMc;
