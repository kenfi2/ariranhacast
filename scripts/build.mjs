import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { loadChangelog } from './changelog.mjs';

mkdirSync('dist', { recursive: true });
const common = { bundle: true, sourcemap: false, minify: false, logLevel: 'info' };

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js',
  platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js',
  platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js',
  platform: 'browser', format: 'iife', target: 'chrome130', loader: { '.wasm': 'binary' },
  // Página "Novidades": o CHANGELOG.md vai junto no app (funciona sem internet).
  define: { __CHANGELOG__: JSON.stringify(loadChangelog()) } });

await build({ ...common, entryPoints: ['src/overlay-preload.ts'], outfile: 'dist/overlay-preload.js',
  platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/overlay.ts'], outfile: 'dist/renderer/overlay.js',
  platform: 'browser', format: 'iife', target: 'chrome130' });
cpSync('src/renderer/overlay.html', 'dist/renderer/overlay.html');
cpSync('src/renderer/overlay.css', 'dist/renderer/overlay.css');
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('assets/tray.png', 'dist/tray.png');
cpSync('assets/icon.png', 'dist/icon.png');
cpSync('assets/icon.png', 'dist/renderer/icon.png');
cpSync('src/renderer/style.css', 'dist/renderer/style.css');
cpSync('src/renderer/pcm-worklet.js', 'dist/renderer/pcm-worklet.js');
cpSync('src/renderer/tap-worklet.js', 'dist/renderer/tap-worklet.js');
// Processador de áudio da supressão por IA (roda na thread de áudio, fora do bundle).
cpSync('node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js', 'dist/renderer/rnnoise-worklet.js');
