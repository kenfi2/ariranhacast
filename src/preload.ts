import { contextBridge, ipcRenderer } from 'electron';

// Única ponte entre a página e o sistema. A página não tem acesso ao Node.js; só a estas funções.
const on = (channel: string, cb: (...args: any[]) => void) => {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_e, ...args) => cb(...args));
};

contextBridge.exposeInMainWorld('ariranhacast', {
  getSources: () => ipcRenderer.invoke('lc:sources'),
  selectSource: (id: string, audio: boolean) => ipcRenderer.invoke('lc:select', id, audio),
  setStreaming: (on: boolean) => ipcRenderer.invoke('lc:streaming', on),
  platform: () => ipcRenderer.invoke('lc:platform'),
  appVersion: () => ipcRenderer.invoke('lc:version'),
  startAudioCap: (sourceId: string) => ipcRenderer.invoke('lc:audiocap-start', sourceId),
  stopAudioCap: () => ipcRenderer.invoke('lc:audiocap-stop'),
  onPcm: (cb: (chunk: Uint8Array) => void) => on('lc:pcm', cb),
  setHotkeys: (keys: { mic: string; deaf: string } | null) => ipcRenderer.invoke('lc:hotkeys', keys),
  onHotkey: (cb: (which: 'mic' | 'deaf' | 'leave') => void) => on('lc:hotkey', cb),
  setInRoom: (inRoom: boolean, micOn: boolean) => ipcRenderer.invoke('lc:inroom', inRoom, micOn),
  onUpdate: (cb: (text: string) => void) => on('lc:update', cb),
  firewallStatus: () => ipcRenderer.invoke('lc:firewall-status'),
  firewallFix: () => ipcRenderer.invoke('lc:firewall-fix'),
});
