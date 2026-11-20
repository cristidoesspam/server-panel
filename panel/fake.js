'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function makeFake(ROOT, startRunning = true) {
  let running = startRunning;
  let since = Date.now();
  let failed = false;
  let tps = 20, mspt = 4;
  let online = 1;
  const lines = [
    '[12:00:01] [Server thread/INFO]: Done (3.2s)! For help, type "help"',
    '[12:00:20] [Server thread/INFO]: Steve joined the game',
  ];
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return []; } };
  const write = (f, v) => fs.writeFileSync(path.join(ROOT, f), JSON.stringify(v));
  return {
    async state() {
      return { active: running ? 'active' : failed ? 'failed' : 'inactive', uptime: running ? Math.round((Date.now() - since) / 1000) : 0, memMB: running ? 1234 : null };
    },
    async power(action) {
      running = action !== 'stop';
      failed = false;
      if (running) since = Date.now();
      lines.push('[panel-test] ' + action);
    },
    async command(line) {
      if (!running) throw Object.assign(new Error('the server is not running'), { status: 409 });
      lines.push('[12:01:00] [Server thread/INFO]: [panel-test] ' + line);
      const [cmd, a, b] = line.split(' ');
      const say = (...l) => lines.push(...l.map(x => '[12:01:02] [Server thread/INFO]: ' + x));
      const quoted = (/"([^"]+)"/.exec(line) || [])[1];
      if (cmd === 'allowlist' && a === 'add') write('allowlist.json', [...read('allowlist.json'), { ignoresPlayerLimit: false, name: quoted || b }]);
      if (cmd === 'allowlist' && a === 'remove') write('allowlist.json', read('allowlist.json').filter(p => p.name !== (quoted || b)));
      if (line === 'save hold') say('Saving...');
      if (line === 'save query') say('Data saved. Files are now ready to be copied.');
      if (line === 'save resume') say('Changes to the world are resumed.');
      if (cmd === 'fwhitelist' && a === 'add') write('whitelist.json', [...read('whitelist.json'), { uuid: 'x', name: '.' + b }]);
      if (cmd === 'fwhitelist' && a === 'remove') write('whitelist.json', read('whitelist.json').filter(p => p.name !== '.' + b));
      if (cmd === 'whitelist' && a === 'add') write('whitelist.json', [...read('whitelist.json'), { uuid: 'x', name: b }]);
      if (cmd === 'whitelist' && a === 'remove') write('whitelist.json', read('whitelist.json').filter(p => p.name !== b));
      if (cmd === 'op') write('ops.json', [...read('ops.json'), { uuid: 'x', name: a, level: 4 }]);
      if (cmd === 'deop') write('ops.json', read('ops.json').filter(p => p.name !== a));
      if (line === 'spark health' || line === 'spark tps') say('TPS from last 5s, 10s, 1m, 5m, 15m:', ' ' + [tps, tps, tps, tps, tps].join(', '), 'Tick durations (min/med/95%ile/max ms) from last 10s, 1m:', ' 1.1/' + mspt + '/' + mspt * 2 + '/9.3;  1.0/' + mspt + '/' + mspt * 2 + '/12.1');
      if (line === 'tick query') say('The game is running normally', 'Average time per tick: ' + mspt + 'ms (Target: 50.0ms)');
      if (line === 'spark profiler start --timeout 60') say('Profiler stopped & upload complete! Results: https://spark.lucko.me/AbCd123');
      if (cmd === 'chunky' && a === 'start') say('[Chunky] Task running for minecraft:overworld. Processed: 100 chunks (1.5%), ETA: 0:01:02, Rate: 55.1 cps, Current: 3, 4');
      if (line === 'save-all flush') lines.push('[12:01:01] [Server thread/INFO]: Saved the game');
    },
    async log(n) { return lines.slice(-n).join('\n') + '\n'; },
    async ping() { return running ? { online, max: 10, names: online ? ['Steve'] : [], version: '26.3' } : null; },
    setOnline(n) { online = n; },
    setSpeed(t, m) { tps = t; mspt = m; },
    crash() { running = false; failed = true; },
  };
};
