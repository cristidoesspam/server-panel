'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { fail } = require('./common');

const NAME = /^world-\d{8}-\d{6}(-\d+)?\.tar\.gz$/;
const REMOTE = /^[A-Za-z0-9_.-]{2,40}:[A-Za-z0-9_ ./-]{0,200}$/;
const order = n => { const m = /^world-(\d{8}-\d{6})(?:-(\d+))?\.tar\.gz$/.exec(n); return m[1] + '-' + String(m[2] || 1).padStart(4, '0'); };
const byAge = (a, b) => order(a).localeCompare(order(b));
const SERVER_ID = /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/;

function rclone(args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const p = spawn(process.env.PANEL_RCLONE || 'rclone', args, { windowsHide: true });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'rclone is not installed on this computer (see rclone.org/install)' : e.message)); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error((err.trim().split('\n').pop() || 'rclone failed').slice(0, 200))); });
  });
}

module.exports = function makeOffsite({ dir }) {
  const file = path.join(dir, 'offsite.json');
  let cfg = { folder: '', rclone: '', keep: 10 };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { }
  const last = { at: 0, ok: null, message: '' };
  let queue = Promise.resolve();

  const view = () => ({ folder: cfg.folder, rclone: cfg.rclone, keep: cfg.keep, last: { ...last } });

  async function set(b) {
    const next = { ...cfg };
    if (b.folder !== undefined) {
      const f = String(b.folder).trim();
      if (f) {
        if (!path.isAbsolute(f) || /\0/.test(f)) fail(400, 'Give the whole path of a folder, for example /media/usb/minecraft or D:\\minecraft-backups');
        const st = await fsp.stat(f).catch(() => null);
        if (!st || !st.isDirectory()) fail(400, 'That folder does not exist on this computer. Make it (or plug the drive in) first.');
        const probe = path.join(f, '.panel-write-test');
        await fsp.writeFile(probe, 'ok').then(() => fsp.rm(probe, { force: true })).catch(() => fail(400, 'The panel cannot write into that folder.'));
      }
      next.folder = f;
    }
    if (b.rclone !== undefined) {
      const r = String(b.rclone).trim().replace(/\/+$/, '');
      if (r) {
        if (!REMOTE.test(r)) fail(400, 'A cloud address looks like gdrive:minecraft-backups (the name from "rclone config", a colon, a folder).');
        await rclone(['lsd', r.split(':')[0] + ':', '--max-depth', '0'], 60000).catch(e => fail(400, 'rclone could not open that cloud: ' + e.message));
      }
      next.rclone = r;
    }
    if (b.keep !== undefined) {
      const n = Number(b.keep);
      if (!Number.isInteger(n) || n < 1 || n > 100) fail(400, 'Copies to keep per server: a whole number from 1 to 100');
      next.keep = n;
    }
    cfg = next;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(cfg), { mode: 0o600 });
  }

  async function copy(serverId, src, name) {
    if (!NAME.test(name) || !SERVER_ID.test(serverId) || (!cfg.folder && !cfg.rclone)) return;
    const problems = [];
    if (cfg.folder) {
      try {
        const to = path.join(cfg.folder, serverId);
        await fsp.mkdir(to, { recursive: true });
        await fsp.copyFile(src, path.join(to, name + '.part'));
        await fsp.rename(path.join(to, name + '.part'), path.join(to, name));
        const mine = (await fsp.readdir(to)).filter(n => NAME.test(n)).sort(byAge);
        for (const old of mine.slice(0, Math.max(0, mine.length - cfg.keep))) await fsp.rm(path.join(to, old), { force: true });
      } catch (e) { problems.push('folder: ' + e.message); }
    }
    if (cfg.rclone) {
      try {
        const to = `${cfg.rclone}/${serverId}`;
        await rclone(['copyto', src, `${to}/${name}`]);
        const mine = (await rclone(['lsf', to])).split('\n').map(s => s.trim()).filter(n => NAME.test(n)).sort(byAge);
        for (const old of mine.slice(0, Math.max(0, mine.length - cfg.keep))) await rclone(['deletefile', `${to}/${old}`], 120000).catch(() => {});
      } catch (e) { problems.push('cloud: ' + e.message); }
    }
    Object.assign(last, { at: Date.now(), ok: !problems.length, message: problems.length ? problems.join('; ') : `Copied ${name} (${serverId})` });
    console.log('offsite:', last.message);
  }
  const send = (serverId, src, name) => (queue = queue.then(() => copy(serverId, src, name)).catch(() => {}));

  return { view, set, send, enabled: () => !!(cfg.folder || cfg.rclone) };
};
