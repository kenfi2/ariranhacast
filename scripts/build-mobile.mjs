// Gera a página do app Android em mobile/www (o Capacitor empacota essa pasta no APK).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChangelog } from './changelog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'mobile', 'www');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const lobbyUrl = typeof pkg.ariranhacast?.lobbyUrl === 'string' ? pkg.ariranhacast.lobbyUrl : '';
const updateUrl = typeof pkg.ariranhacast?.updateUrl === 'string' ? pkg.ariranhacast.updateUrl : '';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'src/mobile/app.ts')],
  outfile: join(out, 'app.js'),
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  loader: { '.wasm': 'binary' },
  define: { __VERSION__: JSON.stringify(version), __LOBBY_URL__: JSON.stringify(lobbyUrl), __UPDATE_URL__: JSON.stringify(updateUrl), __CHANGELOG__: JSON.stringify(loadChangelog(version)) },
  // @capacitor/core vem do pacote do app Android
  nodePaths: [join(root, 'mobile', 'node_modules')],
  logLevel: 'info',
});
for (const f of ['index.html', 'style.css']) cpSync(join(root, 'src/mobile', f), join(out, f));
cpSync(join(root, 'assets/icon.png'), join(out, 'icon.png'));
cpSync(join(root, 'node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js'), join(out, 'rnnoise-worklet.js'));
