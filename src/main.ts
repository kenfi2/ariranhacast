import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, powerSaveBlocker, session, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dev = !app.isPackaged;

// ---- argumentos de linha de comando ----
// No app distribuído só valem --lc-profile e --lc-name (abrir uma segunda janela para
// testar sozinho). Os demais existem para os testes automatizados e só em desenvolvimento.
const PUBLIC_ARGS = new Set(['profile', 'name']);
const arg = (name: string): string | undefined => {
  if (!dev && !PUBLIC_ARGS.has(name)) return undefined;
  const hit = process.argv.find((a) => a === `--lc-${name}` || a.startsWith(`--lc-${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '1' : hit.slice(eq + 1);
};

const profile = arg('profile');
if (profile && /^[\w-]{1,32}$/.test(path.basename(profile))) {
  // Perfil separado, sempre dentro da pasta de dados do próprio app.
  app.setPath('userData', dev ? path.resolve(profile) : path.join(app.getPath('userData'), 'perfis', path.basename(profile)));
}

// O caminho crítico (captura, encode, rede) roda em C++ dentro do Chromium/libwebrtc.
// Estes switches garantem encoder/decoder por hardware e evitam que o Chromium
// reduza a prioridade do app quando a janela está minimizada ou atrás do jogo.
app.commandLine.appendSwitch(
  'enable-features',
  ['MediaFoundationAV1Encoding', 'PlatformHEVCEncoderSupport', 'WebRtcAllowH265Send', 'WebRtcAllowH265Receive'].join(','),
);
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let pending: { id: string; audio: boolean } | null = null;
let blocker: number | null = null;
let audiocap: ChildProcess | null = null;
let inRoom = false;
let micOn = false;
let quitting = false;
let trayHintShown = false;

const INDEX = path.join(__dirname, 'renderer', 'index.html');
const SOURCE_ID = /^(screen|window):\d{1,20}:\d{1,10}$/;

/** Só a nossa própria janela, carregando a nossa própria página, pode usar o IPC. */
function trusted(e: IpcMainInvokeEvent): boolean {
  if (!win || e.sender !== win.webContents || e.senderFrame !== e.sender.mainFrame) return false;
  try {
    return new URL(e.senderFrame.url).protocol === 'file:';
  } catch {
    return false;
  }
}

function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => R): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('origem não autorizada');
    return fn(...(args as T));
  });
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---------- áudio por aplicativo ----------
function stopAudioCap(): void {
  audiocap?.kill();
  audiocap = null;
}

/**
 * Inicia o audiocap.exe (C++/WASAPI process loopback) e repassa o PCM dele ao renderer.
 * Janela → só o áudio do aplicativo dono da janela. Tela inteira → tudo, menos o
 * próprio AriranhaCast (as vozes do chat não voltam em eco).
 */
function startAudioCap(sourceId: unknown): Promise<{ ok: boolean; reason?: string }> {
  stopAudioCap();
  return new Promise((resolve) => {
    const exe = path.join(__dirname, '..', 'native', 'audiocap.exe');
    if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) return resolve({ ok: false, reason: 'fonte inválida' });
    if (process.platform !== 'win32' || !fs.existsSync(exe)) return resolve({ ok: false, reason: 'indisponível neste sistema' });
    const m = sourceId.match(/^window:(\d+):/);
    // Argumentos sempre numéricos e passados como lista (sem shell): não há como injetar comandos.
    const args = m ? ['--include-hwnd', m[1]] : ['--exclude-pid', String(process.pid)];
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    audiocap = child;
    let settled = false;
    const settle = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!ok && audiocap === child) stopAudioCap();
      resolve({ ok, reason });
    };
    const timeout = setTimeout(() => settle(false, 'sem resposta'), 6000);
    let err = '';
    child.stderr!.on('data', (d: Buffer) => {
      if (err.length < 2000) err += d.toString();
      if (err.includes('READY')) settle(true);
    });
    let rest: Buffer = Buffer.alloc(0);
    child.stdout!.on('data', (d: Buffer) => {
      // entrega sempre quadros inteiros (4 bytes = 1 amostra estéreo de 16 bits)
      const all = rest.length ? Buffer.concat([rest, d]) : d;
      const usable = all.length - (all.length % 4);
      rest = all.subarray(usable);
      if (usable) send('lc:pcm', all.subarray(0, usable));
    });
    child.on('error', (e) => settle(false, e.message));
    child.on('exit', (code) => {
      settle(false, err.trim().slice(0, 200) || `código ${code}`);
      if (audiocap === child) audiocap = null;
    });
  });
}

// ---------- atalhos globais ----------
// Exige um modificador (ou tecla de função), para nunca "engolir" uma tecla comum do sistema.
const ACCELERATOR = /^(?:(?:Ctrl|Alt|Shift|Super)\+){1,3}(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|num[0-9])$|^F(?:[1-9]|1\d|2[0-4])$/;

function setHotkeys(keys: unknown): { mic: boolean; deaf: boolean } {
  globalShortcut.unregisterAll();
  const result = { mic: false, deaf: false };
  if (!keys || typeof keys !== 'object') return result;
  const { mic, deaf } = keys as { mic?: unknown; deaf?: unknown };
  const reg = (accel: unknown, which: 'mic' | 'deaf'): boolean => {
    if (typeof accel !== 'string' || !ACCELERATOR.test(accel)) return false;
    try {
      return globalShortcut.register(accel, () => send('lc:hotkey', which));
    } catch {
      return false;
    }
  };
  result.mic = reg(mic, 'mic');
  if (deaf !== mic) result.deaf = reg(deaf, 'deaf');
  return result;
}

// ---------- bandeja ----------
function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function refreshTray(): void {
  if (!tray) return;
  tray.setToolTip(inRoom ? `AriranhaCast · na sala · microfone ${micOn ? 'ligado' : 'desligado'}` : 'AriranhaCast');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir o AriranhaCast', click: showWindow },
      { type: 'separator' },
      { label: micOn ? 'Desligar microfone' : 'Ligar microfone', enabled: inRoom, click: () => send('lc:hotkey', 'mic') },
      { label: 'Silenciar / ouvir vozes', enabled: inRoom, click: () => send('lc:hotkey', 'deaf') },
      { label: 'Sair da sala', enabled: inRoom, click: () => send('lc:hotkey', 'leave') },
      { type: 'separator' },
      {
        label: 'Fechar o AriranhaCast',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
    tray.on('click', showWindow);
    refreshTray();
  } catch {
    tray = null; // sem bandeja (ambiente sem suporte): fechar a janela encerra o app
  }
}

// ---------- atualização automática ----------
// Só existe no app instalado pelo instalador e só quando o pacote foi gerado com
// "ariranhacast.updateUrl" (HTTPS) preenchido em package.json; nesse caso o instalador grava
// resources/app-update.yml, que diz ao electron-updater onde procurar. O arquivo baixado
// é conferido contra o SHA-512 publicado no latest.yml antes de ser instalado.
function startUpdater(): void {
  if (dev) return;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const url: unknown = pkg?.ariranhacast?.updateUrl;
    if (typeof url !== 'string' || !url.startsWith('https://')) return;
    if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('update-downloaded', (info) => send('lc:update', `Versão ${info.version} baixada. Ela será instalada quando você fechar o AriranhaCast.`));
    autoUpdater.on('error', () => {});
    void autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  } catch {
    /* sem atualização automática */
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: 'AriranhaCast',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: dev,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.removeMenu();

  const query: Record<string, string> = {};
  for (const k of ['auto', 'code', 'fake', 'server', 'maxdirect', 'name', 'mic', 'ns', 'cam', 'ice', 'relayonly', 'netcheck', 'pass', 'act', 'realcap']) {
    const v = arg(k);
    if (v !== undefined) query[k] = v.slice(0, 2000);
  }
  void win.loadFile(INDEX, { query });

  if (arg('log')) {
    win.webContents.on('console-message', (e) => {
      if (e.message) console.log(e.message);
    });
  }
  const shot = arg('shot'); // teste: salva uma captura da janela após alguns segundos
  if (shot) {
    setTimeout(async () => {
      const image = await win?.webContents.capturePage();
      if (image) fs.writeFileSync(shot, image.toPNG());
    }, 14000);
  }

  // Numa sala, fechar a janela só a esconde: a conversa continua e o app fica na bandeja.
  win.on('close', (e) => {
    if (quitting || !inRoom || !tray) return;
    e.preventDefault();
    win?.hide();
    if (!trayHintShown && process.platform === 'win32') {
      trayHintShown = true;
      tray.displayBalloon({ title: 'AriranhaCast continua aberto', content: 'Você ainda está na sala. Use o ícone da bandeja para voltar ou sair.' });
    }
  });
  win.on('closed', () => (win = null));
}

// A janela só exibe a página do próprio app: nada de navegar, abrir janelas ou embutir páginas.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(() => {
  // Permissões: só o que o app usa (microfone/câmera, captura de tela, escolher saída de
  // áudio, tela cheia, copiar o código). Todo o resto é negado.
  const ALLOWED = new Set(['media', 'display-capture', 'speaker-selection', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === win?.webContents && ALLOWED.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    return contents === win?.webContents && ALLOWED.has(permission);
  });

  // O renderer escolhe a fonte na nossa própria tela de seleção; aqui só entregamos
  // essa fonte ao getDisplayMedia, com o áudio do sistema (loopback WASAPI) se pedido.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        if (!pending) return callback({});
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const source = sources.find((s) => s.id === pending?.id);
        if (!source) return callback({});
        const wantAudio = pending.audio && process.platform === 'win32';
        pending = null; // cada captura precisa de uma escolha explícita do usuário
        callback(wantAudio ? { video: source, audio: 'loopback' } : { video: source });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  handle('lc:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources
      .filter((s) => s.name !== 'AriranhaCast')
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      }));
  });

  handle('lc:select', (id: unknown, audio: unknown) => {
    pending = typeof id === 'string' && SOURCE_ID.test(id) ? { id, audio: audio === true } : null;
  });

  handle('lc:streaming', (on: unknown) => {
    if (on === true && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (on !== true && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  });

  handle('lc:platform', () => process.platform);
  handle('lc:version', () => app.getVersion());
  handle('lc:audiocap-start', (sourceId: unknown) => startAudioCap(sourceId));
  handle('lc:audiocap-stop', () => stopAudioCap());
  handle('lc:hotkeys', (keys: unknown) => setHotkeys(keys));
  handle('lc:inroom', (on: unknown, mic: unknown) => {
    inRoom = on === true;
    micOn = mic === true;
    refreshTray();
  });

  createTray();
  createWindow();
  startUpdater();
});

app.on('before-quit', () => (quitting = true));
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopAudioCap();
});
app.on('window-all-closed', () => app.quit());
