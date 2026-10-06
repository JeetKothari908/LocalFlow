const fs = require('fs'), path = require('path'), crypto = require('crypto');
module.exports = function sourceHash() {
  const root = path.resolve(__dirname, '../..');
  const hash = crypto.createHash('sha256');
  function visit(relative) {
    const absolute = path.join(root, relative);
    if (fs.statSync(absolute).isDirectory()) { for (const name of fs.readdirSync(absolute).sort()) visit(relative + '/' + name); }
    else if (!relative.includes('.test.')) { hash.update(relative); hash.update(fs.readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n')); }
  }
  for (const relative of ['packages/core/src', 'packages/ui/src', 'packages/platform/src', 'mobile-web/src', 'mobile-web/index.html', 'mobile-web/webpack.config.cjs', 'mobile-web/tsconfig.json', 'mobile-web/scripts/build.cjs', 'package-lock.json']) visit(relative);
  return hash.digest('hex');
};
