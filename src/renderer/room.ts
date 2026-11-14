import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { ID_PREFIX, iceServers, makePeer, newRoomCode, setRoomIce, shareableIce } from './signaling';
import type { Msg, RosterEntry, Settings } from './types';

/** Versão do protocolo entre os apps. Muda quando versões diferentes deixam de se entender. */
export const PROTO = 3;
const MAX_MEMBERS = 16;
const DEAD_AFTER_MS = 5000;
const RECOVER_FOR_MS = 120_000;
const HELLO_TIMEOUT_MS = 10_000;

interface Member {
  conn: DataConnection;
  entry: RosterEntry;
  deadSince?: number;
}

type JoinResult = { ok: true } | { ok: false; reason: string; fatal: boolean };

/** Texto vindo da rede: limita o tamanho e remove caracteres de controle/formatação
 * (inclusive os que invertem a direção do texto para disfarçar nomes). */
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, max) : '');

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Tudo o que chega pela rede é tratado como dado não confiável. */
function cleanRoster(raw: unknown): RosterEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const p of raw.slice(0, MAX_MEMBERS + 1)) {
    if (!p || typeof p !== 'object') continue;
    const id = str((p as any).id, 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: str((p as any).name, 24) || 'Convidado',
      cam: (p as any).cam === true,
      screen: (p as any).screen === true,
      title: str((p as any).title, 80),
    });
  }
  return out;
}

async function proof(password: string, nonce: string, code: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${nonce}:${code}`));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A sala. Cada participante tem um peer de identidade (id aleatório), usado para voz,
 * webcam e transmissões. Quem hospeda a sala mantém, além disso, o "peer da sala"
 * (id = código), que só serve para receber quem entra e distribuir a lista de
 * participantes. Se quem hospeda sai ou cai, o participante mais antigo assume o
 * código; voz e vídeo entre os demais nem são interrompidos, pois são diretos.
 */
export class Room {
  peer!: Peer; // identidade
  code = '';
  isHost = false;
  roster: RosterEntry[] = [];
  private roomPeer?: Peer; // só em quem hospeda
  private self: RosterEntry;
  private members = new Map<string, Member>(); // só em quem hospeda
  /** Ao assumir a sala: participantes da lista anterior que ainda não se reapresentaram. */
  private pending = new Map<string, { entry: RosterEntry; until: number }>();
  private control?: DataConnection; // só nos demais
  private timer = 0;
  private closed = false;
  private recovering = false;

  onroster: (list: RosterEntry[]) => void = () => {};
  onend: (reason: string) => void = () => {};
  /** Texto de estado ("Reconectando à sala…") ou vazio quando está tudo certo. */
  onstatus: (text: string) => void = () => {};
  /** Quem hospeda pediu algo (hoje: desligar nosso microfone). */
  oncommand: (cmd: 'mute') => void = () => {};
  /** Alguém quer assistir à nossa transmissão. */
  onwatch: (conn: DataConnection) => void = (c) => c.close();
  /** Alguém foi direcionado a nós para receber, por relay, a transmissão de `pub`. */
  onrelay: (conn: DataConnection, pub: string) => void = (c) => c.close();

  constructor(
    private settings: Settings,
    private version: string,
    private password = '',
  ) {
    this.self = { id: '', name: settings.name.slice(0, 24) || 'Convidado', cam: false, screen: false, title: '' };
  }

  get selfId(): string {
    return this.peer?.id ?? '';
  }

  get hostId(): string {
    return this.roster[0]?.id ?? '';
  }

  /** Só aceitamos conexões de voz/vídeo de quem está na lista da sala. */
  isMember(id: string): boolean {
    return this.roster.some((p) => p.id === id);
  }

  nameOf(id: string): string {
    return this.roster.find((p) => p.id === id)?.name ?? 'Participante';
  }

  // ---------- identidade ----------
  private openIdentity(): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = makePeer(this.settings);
      let opened = false;
      const timeout = window.setTimeout(() => {
        if (opened) return;
        peer.destroy();
        reject(new Error('Não foi possível falar com o servidor de sinalização.'));
      }, 15000);
      peer.on('open', () => {
        opened = true;
        clearTimeout(timeout);
        this.peer = peer;
        this.self.id = peer.id;
        this.timer = window.setInterval(() => this.reap(), 1000);
        peer.on('disconnected', () => !this.closed && peer.reconnect());
        peer.on('connection', (conn) => {
          const meta = (conn.metadata ?? {}) as { role?: string; pub?: string };
          if (!this.isMember(conn.peer)) return conn.close();
          if (meta.role === 'watch') this.onwatch(conn);
          else if (meta.role === 'relay' && typeof meta.pub === 'string') this.onrelay(conn, meta.pub);
          else conn.close();
        });
        resolve();
      });
      peer.on('error', (err: any) => {
        if (opened) return; // erros de chamadas individuais são tratados por quem as fez
        clearTimeout(timeout);
        peer.destroy();
        reject(new Error('Não foi possível falar com o servidor de sinalização.'));
      });
    });
  }

  // ---------- hospedar ----------
  async create(forcedCode?: string): Promise<string> {
    await this.openIdentity();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = forcedCode ?? newRoomCode();
      const result = await this.claim(code);
      if (result === 'ok') return code;
      if (result === 'error' || forcedCode) break;
    }
    this.peer.destroy();
    throw new Error('Não foi possível criar a sala.');
  }

  /** Registra o código no servidor de sinalização e passa a hospedar a sala. */
  private claim(code: string): Promise<'ok' | 'taken' | 'error'> {
    return new Promise((resolve) => {
      const roomPeer = makePeer(this.settings, ID_PREFIX + code);
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        roomPeer.destroy();
        resolve('error');
      }, 8000);
      roomPeer.on('open', () => {
        if (settled || this.closed) return roomPeer.destroy();
        settled = true;
        clearTimeout(timeout);
        this.roomPeer = roomPeer;
        this.code = code;
        this.isHost = true;
        this.control = undefined;
        this.members.clear();
        // Assumindo uma sala que já existia: mantém os demais na lista por alguns segundos,
        // enquanto se reapresentam, para que voz e vídeo entre todos não sejam derrubados.
        this.pending.clear();
        for (const p of this.roster.slice(1)) {
          if (p.id !== this.selfId) this.pending.set(p.id, { entry: p, until: Date.now() + 25_000 });
        }
        roomPeer.on('connection', (conn) => {
          if ((conn.metadata as { role?: string } | undefined)?.role === 'control') this.admit(conn);
          else conn.close();
        });
        roomPeer.on('disconnected', () => !this.closed && this.roomPeer === roomPeer && roomPeer.reconnect());
        this.publish();
        resolve('ok');
      });
      roomPeer.on('error', (err: any) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          roomPeer.destroy();
          return resolve(err.type === 'unavailable-id' ? 'taken' : 'error');
        }
        // Já hospedávamos, caímos do servidor e outro participante assumiu o código.
        if (err.type === 'unavailable-id' && this.roomPeer === roomPeer) this.demote();
      });
    });
  }

  private admit(conn: DataConnection): void {
    let member: Member | null = null;
    const nonce = randomHex(16);
    let burst = 0; // mensagens no segundo atual (anti-inundação)
    let burstAt = 0;
    const send = (msg: Msg) => conn.open && conn.send(msg);
    const helloTimer = window.setTimeout(() => !member && conn.close(), HELLO_TIMEOUT_MS);

    conn.on('open', () => {
      send({ t: 'challenge', nonce, proto: PROTO, version: this.version, password: !!this.password });
    });
    conn.on('data', async (d) => {
      const msg = d as Msg;
      if (!msg || typeof msg !== 'object') return;
      const now = Date.now();
      if (now - burstAt > 1000) {
        burstAt = now;
        burst = 0;
      }
      if (++burst > 30) return conn.close(); // nenhum uso legítimo manda tanto
      if (!member) {
        if (msg.t !== 'hello') return;
        clearTimeout(helloTimer);
        const refuse = (reason: 'version' | 'password' | 'full') => {
          send({ t: 'reject', reason, version: this.version });
          setTimeout(() => conn.close(), 300);
        };
        if (msg.proto !== PROTO) return refuse('version');
        if (this.password && !sameText(str(msg.auth, 128), await proof(this.password, nonce, this.code))) return refuse('password');
        if (this.members.size >= MAX_MEMBERS - 1 && !this.members.has(conn.peer)) return refuse('full');
        this.members.get(conn.peer)?.conn.close(); // reconexão do mesmo participante
        member = {
          conn,
          entry: { id: conn.peer, name: str(msg.name, 24) || 'Convidado', cam: false, screen: false, title: '' },
        };
        this.members.set(conn.peer, member);
        this.pending.delete(conn.peer);
        // Quem hospeda também prova que conhece a senha: assim ninguém se passa pela sala.
        send({ t: 'welcome', auth: this.password ? await proof(this.password, str(msg.cnonce, 64), `${this.code}:host`) : '' });
        // Antes da lista: as conexões que o novo participante abrir já usam o mesmo TURN.
        const servers = shareableIce();
        if (servers.length) send({ t: 'ice-config', servers });
        this.publish();
      } else if (msg.t === 'state') {
        member.entry.cam = msg.cam === true;
        member.entry.screen = msg.screen === true;
        member.entry.title = str(msg.title, 80);
        this.publish();
      }
    });
    const gone = () => {
      clearTimeout(helloTimer);
      if (!member || this.members.get(conn.peer) !== member) return;
      this.members.delete(conn.peer);
      this.publish();
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  /** Participante que caiu sem se despedir: o canal de controle perde conectividade. */
  private controlDeadSince = 0;

  private reap(): void {
    // Participante: quem hospeda caiu sem se despedir (travou, perdeu a rede). O canal não
    // avisa sozinho por dezenas de segundos, então vigiamos a conectividade dele.
    if (!this.isHost) {
      const state = this.control?.peerConnection?.connectionState;
      if (this.control && (state === 'disconnected' || state === 'failed' || state === 'closed')) {
        this.controlDeadSince ||= Date.now();
        if (Date.now() - this.controlDeadSince > DEAD_AFTER_MS) {
          this.controlDeadSince = 0;
          this.control.close(); // dispara a recuperação
        }
      } else {
        this.controlDeadSince = 0;
      }
      return;
    }
    for (const [id, p] of [...this.pending]) {
      if (Date.now() > p.until) {
        this.pending.delete(id);
        this.publish();
      }
    }
    for (const [id, m] of [...this.members]) {
      const state = m.conn.peerConnection?.connectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        m.deadSince ??= Date.now();
        if (Date.now() - m.deadSince > DEAD_AFTER_MS) {
          this.members.delete(id);
          m.conn.close();
          this.publish();
        }
      } else {
        m.deadSince = undefined;
      }
    }
  }

  private publish(): void {
    // Ao sair, as conexões fecham uma a uma; sem esta guarda, cada fechamento mandaria aos
    // demais uma lista encolhida e eles derrubariam a voz entre si.
    if (!this.isHost || this.closed) return;
    this.roster = [
      { ...this.self },
      ...[...this.members.values()].map((m) => ({ ...m.entry })),
      ...[...this.pending.values()].map((p) => ({ ...p.entry })),
    ];
    const msg: Msg = { t: 'room', peers: this.roster };
    for (const m of this.members.values()) if (m.conn.open) m.conn.send(msg);
    this.onroster(this.roster);
  }

  // ---------- controles de quem hospeda ----------
  muteMember(id: string): void {
    const m = this.members.get(id);
    if (this.isHost && m?.conn.open) m.conn.send({ t: 'cmd', cmd: 'mute' } satisfies Msg);
  }

  kick(id: string): void {
    const m = this.members.get(id);
    if (!this.isHost || !m) return;
    if (m.conn.open) m.conn.send({ t: 'kick' } satisfies Msg);
    this.members.delete(id);
    setTimeout(() => m.conn.close(), 300);
    this.publish();
  }

  // ---------- participar ----------
  async join(code: string): Promise<void> {
    await this.openIdentity();
    this.code = code;
    const result = await this.connectControl();
    if (!result.ok) {
      this.closed = true;
      this.peer.destroy();
      throw new Error(result.reason);
    }
  }

  /** Abre o canal de controle com quem hospeda e faz a apresentação (versão e senha). */
  private connectControl(timeoutMs = 15000): Promise<JoinResult> {
    return new Promise((resolve) => {
      const hostId = ID_PREFIX + this.code;
      const conn = this.peer.connect(hostId, { reliable: true, metadata: { role: 'control' } });
      let settled = false;
      let opened = false;
      let missing = false;
      const cnonce = randomHex(16);
      const finish = (r: JoinResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.peer.off('error', onPeerError);
        if (!r.ok) conn.close();
        resolve(r);
      };
      const onPeerError = (err: any) => {
        if (err.type === 'peer-unavailable' && String(err.message ?? '').includes(hostId)) {
          missing = true;
          finish({ ok: false, reason: 'Sala não encontrada. Confira o código.', fatal: false });
        }
      };
      this.peer.on('error', onPeerError);
      const timeout = window.setTimeout(() => {
        finish({
          ok: false,
          fatal: false,
          reason: opened
            ? 'A sala não respondeu.'
            : missing
              ? 'Sala não encontrada. Confira o código.'
              : 'A sala existe, mas a conexão direta com quem a hospeda não fechou (rede restrita ou CGNAT). Quem hospeda precisa configurar um servidor TURN em Configurações.',
        });
      }, timeoutMs);

      conn.on('open', () => (opened = true));
      conn.on('data', async (d) => {
        const msg = d as Msg;
        if (!msg || typeof msg !== 'object') return;
        if (!settled) {
          if (msg.t === 'challenge') {
            const auth = this.password && typeof msg.nonce === 'string' ? await proof(this.password, msg.nonce.slice(0, 64), this.code) : '';
            conn.send({ t: 'hello', name: this.self.name, proto: PROTO, version: this.version, auth, cnonce } satisfies Msg);
          } else if (msg.t === 'reject') {
            const theirs = str(msg.version, 16);
            const reason =
              msg.reason === 'version'
                ? `A sala usa outra versão do AriranhaCast (${theirs || '?'}; a sua é ${this.version}). Todos precisam da mesma versão.`
                : msg.reason === 'password'
                  ? this.password
                    ? 'Senha da sala incorreta.'
                    : 'Esta sala exige senha.'
                  : 'A sala está cheia.';
            finish({ ok: false, reason, fatal: true });
          } else if (msg.t === 'welcome') {
            if (this.password && !sameText(str(msg.auth, 128), await proof(this.password, cnonce, `${this.code}:host`))) {
              return finish({ ok: false, fatal: true, reason: 'Quem respondeu por esta sala não conhece a senha. Confira o código com seus amigos.' });
            }
            this.control = conn;
            this.isHost = false;
            finish({ ok: true });
            this.sendState();
          }
          return;
        }
        if (this.control !== conn) return;
        if (msg.t === 'ice-config') {
          setRoomIce(msg.servers);
          const config = (this.peer as any).options?.config;
          if (config) config.iceServers = iceServers();
        } else if (msg.t === 'room') {
          const list = cleanRoster(msg.peers);
          if (!list.some((p) => p.id === this.selfId)) return;
          this.roster = list;
          this.onroster(this.roster);
        } else if (msg.t === 'cmd' && msg.cmd === 'mute') {
          this.oncommand('mute');
        } else if (msg.t === 'kick') {
          this.end('Você foi removido da sala por quem a hospeda.');
        }
      });
      const lost = () => {
        if (!settled) return finish({ ok: false, reason: 'A conexão com a sala caiu.', fatal: false });
        if (this.control === conn) void this.recover();
      };
      conn.on('close', lost);
      conn.on('error', lost);
    });
  }

  /**
   * O canal com quem hospeda caiu: ou ele saiu, ou a nossa rede piscou. Tentamos
   * reentrar na sala e, se ninguém a estiver hospedando, o participante mais antigo
   * assume o código (os seguintes na fila tentam depois, se ele também tiver sumido).
   */
  private async recover(): Promise<void> {
    if (this.closed || this.recovering) return;
    this.recovering = true;
    this.control = undefined;
    this.onstatus('Reconectando à sala…');
    const rank = Math.max(0, this.roster.findIndex((p) => p.id === this.selfId) - 1);
    const claimAfter = 3000 + rank * 8000;
    const started = Date.now();
    while (!this.closed && Date.now() - started < RECOVER_FOR_MS) {
      if (this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect();
      if (!this.peer.disconnected) {
        const r = await this.connectControl(8000);
        if (this.closed) return;
        if (r.ok) break;
        if (r.fatal) {
          this.recovering = false;
          return this.end(r.reason);
        }
        if (Date.now() - started >= claimAfter && (await this.claim(this.code)) === 'ok') break;
      }
      await sleep(2000);
    }
    this.recovering = false;
    if (this.closed) return;
    if (!this.isHost && !this.control) return this.end('Não foi possível reconectar à sala.');
    this.onstatus('');
  }

  /** Deixamos de hospedar (outro participante assumiu enquanto estávamos fora do ar). */
  private demote(): void {
    const old = this.roomPeer;
    this.roomPeer = undefined;
    old?.destroy();
    this.isHost = false;
    this.members.clear();
    this.pending.clear();
    void this.recover();
  }

  /** Avisa a sala do que estamos publicando (webcam, transmissão). */
  setState(patch: Partial<Pick<RosterEntry, 'cam' | 'screen' | 'title'>>): void {
    Object.assign(this.self, patch);
    if (this.isHost) this.publish();
    else this.sendState();
  }

  private sendState(): void {
    if (this.control?.open) {
      this.control.send({ t: 'state', cam: this.self.cam, screen: this.self.screen, title: this.self.title } satisfies Msg);
    }
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.leave();
    this.onend(reason);
  }

  leave(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    // Libera o código na hora, para o próximo participante assumir a sala sem esperar.
    this.roomPeer?.destroy();
    this.control?.close();
    const peer = this.peer;
    setTimeout(() => peer?.destroy(), 300);
  }
}
