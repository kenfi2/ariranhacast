import type Peer from 'peerjs';
import type { MediaConnection } from 'peerjs';
import { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
// @ts-expect-error binário embutido pelo esbuild (loader "binary")
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm';

/** off = microfone cru · standard = supressão do WebRTC · ai = rede neural RNNoise */
export type NsMode = 'off' | 'standard' | 'ai';

export interface VoicePrefs {
  mode: NsMode;
  micId: string;
  sinkId: string; // saída das vozes
  streamSinkId: string; // saída do áudio das transmissões
  volume: number; // volume geral das vozes (0..1)
}

export interface VoiceRow {
  id: string;
  name: string;
  self: boolean;
  connected: boolean;
  speaking: boolean;
  volume: number;
  turn: boolean; // a conexão com este participante passa pelo TURN
}

interface Remote {
  name: string;
  inRoster: boolean;
  call?: MediaConnection;
  audio: HTMLAudioElement;
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  volume: number;
  speaking: boolean;
  lastDial: number;
}

const SPEAK_DB = -50;
const SPEAK_HOLD_MS = 350;

function loadPrefs(): VoicePrefs {
  try {
    const saved = JSON.parse(localStorage.getItem('ariranhacast.voice') ?? '{}');
    return {
      mode: ['off', 'standard', 'ai'].includes(saved.mode) ? saved.mode : 'standard',
      micId: typeof saved.micId === 'string' ? saved.micId : '',
      sinkId: typeof saved.sinkId === 'string' ? saved.sinkId : '',
      streamSinkId: typeof saved.streamSinkId === 'string' ? saved.streamSinkId : '',
      volume: typeof saved.volume === 'number' ? Math.min(1, Math.max(0, saved.volume)) : 1,
    };
  } catch {
    return { mode: 'standard', micId: '', sinkId: '', streamSinkId: '', volume: 1 };
  }
}

/** Opus de voz: DTX (não transmite silêncio), FEC contra perda e bitrate de fala. */
function voiceSdp(sdp: string): string {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (_m, p: string) => `a=fmtp:${pt} ${p};usedtx=1;maxaveragebitrate=64000`);
}

function levelDb(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const x of buf) sum += x * x;
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * Chat de voz em malha: cada participante mantém uma conexão de áudio direta com
 * cada um dos outros (áudio é leve; 10 pessoas = 9 fluxos Opus de ~30 kbps).
 * O que enviamos é sempre a mesma faixa de saída de um grafo Web Audio; ligar o
 * microfone ou trocar a supressão de ruído só religa o grafo, sem renegociar.
 */
export class Voice {
  readonly prefs = loadPrefs();
  micOn = false;
  deafened = false;
  micError = '';
  private ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  private out = this.ctx.createMediaStreamDestination();
  private micGain = this.ctx.createGain();
  private selfAnalyser = this.ctx.createAnalyser();
  private buf = new Float32Array(1024);
  private mic?: MediaStream;
  private micNodes: AudioNode[] = [];
  private rnnoise?: RnnoiseWorkletNode;
  private workletLoaded?: Promise<void>;
  private remotes = new Map<string, Remote>();
  private selfSpeaking = false;
  private selfLast = 0;
  private lastSeen = new Map<string, number>();
  private timer: number;
  private closed = false;
  /** ids cuja conexão de voz passa pelo TURN (atualizado pelo app a partir das estatísticas). */
  turnIds = new Set<string>();
  onchange: () => void = () => {};

  constructor(
    private peer: Peer,
    private selfName: string,
    private allow: (id: string) => boolean, // o id pertence a alguém da sala?
  ) {
    this.selfAnalyser.fftSize = 1024;
    this.micGain.connect(this.out);
    this.micGain.connect(this.selfAnalyser);
    void this.ctx.resume();
    peer.on('call', (call) => this.onIncoming(call));
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  // ---------- participantes ----------
  setRoster(list: { id: string; name: string }[]): void {
    const me = this.peer.id;
    const ids = new Set(list.map((p) => p.id));
    for (const p of list) {
      if (p.id === me) continue;
      const r = this.ensure(p.id, p.name);
      r.name = p.name;
      r.inRoster = true;
    }
    for (const [id, r] of this.remotes) {
      if (!ids.has(id)) this.drop(id, r);
    }
    this.dialMissing();
    this.onchange();
  }

  private ensure(id: string, name: string): Remote {
    let r = this.remotes.get(id);
    if (!r) {
      const audio = new Audio();
      audio.autoplay = true;
      audio.muted = this.deafened;
      if (this.prefs.sinkId) void (audio as any).setSinkId?.(this.prefs.sinkId).catch(() => {});
      audio.volume = this.prefs.volume;
      r = { name, inRoster: false, audio, volume: 1, speaking: false, lastDial: 0 };
      this.remotes.set(id, r);
    }
    return r;
  }

  /** Entre dois participantes, quem tem o menor id é quem liga (evita chamadas cruzadas). */
  private dialMissing(): void {
    const me = this.peer.id;
    if (!me || this.closed) return;
    for (const [id, r] of this.remotes) {
      if (r.call || !r.inRoster || me > id || Date.now() - r.lastDial < 4000) continue;
      r.lastDial = Date.now();
      const call = this.peer.call(id, this.out.stream, {
        metadata: { role: 'voice' },
        sdpTransform: voiceSdp,
      });
      if (call) this.bind(id, r, call);
    }
  }

  private onIncoming(call: MediaConnection): void {
    const meta = (call.metadata ?? {}) as { role?: string };
    if (meta.role !== 'voice') return; // webcam e afins têm seus próprios tratadores
    // Só atendemos quem está na sala; quem ligou tenta de novo se a lista ainda não chegou.
    if (this.closed || !this.allow(call.peer)) return call.close();
    const r = this.ensure(call.peer, 'Participante');
    r.call?.close();
    call.answer(this.out.stream, { sdpTransform: voiceSdp });
    this.bind(call.peer, r, call);
  }

  private bind(id: string, r: Remote, call: MediaConnection): void {
    r.call = call;
    const gone = () => {
      if (r.call !== call) return;
      r.call = undefined;
      this.detach(r);
      this.onchange();
    };
    call.on('stream', (stream) => {
      if (r.call !== call) return;
      this.detach(r);
      r.audio.srcObject = stream;
      void r.audio.play().catch(() => {});
      r.source = this.ctx.createMediaStreamSource(stream);
      r.analyser = this.ctx.createAnalyser();
      r.analyser.fftSize = 1024;
      r.source.connect(r.analyser);
      this.onchange();
    });
    call.on('close', gone);
    call.on('error', gone);
  }

  private detach(r: Remote): void {
    r.source?.disconnect();
    r.source = undefined;
    r.analyser = undefined;
    r.audio.srcObject = null;
    r.speaking = false;
  }

  private drop(id: string, r: Remote): void {
    const call = r.call;
    r.call = undefined;
    call?.close();
    this.detach(r);
    this.remotes.delete(id);
    this.lastSeen.delete(id);
  }

  // ---------- microfone e supressão de ruído ----------
  async setMic(on: boolean): Promise<void> {
    this.micError = '';
    if (!on) {
      this.closeMic();
      this.micOn = false;
      return this.onchange();
    }
    try {
      await this.openMic();
      this.micOn = true;
      if (this.deafened) this.setDeafened(false);
    } catch (e: any) {
      this.closeMic();
      this.micOn = false;
      this.micError = e?.name === 'NotFoundError' ? 'Nenhum microfone encontrado.' : `Microfone indisponível (${e?.name ?? e}).`;
    }
    this.onchange();
  }

  private async openMic(): Promise<void> {
    this.closeMic();
    await this.ctx.resume();
    const mode = this.prefs.mode;
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.prefs.micId ? { exact: this.prefs.micId } : undefined,
        channelCount: 1,
        echoCancellation: true, // sempre: remove o som do jogo/vozes que vaza das caixas
        autoGainControl: true,
        noiseSuppression: mode === 'standard',
      },
    });
    const source = this.ctx.createMediaStreamSource(this.mic);
    this.micNodes = [source];
    let last: AudioNode = source;
    if (mode === 'ai') {
      this.workletLoaded ??= this.ctx.audioWorklet.addModule('rnnoise-worklet.js');
      await this.workletLoaded;
      const bytes = rnnoiseWasm as Uint8Array;
      const wasmBinary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      this.rnnoise = new RnnoiseWorkletNode(this.ctx, { maxChannels: 1, wasmBinary });
      source.connect(this.rnnoise);
      this.micNodes.push(this.rnnoise);
      last = this.rnnoise;
    }
    last.connect(this.micGain);
  }

  private closeMic(): void {
    for (const n of this.micNodes) n.disconnect();
    this.micNodes = [];
    this.rnnoise?.destroy();
    this.rnnoise = undefined;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = undefined;
  }

  async setMode(mode: NsMode): Promise<void> {
    this.prefs.mode = mode;
    this.save();
    if (this.micOn) await this.setMic(true);
  }

  async setMicDevice(id: string): Promise<void> {
    this.prefs.micId = id;
    this.save();
    if (this.micOn) await this.setMic(true);
  }

  setSink(id: string): void {
    this.prefs.sinkId = id;
    this.save();
    for (const r of this.remotes.values()) void (r.audio as any).setSinkId?.(id).catch(() => {});
  }

  setDeafened(on: boolean): void {
    this.deafened = on;
    for (const r of this.remotes.values()) r.audio.muted = on;
    if (on && this.micOn) void this.setMic(false);
    this.onchange();
  }

  setVolume(id: string, volume: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.volume = volume;
    r.audio.volume = volume * this.prefs.volume;
  }

  /** Volume geral das vozes, por cima do volume de cada participante. */
  setMasterVolume(volume: number): void {
    this.prefs.volume = Math.min(1, Math.max(0, volume));
    this.save();
    for (const r of this.remotes.values()) r.audio.volume = r.volume * this.prefs.volume;
  }

  setStreamSink(id: string): void {
    this.prefs.streamSinkId = id;
    this.save();
    this.onchange();
  }

  /** Conexões de voz, por participante (para medir rota e consumo do TURN). */
  pcs(): [string, RTCPeerConnection][] {
    const out: [string, RTCPeerConnection][] = [];
    for (const [id, r] of this.remotes) if (r.call?.peerConnection) out.push([id, r.call.peerConnection]);
    return out;
  }

  private save(): void {
    localStorage.setItem('ariranhacast.voice', JSON.stringify(this.prefs));
  }

  // ---------- indicador de quem está falando, reconexão ----------
  private ticks = 0;
  private tick(): void {
    const now = Date.now();
    let changed = false;
    if (this.micOn && levelDb(this.selfAnalyser, this.buf) > SPEAK_DB) this.selfLast = now;
    const self = this.micOn && now - this.selfLast < SPEAK_HOLD_MS;
    if (self !== this.selfSpeaking) {
      this.selfSpeaking = self;
      changed = true;
    }
    for (const [id, r] of this.remotes) {
      if (r.analyser && levelDb(r.analyser, this.buf) > SPEAK_DB) this.lastSeen.set(id, now);
      const speaking = now - (this.lastSeen.get(id) ?? 0) < SPEAK_HOLD_MS;
      if (speaking !== r.speaking) {
        r.speaking = speaking;
        changed = true;
      }
      const state = r.call?.peerConnection?.connectionState;
      if (state === 'failed' || state === 'closed') r.call?.close();
    }
    if (++this.ticks % 20 === 0) this.dialMissing();
    if (changed) this.onchange();
  }

  /** ids de quem está falando agora ('self' = nós). */
  speakingIds(): Set<string> {
    const ids = new Set<string>();
    if (this.selfSpeaking) ids.add('self');
    for (const [id, r] of this.remotes) if (r.speaking) ids.add(id);
    return ids;
  }

  rows(): VoiceRow[] {
    const rows: VoiceRow[] = [
      { id: 'self', name: `${this.selfName} (você)`, self: true, connected: true, speaking: this.selfSpeaking, volume: 1, turn: false },
    ];
    for (const [id, r] of this.remotes) {
      const connected = r.call?.peerConnection?.connectionState === 'connected';
      rows.push({ id, name: r.name, self: false, connected, speaking: r.speaking, volume: r.volume, turn: connected && this.turnIds.has(id) });
    }
    return rows;
  }

  async devices(): Promise<{ mics: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    return {
      mics: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications'),
      outputs: all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications'),
    };
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.closeMic();
    for (const [id, r] of [...this.remotes]) this.drop(id, r);
    void this.ctx.close();
  }
}
