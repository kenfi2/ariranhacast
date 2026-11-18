// Captura de jogo (estilo OBS): os quadros vêm do gamecap.exe pela placa de vídeo (ver
// src/main.ts e native/gamecap.cpp) e viram uma faixa de vídeo comum, pronta para o WebRTC.
import type { GameCapState, SourceInfo } from './types';

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' | 'audio' });
  readonly writable: WritableStream<VideoFrame>;
}

let active: { track: MediaStreamTrack; port: MessagePort; writer: WritableStreamDefaultWriter<VideoFrame> } | null = null;
let onLost: (reason: string) => void = () => {};

window.ariranhacast.onGameCap((s: GameCapState) => {
  if (!active || s.state === 'hooked') return;
  const why = s.reason || s.state;
  stopGameCapture();
  onLost(why);
});

/** Captura de janela/tela sem o cursor (pelo gamecap.exe, sem hook). */
export async function noCursorAvailable(): Promise<boolean> {
  return typeof (window as any).MediaStreamTrackGenerator === 'function' && (await window.ariranhacast.noCursorAvailable().catch(() => false));
}

export async function gameCaptureAvailable(): Promise<boolean> {
  return typeof (window as any).MediaStreamTrackGenerator === 'function' && (await window.ariranhacast.gameCapAvailable().catch(() => false));
}

/**
 * Começa a capturar o jogo dono da janela. Devolve a faixa de vídeo, ou o motivo de não ter dado
 * (aí o app usa a captura de janela normal). lost é chamado se o jogo fechar ou a captura cair.
 */
export async function startGameCapture(
  source: SourceInfo,
  fps: number,
  height: number,
  lost: (reason: string) => void,
  mode: 'hook' | 'plain' = 'hook',
): Promise<{ track: MediaStreamTrack } | { error: string }> {
  stopGameCapture();
  if (mode === 'hook' && source.kind !== 'window') return { error: 'só funciona com janelas' };

  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  let pending: Promise<{ ok: boolean; reason?: string }> = Promise.resolve({ ok: false, reason: 'não iniciou' });
  const port = await new Promise<MessagePort | null>((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMsg);
      resolve(null);
    }, 3000);
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window || e.data?.type !== 'ariranhacast:frames' || !e.ports[0]) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve(e.ports[0]);
    };
    window.addEventListener('message', onMsg);
    pending = window.ariranhacast.gameCapStart(source.id, fps, height, mode);
  });
  const result = await pending;
  if (!port || !result.ok) {
    port?.close();
    generator.stop();
    void window.ariranhacast.gameCapStop();
    return { error: result.reason || 'canal de quadros indisponível' };
  }

  port.onmessage = (e: MessageEvent) => {
    const frame = e.data as VideoFrame;
    if (!active || active.port !== port) return frame.close();
    // Codificador atrasado: descarta em vez de acumular (latência baixa).
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return frame.close();
    writer.write(frame).catch(() => frame.close());
  };
  active = { track: generator, port, writer };
  onLost = lost;
  return { track: generator };
}
export function stopGameCapture(): void {
  if (!active) return;
  const a = active;
  active = null;
  a.port.onmessage = null;
  a.port.close();
  a.writer.close().catch(() => {});
  a.track.stop();
  void window.ariranhacast.gameCapStop();
}

/** Esta faixa é a da captura de jogo em andamento? */
export function isGameCaptureTrack(t: MediaStreamTrack | undefined): boolean {
  return !!t && !!active && active.track === t;
}
