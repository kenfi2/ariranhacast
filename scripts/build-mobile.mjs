// Gera a página do app Android em mobile/www (o Capacitor empacota essa pasta no APK).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'mobile', 'www');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
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
  define: { __VERSION__: JSON.stringify(version) },
  // @capacitor/core vem do pacote do app Android
  nodePaths: [join(root, 'mobile', 'node_modules')],
  logLevel: 'info',
});
for (const f of ['index.html', 'style.css']) cpSync(join(root, 'src/mobile', f), join(out, f));
cpSync(join(root, 'assets/icon.png'), join(out, 'icon.png'));
cpSync(join(root, 'node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js'), join(out, 'rnnoise-worklet.js'));
