// Build the browser-only demo into dist/ (static files for GitHub Pages).
// The engine bundle is the Node prototype's own server code (service, rules, bot API, routes, mock provider,
// audit, settings) with tiny browser shims for node:crypto/fs/path/url; the UI is public/ unchanged.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(HERE, 'dist');
const S = (...p) => path.join(HERE, 'src', 'shims', ...p);
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'js'), { recursive: true });

const shim = {
  name: 'node-shims',
  setup(b) {
    const map = { 'node:crypto': S('crypto.js'), 'node:fs': S('fs.js'), 'node:path': S('path.js'), 'node:url': S('url.js') };
    b.onResolve({ filter: /^node:(crypto|fs|path|url)$/ }, (a) => ({ path: map[a.path] }));
    // The Plaid adapter is never part of the demo; fail the build if anything pulls it in.
    b.onResolve({ filter: /plaidSandbox\.js$|^plaid$/ }, (a) => ({ errors: [{ text: `demo must not bundle ${a.path}` }] }));
  },
};
await esbuild.build({
  entryPoints: [path.join(HERE, 'src', 'browser-server.js')],
  bundle: true, format: 'esm', platform: 'browser', target: ['es2020', 'safari15'],
  outfile: path.join(DIST, 'js', 'engine.js'), minify: true, sourcemap: false, legalComments: 'none',
  inject: [S('buffer-global.js')], plugins: [shim], loader: { '.json': 'json' },
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: '// Lock & Deploy Vault simulation engine: bundled from server/*.js of the prototype. Fictional money only.' },
});

const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
copy(path.join(ROOT, 'public', 'js', 'app.js'), path.join(DIST, 'js', 'app.js'));
copy(path.join(ROOT, 'public', 'css', 'styles.css'), path.join(DIST, 'css', 'styles.css'));
for (const f of fs.readdirSync(path.join(HERE, 'static', 'icons'))) copy(path.join(HERE, 'static', 'icons', f), path.join(DIST, 'icons', f));
for (const f of ['manifest.webmanifest', '404.html']) copy(path.join(HERE, 'static', f), path.join(DIST, f));
copy(path.join(HERE, 'static', 'js', 'sw-register.js'), path.join(DIST, 'js', 'sw-register.js'));

// Build id = hash of every output file, used for cache-busting and the SW cache name.
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(DIST);
const h = crypto.createHash('sha256');
for (const f of files.sort()) h.update(fs.readFileSync(f));
h.update(fs.readFileSync(path.join(HERE, 'static', 'index.html')));
const BUILD = h.digest('hex').slice(0, 10);

fs.writeFileSync(path.join(DIST, 'index.html'), fs.readFileSync(path.join(HERE, 'static', 'index.html'), 'utf8').replaceAll('__BUILD__', BUILD));
const rel = (p) => './' + path.relative(DIST, p).split(path.sep).join('/');
const assets = ['./', './index.html', ...files.filter((f) => !f.endsWith('404.html')).map(rel).map((r) => (/\/js\/(engine|app|sw-register)\.js$/.test(r) ? `${r}?v=${BUILD}` : r))];
fs.writeFileSync(path.join(DIST, 'sw.js'), fs.readFileSync(path.join(HERE, 'static', 'sw.template.js'), 'utf8').replaceAll('__BUILD__', BUILD).replace('__ASSETS__', JSON.stringify(assets, null, 2)));
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
fs.writeFileSync(path.join(DIST, 'version.json'), JSON.stringify({ build: BUILD, builtAt: new Date().toISOString(), simulation: true, realMoney: false }, null, 2));
console.log(`built dist/ (${BUILD}), engine ${(fs.statSync(path.join(DIST, 'js', 'engine.js')).size / 1024).toFixed(0)} KB, ${assets.length} precached assets`);
