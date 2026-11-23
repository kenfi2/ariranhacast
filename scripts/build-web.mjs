// Versão web (o site do AriranhaCast), servida pelo Worker do lobby em /web/:
//   lobby/public/web    — a página do PC (src/renderer) com a ponte do navegador (src/web/shim.ts)
//   lobby/public/web/m  — a página do app Android, para celular (o shim manda o celular para lá)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChangelog } from './changelog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'lobby', 'public', 'web');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'src/web/main.ts')],
  outfile: join(out, 'app.js'),
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  loader: { '.wasm': 'binary' },
  define: { __VERSION__: JSON.stringify(version), __CHANGELOG__: JSON.stringify(loadChangelog()) },
  logLevel: 'info',
});
for (const f of ['index.html', 'style.css', 'pcm-worklet.js']) cpSync(join(root, 'src/renderer', f), join(out, f));
cpSync(join(root, 'assets/icon.png'), join(out, 'icon.png'));
cpSync(join(root, 'node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js'), join(out, 'rnnoise-worklet.js'));

execFileSync(process.execPath, [join(root, 'scripts/build-mobile.mjs'), '--web'], { stdio: 'inherit' });
