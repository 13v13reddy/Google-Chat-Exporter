'use strict';

const fs = require('node:fs');
const path = require('node:path');

function files(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative) : [relative];
  });
}

function checkSources(root = path.join(__dirname, '..')) {
  const chrome = path.join(root, 'chrome');
  const firefox = path.join(root, 'firefox');
  const shared = new Set([...files(chrome), ...files(firefox)]);
  shared.delete('manifest.json');
  for (const file of shared) {
    const a = path.join(chrome, file), b = path.join(firefox, file);
    if (!fs.existsSync(a) || !fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))) {
      throw new Error(`Browser sources differ: ${file}. Keep shared files identical; only manifest.json may differ.`);
    }
  }
}

if (require.main === module) {
  checkSources();
  console.log('Chrome and Firefox shared sources match.');
}

module.exports = { checkSources };
