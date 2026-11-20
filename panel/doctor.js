'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const GB = 1024 ** 3;
const gb = n => (n / GB).toFixed(1) + ' GB';

module.exports = function makeDoctor({ registry, dataDir, panelPort, version, owner }) {
  const urls = process.env.DOCTOR_URLS ? process.env.DOCTOR_URLS.split(',') : ['https://api.modrinth.com/v2/', 'https://piston-meta.mojang.com/', 'https://download.geysermc.org/', 'https://api.adoptium.net/'];
  const systemd = process.env.PANEL_RUNNER ? process.env.PANEL_RUNNER === 'systemd' : process.platform === 'linux' && fs.existsSync('/run/systemd/system');

  async function run() {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    add('Panel', true, `version ${version}, Node.js ${process.versions.node} on ${process.platform} ${os.arch()}, running for ${Math.round(process.uptime() / 60)} minutes, port ${panelPort}`);
    add('Servers run as', true, systemd ? 'systemd services (they keep running if the panel restarts)' : 'programs started by the panel (they stop when the panel stops)');
    add('Access', !!owner(), owner() ? 'the panel has an owner' : 'nobody owns the panel yet: open the setup link the installer printed');

    try {
      await fsp.mkdir(dataDir, { recursive: true });
      const probe = path.join(dataDir, '.doctor-' + process.pid);
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe);
      add('Panel files', true, 'the panel can write its settings (' + dataDir + ')');
    } catch (e) { add('Panel files', false, 'the panel cannot write to ' + dataDir + ': ' + e.message); }

    try {
      const s = await fsp.statfs(dataDir);
      const free = s.bavail * s.bsize;
      add('Disk space', free >= 5 * GB, `${gb(free)} free where the panel lives${free < 5 * GB ? ' (a world, a backup and Java need room: free some space)' : ''}`);
    } catch { add('Disk space', true, 'could not be measured here'); }

    const total = os.totalmem(), free = os.freemem();
    add('Memory', total >= 2 * GB, `${gb(total)} in the computer, ${gb(free)} free now${total < 2 * GB ? ' (a server needs about 2 GB: use a lighter one, or add memory)' : ''}`);

    const net = await Promise.all(urls.map(async u => {
      try { await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(6000) }); return [u, true]; } catch { return [u, false]; }
    }));
    for (const [u, ok] of net) add('Can reach ' + new URL(u).hostname, ok, ok ? 'yes' : 'no: downloads from there will fail (is the computer online?)');

    const addrs = registry.joinAddresses(25565);
    add('Network addresses', addrs.length > 0, addrs.length ? addrs.map(a => `${a.address} (${a.label})`).join(', ') : 'no home-network or Tailscale address found');

    for (const i of registry.all()) {
      const name = `Server "${i.entry.name}"`;
      try {
        const st = (await i.sys.state()).active;
        const install = await i.getInstall();
        if (install.state === 'failed') { add(name, false, 'the software install failed: ' + (install.error || 'unknown error')); continue; }
        if (install.state === 'running') { add(name, true, 'still installing: ' + (install.step || 'working')); continue; }
        const launcher = i.id === 'main' ? true : await fsp.stat(path.join(i.root, process.platform === 'win32' ? 'launch.cmd' : 'launch.sh')).then(() => true, () => false);
        const game = st === 'active' ? await i.sys.ping() : null;
        add(name, launcher && st !== 'failed', `${i.sw.label} ${i.entry.mc}, ${st}${st === 'active' ? (game ? `, ${game.online}/${game.max} players` : ', not answering yet') : ''}${launcher ? '' : ', the start file is missing (change the software to reinstall)'}`);
      } catch (e) { add(name, false, e.message); }
    }
    const text = checks.map(c => `${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n');
    return { checks, text };
  }
  return { run };
};
