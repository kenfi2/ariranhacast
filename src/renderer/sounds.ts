/** Sons curtos da sala (entrar, sair, mutar…), sintetizados na hora: nenhum arquivo de áudio. */
export type Sfx = 'join' | 'leave' | 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'live' | 'saved';

// [frequência Hz, início s, duração s]
const NOTES: Record<Sfx, [number, number, number][]> = {
  join: [[523, 0, 0.09], [784, 0.08, 0.14]],
  leave: [[659, 0, 0.09], [440, 0.08, 0.14]],
  unmute: [[660, 0, 0.07], [880, 0.06, 0.09]],
  mute: [[660, 0, 0.07], [440, 0.06, 0.09]],
  undeafen: [[440, 0, 0.07], [587, 0.06, 0.07], [784, 0.12, 0.1]],
  deafen: [[784, 0, 0.07], [587, 0.06, 0.07], [392, 0.12, 0.1]],
  saved: [[880, 0, 0.14]],
  live: [[587, 0, 0.08], [740, 0.08, 0.08], [880, 0.16, 0.14]],
};

let ctx: AudioContext | undefined;
let sink = '';

/** Toca um som pela saída das vozes. `enabled` vem das preferências (Configurações > Voz). */
export function playSfx(kind: Sfx, enabled: boolean, sinkId = ''): void {
  if (!enabled) return;
  try {
    ctx ??= new AudioContext({ latencyHint: 'interactive' });
    if (sinkId !== sink) {
      sink = sinkId;
      void (ctx as any).setSinkId?.(sinkId).catch(() => {});
    }
    void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, at, dur] of NOTES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.09, t0 + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.02);
    }
  } catch {
    /* sem saída de áudio */
  }
}
