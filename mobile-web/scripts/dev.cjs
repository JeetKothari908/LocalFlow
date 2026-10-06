// A build plus static server keeps the preview identical to the bundled UI.
const { spawnSync } = require('child_process');
const result = spawnSync(process.execPath, [require.resolve('./build.cjs')], { stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
if (result.status !== 0) process.exit(result.status || 1);
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '../dist/bundle');
http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(file));
}).listen(8093, '127.0.0.1', () => console.log('Mobile preview: http://127.0.0.1:8093/?preview=1'));
