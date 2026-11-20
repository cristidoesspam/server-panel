'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fail } = require('./common');

const DISCORD = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,100}$/;
const TOPIC = /^[A-Za-z0-9_-]{6,64}$/;
const LABELS = { crash: 'A server crashes', start: 'A server starts', stop: 'A server stops', join: 'A player joins', leave: 'A player leaves' };
const DEFAULTS = { crash: true, start: true, stop: true, join: true, leave: false };

module.exports = function makeAlerts({ dir, base = process.env.ALERT_TEST_BASE || '', log = console.log }) {
  const file = path.join(dir, 'alerts.json');
  let cfg = { discord: '', ntfy: '', events: { ...DEFAULTS } };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { }
  cfg.events = { ...DEFAULTS, ...cfg.events };
  const save = () => fsp.mkdir(dir, { recursive: true }).then(() => fsp.writeFile(file, JSON.stringify(cfg), { mode: 0o600 }));

  const view = () => ({ discord: !!cfg.discord, ntfy: cfg.ntfy, events: cfg.events, labels: LABELS });
  async function set(b) {
    if (b.clearDiscord) cfg.discord = '';
    if (typeof b.discord === 'string' && b.discord.trim()) {
      if (!base && !DISCORD.test(b.discord.trim())) fail(400, 'that is not a Discord webhook address (it starts with https://discord.com/api/webhooks/)');
      cfg.discord = b.discord.trim();
    }
    if (typeof b.ntfy === 'string') {
      if (b.ntfy.trim() && !TOPIC.test(b.ntfy.trim())) fail(400, 'a topic is 6 to 64 letters, digits, - or _');
      cfg.ntfy = b.ntfy.trim();
    }
    for (const k of Object.keys(LABELS)) if (b.events && typeof b.events[k] === 'boolean') cfg.events[k] = b.events[k];
    await save();
  }

  async function post(url, body, headers) {
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
      if (!r.ok) log('alert not delivered:', r.status);
    } catch (e) { log('alert not delivered:', e.message); }
  }
  async function send(event, text) {
    if (event && !cfg.events[event]) return;
    const jobs = [];
    if (cfg.discord) jobs.push(post(base ? base + '/discord' : cfg.discord, JSON.stringify({ content: text }), { 'content-type': 'application/json' }));
    if (cfg.ntfy) jobs.push(post(base ? `${base}/ntfy/${cfg.ntfy}` : `https://ntfy.sh/${cfg.ntfy}`, text, { Title: 'Server Panel' }));
    await Promise.all(jobs);
  }

  function watch(registry) {
    const seen = new Map();
    return async function check() {
      for (const i of registry.all()) {
        try {
          const st = (await i.sys.state()).active;
          const g = st === 'active' ? await i.sys.ping() : null;
          const names = new Set(g?.names || []);
          const prev = seen.get(i.id);
          const name = i.entry.name;
          if (prev) {
            if (prev.st !== 'active' && st === 'active') await send('start', `${name} started.`);
            else if (prev.st === 'active' && (st === 'failed' || st === 'activating')) await send('crash', `${name} crashed.`);
            else if (prev.st === 'active' && (st === 'inactive' || st === 'deactivating')) await send('stop', `${name} stopped.`);
            if (st === 'active') {
              for (const n of names) if (!prev.names.has(n)) await send('join', `${n} joined ${name}.`);
              for (const n of prev.names) if (!names.has(n) && g) await send('leave', `${n} left ${name}.`);
            }
          }
          seen.set(i.id, { st, names });
        } catch (e) { log(`[${i.id}] alerts:`, e.message); }
      }
    };
  }
  return { view, set, send, watch };
};
