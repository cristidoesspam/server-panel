'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { fail, getJson, downloadVerified, modInfo, installedIds } = require('./common');
const zip = require('./zip');

const MAX_MOD = 200 * 1024 * 1024;
const CF = { game: 432, mods: 6, loader: { fabric: 4, forge: 1, neoforge: 6 }, required: 3, sha1: 1 };
const enc = encodeURIComponent;

module.exports = function makeSources({
  root, mc, sw, curseKey = '',
  modrinthApi = 'https://api.modrinth.com/v2',
  curseApi = 'https://api.curseforge.com',
  geyserApi = 'https://download.geysermc.org',
  extraHosts = [],
}) {
  const modsDir = sw.dir ? path.join(root, sw.dir) : '';
  const noun = sw.kind === 'plugin' ? 'plugin' : 'mod';
  const needDir = () => { if (!sw.dir) fail(409, `${sw.label} servers have no mods or plugins`); };
  const hostOk = h => h === 'cdn.modrinth.com' || h === 'download.geysermc.org' || h === 'edge.forgecdn.net' || h === 'mediafilecdn.curseforge.com' || h.endsWith('.forgecdn.net') || extraHosts.includes(h);

  async function sha(file, algo) {
    const h = crypto.createHash(algo);
    await pipeline(fs.createReadStream(file), h);
    return h.digest('hex');
  }

  async function installFiles(items, warnings = []) {
    needDir();
    await fsp.mkdir(modsDir, { recursive: true });
    const ids = await installedIds(modsDir);
    const done = [];
    for (const { target, file } of items) {
      const name = file.name.replace(/[^\w.+() -]/g, '_');
      if (!/\.jar$/i.test(name)) fail(502, file.name + ' is not a .jar file');
      const dest = path.join(modsDir, name);
      if (!target && await fsp.stat(dest).catch(() => null) && await sha(dest, file.hash.algo) === file.hash.hex.toLowerCase()) {
        done.push({ name, status: 'already installed' });
        continue;
      }
      const tmp = dest + '.part-' + crypto.randomBytes(4).toString('hex');
      await downloadVerified(file.url, tmp, { hash: file.hash, hostOk, max: MAX_MOD, allowHttp: extraHosts.length > 0 });
      const info = await modInfo(tmp);
      if (info.kind !== sw.kind) { await fsp.rm(tmp, { force: true }); fail(502, `${name} is not a ${sw.label} ${noun}, refused`); }
      const old = info.id && ids.get(info.id);
      if (old && !target) { await fsp.rm(tmp, { force: true }); done.push({ name, status: 'already installed' }); continue; }
      const wasOff = old && old.endsWith('.disabled');
      const finalName = wasOff ? name + '.disabled' : name;
      if (old && old !== finalName) await fsp.rm(path.join(modsDir, old), { force: true });
      await fsp.rm(path.join(modsDir, name + (wasOff ? '' : '.disabled')), { force: true });
      await fsp.rename(tmp, path.join(modsDir, finalName));
      if (info.id) ids.set(info.id, finalName);
      done.push({ name, status: old ? 'updated' : 'added' });
    }
    return { done, warnings };
  }

  async function modrinthSearch(query) {
    needDir();
    const facets = JSON.stringify([['project_type:' + (sw.kind === 'plugin' ? 'plugin' : 'mod')], sw.loaders.map(l => 'categories:' + l), ['versions:' + mc]]);
    const r = await getJson(`${modrinthApi}/search?query=${enc(query)}&facets=${enc(facets)}&limit=20`);
    return r.hits.map(h => ({ id: h.slug || h.project_id, title: h.title, description: h.description, author: h.author, downloads: h.downloads }));
  }

  function parseSlug(input) {
    const m = /modrinth\.com\/(?:mod|plugin|project|resourcepack|datapack)\/([\w-]+)/.exec(input) || /^([\w-]{2,64})$/.exec(input);
    if (!m) fail(400, 'that is not a Modrinth link or project name');
    return m[1];
  }

  async function modrinthInstall(input) {
    needDir();
    const slug = parseSlug(input);
    const items = [];
    const seen = new Set();
    async function plan(project, target, depth) {
      const url = `${modrinthApi}/project/${enc(project)}/version?game_versions=${enc(JSON.stringify([mc]))}&loaders=${enc(JSON.stringify(sw.loaders))}&include_changelog=false`;
      const versions = await getJson(url);
      const v = versions.find(x => x.version_type === 'release') || versions[0];
      if (!v) fail(404, `${project} has no ${sw.label} version for Minecraft ${mc}`);
      if (seen.has(v.project_id)) return;
      seen.add(v.project_id);
      const file = v.files.find(f => f.primary) || v.files[0];
      if (!file?.hashes?.sha512) fail(502, 'the mod site sent no checksum, refused');
      items.push({ target, file: { name: file.filename, url: file.url, hash: { algo: 'sha512', hex: file.hashes.sha512 } } });
      if (depth >= 4 || items.length > 20) return;
      for (const d of v.dependencies || []) {
        if (d.dependency_type !== 'required') continue;
        const pid = d.project_id || (d.version_id && (await getJson(`${modrinthApi}/version/${enc(d.version_id)}`)).project_id);
        if (pid) await plan(pid, false, depth + 1);
      }
    }
    await plan(slug, true, 0);
    return installFiles(items);
  }

  async function modUpdates() {
    needDir();
    await fsp.mkdir(modsDir, { recursive: true });
    const byHash = new Map();
    for (const f of (await fsp.readdir(modsDir)).filter(f => /\.jar(\.disabled)?$/.test(f))) byHash.set(await sha(path.join(modsDir, f), 'sha512'), f);
    if (!byHash.size) return [];
    const r = await getJson(`${modrinthApi}/version_files/update`, { body: { hashes: [...byHash.keys()], algorithm: 'sha512', loaders: sw.loaders, game_versions: [mc] } });
    const out = [];
    for (const [hash, v] of Object.entries(r || {})) {
      const file = v.files?.find(x => x.primary) || v.files?.[0];
      if (!file?.hashes?.sha512 || file.hashes.sha512 === hash) continue;
      out.push({ file: byHash.get(hash), to: file.filename, version: v.version_number || v.name || '', url: file.url, sha512: file.hashes.sha512 });
    }
    return out;
  }
  async function modUpdate(names) {
    const list = (await modUpdates()).filter(u => !names || names.includes(u.file));
    if (!list.length) return { done: [], warnings: ['Everything is up to date.'] };
    return installFiles(list.map(u => ({ target: true, file: { name: u.to, url: u.url, hash: { algo: 'sha512', hex: u.sha512 } } })));
  }

  async function bedrockInstall() {
    if (sw.kind !== 'plugin') fail(409, 'Bedrock players are supported on Paper and Purpur servers');
    const items = [];
    for (const p of ['geyser', 'floodgate']) {
      const b = await getJson(`${geyserApi}/v2/projects/${p}/versions/latest/builds/latest`);
      const d = b.downloads?.spigot;
      if (!d?.sha256 || !/^[\w.-]+\.jar$/.test(d.name || '')) fail(502, 'GeyserMC sent no usable download for ' + p);
      items.push({ target: true, file: { name: d.name, url: `${geyserApi}/v2/projects/${p}/versions/${b.version}/builds/${b.build}/downloads/spigot`, hash: { algo: 'sha256', hex: d.sha256 } } });
    }
    return installFiles(items);
  }

  async function packSearch(query) {
    const facets = JSON.stringify([['project_type:resourcepack'], ['versions:' + mc]]);
    const r = await getJson(`${modrinthApi}/search?query=${enc(query)}&facets=${enc(facets)}&limit=20`);
    return r.hits.map(h => ({ id: h.slug || h.project_id, title: h.title, description: h.description, author: h.author, downloads: h.downloads }));
  }
  async function packResolve(input) {
    const versions = await getJson(`${modrinthApi}/project/${enc(parseSlug(input))}/version?game_versions=${enc(JSON.stringify([mc]))}&include_changelog=false`);
    const v = versions.find(x => x.version_type === 'release') || versions[0];
    if (!v) fail(404, `that pack has no version for Minecraft ${mc}`);
    const file = v.files.find(f => f.primary) || v.files[0];
    if (!file?.hashes?.sha1 || !/^https:\/\//.test(file.url)) fail(502, 'the site sent no usable download for that pack');
    return { url: file.url, sha1: file.hashes.sha1, name: v.name || file.filename };
  }

  async function datapackSearch(query) {
    const facets = JSON.stringify([['project_type:datapack'], ['versions:' + mc]]);
    const r = await getJson(`${modrinthApi}/search?query=${enc(query)}&facets=${enc(facets)}&limit=20`);
    return r.hits.map(h => ({ id: h.slug || h.project_id, title: h.title, description: h.description, author: h.author, downloads: h.downloads }));
  }
  async function datapackInstall(input, destDir) {
    const slug = parseSlug(input);
    const url = `${modrinthApi}/project/${enc(slug)}/version?game_versions=${enc(JSON.stringify([mc]))}&loaders=${enc(JSON.stringify(['datapack']))}&include_changelog=false`;
    const versions = await getJson(url);
    const v = versions.find(x => x.version_type === 'release') || versions[0];
    if (!v) fail(404, `${slug} has no data pack for Minecraft ${mc}`);
    const file = v.files.find(f => f.primary) || v.files[0];
    const name = String(file?.filename || '').replace(/[^\w.+() -]/g, '_');
    if (!file?.hashes?.sha512 || !/\.zip$/i.test(name)) fail(502, 'the site sent no usable data pack file, refused');
    await fsp.mkdir(destDir, { recursive: true });
    const tmp = path.join(destDir, name + '.part-' + crypto.randomBytes(4).toString('hex'));
    await downloadVerified(file.url, tmp, { hash: { algo: 'sha512', hex: file.hashes.sha512 }, hostOk, max: 100 * 1024 * 1024, allowHttp: extraHosts.length > 0 });
    const names = (await zip.list(tmp).catch(() => [])).map(e => e.name);
    if (!names.includes('pack.mcmeta')) { await fsp.rm(tmp, { force: true }); fail(502, name + ' is not a data pack (no pack.mcmeta), refused'); }
    await fsp.rename(tmp, path.join(destDir, name));
    return { name };
  }

  const cf = pathAndQuery => {
    if (!curseKey) fail(412, 'CurseForge needs your own free API key (console.curseforge.com): run the panel installer again and add it (see the README)');
    return getJson(curseApi + pathAndQuery, { headers: { 'x-api-key': curseKey } });
  };
  const loaderType = () => {
    needDir();
    if (!CF.loader[sw.loaders[0]]) fail(409, 'CurseForge search here only covers Fabric, Forge and NeoForge mods; use Modrinth for plugins');
    return CF.loader[sw.loaders[0]];
  };

  async function curseSearch(query) {
    const lt = loaderType();
    const sort = query ? '' : '&sortField=2&sortOrder=desc';
    const r = await cf(`/v1/mods/search?gameId=${CF.game}&classId=${CF.mods}&searchFilter=${enc(query)}&gameVersion=${enc(mc)}&modLoaderType=${lt}&pageSize=20${sort}`);
    return r.data.map(x => ({
      id: String(x.id), title: x.name, description: x.summary, author: x.authors?.[0]?.name || '', downloads: x.downloadCount,
      note: x.allowModDistribution === false ? 'the author only allows downloads on curseforge.com' : '',
    }));
  }

  async function curseInstall(input) {
    const lt = loaderType();
    let id = /^\d+$/.test(input) ? input : '';
    if (!id) {
      const m = /curseforge\.com\/minecraft\/mc-mods\/([\w-]+)/.exec(input);
      if (!m) fail(400, 'that is not a CurseForge link or mod number');
      const r = await cf(`/v1/mods/search?gameId=${CF.game}&classId=${CF.mods}&slug=${enc(m[1])}`);
      if (!r.data[0]) fail(404, 'no such mod on CurseForge');
      id = String(r.data[0].id);
    }
    const items = [], warnings = [], seen = new Set([id]);
    async function plan(modId, target, depth) {
      const r = await cf(`/v1/mods/${modId}/files?gameVersion=${enc(mc)}&modLoaderType=${lt}&pageSize=30`);
      const files = r.data.filter(f => f.isAvailable !== false)
        .sort((a, b) => (b.releaseType === 1) - (a.releaseType === 1) || Date.parse(b.fileDate) - Date.parse(a.fileDate));
      const f = files[0];
      const problem = !f ? `no ${sw.label} file for Minecraft ${mc}` : !f.downloadUrl ? 'the author does not allow downloads outside CurseForge: download it on its CurseForge page and upload it under "Add mods"' : !f.hashes?.some(h => h.algo === CF.sha1) ? 'CurseForge sent no checksum' : '';
      if (problem) {
        const name = (await cf(`/v1/mods/${modId}`)).data?.name || 'mod ' + modId;
        if (target) fail(409, `${name}: ${problem}`);
        return void warnings.push(`${name} (needed by it) was not installed: ${problem}`);
      }
      items.push({ target, file: { name: f.fileName, url: f.downloadUrl, hash: { algo: 'sha1', hex: f.hashes.find(h => h.algo === CF.sha1).value } } });
      if (depth >= 4 || items.length > 20) return;
      for (const d of f.dependencies || []) {
        if (d.relationType !== CF.required || seen.has(String(d.modId))) continue;
        seen.add(String(d.modId));
        await plan(d.modId, false, depth + 1);
      }
    }
    await plan(id, true, 0);
    return installFiles(items, warnings);
  }

  return { modUpdates, modUpdate, bedrockInstall, modrinthSearch, modrinthInstall, curseSearch, curseInstall, curseConfigured: !!curseKey, packSearch, packResolve, datapackSearch, datapackInstall };
};
