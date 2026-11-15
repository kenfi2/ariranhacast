import type { LinkQuality } from './link';
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
  gate: GateMode; // sensibilidade do microfone
  gateDb: number; // limiar manual, em dB (-80..-20)
  sounds: boolean; // sons de entrar, sair, mutar…
}

/** off = envia tudo · auto = limiar acompanha o ruído de fundo · manual = limiar fixo */
export type GateMode = 'off' | 'auto' | 'manual';
export const GATE_MIN_DB = -80;
export const GATE_MAX_DB = -20;

export interface VoiceRow {
  id: string;
  name: string;
  self: boolean;
  connected: boolean;
  speaking: boolean;
  volume: number;
  turn: boolean; // a conexão com este participante passa pelo TURN
  muted: boolean; // microfone desligado
  deaf: boolean; // não está ouvindo as vozes
  link?: LinkQuality;
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
const GATE_HOLD_MS = 450;

export function loadVoicePrefs(): VoicePrefs {
  try {
    const saved = JSON.parse(localStorage.getItem('ariranhacast.voice') ?? '{}');
    return {
      mode: ['off', 'standard', 'ai'].includes(saved.mode) ? saved.mode : 'standard',
      micId: typeof saved.micId === 'string' ? saved.micId : '',
      sinkId: typeof saved.sinkId === 'string' ? saved.sinkId : '',
      streamSinkId: typeof saved.streamSinkId === 'string' ? saved.streamSinkId : '',
      volume: typeof saved.volume === 'number' ? Math.min(1, Math.max(0, saved.volume)) : 1,
      gate: saved.gate === 'auto' || saved.gate === 'manual' ? saved.gate : 'off',
      gateDb: typeof saved.gateDb === 'number' ? Math.min(GATE_MAX_DB, Math.max(GATE_MIN_DB, saved.gateDb)) : -50,
      sounds: saved.sounds !== false,
    };
  } catch {
    return { mode: 'standard', micId: '', sinkId: '', streamSinkId: '', volume: 1, gate: 'off', gateDb: -50, sounds: true };
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
  readonly prefs = loadVoicePrefs();
  micOn = false;
  deafened = false;
  micError = '';
  private ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  private out = this.ctx.createMediaStreamDestination();
  private micGain = this.ctx.createGain(); // microfone já tratado (supressão de ruído)
  private gateGain = this.ctx.createGain(); // sensibilidade: fecha quando o som fica abaixo do limiar
  private gateOpen = true;
  private gateLast = 0; // última vez que o som passou do limiar
  private noiseDb = -70; // ruído de fundo estimado (modo automático)
  private gateTimer: number;
  private gateBuf = new Float32Array(1024);
  private sendGain = this.ctx.createGain(); // 1 = os amigos ouvem · 0 = mudo ou em teste
  private monitorGain = this.ctx.createGain(); // retorno do teste de microfone
  private recDest = this.ctx.createMediaStreamDestination(); // mistura da conversa para o clipe de voz
  /** Teste de microfone ligado: você se ouve na hora e os amigos não te ouvem. */
  monitoring = false;
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
  links = new Map<string, LinkQuality>(); // ping/perda por pessoa (preenchido pelo app)
  /** mudo/sem ouvir de cada pessoa, como a sala informa (preenchido pelo app). */
  peerState = new Map<string, { muted: boolean; deaf: boolean }>();
  onchange: () => void = () => {};

  constructor(
    private peer: Peer,
    private selfName: string,
    private allow: (id: string) => boolean, // o id pertence a alguém da sala?
  ) {
    this.selfAnalyser.fftSize = 1024;
    this.micGain.connect(this.gateGain);
    this.gateGain.connect(this.sendGain);
    this.sendGain.connect(this.out);
    this.sendGain.connect(this.recDest);
    this.sendGain.gain.value = 0;
    this.micGain.connect(this.selfAnalyser);
    this.monitorGain.gain.value = 0;
    this.gateGain.connect(this.monitorGain); // o teste já passa pela sensibilidade: você ouve o que a sala ouviria
    this.monitorGain.connect(this.ctx.destination);
    this.applyMonitorSink();
    void this.ctx.resume();
    peer.on('call', (call) => this.onIncoming(call));
    this.timer = window.setInterval(() => this.tick(), 100);
    this.gateTimer = window.setInterval(() => this.gateTick(), 20);
  }

  // ---------- sensibilidade do microfone ----------
  /** Limiar em uso agora, em dB (no automático, acompanha o ruído de fundo). */
  gateThreshold(): number {
    if (this.prefs.gate === 'manual') return this.prefs.gateDb;
    return Math.min(-38, Math.max(-62, this.noiseDb + 9));
  }

  /** O microfone está passando som para a sala neste instante? */
  get gateIsOpen(): boolean {
    return this.gateOpen;
  }

  /** Nível atual do microfone em dB (antes da sensibilidade). */
  selfDb(): number {
    const db = levelDb(this.selfAnalyser, this.gateBuf);
    return Number.isFinite(db) ? Math.max(-100, db) : -100;
  }

  private gateTick(): void {
    const mode = this.prefs.gate;
    if (mode === 'off' || !this.mic) {
      if (!this.gateOpen) this.setGate(true);
      return;
    }
    const now = performance.now();
    const db = this.selfDb();
    if (mode === 'auto') {
      // Ruído de fundo: desce rápido para o nível mais baixo visto, sobe bem devagar (≈1,5 dB/s).
      if (db < this.noiseDb) this.noiseDb += (db - this.noiseDb) * 0.3;
      else this.noiseDb = Math.min(-40, this.noiseDb + 0.03);
      this.noiseDb = Math.max(-90, this.noiseDb);
    }
    const thr = this.gateThreshold();
    // Abre no limiar; para fechar exige ficar 3 dB abaixo por um tempo (não corta fim de palavra).
    if (db >= thr) this.gateLast = now;
    else if (this.gateOpen && db >= thr - 3) this.gateLast = Math.max(this.gateLast, now - GATE_HOLD_MS / 2);
    const open = now - this.gateLast < GATE_HOLD_MS;
    if (open !== this.gateOpen) this.setGate(open);
  }

  private setGate(open: boolean): void {
    this.gateOpen = open;
    const g = this.gateGain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(open ? 1 : 0, t, open ? 0.004 : 0.04); // abre quase na hora, fecha suave
  }

  setGateMode(mode: GateMode): void {
    this.prefs.gate = mode;
    this.gateLast = 0;
    this.save();
    if (mode === 'off') this.setGate(true);
  }

  setGateDb(db: number): void {
    this.prefs.gateDb = Math.min(GATE_MAX_DB, Math.max(GATE_MIN_DB, db));
    this.save();
  }

  setSounds(on: boolean): void {
    this.prefs.sounds = on;
    this.save();
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
      r.source.connect(this.recDest);
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
      this.micOn = false;
      this.syncSend();
      if (!this.monitoring) this.closeMic();
      return this.onchange();
    }
    try {
      await this.openMic();
      this.micOn = true;
      if (this.deafened) this.setDeafened(false);
    } catch (e: any) {
      this.failMic(e);
    }
    this.syncSend();
    this.onchange();
  }

  private failMic(e: any): void {
    this.closeMic();
    this.micOn = false;
    this.monitoring = false;
    this.monitorGain.gain.value = 0;
    this.micError = e?.name === 'NotFoundError' ? 'Nenhum microfone encontrado.' : `Microfone indisponível (${e?.name ?? e}).`;
  }

  /** Os amigos só ouvem com o microfone ligado e fora do teste. */
  private syncSend(): void {
    this.sendGain.gain.value = this.micOn && !this.monitoring ? 1 : 0;
  }

  private applyMonitorSink(): void {
    void (this.ctx as any).setSinkId?.(this.prefs.sinkId || '').catch(() => {});
  }

  /**
   * Teste de microfone com retorno instantâneo: você se ouve ao vivo, do jeito que os amigos
   * ouvem (com a supressão de ruído escolhida). Enquanto o teste está ligado, a sala não te ouve.
   */
  async setMonitor(on: boolean): Promise<void> {
    if (on === this.monitoring) return;
    this.micError = '';
    if (on) {
      try {
        if (!this.mic) await this.openMic();
        this.monitoring = true;
        this.monitorGain.gain.value = 1;
      } catch (e: any) {
        this.failMic(e);
      }
    } else {
      this.monitoring = false;
      this.monitorGain.gain.value = 0;
      if (!this.micOn) this.closeMic();
    }
    this.syncSend();
    this.onchange();
  }

  /** Reabre o microfone (troca de dispositivo ou de supressão) mantendo mudo/teste como estavam. */
  private async reopenMic(): Promise<void> {
    if (!this.micOn && !this.monitoring) return;
    try {
      await this.openMic();
    } catch (e: any) {
      this.failMic(e);
    }
    this.syncSend();
    this.onchange();
  }

  /** Mistura da conversa (seu microfone quando ligado + as vozes dos outros), para o clipe de voz. */
  get recordStream(): MediaStream {
    return this.recDest.stream;
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

  /** Nível atual do microfone, de 0 a 1 (para o medidor do teste). */
  selfLevel(): number {
    const db = levelDb(this.selfAnalyser, this.buf);
    return Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 60) / 60)) : 0;
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
    await this.reopenMic();
  }

  async setMicDevice(id: string): Promise<void> {
    this.prefs.micId = id;
    this.save();
    await this.reopenMic();
  }

  setSink(id: string): void {
    this.prefs.sinkId = id;
    this.save();
    this.applyMonitorSink();
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
    if (this.micOn && !this.monitoring && this.gateOpen && levelDb(this.selfAnalyser, this.buf) > SPEAK_DB) this.selfLast = now;
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
      { id: 'self', name: `${this.selfName} (você)`, self: true, connected: true, speaking: this.selfSpeaking, volume: 1, turn: false, muted: !this.micOn, deaf: this.deafened },
    ];
    for (const [id, r] of this.remotes) {
      const connected = r.call?.peerConnection?.connectionState === 'connected';
      const st = this.peerState.get(id);
      rows.push({ id, name: r.name, self: false, connected, speaking: r.speaking, volume: r.volume, turn: connected && this.turnIds.has(id), muted: !!st?.muted, deaf: !!st?.deaf, link: connected ? this.links.get(id) : undefined });
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
    clearInterval(this.gateTimer);
    this.closeMic();
    for (const [id, r] of [...this.remotes]) this.drop(id, r);
    void this.ctx.close();
  }
}
