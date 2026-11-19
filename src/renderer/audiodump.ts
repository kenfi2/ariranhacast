/**
 * Depuração do áudio (Ctrl+Shift+A): grava em WAV, sem compressão, cada faixa de áudio que
 * importa no momento — a que vai para o WebRTC (quem transmite) e as recebidas (quem assiste).
 * O processo principal grava junto o PCM cru do audiocap.exe. Comparando os arquivos dá para ver
 * em que etapa o som estraga. Nada é gravado sem a pessoa apertar o atalho.
 */

const MAX_SECONDS = 180;

interface Tap {
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
}

let ctx: AudioContext | null = null;
let mute: GainNode | null = null;
let taps = new Map<string, Tap>();
let active = false;
let stopTimer = 0;
let onAuto: ((r: { files: number; dir?: string }) => void) | null = null;

/** Avisa quando a gravação para sozinha (limite de tempo). */
export function onDumpAutoStop(cb: (r: { files: number; dir?: string }) => void): void {
  onAuto = cb;
}

export const dumping = (): boolean => active;

/** Só letras/números ASCII: o nome vira parte do nome do arquivo. */
function slug(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[^\x00-\x7f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 20) || 'x'
  );
}

async function ensureCtx(): Promise<AudioContext> {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('tap-worklet.js');
    // O worklet só é processado se chegar ao destino; ganho 0 para não tocar nada.
    mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
  }
  await ctx.resume();
  return ctx;
}

function addTap(c: AudioContext, name: string, track: MediaStreamTrack): void {
  if (taps.has(name)) return;
  const source = c.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(c, 'tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
  node.port.onmessage = (e) => {
    if (active) window.ariranhacast.dumpWrite(name, e.data as ArrayBuffer);
  };
  source.connect(node);
  node.connect(mute!);
  taps.set(name, { source, node });
}

/**
 * Liga/atualiza as gravações. `sent`: faixa de áudio da sua transmissão (antes do encoder);
 * `received`: transmissões que você assiste (nome de quem transmite → faixa já decodificada).
 * Pode ser chamada de novo durante a gravação para pegar faixas que surgirem depois.
 */
export async function syncDumpTaps(sent: MediaStreamTrack | null, received: Array<[string, MediaStreamTrack]>): Promise<void> {
  if (!active) return;
  const c = await ensureCtx();
  if (sent && sent.readyState === 'live') addTap(c, '2-enviado', sent);
  received.forEach(([who, track], i) => {
    if (track.readyState === 'live') addTap(c, `3-recebido-${i + 1}-${slug(who)}`, track);
  });
}

export async function startDump(): Promise<{ ok: boolean; error?: string }> {
  if (active) return { ok: true };
  const r = await window.ariranhacast.dumpStart();
  if (!r.ok) return { ok: false, error: r.error };
  active = true;
  stopTimer = window.setTimeout(() => void stopDump().then((r) => onAuto?.(r)), MAX_SECONDS * 1000);
  return { ok: true };
}

export async function stopDump(): Promise<{ files: number; dir?: string }> {
  if (!active) return { files: 0 };
  active = false;
  clearTimeout(stopTimer);
  for (const t of taps.values()) {
    t.source.disconnect();
    t.node.disconnect();
    t.node.port.onmessage = null;
  }
  taps = new Map();
  return window.ariranhacast.dumpStop();
}

export { MAX_SECONDS as DUMP_MAX_SECONDS };
