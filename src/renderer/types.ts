export interface SourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
}

export interface AriranhaBridge {
  getSources(): Promise<SourceInfo[]>;
  selectSource(id: string, audio: boolean): Promise<void>;
  setStreaming(on: boolean): Promise<void>;
  platform(): Promise<string>;
  startAudioCap(sourceId: string): Promise<{ ok: boolean; reason?: string }>;
  stopAudioCap(): Promise<void>;
  onPcm(cb: (chunk: Uint8Array) => void): void;
  setHotkeys(keys: { mic: string; deaf: string } | null): Promise<{ mic: boolean; deaf: boolean }>;
  onHotkey(cb: (which: 'mic' | 'deaf' | 'leave') => void): void;
  setInRoom(on: boolean, micOn: boolean): Promise<void>;
  appVersion(): Promise<string>;
  onUpdate(cb: (text: string) => void): void;
}

declare global {
  interface Window {
    ariranhacast: AriranhaBridge;
  }
}

export type CodecChoice = 'auto' | 'AV1' | 'H265' | 'H264' | 'VP9' | 'VP8';

/** Parâmetros de encode; quem transmite manda isso aos relays para repassarem na mesma qualidade. */
export interface EncodeOpts {
  maxBitrate: number; // bps
  maxFps: number;
  mode: 'motion' | 'detail';
  codec: CodecChoice;
}

/** Um participante da sala e o que ele está publicando. */
export interface RosterEntry {
  id: string;
  name: string;
  cam: boolean;
  screen: boolean;
  title: string; // nome da tela/janela transmitida
}

export type Msg =
  // sinalização de mídia (transmissão de tela)
  | { t: 'sdp'; sdp: RTCSessionDescriptionInit }
  | { t: 'ice'; candidate: RTCIceCandidateInit }
  // quem transmite → quem assiste
  | { t: 'assign'; parent: string; opts: EncodeOpts; title: string }
  | { t: 'end' }
  // quem assiste → quem transmite
  | { t: 'status'; receiving: boolean }
  | { t: 'need-parent'; failed: string }
  // sala: entrada (anfitrião desafia, participante se apresenta)
  | { t: 'challenge'; nonce: string; proto: number; version: string; password: boolean }
  | { t: 'hello'; name: string; proto: number; version: string; auth: string; cnonce: string }
  | { t: 'welcome'; auth: string }
  | { t: 'reject'; reason: 'version' | 'password' | 'full'; version: string }
  // sala: funcionamento
  | { t: 'room'; peers: RosterEntry[] }
  | { t: 'ice-config'; servers: RTCIceServer[] }
  | { t: 'state'; cam: boolean; screen: boolean; title: string }
  | { t: 'cmd'; cmd: 'mute' }
  | { t: 'kick' };

export interface Settings {
  name: string;
  server: string; // "host:porta" de um PeerServer próprio; vazio = nuvem pública do PeerJS
  iceServers: string; // JSON com RTCIceServer[] extras (TURN)
  hotMic: string; // atalho global: ligar/desligar microfone
  hotDeaf: string; // atalho global: silenciar vozes
}
