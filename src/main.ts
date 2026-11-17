import os from 'node:os';
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerSaveBlocker, screen, session, shell, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
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

// ---- registro de erros (fica só neste PC; nada é enviado) ----
// %APPDATA%/AriranhaCast/logs/app.log, com rodízio em 1 MB. Serve para descobrir o que houve
// quando o app falha no computador de alguém.
const logDir = (): string => path.join(app.getPath('userData'), 'logs');
let logBudget = 0;
let logWindow = 0;
function writeLog(level: 'info' | 'warn' | 'error', source: string, message: unknown): void {
  try {
    const now = Date.now();
    if (now - logWindow > 60_000) {
      logWindow = now;
      logBudget = 0;
    }
    if (++logBudget > 120) return; // um erro em laço não pode encher o disco
    const raw = message instanceof Error ? (message.stack ?? message.message) : String(message);
    const text = raw
      .split(os.homedir()).join('~')
      .replace(/[\r\n]+/g, ' | ')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .slice(0, 2000);
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'app.log');
    try {
      if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, path.join(dir, 'app.old.log'));
    } catch {
      /* ainda não existe */
    }
    fs.appendFileSync(file, `${new Date(now).toISOString()} [${level}] ${source}: ${text}\n`);
  } catch {
    /* sem disco ou sem permissão: segue sem log */
  }
}
process.on('uncaughtException', (e) => writeLog('error', 'main', e));
process.on('unhandledRejection', (e) => writeLog('error', 'main (promise)', e));

// ---- desempenho gráfico (Configurações > Desempenho) ----
// Lido antes do app iniciar: são opções do Chromium que só valem com o app reiniciado.
//  hwAccel: aceleração de hardware (GPU) da interface e do vídeo. Desligar ajuda em PCs em que a
//    GPU está no limite com o jogo/filme, ou com drivers problemáticos; o encode passa para a CPU.
//  capture: 'modern' usa o Windows.Graphics.Capture (padrão); 'compat' usa os métodos antigos
//    (DXGI para telas, GDI para janelas), útil quando uma janela aparece preta ou nem aparece
//    (ex.: navegador com a aceleração de hardware desligada).
type Gfx = { hwAccel: boolean; capture: 'modern' | 'compat' };
const gfxFile = (): string => path.join(app.getPath('userData'), 'graphics.json');
function cleanGfx(v: unknown): Gfx {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { hwAccel: o.hwAccel !== false, capture: o.capture === 'compat' ? 'compat' : 'modern' };
}
function loadGfx(): Gfx {
  try {
    return cleanGfx(JSON.parse(fs.readFileSync(gfxFile(), 'utf8')));
  } catch {
    return cleanGfx({});
  }
}
const gfx = loadGfx(); // o que está valendo nesta execução
if (!gfx.hwAccel) app.disableHardwareAcceleration();

// O caminho crítico (captura, encode, rede) roda em C++ dentro do Chromium/libwebrtc.
// Estes switches garantem encoder/decoder por hardware e evitam que o Chromium
// reduza a prioridade do app quando a janela está minimizada ou atrás do jogo.
app.commandLine.appendSwitch(
  'enable-features',
  ['MediaFoundationAV1Encoding', 'PlatformHEVCEncoderSupport', 'WebRtcAllowH265Send', 'WebRtcAllowH265Receive'].join(','),
);
// WebRtcWgcRequireBorder desligado: pede ao Windows para não desenhar a borda amarela em volta
// do que está sendo capturado (o Windows 10 ignora o pedido na captura de janelas).
const disabled = ['WebRtcHideLocalIpsWithMdns', 'WebRtcWgcRequireBorder'];
if (gfx.capture === 'compat') disabled.push('AllowWgcScreenCapturer', 'AllowWgcWindowCapturer');
app.commandLine.appendSwitch('disable-features', disabled.join(','));
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
let flashing = false;

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

function setHotkeys(keys: unknown): { mic: boolean; deaf: boolean; clip: boolean; voice: boolean } {
  globalShortcut.unregisterAll();
  const result = { mic: false, deaf: false, clip: false, voice: false };
  if (!keys || typeof keys !== 'object') return result;
  const { mic, deaf, clip, voice } = keys as { mic?: unknown; deaf?: unknown; clip?: unknown; voice?: unknown };
  const used = new Set<string>();
  const reg = (accel: unknown, which: 'mic' | 'deaf' | 'clip' | 'voice'): boolean => {
    if (typeof accel !== 'string' || !ACCELERATOR.test(accel) || used.has(accel)) return false;
    try {
      const ok = globalShortcut.register(accel, () => send('lc:hotkey', which));
      if (ok) used.add(accel);
      return ok;
    } catch {
      return false;
    }
  };
  result.mic = reg(mic, 'mic');
  result.deaf = reg(deaf, 'deaf');
  result.clip = reg(clip, 'clip');
  result.voice = reg(voice, 'voice');
  return result;
}


// ---------- links, clipes, GIFs ----------
/** Só abre links http(s) no navegador padrão (nunca file:, javascript:, etc.). */
function openExternal(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 2000) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    void shell.openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
}

const clipDir = (): string => path.join(app.getPath('videos'), 'AriranhaCast');

async function saveClip(data: unknown, ext: unknown, voice: unknown): Promise<{ ok: boolean; path?: string; error?: string }> {
  const kind = ext === 'mp4' || ext === 'm4a' ? ext : 'webm';
  const label = voice === true ? 'Voz' : 'Clipe';
  const buf = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!buf || buf.length < 200 || buf.length > 600 * 1024 * 1024) return { ok: false, error: 'clipe vazio ou grande demais' };
  try {
    fs.mkdirSync(clipDir(), { recursive: true });
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const name = `${label} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${kind}`;
    const file = path.join(clipDir(), name);
    fs.writeFileSync(file, buf);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

const GIF_HOSTS = /^(?:media\d*|i)\.giphy\.com$/;

async function gifSearch(key: unknown, query: unknown) {
  if (typeof key !== 'string' || !/^[\w-]{16,64}$/.test(key)) return { ok: false, items: [], error: 'Falta a chave do Giphy (Configurações).' };
  const q = typeof query === 'string' ? query.trim().slice(0, 80) : '';
  const url = q
    ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(q)}&limit=18&rating=pg-13&lang=pt`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=18&rating=pg-13`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, items: [], error: res.status === 401 || res.status === 403 ? 'Chave do Giphy recusada.' : `Giphy respondeu ${res.status}.` };
    const json = (await res.json()) as { data?: any[] };
    const items = await Promise.all(
      (json.data ?? []).slice(0, 18).map(async (g) => {
        const thumb: string = g?.images?.fixed_width_small?.url ?? g?.images?.fixed_width?.url ?? '';
        const full: string = g?.images?.fixed_height?.url ?? g?.images?.downsized?.url ?? '';
        try {
          if (!GIF_HOSTS.test(new URL(thumb).hostname) || !GIF_HOSTS.test(new URL(full).hostname)) return null;
          const r = await fetch(thumb, { signal: AbortSignal.timeout(8000) });
          const b = Buffer.from(await r.arrayBuffer());
          if (!r.ok || b.length > 600_000) return null;
          return { id: String(g.id).slice(0, 40), title: String(g.title ?? '').slice(0, 80), thumb: `data:image/gif;base64,${b.toString('base64')}`, url: full };
        } catch {
          return null;
        }
      }),
    );
    return { ok: true, items: items.filter(Boolean) };
  } catch {
    return { ok: false, items: [], error: 'Sem conexão com o Giphy.' };
  }
}

async function gifFetch(url: unknown): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }> {
  try {
    if (typeof url !== 'string') throw new Error('url');
    const u = new URL(url);
    if (u.protocol !== 'https:' || !GIF_HOSTS.test(u.hostname)) throw new Error('host');
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    const b = Buffer.from(await r.arrayBuffer());
    if (!r.ok || b.length > 4 * 1024 * 1024) throw new Error('size');
    return { ok: true, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer };
  } catch {
    return { ok: false, error: 'Não consegui baixar o GIF.' };
  }
}

// ---------- overlay "quem está falando" ----------
type OverlayCfg = { enabled: boolean; corner: 'tl' | 'tr' | 'bl' | 'br'; mode: 'speaking' | 'all' };
let overlay: BrowserWindow | null = null;
let overlayCfg: OverlayCfg = { enabled: false, corner: 'tr', mode: 'speaking' };

function placeOverlay(): void {
  if (!overlay || overlay.isDestroyed()) return;
  const wa = screen.getDisplayMatching(win?.getBounds() ?? screen.getPrimaryDisplay().bounds).workArea;
  const w = 260;
  const h = 360;
  const x = overlayCfg.corner.endsWith('l') ? wa.x + 12 : wa.x + wa.width - w - 12;
  const y = overlayCfg.corner.startsWith('t') ? wa.y + 12 : wa.y + wa.height - h - 12;
  overlay.setBounds({ x, y, width: w, height: h });
}

function updateOverlay(): void {
  const want = overlayCfg.enabled && inRoom;
  if (!want) {
    if (overlay && !overlay.isDestroyed()) overlay.close();
    overlay = null;
    return;
  }
  if (overlay && !overlay.isDestroyed()) {
    placeOverlay();
    overlay.webContents.send('lc:ov-config', overlayCfg);
    syncOverlayVisible();
    return;
  }
  overlay = new BrowserWindow({
    width: 260,
    height: 360,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.setVisibleOnAllWorkspaces(true);
  void overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlay.webContents.once('did-finish-load', () => {
    placeOverlay();
    overlay?.webContents.send('lc:ov-config', overlayCfg);
    overlay?.webContents.send('lc:ov-rows', overlayRows);
    syncOverlayVisible();
  });
  overlay.on('closed', () => (overlay = null));
}

/**
 * A janela do overlay fica sempre por cima de tudo. Mesmo transparente, ela atrapalha o Windows a
 * reconhecer jogos e vídeos em tela cheia (barra de tarefas aparecendo, perda de fluidez). Por isso
 * só fica visível enquanto há algo para mostrar; com ninguém falando, ela some de verdade.
 */
let overlayRows: { name: string; color: string; speaking: boolean; muted: boolean }[] = [];
function syncOverlayVisible(): void {
  if (!overlay || overlay.isDestroyed() || overlay.webContents.isLoading()) return;
  const want = overlayRows.some((r) => overlayCfg.mode === 'all' || r.speaking);
  if (want && !overlay.isVisible()) overlay.showInactive();
  else if (!want && overlay.isVisible()) overlay.hide();
}

function cleanOverlayCfg(v: unknown): OverlayCfg {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    corner: o.corner === 'tl' || o.corner === 'bl' || o.corner === 'br' ? o.corner : 'tr',
    mode: o.mode === 'all' ? 'all' : 'speaking',
  };
}

// ---------- convite (ariranhacast://entrar/CODIGO) ----------
const CODE_RE = /^[A-Za-z0-9]{4,16}$/;
let deepLink = '';
function codeFromArgs(argv: string[]): string {
  for (const a of argv) {
    const m = /^ariranhacast:\/\/(?:entrar|join)\/([A-Za-z0-9]{4,16})\/?$/i.exec(a);
    if (m) return m[1];
  }
  return '';
}
function takeDeepLink(code: string): void {
  if (!CODE_RE.test(code)) return;
  deepLink = code;
  send('lc:deeplink', code);
  showWindow();
}

// ---------- bandeja ----------
function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Cada setToolTip/setContextMenu vira uma mensagem para o Explorer (Shell_NotifyIcon). Antes isso
// acontecia a cada mudança de "quem está falando" (várias vezes por segundo, por horas) e
// sobrecarregava o Explorer: Alt+Tab lento, barra de tarefas por cima da tela cheia. Agora só
// quando o que aparece na bandeja muda de fato.
let trayKey = '';
function refreshTray(): void {
  if (!tray) return;
  const key = `${inRoom}|${micOn}`;
  if (key === trayKey) return;
  trayKey = key;
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

// ---------- Firewall do Windows ----------
// Sem uma regra de entrada para o programa, o Windows pode barrar a conexão direta dos amigos
// (é o que acontece quando alguém fecha o aviso "Permitir acesso" da primeira execução).
// O app confere a regra, pergunta uma vez e, se a pessoa aceitar, cria a regra com o pedido
// de administrador do próprio Windows (UAC). O script é montado na memória, só com o caminho
// do próprio executável, e vai por -EncodedCommand: nenhum arquivo é gravado nem executado.
type FwState = 'ok' | 'missing' | 'blocked' | 'unknown' | 'na';
const FW_RULE_NAME = 'AriranhaCast';
const FW_SUPPORTED = process.platform === 'win32' && !dev;

const psQuote = (v: string): string => `'${v.replace(/'/g, "''")}'`;

function fwCheckScript(exe: string): string {
  return `$p = ${psQuote(exe)}
try {
  $pol = New-Object -ComObject HNetCfg.FwPolicy2
  $allow = $false; $block = $false
  foreach ($r in $pol.Rules) {
    if ($r.Enabled -and $r.Direction -eq 1 -and $r.ApplicationName -and ($r.ApplicationName -ieq $p)) {
      if ($r.Action -eq 1) { $allow = $true } else { $block = $true }
    }
  }
  if ($block) { 'blocked' } elseif ($allow) { 'ok' } else { 'missing' }
} catch { 'unknown' }`;
}

function fwFixScript(exe: string): string {
  return `$p = ${psQuote(exe)}
$pol = New-Object -ComObject HNetCfg.FwPolicy2
$names = @()
foreach ($r in $pol.Rules) { if ($r.Direction -eq 1 -and $r.ApplicationName -and ($r.ApplicationName -ieq $p)) { $names += $r.Name } }
foreach ($n in ($names | Select-Object -Unique)) { $pol.Rules.Remove($n) }
$rule = New-Object -ComObject HNetCfg.FWRule
$rule.Name = ${psQuote(FW_RULE_NAME)}
$rule.Description = 'Permite conexões de entrada do AriranhaCast (voz, webcam e transmissão entre amigos).'
$rule.ApplicationName = $p
$rule.Direction = 1
$rule.Action = 1
$rule.Enabled = $true
$rule.Profiles = 2147483647
$pol.Rules.Add($rule)`;
}

function runPowerShell(script: string, elevated: boolean, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const base = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden'];
    const args = elevated
      ? [
          ...base,
          '-Command',
          `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${enc}'`,
        ]
      : [...base, '-EncodedCommand', enc];
    try {
      execFile('powershell.exe', args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '').trim() }));
    } catch {
      resolve({ ok: false, out: '' });
    }
  });
}

async function firewallState(): Promise<FwState> {
  if (!FW_SUPPORTED) return 'na';
  const r = await runPowerShell(fwCheckScript(process.execPath), false, 20_000);
  const v = r.out.split(/\s+/).pop();
  return v === 'ok' || v === 'missing' || v === 'blocked' ? v : 'unknown';
}

/** Cria a regra (o Windows mostra o pedido de administrador). Devolve o estado depois. */
async function firewallFix(): Promise<FwState> {
  if (!FW_SUPPORTED) return 'na';
  await runPowerShell(fwFixScript(process.execPath), true, 120_000);
  return firewallState();
}

const fwPrefFile = (): string => path.join(app.getPath('userData'), 'firewall.json');
function fwDeclined(): boolean {
  try {
    return JSON.parse(fs.readFileSync(fwPrefFile(), 'utf8'))?.declinedFor === process.execPath;
  } catch {
    return false;
  }
}
function fwRememberDecline(on: boolean): void {
  try {
    fs.writeFileSync(fwPrefFile(), JSON.stringify(on ? { declinedFor: process.execPath } : {}));
  } catch {
    /* sem preferência salva */
  }
}

/** Na abertura: se faltar a regra, pergunta (uma vez) e libera. */
async function ensureFirewall(): Promise<void> {
  if (!FW_SUPPORTED || fwDeclined()) return;
  const state = await firewallState();
  if (state !== 'missing' && state !== 'blocked') return;
  if (!win || win.isDestroyed()) return;
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Liberar', 'Agora não'],
    defaultId: 0,
    cancelId: 1,
    title: 'AriranhaCast',
    message: 'Liberar o AriranhaCast no Firewall do Windows?',
    detail:
      'Sem isso, o Windows pode bloquear a conexão dos seus amigos.\n\n' +
      'Vai aparecer o pedido de permissão do Windows (administrador). O app cria uma regra só para o AriranhaCast.exe.' +
      (state === 'blocked' ? '\n\nHoje o Windows está bloqueando este programa: a regra de bloqueio será substituída.' : ''),
  });
  if (choice.response !== 0) {
    fwRememberDecline(true);
    send('lc:update', 'Tudo bem. Se alguém não conseguir conectar, libere o app em Configurações > Firewall.');
    return;
  }
  const after = await firewallFix();
  if (after === 'ok') {
    fwRememberDecline(false);
    send('lc:update', 'Firewall liberado. O AriranhaCast já pode receber conexões dos amigos.');
  } else {
    send('lc:update', 'Não consegui liberar o Firewall (a permissão foi negada?). Dá pra tentar de novo em Configurações.');
  }
}

// ---------- atualização automática ----------
// Só existe no app instalado pelo instalador e só quando o pacote foi gerado com
// "ariranhacast.updateUrl" (HTTPS) preenchido em package.json; nesse caso o instalador grava
// resources/app-update.yml, que diz ao electron-updater onde procurar. O arquivo baixado
// é conferido contra o SHA-512 publicado no latest.yml antes de ser instalado.
type UpdState =
  | { state: 'disabled'; reason: 'dev' | 'portatil' | 'sem-url' }
  | { state: 'checking' }
  | { state: 'uptodate' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

let upd: UpdState = { state: 'disabled', reason: dev ? 'dev' : 'portatil' };
let updater: typeof import('electron-updater').autoUpdater | null = null;
let updVersion = '';

function setUpd(s: UpdState): void {
  upd = s;
  send('lc:updater', s);
}

// Espaço livre (MB) no disco onde o app está instalado; null se não der para medir.
const MIN_FREE_MB = 600; // o app instalado tem ~360 MB e o instalador regrava tudo por cima
function freeMB(): number | null {
  try {
    const st = fs.statfsSync(path.dirname(process.execPath));
    return Math.floor((Number(st.bavail) * Number(st.bsize)) / 1048576);
  } catch {
    return null;
  }
}

function shortError(e: unknown): string {
  const raw = String((e as { message?: unknown })?.message ?? e ?? '').split('\n')[0];
  if (/404/.test(raw)) return 'o arquivo da nova versão não está na release (erro 404).';
  if (/ENOTFOUND|ECONN|ETIMEDOUT|network|net::/i.test(raw)) return 'sem conexão com o GitHub.';
  return raw.replace(/https?:\/\/\S+/g, '[link]').slice(0, 110) || 'erro desconhecido.';
}

function checkForUpdates(): void {
  if (!updater || upd.state === 'checking' || upd.state === 'downloading' || upd.state === 'ready') return;
  setUpd({ state: 'checking' });
  updater.checkForUpdates().catch((e) => setUpd({ state: 'error', message: shortError(e) }));
}

function startUpdater(): void {
  // Só para testar a interface (em desenvolvimento): --lc-fakeupd=checking|downloading|ready|error|uptodate
  const fake = arg('fakeupd');
  if (dev && fake) {
    const fakes: Record<string, UpdState> = {
      checking: { state: 'checking' },
      downloading: { state: 'downloading', version: '0.3.2', percent: 45 },
      ready: { state: 'ready', version: '0.3.2' },
      error: { state: 'error', message: 'o arquivo da nova versão não está na release (erro 404).' },
      uptodate: { state: 'uptodate' },
    };
    if (fakes[fake]) setTimeout(() => setUpd(fakes[fake]), 800);
    return;
  }
  if (dev) return;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const url: unknown = pkg?.ariranhacast?.updateUrl;
    if (typeof url !== 'string' || !url.startsWith('https://')) return void (upd = { state: 'disabled', reason: 'sem-url' });
    if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return void (upd = { state: 'disabled', reason: 'portatil' });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    updater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('update-available', (info) => {
      updVersion = info.version;
      setUpd({ state: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => setUpd({ state: 'uptodate' }));
    autoUpdater.on('download-progress', (p) => setUpd({ state: 'downloading', version: updVersion, percent: Math.max(0, Math.min(100, Math.round(p.percent))) }));
    autoUpdater.on('update-downloaded', (info) => setUpd({ state: 'ready', version: info.version }));
    autoUpdater.on('error', (e) => {
      writeLog('error', 'atualização', e);
      setUpd({ state: 'error', message: shortError(e) });
    });
    autoUpdater.on('update-downloaded', (info) => writeLog('info', 'atualização', `${info.version} baixada`));
    upd = { state: 'uptodate' };
    checkForUpdates();
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
  } catch {
    upd = { state: 'disabled', reason: 'portatil' };
  }
}

/** Registra falhas da janela e, se ela não carregar ou travar de vez, oferece recarregar. */
let failDialogOpen = false;
function watchWindow(w: BrowserWindow): void {
  const offerReload = (what: string): void => {
    if (failDialogOpen || quitting || w.isDestroyed()) return;
    failDialogOpen = true;
    void dialog
      .showMessageBox(w, {
        type: 'error',
        title: 'AriranhaCast',
        message: `${what}`,
        detail: 'O erro foi anotado na pasta de logs. Se continuar acontecendo, envie o arquivo app.log para quem cuida do app.',
        buttons: ['Recarregar', 'Abrir pasta de logs', 'Fechar'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      .then(({ response }) => {
        failDialogOpen = false;
        if (w.isDestroyed()) return;
        if (response === 1) void shell.openPath(logDir());
        if (response !== 2) void w.loadFile(INDEX);
      })
      .catch(() => (failDialogOpen = false));
  };
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error' && e.message && !e.message.startsWith('Uncaught')) writeLog('error', `janela ${path.basename(e.sourceId || '')}:${e.lineNumber}`, e.message);
  });
  w.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navegação cancelada
    writeLog('error', 'janela', `não carregou (${code} ${desc}) ${path.basename(url)}`);
    offerReload('A tela do AriranhaCast não carregou.');
  });
  w.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    writeLog('error', 'janela', `processo da janela encerrou: ${d.reason} (código ${d.exitCode})`);
    offerReload('A janela do AriranhaCast parou de funcionar.');
  });
  w.on('unresponsive', () => writeLog('warn', 'janela', 'parou de responder'));
  w.on('responsive', () => writeLog('info', 'janela', 'voltou a responder'));
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
  for (const k of ['auto', 'code', 'fake', 'server', 'maxdirect', 'name', 'mic', 'ns', 'cam', 'ice', 'relayonly', 'netcheck', 'pass', 'act', 'realcap', 'gate', 'tab']) {
    const v = arg(k);
    if (v !== undefined) query[k] = v.slice(0, 2000);
  }
  void win.loadFile(INDEX, { query });
  watchWindow(win);

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
  win.on('focus', () => {
    if (!flashing) return;
    flashing = false;
    win?.flashFrame(false);
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

if (process.platform === 'win32') app.setAsDefaultProtocolClient('ariranhacast', process.execPath, process.defaultApp ? [path.resolve(process.argv[1] ?? '')] : []);
deepLink = codeFromArgs(process.argv);
if (!profile && !app.requestSingleInstanceLock()) {
  // Já existe uma janela aberta: ela recebe o convite e esta cópia fecha.
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const code = codeFromArgs(argv);
    if (code) takeDeepLink(code);
    else showWindow();
  });
}

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
        // Sem miniaturas: aqui só precisamos achar a fonte (gerar miniatura de cada janela é caro).
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
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
  handle('lc:updater-state', () => upd);
  handle('lc:updater-check', () => checkForUpdates());
  handle('lc:updater-install', () => {
    if (upd.state !== 'ready' || !updater) return false;
    // Disco cheio no meio da instalação deixa o app quebrado: avisa antes de fechar.
    const free = freeMB();
    if (free !== null && free < MIN_FREE_MB) {
      setUpd({ state: 'error', message: `pouco espaço no disco: libere pelo menos ${MIN_FREE_MB} MB (restam ${free} MB) e tente de novo.` });
      return false;
    }
    quitting = true; // não esconder a janela na bandeja: o app precisa fechar de verdade
    updater.quitAndInstall(true, true); // instala em silêncio e reabre o app
    return true;
  });
  handle('lc:firewall-status', () => firewallState());
  handle('lc:firewall-fix', async () => {
    const st = await firewallFix();
    if (st === 'ok') fwRememberDecline(false);
    return st;
  });
  handle('lc:inroom', (on: unknown, mic: unknown) => {
    inRoom = on === true;
    micOn = mic === true;
    refreshTray();
    updateOverlay();
  });
  handle('lc:gfx-get', () => ({ current: gfx, saved: loadGfx() }));
  handle('lc:gfx-set', (cfg: unknown) => {
    const clean = cleanGfx(cfg);
    try {
      fs.writeFileSync(gfxFile(), JSON.stringify(clean));
    } catch (e) {
      writeLog('error', 'desempenho', e);
    }
    return { current: gfx, saved: loadGfx() };
  });
  handle('lc:relaunch', () => {
    quitting = true;
    app.relaunch();
    app.quit();
  });
  handle('lc:open-external', (url: unknown) => openExternal(url));
  handle('lc:log', (text: unknown) => writeLog('error', 'janela', String(text ?? '').slice(0, 2000)));
  handle('lc:open-logs', async () => {
    fs.mkdirSync(logDir(), { recursive: true });
    return (await shell.openPath(logDir())) === '';
  });
  handle('lc:save-clip', (data: unknown, ext: unknown, voice: unknown) => saveClip(data, ext, voice));
  // Windows 10 (build < 22000) sempre desenha a borda amarela ao capturar uma janela.
  handle('lc:yellow-border', () => process.platform === 'win32' && Number(os.release().split('.')[2] ?? 0) < 22000);
  handle('lc:show-clip', (file: unknown) => {
    if (typeof file === 'string' && path.dirname(path.resolve(file)) === path.resolve(clipDir())) shell.showItemInFolder(path.resolve(file));
  });
  // Pisca o ícone na barra de tarefas uma vez por "ausência" (não a cada mensagem): piscar de
  // novo e de novo faz o Windows mostrar a barra de tarefas por cima de jogos e vídeos em tela cheia.
  handle('lc:flash', () => {
    if (!win || win.isFocused() || flashing) return;
    flashing = true;
    win.flashFrame(true);
  });
  handle('lc:gif-search', (key: unknown, q: unknown) => gifSearch(key, q));
  handle('lc:gif-fetch', (url: unknown) => gifFetch(url));
  handle('lc:overlay-config', (cfg: unknown) => {
    overlayCfg = cleanOverlayCfg(cfg);
    updateOverlay();
  });
  handle('lc:deeplink-pending', () => {
    const c = deepLink;
    deepLink = '';
    return c;
  });
  // O renderer envia as linhas do overlay (nomes e estado de fala) e o main repassa à janela do overlay.
  ipcMain.on('lc:overlay-rows', (e, rows: unknown) => {
    if (!trusted(e as unknown as IpcMainInvokeEvent) || !Array.isArray(rows)) return;
    const clean = rows.slice(0, 16).map((r) => ({
      name: String(r?.name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 24),
      color: /^#[0-9a-f]{6}$/i.test(String(r?.color)) ? String(r.color) : '#7c8cff',
      speaking: r?.speaking === true,
      muted: r?.muted === true,
    }));
    overlayRows = clean;
    if (!overlay || overlay.isDestroyed()) return;
    overlay.webContents.send('lc:ov-rows', clean);
    syncOverlayVisible();
  });

  writeLog('info', 'main', `AriranhaCast ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform} ${os.release()} ${process.arch} · livre no disco: ${freeMB() ?? '?'} MB · GPU ${gfx.hwAccel ? 'ligada' : 'desligada'} · captura ${gfx.capture}`);
  app.on('child-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') writeLog('error', 'main', `processo ${d.type}${d.name ? ` (${d.name})` : ''} encerrou: ${d.reason} (código ${d.exitCode})`);
  });
  createTray();
  createWindow();
  startUpdater();
  // Depois da janela aparecer, para o pedido não surgir antes da tela do app.
  win?.webContents.once('did-finish-load', () => setTimeout(() => void ensureFirewall().catch(() => {}), 1500));
});

app.on('before-quit', () => {
  quitting = true;
  // Ao fechar, o app instala sozinho a atualização já baixada; com pouco espaço isso quebraria a instalação.
  if (updater) {
    const free = freeMB();
    updater.autoInstallOnAppQuit = free === null || free >= MIN_FREE_MB;
  }
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopAudioCap();
});
app.on('window-all-closed', () => app.quit());
