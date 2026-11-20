'use strict';
const { spawn, execFile } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');
const { fail, ping } = require('./common');

const IS_WIN = process.platform === 'win32';
const KEEP_LINES = 1500;
const STOP_WAIT_MS = 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const procs = new Map();

function launchArgs(dir) {
  if (IS_WIN) return ['cmd.exe', ['/d', '/s', '/c', `"${path.join(dir, 'launch.cmd')}"`], { windowsVerbatimArguments: true }];
  return ['/bin/sh', [path.join(dir, 'launch.sh')], {}];
}

function killTree(child) {
  if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill('SIGKILL');
}

function makeProcessSys({ dir, port }) {
  const running = () => { const p = procs.get(dir); return p && !p.exit ? p : null; };

  async function start() {
    if (running()) fail(409, 'the server is already running');
    const [cmd, args, opt] = launchArgs(dir);
    const file = path.join(dir, IS_WIN ? 'launch.cmd' : 'launch.sh');
    if (!await fsp.stat(file).then(() => true, () => false)) fail(409, 'this server has no start file yet: change its software or create it again');
    const child = spawn(cmd, args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...opt });
    const p = { child, startedAt: Date.now(), exit: null, stopping: false, lines: [], partial: '' };
    const take = chunk => {
      const parts = (p.partial + chunk.toString('utf8')).split(/\r?\n/);
      p.partial = parts.pop();
      p.lines.push(...parts);
      if (p.lines.length > KEEP_LINES) p.lines.splice(0, p.lines.length - KEEP_LINES);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.stdin.on('error', () => {});
    p.done = new Promise(resolve => {
      child.on('error', e => { p.lines.push(`[panel] could not start: ${e.message}`); p.exit = { code: -1 }; resolve(); });
      child.on('close', code => { if (p.partial) p.lines.push(p.partial); p.exit = { code: p.stopping ? 0 : code }; resolve(); });
    });
    procs.set(dir, p);
  }

  async function stop() {
    const p = running();
    if (!p) return;
    p.stopping = true;
    p.child.stdin.write('stop\n');
    await Promise.race([p.done, sleep(STOP_WAIT_MS)]);
    if (!p.exit) { p.lines.push('[panel] it did not stop by itself, ending it'); killTree(p.child); await Promise.race([p.done, sleep(10000)]); }
  }

  return {
    async state() {
      const p = procs.get(dir);
      if (p && !p.exit) return { active: p.stopping ? 'deactivating' : 'active', uptime: Math.round((Date.now() - p.startedAt) / 1000), memMB: null };
      return { active: p && p.exit.code !== 0 ? 'failed' : 'inactive', uptime: 0, memMB: null };
    },
    async power(action) {
      if (action === 'start') return start();
      if (action === 'stop') return stop();
      await stop();
      return start();
    },
    async command(line) {
      const p = running();
      if (!p) fail(409, 'the server is not running');
      p.child.stdin.write(line + '\n');
    },
    async log(n) {
      const p = procs.get(dir);
      if (p) return p.lines.slice(-n).join('\n') + '\n';
      const buf = await fsp.readFile(path.join(dir, 'logs', 'latest.log')).catch(() => Buffer.alloc(0));
      return buf.toString('utf8', Math.max(0, buf.length - 64 * 1024)).split(/\r?\n/).slice(-n).join('\n');
    },
    ping: async () => ping(await port()),
  };
}

const stopAll = () => Promise.all([...procs.values()].filter(p => !p.exit).map(async p => {
  p.stopping = true;
  p.child.stdin.write('stop\n');
  await Promise.race([p.done, sleep(STOP_WAIT_MS)]);
  if (!p.exit) killTree(p.child);
}));

module.exports = { makeProcessSys, stopAll };
