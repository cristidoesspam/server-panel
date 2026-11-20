'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashPassword } = require('./password');

const DATA = path.resolve(process.env.PANEL_DATA || path.join(os.homedir(), '.minecraft-panel'));
const kind = process.argv[2];

if (kind === '--needed') {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(path.join(DATA, 'access.json'), 'utf8')); } catch { }
  const hasOwner = Object.values(d.people || {}).some(p => p.owner);
  process.exit(hasOwner || (d.password && d.password.owner) ? 1 : 0);
}
if (kind !== 'owner' && kind !== 'guest') { console.error('Use:  node set-password.js owner   (or guest)'); process.exit(2); }

function readHidden(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    if (!process.stdin.isTTY) { let s = ''; process.stdin.on('data', d => { s += d; }); process.stdin.on('end', () => resolve(s.replace(/\r?\n$/, ''))); return; }
    let s = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); return resolve(s); }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

(async () => {
  let pw;
  if (process.argv.includes('--stdin')) pw = await readHidden('');
  else {
    pw = await readHidden(`New ${kind === 'owner' ? 'owner' : 'friends'} password (8 or more characters, nothing shows while you type): `);
    if (pw !== await readHidden('Type it again: ')) { console.error('The two did not match. Nothing was changed.'); process.exit(1); }
  }
  let h;
  try { h = hashPassword(pw); } catch (e) { console.error(e.message); process.exit(1); }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'set-password.json'), JSON.stringify({ kind, ...h }), { mode: 0o600 });
  console.log(`Done. The ${kind === 'owner' ? 'owner' : 'friends'} password is set. The panel picks it up in a moment; type it on the panel's sign-in screen.`);
})();
