import type { LobbyState, PublishedRoom } from '../shared/lobby';

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
  gameCapAvailable(): Promise<boolean>;
  /** Os quadros chegam por um MessagePort entregue via window.postMessage({ type: 'ariranhacast:frames' }). */
  gameCapStart(sourceId: string, fps: number, height: number): Promise<{ ok: boolean; reason?: string; width?: number; height?: number }>;
  gameCapStop(): Promise<void>;
  onGameCap(cb: (s: GameCapState) => void): void;
  onPcm(cb: (chunk: Uint8Array) => void): void;
  setHotkeys(keys: { mic: string; deaf: string; clip: string; voice: string } | null): Promise<{ mic: boolean; deaf: boolean; clip: boolean; voice: boolean }>;
  onHotkey(cb: (which: 'mic' | 'deaf' | 'leave' | 'clip' | 'voice') => void): void;
  setInRoom(on: boolean, micOn: boolean): Promise<void>;
  appVersion(): Promise<string>;
  onUpdate(cb: (text: string) => void): void;
  updaterState(): Promise<UpdaterState>;
  updaterCheck(): Promise<void>;
  updaterInstall(): Promise<boolean>;
  onUpdater(cb: (s: UpdaterState) => void): void;
  firewallStatus(): Promise<FirewallState>;
  firewallFix(): Promise<FirewallState>;
  gfxGet(): Promise<{ current: GfxConfig; saved: GfxConfig }>;
  gfxSet(cfg: GfxConfig): Promise<{ current: GfxConfig; saved: GfxConfig }>;
  relaunch(): Promise<void>;
  openExternal(url: string): Promise<boolean>;
  saveClip(data: ArrayBuffer, ext: string, voice?: boolean): Promise<{ ok: boolean; path?: string; error?: string }>;
  showClip(path: string): Promise<void>;
  yellowBorder(): Promise<boolean>;
  flash(): Promise<void>;
  gifSearch(key: string, query: string): Promise<{ ok: boolean; items: GifItem[]; error?: string }>;
  gifFetch(url: string): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }>;
  setOverlay(cfg: OverlayConfig): Promise<void>;
  pushOverlay(rows: OverlayRow[]): void;
  onDeepLink(cb: (code: string) => void): void;
  pendingDeepLink(): Promise<string>;
  logError(text: string): Promise<void>;
  openLogs(): Promise<boolean>;
  /** Conta e lista de salas abertas (o WebSocket e a sessão ficam no processo principal). */
  lobbyState(): Promise<LobbyState>;
  lobbyLogin(provider: string): Promise<boolean>;
  lobbyLogout(): Promise<void>;
  lobbyPublish(room: PublishedRoom | null): Promise<void>;
  lobbyPresence(code: string | null): Promise<void>;
  onLobby(cb: (s: LobbyState) => void): void;
  onLobbyError(cb: (text: string) => void): void;
}

export type GameCapState =
  | { state: 'hooked'; width: number; height: number; kind: string }
  | { state: 'lost' | 'ended' | 'error'; reason: string };

export interface GfxConfig {
  hwAccel: boolean;
  capture: 'auto' | 'wgc' | 'compat';
}

export interface GifItem {
  id: string;
  title: string;
  thumb: string; // data URL
  url: string; // arquivo a baixar quando escolhido
}

export interface OverlayConfig {
  enabled: boolean;
  corner: 'tl' | 'tr' | 'bl' | 'br';
  mode: 'speaking' | 'all';
}

export interface OverlayRow {
  name: string;
  color: string;
  speaking: boolean;
  muted: boolean;
}

export type UpdaterState =
  | { state: 'disabled'; reason: 'dev' | 'portatil' | 'sem-url' }
  | { state: 'checking' }
  | { state: 'uptodate' }
  | { state: 'available'; version: string; notes?: string }
  | { state: 'downloading'; version: string; percent: number; notes?: string }
  | { state: 'ready'; version: string; notes?: string }
  | { state: 'error'; message: string };

export type FirewallState = 'ok' | 'missing' | 'blocked' | 'unknown' | 'na';

declare global {
  interface Window {
    ariranhacast: AriranhaBridge;
  }
}

export type CodecChoice = 'auto' | 'AV1' | 'H265' | 'H264' | 'VP9' | 'VP8';

export type Quality = 'high' | 'med' | 'low';

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
  muted: boolean; // microfone desligado
  deaf: boolean; // silenciou as vozes (não ouve a sala)
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
  | { t: 'quality'; q: Quality }
  | { t: 'paused'; on: boolean }
  | { t: 'need-parent'; failed: string }
  // sala: entrada (anfitrião desafia, participante se apresenta)
  | { t: 'challenge'; nonce: string; proto: number; version: string; password: boolean }
  | { t: 'hello'; name: string; proto: number; version: string; auth: string; cnonce: string }
  | { t: 'welcome'; auth: string }
  | { t: 'reject'; reason: 'version' | 'password' | 'full'; version: string }
  // sala: funcionamento
  | { t: 'room'; peers: RosterEntry[]; limit?: number }
  | { t: 'ice-config'; servers: RTCIceServer[] }
  | { t: 'state'; cam: boolean; screen: boolean; title: string; muted?: boolean; deaf?: boolean }
  | { t: 'cmd'; cmd: 'mute' }
  | { t: 'kick' }
  // chat: membro → anfitrião (anfitrião define autor, hora e id) e anfitrião → todos
  | { t: 'chat'; text: string; img?: ChatImage; sticker?: boolean }
  | { t: 'chat-msg'; m: ChatMessage }
  | { t: 'chat-history'; msgs: ChatMessage[]; emotes: Emote[] }
  | { t: 'chat-del'; id: string }
  | { t: 'typing'; id?: string }
  | { t: 'emote-add'; emote: Emote }
  | { t: 'emote'; emote: Emote }
  | { t: 'emote-del'; name: string };

export interface ChatImage {
  mime: string;
  data: Uint8Array;
}

export interface ChatMessage {
  id: string;
  from: string; // id do participante (definido pelo anfitrião)
  name: string;
  ts: number;
  text: string;
  img?: ChatImage;
  sticker?: boolean; // a imagem é uma figurinha (mostrada menor e sem moldura)
  expired?: boolean; // a imagem foi descartada do histórico para poupar memória
}

export interface Emote {
  name: string; // a-z, 0-9 e _
  mime: string;
  data: Uint8Array;
  by: string;
}

export interface Settings {
  name: string;
  server: string; // "host:porta" de um PeerServer próprio; vazio = nuvem pública do PeerJS
  iceServers: string; // JSON com RTCIceServer[] extras (TURN)
  hotMic: string; // atalho global: ligar/desligar microfone
  hotDeaf: string; // atalho global: silenciar vozes
  hotClip: string; // atalho global: salvar um clipe
  hotVoice: string; // atalho global: salvar um clipe só de voz
  voiceSeconds: 0 | 30 | 60 | 120; // replay de voz (0 = desligado)
  giphyKey: string; // chave gratuita do Giphy para buscar GIFs no chat (opcional)
  relayEconomy: boolean; // limita a qualidade das conexões que passam pelo TURN
  turnLimitGb: number; // limite mensal do plano de TURN, para avisar (0 = sem aviso)
  overlayOn: boolean; // mostra quem está falando por cima do jogo
  overlayCorner: 'tl' | 'tr' | 'bl' | 'br';
  overlayMode: 'speaking' | 'all';
  clipSeconds: 0 | 30 | 60; // replay: quanto tempo para trás um clipe alcança (0 = desligado)
  clipWatched: boolean; // também grava as transmissões que você assiste
  smoothPlayback: boolean; // buffer de reprodução nas transmissões assistidas (filmes)
}
