import { contextBridge, ipcRenderer, sharedTexture } from 'electron';

// Única ponte entre a página e o sistema. A página não tem acesso ao Node.js; só a estas funções.
const on = (channel: string, cb: (...args: any[]) => void) => {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_e, ...args) => cb(...args));
};

// ---- captura de jogo: quadros vindos da placa de vídeo ----
// O processo principal envia cada quadro como textura importada; aqui ela vira um VideoFrame,
// que segue para a página por um MessagePort (transferível entre o mundo isolado do preload e o
// da página). As últimas texturas ficam referenciadas enquanto o codificador ainda pode lê-las;
// ao soltá-las, o gamecap.exe pode reaproveitar a textura.
let framePort: MessagePort | null = null;
const held: { release(): void }[] = [];
function releaseHeld(keep: number): void {
  while (held.length > keep) {
    try {
      held.shift()!.release();
    } catch {
      /* já solta */
    }
  }
}
const textureSupport = typeof sharedTexture?.setSharedTextureReceiver === 'function';
if (textureSupport) {
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
    try {
      if (framePort) {
        const frame = importedSharedTexture.getVideoFrame();
        framePort.postMessage(frame, [frame]);
      }
    } catch {
      /* quadro perdido */
    } finally {
      held.push(importedSharedTexture);
      releaseHeld(4);
    }
  });
}
/** Abre um canal novo de quadros e o entrega à página (por window.postMessage, que transfere a porta). */
function openFrameChannel(): void {
  framePort?.close();
  releaseHeld(0);
  const ch = new MessageChannel();
  framePort = ch.port1;
  window.postMessage({ type: 'ariranhacast:frames' }, '*', [ch.port2]);
}
function closeFrameChannel(): void {
  framePort?.close();
  framePort = null;
  releaseHeld(0);
}

contextBridge.exposeInMainWorld('ariranhacast', {
  getSources: () => ipcRenderer.invoke('lc:sources'),
  selectSource: (id: string, audio: boolean) => ipcRenderer.invoke('lc:select', id, audio),
  setStreaming: (on: boolean) => ipcRenderer.invoke('lc:streaming', on),
  platform: () => ipcRenderer.invoke('lc:platform'),
  appVersion: () => ipcRenderer.invoke('lc:version'),
  startAudioCap: (sourceId: string) => ipcRenderer.invoke('lc:audiocap-start', sourceId),
  stopAudioCap: () => ipcRenderer.invoke('lc:audiocap-stop'),
  gameCapAvailable: async () => textureSupport && (await ipcRenderer.invoke('lc:gamecap-available')) === true,
  gameCapStart: (sourceId: string, fps: number, height: number) => {
    openFrameChannel();
    return ipcRenderer.invoke('lc:gamecap-start', sourceId, fps, height);
  },
  gameCapStop: () => {
    closeFrameChannel();
    return ipcRenderer.invoke('lc:gamecap-stop');
  },
  onGameCap: (cb: (s: unknown) => void) => on('lc:gamecap', cb),
  onPcm: (cb: (chunk: Uint8Array) => void) => on('lc:pcm', cb),
  setHotkeys: (keys: { mic: string; deaf: string; clip: string; voice: string } | null) => ipcRenderer.invoke('lc:hotkeys', keys),
  onHotkey: (cb: (which: 'mic' | 'deaf' | 'leave' | 'clip' | 'voice') => void) => on('lc:hotkey', cb),
  setInRoom: (inRoom: boolean, micOn: boolean) => ipcRenderer.invoke('lc:inroom', inRoom, micOn),
  onUpdate: (cb: (text: string) => void) => on('lc:update', cb),
  updaterState: () => ipcRenderer.invoke('lc:updater-state'),
  updaterCheck: () => ipcRenderer.invoke('lc:updater-check'),
  updaterInstall: () => ipcRenderer.invoke('lc:updater-install'),
  onUpdater: (cb: (s: unknown) => void) => on('lc:updater', cb),
  firewallStatus: () => ipcRenderer.invoke('lc:firewall-status'),
  firewallFix: () => ipcRenderer.invoke('lc:firewall-fix'),
  gfxGet: () => ipcRenderer.invoke('lc:gfx-get'),
  gfxSet: (cfg: unknown) => ipcRenderer.invoke('lc:gfx-set', cfg),
  relaunch: () => ipcRenderer.invoke('lc:relaunch'),
  quit: () => ipcRenderer.invoke('lc:quit'),
  openExternal: (url: string) => ipcRenderer.invoke('lc:open-external', url),
  saveClip: (data: ArrayBuffer, ext: string, voice = false) => ipcRenderer.invoke('lc:save-clip', data, ext, voice),
  yellowBorder: () => ipcRenderer.invoke('lc:yellow-border'),
  showClip: (file: string) => ipcRenderer.invoke('lc:show-clip', file),
  flash: () => ipcRenderer.invoke('lc:flash'),
  gifSearch: (key: string, q: string) => ipcRenderer.invoke('lc:gif-search', key, q),
  gifFetch: (url: string) => ipcRenderer.invoke('lc:gif-fetch', url),
  setOverlay: (cfg: unknown) => ipcRenderer.invoke('lc:overlay-config', cfg),
  pushOverlay: (rows: unknown) => ipcRenderer.send('lc:overlay-rows', rows),
  onDeepLink: (cb: (code: string) => void) => on('lc:deeplink', cb),
  pendingDeepLink: () => ipcRenderer.invoke('lc:deeplink-pending'),
  logError: (text: string) => ipcRenderer.invoke('lc:log', text),
  openLogs: () => ipcRenderer.invoke('lc:open-logs'),
  lobbyState: () => ipcRenderer.invoke('lc:lobby-state'),
  lobbyLogin: (provider: string) => ipcRenderer.invoke('lc:lobby-login', provider),
  lobbyLogout: () => ipcRenderer.invoke('lc:lobby-logout'),
  lobbyPublish: (room: unknown) => ipcRenderer.invoke('lc:lobby-publish', room),
  lobbyPresence: (code: string | null) => ipcRenderer.invoke('lc:lobby-presence', code),
  onLobby: (cb: (s: unknown) => void) => on('lc:lobby', cb),
  onLobbyError: (cb: (text: string) => void) => on('lc:lobby-error', cb),
});
