import { Capacitor, registerPlugin } from '@capacitor/core';

/** Ponte com o código nativo do Android (mobile/android/.../CallPlugin.java). */
interface CallPlugin {
  start(o: { text: string }): Promise<void>;
  stop(): Promise<void>;
  setSpeaker(o: { on: boolean }): Promise<{ ok: boolean; headset: boolean }>;
  status(): Promise<{ headset: boolean; sdk: number; model: string }>;
  keepScreenOn(o: { on: boolean }): Promise<void>;
  fullscreen(o: { on: boolean }): Promise<void>;
  addListener(event: 'fullscreenExit', cb: () => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'appLink', cb: (e: { url: string }) => void): Promise<{ remove(): Promise<void> }>;
  openUrl(o: { url: string }): Promise<void>;
  takeLaunchLink(): Promise<{ url?: string }>;
}

const Call = registerPlugin<CallPlugin>('Call');
export const native = Capacitor.isNativePlatform();

/** Mantém a chamada viva em segundo plano (notificação "Em uma sala"). */
export async function callStart(text: string): Promise<string> {
  if (!native) return '';
  try {
    await Call.start({ text });
    return '';
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

export async function callStop(): Promise<void> {
  if (native) await Call.stop().catch(() => {});
}

export async function setSpeaker(on: boolean): Promise<{ ok: boolean; headset: boolean }> {
  if (!native) return { ok: false, headset: false };
  return Call.setSpeaker({ on }).catch(() => ({ ok: false, headset: false }));
}

let screenOn = false;
export function keepScreenOn(on: boolean): void {
  if (!native || on === screenOn) return;
  screenOn = on;
  void Call.keepScreenOn({ on }).catch(() => {});
}

export async function deviceStatus(): Promise<{ headset: boolean; sdk: number; model: string }> {
  if (!native) return { headset: false, sdk: 0, model: navigator.userAgent.slice(0, 60) };
  return Call.status().catch(() => ({ headset: false, sdk: 0, model: '?' }));
}

/** Modo imersivo do Android: esconde as barras do sistema e gira para paisagem. */
export function setFullscreen(on: boolean): void {
  if (native) void Call.fullscreen({ on }).catch(() => {});
}

/** O botão voltar do Android, com o vídeo em tela cheia, sai da tela cheia (em vez de sair do app). */
export function onFullscreenExit(cb: () => void): void {
  if (native) void Call.addListener('fullscreenExit', cb).catch(() => {});
}

/** Abre uma URL https no navegador do sistema (login). */
export async function openBrowser(url: string): Promise<boolean> {
  if (!native) return !!window.open(url, '_blank');
  return Call.openUrl({ url }).then(
    () => true,
    () => false,
  );
}

/** Links ariranhacast:// (volta do login, convites): o que abriu o app e os que chegam com ele aberto. */
export function onAppLink(cb: (url: string) => void): void {
  if (!native) return;
  void Call.addListener('appLink', (e) => typeof e?.url === 'string' && cb(e.url)).catch(() => {});
  void Call.takeLaunchLink()
    .then((r) => r.url && cb(r.url))
    .catch(() => {});
}
