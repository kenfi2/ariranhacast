import { preferCodec } from './codecs';
import { icePolicy } from './signaling';
import type { EncodeOpts, Msg } from './types';

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

/** Pede ao remetente áudio estéreo em bitrate de música (padrão do WebRTC é mono de voz). */
function withStereoOpus(sdp: string): string {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!pt) return sdp;
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=192000';
  return re.test(sdp)
    ? sdp.replace(re, (_m, params: string) => `a=fmtp:${pt} ${params};${extra}`)
    : sdp.replace(new RegExp(`(a=rtpmap:${pt} opus[^\\r\\n]*)`, 'i'), `$1\r\na=fmtp:${pt} ${extra}`);
}

/** A conexão está passando por um servidor TURN? E quantos bytes já trafegaram por ela. */
export function routeOf(report: RTCStatsReport): { relay: boolean; bytes: number } | null {
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
  return {
    relay: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
    bytes: (pair.bytesSent ?? 0) + (pair.bytesReceived ?? 0),
  };
}

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
}

/** Lado que envia: usado pelo host e também por espectadores que fazem relay. */
export class Outgoing {
  readonly pc: RTCPeerConnection;
  private queued: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private lastBytes = 0;
  private lastTime = 0;
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
        await this.pc.setRemoteDescription({ type: 'answer', sdp: withStartBitrate(msg.sdp.sdp!, startKbps) });
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
      if (sender.track?.kind !== 'video') continue;
      const p = sender.getParameters();
      if (!p.encodings?.length) continue;
      p.degradationPreference = opts.mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
      p.encodings[0].maxBitrate = opts.maxBitrate;
      p.encodings[0].maxFramerate = opts.maxFps;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      await sender.setParameters(p).catch((e) => console.warn('[LC] setParameters', e));
    }
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
    let out: any, remote: any;
    report.forEach((s: any) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
      if (s.type === 'remote-inbound-rtp' && s.kind === 'video') remote = s;
    });
    if (!out) return null;
    const codec: any = out.codecId ? report.get(out.codecId) : null;
    const dt = (out.timestamp - this.lastTime) / 1000;
    const kbps = this.lastTime && dt > 0 ? ((out.bytesSent - this.lastBytes) * 8) / dt / 1000 : 0;
    this.lastBytes = out.bytesSent;
    this.lastTime = out.timestamp;
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
      // Sem buffer extra: exibe o quadro assim que chega (latência mínima).
      if (e.track.kind === 'video') {
        try {
          (e.receiver as any).jitterBufferTarget = 0;
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
    let inn: any, pair: any;
    report.forEach((s: any) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inn = s;
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
    if (!inn) return null;
    const codec: any = inn.codecId ? report.get(inn.codecId) : null;
    const dt = (inn.timestamp - this.lastTime) / 1000;
    const kbps = this.lastTime && dt > 0 ? ((inn.bytesReceived - this.lastBytes) * 8) / dt / 1000 : 0;
    this.lastBytes = inn.bytesReceived;
    this.lastTime = inn.timestamp;
    const emitted = inn.jitterBufferEmittedCount || 0;
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
    };
  }

  close(): void {
    this.pc.onconnectionstatechange = null;
    this.pc.ontrack = null;
    this.pc.close();
  }
}
