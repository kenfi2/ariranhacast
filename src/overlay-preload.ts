import { contextBridge, ipcRenderer } from 'electron';

// Ponte da janela de overlay: só recebe dados prontos para exibir, não envia nada.
contextBridge.exposeInMainWorld('overlay', {
  onRows: (cb: (rows: unknown) => void) => ipcRenderer.on('lc:ov-rows', (_e, rows) => cb(rows)),
  onConfig: (cb: (cfg: unknown) => void) => ipcRenderer.on('lc:ov-config', (_e, cfg) => cb(cfg)),
});
