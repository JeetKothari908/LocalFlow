const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../app/MobileWeb');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
if (manifest.protocol !== 1) throw new Error('Unexpected bridge version');
for (const name of ['index.html', 'app.js', 'app.css']) if (!manifest.hashes?.[name]) throw new Error(`Missing required asset: ${name}`);
if (manifest.sourceHash !== require('./source-hash.cjs')()) throw new Error('Mobile sources changed. Run npm run build:mobile before building iOS.');
for (const [name, expected] of Object.entries(manifest.hashes)) {
  const value = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
  if (value !== expected) throw new Error(`Mobile bundle mismatch: ${name}`);
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (/\b(?:src|href)="(?:\/|https?:)/.test(html)) throw new Error('Bundle must use relative local assets');
console.log('Verified bundled mobile assets and protocol.');
