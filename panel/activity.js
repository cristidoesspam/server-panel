'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function makeActivity({ dir, maxBytes = 1024 * 1024 }) {
  const file = path.join(dir, 'activity.log');
  fs.mkdirSync(dir, { recursive: true });
  function record(e) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.old');
      fs.appendFileSync(file, JSON.stringify(e) + '\n');
    } catch { }
  }
  const lines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  function list(n = 200) {
    const out = [];
    for (const l of [...lines(file + '.old'), ...lines(file)].slice(-n).reverse()) { try { out.push(JSON.parse(l)); } catch { } }
    return out;
  }
  return { record, list };
};
