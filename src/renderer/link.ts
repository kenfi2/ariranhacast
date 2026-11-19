import { preferCodec } from './codecs';
import { icePolicy, net } from './signaling';
import type { EncodeOpts, Msg, Quality } from './types';

type Send = (msg: Msg) => void;

/** Dá ao encoder um bitrate inicial alto, em vez de começar baixo e subir aos poucos. */
function withStartBitrate(sdp: string, kbps: number): string {
  const lines = sdp.split('\r\n');
  let inVideo = false;
  return lines
    .map((line) => {
      if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
      if (inVideo && line.startsWith('a=fmtp:') && !line.includes('apt=')) {
        return `${line};x-google-start-bitrate=${kbps}`;
      }
      return line;
    })
    .join('\r\n');
}

/** Bitrate do Opus da transmissão (música/jogo). O padrão do WebRTC é ~32 kbps mono, de voz. */
const AUDIO_BITRATE = 192_000;

/**
 * Pede áudio estéreo em bitrate de música. Aplicado nos dois lados: o espectador pede na
 * resposta e quem transmite reforça na descrição remota (que é o que configura o encoder),
 * para valer mesmo se o Chromium recusar a edição local ou o espectador estiver numa versão antiga.
 */
function withStereoOpus(sdp: string): string {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!pt) return sdp;
  const want: Record<string, string> = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(AUDIO_BITRATE) };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (!re.test(sdp)) {
    const extra = Object.entries(want).map(([k, v]) => `${k}=${v}`).join(';');
    return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus[^\\r\\n]*)`, 'i'), `$1\r\na=fmtp:${pt} ${extra}`);
  }
  return sdp.replace(re, (_m, params: string) => {
    const kept = params.split(';').map((x) => x.trim()).filter((x) => x && !(x.split('=')[0] in want));
    return `a=fmtp:${pt} ${[...kept, ...Object.entries(want).map(([k, v]) => `${k}=${v}`)].join(';')}`;
  });
}

export interface Route {
  relay: boolean; // algum dos lados usa servidor TURN
  localRelay: boolean; // este PC usa a própria alocação no TURN
  bytes: number;
  localType: string;
  remoteType: string;
  protocol: string;
  family: 'IPv4' | 'IPv6' | '';
  rttMs: number;
}

/** A conexão está passando por um servidor TURN? E quantos bytes já trafegaram por ela. */
export function routeOf(report: RTCStatsReport): Route | null {
  let pair: any;
  report.forEach((s: any) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId) ?? pair;
  });
  if (!pair) {
    report.forEach((s: any) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
  }
  if (!pair) return null;
  const local: any = report.get(pair.localCandidateId);
  const remote: any = report.get(pair.remoteCandidateId);
  const addr: string = String(remote?.address ?? remote?.ip ?? '');
  return {
    relay: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
    localRelay: local?.candidateType === 'relay',
    bytes: (pair.bytesSent ?? 0) + (pair.bytesReceived ?? 0),
    localType: String(local?.candidateType ?? ''),
    remoteType: String(remote?.candidateType ?? ''),
    protocol: String(local?.protocol ?? ''),
    family: addr ? (addr.includes(':') ? 'IPv6' : 'IPv4') : '',
    rttMs: Math.round((pair.currentRoundTripTime ?? 0) * 1000),
  };
}

export interface LinkQuality {
  rttMs: number;
  lossPct: number;
  jitterMs: number;
  level: 0 | 1 | 2 | 3; // 3 = ótima … 0 = ruim
}

const lastLoss = new WeakMap<RTCPeerConnection, { lost: number; recv: number }>();

/** Ping, perda de pacotes e jitter de uma conexão de voz (perda medida entre duas leituras). */
export async function measurePc(pc: RTCPeerConnection): Promise<LinkQuality | null> {
  if (pc.connectionState !== 'connected') return null;
  const report = await pc.getStats().catch(() => null);
  if (!report) return null;
  const route = routeOf(report);
  let inb: any;
  report.forEach((s: any) => {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') inb = s;
  });
  let lossPct = 0;
  let jitterMs = 0;
  if (inb) {
    const prev = lastLoss.get(pc);
    const lost = Math.max(0, inb.packetsLost ?? 0);
    const recv = inb.packetsReceived ?? 0;
    lastLoss.set(pc, { lost, recv });
    if (prev) {
      const dl = Math.max(0, lost - prev.lost);
      const dr = Math.max(0, recv - prev.recv);
      lossPct = dl + dr > 0 ? Math.round((dl / (dl + dr)) * 1000) / 10 : 0;
    }
    jitterMs = Math.round((inb.jitter ?? 0) * 1000);
  }
  const rttMs = route?.rttMs ?? 0;
  const level = rttMs < 70 && lossPct < 1 ? 3 : rttMs < 140 && lossPct < 3 ? 2 : rttMs < 280 && lossPct < 8 ? 1 : 0;
  return { rttMs, lossPct, jitterMs, level };
}

/** Limites de qualidade por espectador e por rota (TURN). */
const QUALITY_CAPS: Record<Quality, { br: number; fps: number; scale: number }> = {
  high: { br: Infinity, fps: Infinity, scale: 1 },
  med: { br: 3_000_000, fps: 60, scale: 1.5 },
  low: { br: 1_000_000, fps: 30, scale: 2 },
};
const RELAY_CAP = { br: 2_500_000, fps: 30, scale: 1.5 };

export interface OutStats {
  kbps: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
  encoder: string;
  hardware: boolean;
  limited: string;
  rttMs: number;
  lossPct: number;
  turn: boolean;
  capped: string; // '' ou o motivo de a qualidade estar reduzida (TURN, escolha do espectador)
  audio: AudioStats | null;
}

/** Áudio da transmissão: bitrate real, alvo do encoder (só quem envia) e se é estéreo. */
export interface AudioStats {
  kbps: number;
  targetKbps: number; // 0 quando não disponível (lado que recebe)
  stereo: boolean;
  concealedPct: number; // % de amostras inventadas pelo decoder por perda/atraso (lado que recebe)
}

function opusStereo(codec: any): boolean {
  return /(^|;)\s*stereo=1/.test(codec?.sdpFmtpLine ?? '');
}

export interface InStats {
  kbps: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
  decoder: string;
  rttMs: number;
  bufferMs: number;
  lost: number;
  dropped: number;
  turn: boolean;
  audio: AudioStats | null;
}

/** Lado que envia: usado pelo host e também por espectadores que fazem relay. */
export class Outgoing {
  readonly pc: RTCPeerConnection;
  private queued: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private lastBytes = 0;
  private lastTime = 0;
  private lastAudioBytes = 0;
  private lastAudioTime = 0;
  private quality: Quality = 'high';
  private relayed = false;
  onstate: (state: RTCPeerConnectionState) => void = () => {};

  constructor(
    stream: MediaStream,
    private send: Send,
    private opts: EncodeOpts,
    ice: RTCIceServer[],
    codecMime: string,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle', iceTransportPolicy: icePolicy });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ t: 'ice', candidate: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => this.onstate(this.pc.connectionState);
    for (const track of stream.getTracks()) {
      const tr = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      if (track.kind === 'video') preferCodec(tr, codecMime);
    }
    void this.offer();
  }

  private async offer(): Promise<void> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.send({ t: 'sdp', sdp: this.pc.localDescription!.toJSON() });
  }

  async handle(msg: Msg): Promise<void> {
    try {
      await this.apply(msg);
    } catch (e) {
      console.warn('[LC] sinalização inválida ignorada', e);
    }
  }

  private async apply(msg: Msg): Promise<void> {
    if (msg.t === 'sdp') {
      if (!msg.sdp || typeof msg.sdp.sdp !== 'string' || msg.sdp.sdp.length > 100_000) return;
      const startKbps = Math.round(this.opts.maxBitrate / 2000);
      try {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: withStereoOpus(withStartBitrate(msg.sdp.sdp!, startKbps)) });
      } catch {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp.sdp });
      }
      this.remoteSet = true;
      for (const c of this.queued.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      await this.applyParams();
    } else if (msg.t === 'ice') {
      if (!msg.candidate || typeof msg.candidate !== 'object') return;
      if (this.remoteSet) await this.pc.addIceCandidate(msg.candidate).catch(() => {});
      else this.queued.push(msg.candidate);
    }
  }

  /** Bitrate/FPS máximos e o que sacrificar quando a banda aperta. */
  async applyParams(opts: EncodeOpts = this.opts): Promise<void> {
    this.opts = opts;
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind === 'audio') {
        // Sem isto o áudio fica com prioridade 'low' e, quando a banda aperta, o vídeo leva
        // quase tudo e o Opus cai para poucos kbps (chiado/"sopro" em sons tipo ruído).
        const p = sender.getParameters();
        if (!p.encodings?.length) continue;
        p.encodings[0].maxBitrate = AUDIO_BITRATE;
        p.encodings[0].priority = 'high';
        p.encodings[0].networkPriority = 'high';
        await sender.setParameters(p).catch((e) => console.warn('[LC] setParameters (áudio)', e));
        continue;
      }
      if (sender.track?.kind !== 'video') continue;
      const p = sender.getParameters();
      if (!p.encodings?.length) continue;
      p.degradationPreference = opts.mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
      const cap = this.cap();
      p.encodings[0].maxBitrate = Math.min(opts.maxBitrate, cap.br);
      p.encodings[0].maxFramerate = Math.min(opts.maxFps, cap.fps);
      p.encodings[0].scaleResolutionDownBy = cap.scale;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      await sender.setParameters(p).catch((e) => console.warn('[LC] setParameters', e));
    }
  }

  /** Limite em vigor: o mais restritivo entre a escolha do espectador e a economia no TURN. */
  private cap(): { br: number; fps: number; scale: number } {
    const q = QUALITY_CAPS[this.quality];
    if (!this.relayed || !net.relayEconomy) return q;
    return { br: Math.min(q.br, RELAY_CAP.br), fps: Math.min(q.fps, RELAY_CAP.fps), scale: Math.max(q.scale, RELAY_CAP.scale) };
  }

  /** Motivo da qualidade reduzida, para exibir a quem transmite. */
  get capReason(): string {
    const parts: string[] = [];
    if (this.quality !== 'high') parts.push(`espectador pediu qualidade ${this.quality === 'med' ? 'média' : 'baixa'}`);
    if (this.relayed && net.relayEconomy) parts.push('economia no TURN');
    return parts.join(' + ');
  }

  /** O espectador escolheu uma qualidade menor (ou voltou à máxima). */
  async setQuality(q: Quality): Promise<void> {
    if (q === this.quality) return;
    this.quality = q;
    if (this.remoteSet) await this.applyParams();
  }

  private async setRelayed(on: boolean): Promise<void> {
    if (on === this.relayed) return;
    this.relayed = on;
    if (this.remoteSet) await this.applyParams();
  }

  /** Troca as faixas sem renegociar (trocar de janela, ou relay que mudou de origem). */
  async replaceStream(stream: MediaStream): Promise<void> {
    for (const tr of this.pc.getTransceivers()) {
      const next = stream.getTracks().find((t) => t.kind === tr.receiver.track.kind);
      if (next && tr.sender.track !== next) await tr.sender.replaceTrack(next).catch(() => {});
    }
  }

  async stats(): Promise<OutStats | null> {
    const report = await this.pc.getStats().catch(() => null);
    if (!report) return null;
    let out: any, remote: any, aout: any;
    report.forEach((s: any) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
      if (s.type === 'outbound-rtp' && s.kind === 'audio') aout = s;
      if (s.type === 'remote-inbound-rtp' && s.kind === 'video') remote = s;
    });
    if (!out) return null;
    void this.setRelayed(!!routeOf(report)?.relay);
    const codec: any = out.codecId ? report.get(out.codecId) : null;
    const dt = (out.timestamp - this.lastTime) / 1000;
    const kbps = this.lastTime && dt > 0 ? ((out.bytesSent - this.lastBytes) * 8) / dt / 1000 : 0;
    this.lastBytes = out.bytesSent;
    this.lastTime = out.timestamp;
    let audio: AudioStats | null = null;
    if (aout) {
      const adt = (aout.timestamp - this.lastAudioTime) / 1000;
      const akbps = this.lastAudioTime && adt > 0 ? ((aout.bytesSent - this.lastAudioBytes) * 8) / adt / 1000 : 0;
      this.lastAudioBytes = aout.bytesSent;
      this.lastAudioTime = aout.timestamp;
      audio = {
        kbps: Math.round(akbps),
        targetKbps: Math.round((aout.targetBitrate ?? 0) / 1000),
        stereo: opusStereo(aout.codecId ? report.get(aout.codecId) : null),
        concealedPct: 0,
      };
    }
    return {
      kbps: Math.round(kbps),
      fps: Math.round(out.framesPerSecond ?? 0),
      width: out.frameWidth ?? 0,
      height: out.frameHeight ?? 0,
      codec: (codec?.mimeType ?? '').replace('video/', ''),
      encoder: out.encoderImplementation ?? '',
      hardware: !!out.powerEfficientEncoder,
      limited: out.qualityLimitationReason ?? 'none',
      rttMs: Math.round((remote?.roundTripTime ?? 0) * 1000),
      lossPct: Math.round((remote?.fractionLost ?? 0) * 1000) / 10,
      turn: !!routeOf(report)?.relay,
      capped: this.capReason,
      audio,
    };
  }

  close(): void {
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}

/** Lado que recebe. */
export class Incoming {
  readonly pc: RTCPeerConnection;
  readonly stream = new MediaStream();
  private queued: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private lastBytes = 0;
  private lastTime = 0;
  private lastAudioBytes = 0;
  private lastAudioTime = 0;
  onstream: (stream: MediaStream) => void = () => {};
  onstate: (state: RTCPeerConnectionState) => void = () => {};

  constructor(
    private send: Send,
    ice: RTCIceServer[],
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle', iceTransportPolicy: icePolicy });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ t: 'ice', candidate: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => this.onstate(this.pc.connectionState);
    this.pc.ontrack = (e) => {
      // Buffer de reprodução: 0 = exibe o quadro assim que chega (latência mínima); com "reprodução
      // suave" ligada, segura alguns quadros para exibir num ritmo constante (o áudio acompanha
      // pela sincronia de lábios do próprio WebRTC).
      if (e.track.kind === 'video') {
        try {
          (e.receiver as any).jitterBufferTarget = net.smoothMs;
        } catch {
          /* API ausente */
        }
      }
      this.stream.addTrack(e.track);
      this.onstream(this.stream);
    };
  }

  async handle(msg: Msg): Promise<void> {
    try {
      await this.apply(msg);
    } catch (e) {
      console.warn('[LC] sinalização inválida ignorada', e);
    }
  }

  private async apply(msg: Msg): Promise<void> {
    if (msg.t === 'sdp') {
      if (!msg.sdp || typeof msg.sdp.sdp !== 'string' || msg.sdp.sdp.length > 100_000) return;
      await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp.sdp });
      this.remoteSet = true;
      for (const c of this.queued.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      const answer = await this.pc.createAnswer();
      const stereo = { type: answer.type, sdp: withStereoOpus(answer.sdp ?? '') };
      try {
        await this.pc.setLocalDescription(stereo);
      } catch {
        await this.pc.setLocalDescription(answer);
      }
      this.send({ t: 'sdp', sdp: this.pc.localDescription!.toJSON() });
    } else if (msg.t === 'ice') {
      if (!msg.candidate || typeof msg.candidate !== 'object') return;
      if (this.remoteSet) await this.pc.addIceCandidate(msg.candidate).catch(() => {});
      else this.queued.push(msg.candidate);
    }
  }

  async stats(): Promise<InStats | null> {
    const report = await this.pc.getStats().catch(() => null);
    if (!report) return null;
    let inn: any, pair: any, ain: any;
    report.forEach((s: any) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inn = s;
      if (s.type === 'inbound-rtp' && s.kind === 'audio') ain = s;
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
    if (!inn) return null;
    const codec: any = inn.codecId ? report.get(inn.codecId) : null;
    const dt = (inn.timestamp - this.lastTime) / 1000;
    const kbps = this.lastTime && dt > 0 ? ((inn.bytesReceived - this.lastBytes) * 8) / dt / 1000 : 0;
    this.lastBytes = inn.bytesReceived;
    this.lastTime = inn.timestamp;
    const emitted = inn.jitterBufferEmittedCount || 0;
    let audio: AudioStats | null = null;
    if (ain) {
      const adt = (ain.timestamp - this.lastAudioTime) / 1000;
      const akbps = this.lastAudioTime && adt > 0 ? ((ain.bytesReceived - this.lastAudioBytes) * 8) / adt / 1000 : 0;
      this.lastAudioBytes = ain.bytesReceived;
      this.lastAudioTime = ain.timestamp;
      const total = ain.totalSamplesReceived || 0;
      audio = {
        kbps: Math.round(akbps),
        targetKbps: 0,
        stereo: opusStereo(ain.codecId ? report.get(ain.codecId) : null),
        concealedPct: total ? Math.round(((ain.concealedSamples ?? 0) / total) * 1000) / 10 : 0,
      };
    }
    return {
      kbps: Math.round(kbps),
      fps: Math.round(inn.framesPerSecond ?? 0),
      width: inn.frameWidth ?? 0,
      height: inn.frameHeight ?? 0,
      codec: (codec?.mimeType ?? '').replace('video/', ''),
      decoder: inn.decoderImplementation ?? '',
      rttMs: Math.round((pair?.currentRoundTripTime ?? 0) * 1000),
      bufferMs: emitted ? Math.round((inn.jitterBufferDelay / emitted) * 1000) : 0,
      lost: inn.packetsLost ?? 0,
      dropped: inn.framesDropped ?? 0,
      turn: !!routeOf(report)?.relay,
      audio,
    };
  }

  close(): void {
    this.pc.onconnectionstatechange = null;
    this.pc.ontrack = null;
    this.pc.close();
  }
}
