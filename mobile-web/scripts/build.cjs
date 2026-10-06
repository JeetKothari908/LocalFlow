const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const config = require('../webpack.config.cjs');
webpack(config, (error, stats) => {
  if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1; return; }
  const destination = path.resolve(__dirname, '../../app/MobileWeb');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['index.html', 'app.js', 'app.css']) fs.copyFileSync(path.join(config.output.path, name), path.join(destination, name));
  const crypto = require('crypto');
  const hashes = Object.fromEntries(['index.html', 'app.js', 'app.css'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, name))).digest('hex')]));
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ protocol: 1, sourceHash: require('./source-hash.cjs')(), hashes }, null, 2));
  console.log(stats.toString({ all: false, timings: true, assets: true }));
  console.log('Bundled mobile interface copied to app/MobileWeb.');
});
