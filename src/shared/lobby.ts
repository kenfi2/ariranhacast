// Cliente do lobby (lista de salas abertas + conta). Roda no processo principal do PC
// (Node, WebSocket global) e na página do app Android: só usa fetch e WebSocket.
//
// O servidor está em lobby/ (Cloudflare Worker). Fluxo de login:
//   1. loginUrl(provedor) → o app abre essa URL no navegador do sistema;
//   2. o provedor (Discord, Google…) devolve ao servidor, que cria uma sessão para este aparelho;
//   3. o navegador abre ariranhacast://auth?token=…&app_state=… → completeLogin(link).
// Cada aparelho tem a sua sessão: a mesma conta fica logada no PC e no celular ao mesmo tempo.

export interface LobbyUser {
  id: string; // "<provedor>:<id>"
  name: string;
  avatar: string | null;
  provider: string;
}

export interface LobbyRoom {
  code: string;
  name: string;
  locked: boolean;
  host: LobbyUser;
  count: number;
  members: string[];
  live: number;
  proto: number;
  createdAt: number;
  /** Servidores do Discord em comum entre você e quem hospeda (ids; nomes em LobbyState.guilds). */
  guilds: string[];
}

/** Alguém online agora que tem servidor do Discord em comum com você. */
export interface LobbyOnline {
  id: string;
  name: string;
  avatar: string | null;
  room: string | null; // sala em que está (código) ou null
  devices: string[]; // "pc", "android"
  guilds: string[];
}

/** Um servidor do Discord da sua conta. */
export interface LobbyGuild {
  id: string;
  name: string;
  icon: string | null;
}

export interface LobbyProvider {
  id: string;
  label: string;
}

/** O que quem hospeda publica sobre a sala. */
export interface PublishedRoom {
  code: string;
  name: string;
  locked: boolean;
  count: number;
  members: string[];
  live: number;
  proto: number;
}

/**
 * disabled   — o app não tem servidor de lobby configurado;
 * logged-out — precisa entrar com uma conta;
 * connecting / online / offline — logado; offline = sem lista no momento (tenta de novo sozinho).
 */
export type LobbyStatus = 'disabled' | 'logged-out' | 'connecting' | 'online' | 'offline';

export interface LobbyState {
  status: LobbyStatus;
  user: LobbyUser | null;
  rooms: LobbyRoom[];
  providers: LobbyProvider[];
  /** Seus servidores do Discord (vazio para contas Google ou antes de logar de novo). */
  guilds: LobbyGuild[];
  /** Online agora, com servidor do Discord em comum. */
  online: LobbyOnline[];
}

export interface Session {
  token: string;
  user: LobbyUser;
}

/** Onde a sessão fica guardada (PC: safeStorage do Electron; Android: armazenamento do app). */
export interface SessionStore {
  load(): Promise<Session | null> | Session | null;
  save(s: Session | null): Promise<void> | void;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^[A-Z0-9]{4,16}$/;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max) : '');
const int = (v: unknown, min: number, max: number) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v as number)) : min);

function cleanAvatar(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && (u.hostname === 'cdn.discordapp.com' || u.hostname.endsWith('.googleusercontent.com')) ? u.toString() : null;
  } catch {
    return null;
  }
}

export function cleanUser(raw: unknown): LobbyUser | null {
  const u = raw as Record<string, unknown> | null;
  const id = str(u?.id, 100);
  if (!id || !id.includes(':')) return null;
  return { id, name: str(u?.name, 24) || 'Usuário', avatar: cleanAvatar(u?.avatar), provider: str(u?.provider, 20) };
}

function cleanRoom(raw: unknown): LobbyRoom | null {
  const r = raw as Record<string, unknown> | null;
  const code = str(r?.code, 16);
  const host = cleanUser(r?.host);
  if (!CODE_RE.test(code) || !host) return null;
  return {
    code,
    name: str(r?.name, 40) || `Sala de ${host.name}`,
    locked: r?.locked === true,
    host,
    count: int(r?.count, 1, 16),
    members: Array.isArray(r?.members) ? (r.members as unknown[]).slice(0, 16).map((m) => str(m, 24)).filter(Boolean) : [],
    live: int(r?.live, 0, 16),
    proto: int(r?.proto, 0, 1000),
    createdAt: Number.isFinite(r?.createdAt) ? Number(r!.createdAt) : 0,
    guilds: Array.isArray(r?.guilds) ? (r.guilds as unknown[]).slice(0, 10).filter((g): g is string => typeof g === 'string' && /^\d{5,25}$/.test(g)) : [],
  };
}

function cleanOnline(raw: unknown): LobbyOnline | null {
  const o = raw as Record<string, unknown> | null;
  const user = cleanUser({ ...o, provider: 'discord' });
  if (!user) return null;
  const room = str(o?.room, 16);
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    room: CODE_RE.test(room) ? room : null,
    devices: Array.isArray(o?.devices) ? (o.devices as unknown[]).filter((d): d is string => d === 'pc' || d === 'android') : [],
    guilds: Array.isArray(o?.guilds) ? (o.guilds as unknown[]).slice(0, 10).filter((g): g is string => typeof g === 'string' && /^\d{5,25}$/.test(g)) : [],
  };
}

function cleanGuild(raw: unknown): LobbyGuild | null {
  const g = raw as Record<string, unknown> | null;
  const id = str(g?.id, 25);
  if (!/^\d{5,25}$/.test(id)) return null;
  let icon: string | null = null;
  try {
    const u = new URL(String(g?.icon));
    if (u.protocol === 'https:' && u.hostname === 'cdn.discordapp.com') icon = u.toString();
  } catch {
    /* sem ícone */
  }
  return { id, name: str(g?.name, 60) || 'Servidor', icon };
}

function randomState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class LobbyClient {
  state: LobbyState = { status: 'disabled', user: null, rooms: [], providers: [], guilds: [], online: [] };
  onchange: (s: LobbyState) => void = () => {};
  onerror: (text: string) => void = () => {};

  private session: Session | null = null;
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private stopped = true;
  private pendingState: { value: string; until: number } | null = null;
  private hosting: PublishedRoom | null = null;
  private lastSent = '';
  private presence: { room: string | null; device: 'pc' | 'android' } = { room: null, device: 'pc' };
  private lastPresence = '';

  constructor(
    private baseUrl: string,
    private store: SessionStore,
    /** Só em desenvolvimento (servidor local do wrangler). */
    private allowHttp = false,
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  }

  get enabled(): boolean {
    return /^https:\/\/[^/]+/i.test(this.baseUrl) || (this.allowHttp && /^http:\/\/[^/]+/i.test(this.baseUrl));
  }

  /** Carrega a sessão salva e conecta. Sem rede, segue com a conta salva (o app continua usável). */
  async start(): Promise<void> {
    if (!this.enabled) return this.set({ status: 'disabled' });
    this.stopped = false;
    void this.loadProviders();
    try {
      const s = await this.store.load();
      const user = s ? cleanUser(s.user) : null;
      this.session = s && user && TOKEN_RE.test(s.token) ? { token: s.token, user } : null;
    } catch {
      this.session = null;
    }
    if (!this.session) return this.set({ status: 'logged-out', user: null, rooms: [], guilds: [], online: [] });
    this.set({ user: this.session.user });
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
  }

  /** URL a abrir no navegador para entrar com `provider`. Vale por 10 minutos. */
  loginUrl(provider: string): string {
    const value = randomState();
    this.pendingState = { value, until: Date.now() + 10 * 60_000 };
    return `${this.baseUrl}/auth/login?provider=${encodeURIComponent(provider)}&app_state=${value}`;
  }

  /** Recebe o link ariranhacast://auth?… que o navegador abriu. Só aceita se foi este app que iniciou o login. */
  async completeLogin(link: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return false;
    }
    if (url.protocol !== 'ariranhacast:' || url.hostname !== 'auth') return false;
    const token = url.searchParams.get('token') ?? '';
    const appState = url.searchParams.get('app_state');
    const pending = this.pendingState;
    if (!pending || pending.until < Date.now() || appState !== pending.value || !TOKEN_RE.test(token)) return false;
    this.pendingState = null;

    const user = await this.fetchMe(token).catch(() => null);
    if (!user || user === 'unauthorized') {
      this.onerror('Não foi possível concluir o login. Tente de novo.');
      return false;
    }
    this.session = { token, user };
    await this.store.save(this.session);
    this.stopped = false;
    this.set({ user, rooms: [] });
    await this.connect();
    return true;
  }

  async logout(): Promise<void> {
    const token = this.session?.token;
    this.session = null;
    this.hosting = null;
    this.cleanup();
    await this.store.save(null);
    this.set({ status: 'logged-out', user: null, rooms: [], guilds: [], online: [] });
    if (token) {
      await fetch(`${this.baseUrl}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
  }

  /** Em que sala esta pessoa está agora (null = nenhuma). Aparece em "Online agora" para quem tem servidor em comum. */
  setPresence(room: string | null, device: 'pc' | 'android'): void {
    this.presence = { room: room && CODE_RE.test(room) ? room : null, device };
    const msg = JSON.stringify({ type: 'presence', ...this.presence });
    if (msg === this.lastPresence) return;
    if (this.send(msg)) this.lastPresence = msg;
  }

  /** Quem hospeda publica a sala (null = tira da lista). Reenviada sozinha após reconectar. */
  publish(room: PublishedRoom | null): void {
    this.hosting = room;
    const msg = JSON.stringify(room ? { type: 'set_room', ...room } : { type: 'close_room' });
    if (msg === this.lastSent) return;
    if (this.send(msg)) this.lastSent = msg;
  }

  // ---------- internos ----------

  private set(patch: Partial<LobbyState>): void {
    this.state = { ...this.state, ...patch };
    this.onchange(this.state);
  }

  private async loadProviders(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/providers`, { signal: AbortSignal.timeout(8000) });
      const list = (await res.json()) as unknown;
      if (!Array.isArray(list)) return;
      const providers = list
        .map((p) => ({ id: str(p?.id, 20), label: str(p?.label, 30) }))
        .filter((p) => /^[a-z0-9-]+$/.test(p.id) && p.label);
      this.set({ providers });
    } catch {
      setTimeout(() => !this.stopped && !this.state.providers.length && void this.loadProviders(), 15_000);
    }
  }

  private async fetchMe(token: string): Promise<LobbyUser | 'unauthorized' | null> {
    const res = await fetch(`${this.baseUrl}/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401) return 'unauthorized';
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return cleanUser(await res.json());
  }

  private async connect(): Promise<void> {
    this.cleanup();
    const session = this.session;
    if (this.stopped || !session) return;
    this.set({ status: 'connecting' });

    // Confere a sessão antes (um 401 no WebSocket não diz o motivo) e atualiza nome/foto.
    try {
      const me = await this.fetchMe(session.token);
      if (this.session !== session) return;
      if (me === 'unauthorized') {
        this.session = null;
        await this.store.save(null);
        this.onerror('Sua sessão expirou. Entre de novo.');
        return this.set({ status: 'logged-out', user: null, rooms: [], guilds: [], online: [] });
      }
      if (me && JSON.stringify(me) !== JSON.stringify(session.user)) {
        session.user = me;
        await this.store.save(session);
        this.set({ user: me });
      }
    } catch {
      return this.scheduleReconnect();
    }

    const ws = new WebSocket(`${this.baseUrl.replace(/^http/i, 'ws')}/lobby`, ['ariranhacast', session.token]);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.lastSent = '';
      this.set({ status: 'online' });
      this.pingTimer = setInterval(() => ws.readyState === ws.OPEN && ws.send('ping'), 25_000);
      this.lastPresence = '';
      this.setPresence(this.presence.room, this.presence.device);
      if (this.hosting) this.publish(this.hosting);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data === 'pong') return;
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg?.type === 'welcome' || msg?.type === 'rooms') {
        const rooms = Array.isArray(msg.rooms) ? (msg.rooms as unknown[]).slice(0, 200).map(cleanRoom).filter((r): r is LobbyRoom => !!r) : [];
        const online = Array.isArray(msg.online) ? (msg.online as unknown[]).slice(0, 100).map(cleanOnline).filter((o): o is LobbyOnline => !!o) : [];
        if (msg.type === 'welcome' && Array.isArray(msg.guilds)) {
          const guilds = (msg.guilds as unknown[]).slice(0, 250).map(cleanGuild).filter((g): g is LobbyGuild => !!g);
          this.set({ rooms, online, guilds });
        } else this.set({ rooms, online });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.cleanup();
      if (!this.stopped && this.session) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* o onclose vem em seguida */
    };
  }

  private send(text: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(text);
    return true;
  }

  private scheduleReconnect(): void {
    this.set({ status: 'offline', rooms: [], online: [] });
    const delay = Math.min(30_000, 1000 * 2 ** this.retries++) + Math.random() * 500;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.lastSent = '';
    this.lastPresence = '';
    if (ws && (ws.readyState === ws.CONNECTING || ws.readyState === ws.OPEN)) {
      try {
        ws.close(1000);
      } catch {
        /* já fechado */
      }
    }
  }
}
