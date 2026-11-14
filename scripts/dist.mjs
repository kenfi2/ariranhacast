// Gera em release/: o instalador (AriranhaCast-Setup-<versão>.exe), a versão portátil (.zip)
// e, se "ariranhacast.updateUrl" estiver preenchido em package.json, o latest.yml da
// atualização automática. Funciona em Windows, Linux ou macOS.
//   ELECTRON_DIST  pasta com o Electron para Windows já extraído (evita baixar)
//   MAKENSIS       caminho do makensis (senão procura no cache do electron-builder e no PATH)
import { build, Platform } from 'electron-builder';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { hardenExe } from './harden-exe.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const updateUrl = String(pkg.ariranhacast?.updateUrl ?? '');
if (updateUrl && !updateUrl.startsWith('https://')) throw new Error('ariranhacast.updateUrl precisa começar com https://');

// 1. Pasta do app (Electron + nosso código), com o executável endurecido.
let appDir = '';
rmSync('release', { recursive: true, force: true });
await build({
  targets: Platform.WINDOWS.createTarget('dir', 'x64'),
  config: {
    appId: 'dev.ariranhacast.app',
    productName: 'AriranhaCast',
    directories: { output: 'release' },
    files: ['dist/**/*', 'native/audiocap.exe', 'package.json'],
    asar: false,
    npmRebuild: false,
    ...(process.env.ELECTRON_DIST ? { electronDist: process.env.ELECTRON_DIST } : {}),
    win: { signAndEditExecutable: false },
    publish: null,
    afterPack: async (ctx) => {
      appDir = ctx.appOutDir;
      await hardenExe(join(appDir, 'AriranhaCast.exe'), version);
    },
  },
});
rmSync(join(appDir, 'resources', 'default_app.asar'), { force: true }); // app de exemplo do Electron: não é usado
if (updateUrl) {
  writeFileSync(join(appDir, 'resources', 'app-update.yml'), `provider: generic\nurl: ${JSON.stringify(updateUrl)}\nupdaterCacheDirName: ariranhacast-updater\n`);
}

// 2. Instalador (NSIS).
function findMakensis() {
  if (process.env.MAKENSIS) return { bin: process.env.MAKENSIS, env: {} };
  const cache = join(homedir(), '.cache', 'electron-builder');
  if (process.platform !== 'win32' && existsSync(cache)) {
    for (const a of readdirSync(cache).filter((d) => d.startsWith('nsis-3'))) {
      for (const b of readdirSync(join(cache, a))) {
        const bin = join(cache, a, b, process.platform === 'darwin' ? 'mac' : 'linux', 'makensis');
        if (existsSync(bin)) return { bin, env: { NSISDIR: join(cache, a, b) } };
      }
    }
  }
  return { bin: 'makensis', env: {} };
}
const setup = `AriranhaCast-Setup-${version}.exe`;
const { bin, env } = findMakensis();
execFileSync(bin, ['-V2', `-DSRC=${resolve(appDir)}`, `-DOUT=${resolve('release', setup)}`, `-DVERSION=${version}`, 'scripts/installer.nsi'], {
  stdio: 'inherit',
  env: { ...process.env, ...env },
});

// 3. Versão portátil.
const zipName = `AriranhaCast-portatil-${version}.zip`;
try {
  rmSync(join('release', 'AriranhaCast'), { recursive: true, force: true });
  execFileSync('cp', ['-r', appDir, join('release', 'AriranhaCast')]);
  execFileSync('cp', ['README.md', join('release', 'AriranhaCast', 'LEIA-ME.md')]);
  execFileSync('cp', ['SEGURANCA.md', join('release', 'AriranhaCast', 'SEGURANCA.md')]);
  execFileSync('zip', ['-qr', zipName, 'AriranhaCast'], { cwd: 'release' });
  rmSync(join('release', 'AriranhaCast'), { recursive: true, force: true });
} catch {
  console.log('zip indisponível: versão portátil não gerada');
}

// 4. Metadados da atualização automática e hashes para conferência.
const hash = (file, algo, enc) => createHash(algo).update(readFileSync(file)).digest(enc);
const setupPath = join('release', setup);
if (updateUrl) {
  const sha512 = hash(setupPath, 'sha512', 'base64');
  writeFileSync(
    join('release', 'latest.yml'),
    `version: ${version}\nfiles:\n  - url: ${setup}\n    sha512: ${sha512}\n    size: ${statSync(setupPath).size}\npath: ${setup}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`,
  );
}
let sums = '';
for (const f of [setup, zipName]) {
  if (existsSync(join('release', f))) sums += `${hash(join('release', f), 'sha256', 'hex')}  ${f}\n`;
}
writeFileSync(join('release', 'SHA256SUMS.txt'), sums);
console.log(sums);
