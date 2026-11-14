import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { pickCodec } from './codecs';
import { Incoming, Outgoing, type InStats } from './link';
import { iceServers } from './signaling';
import type { EncodeOpts, Msg, Settings } from './types';

const HOST = 'host';
const LINK_TIMEOUT_MS = 12000;
const DEAD_AFTER_MS = 4000;

/** Lado de quem assiste a uma transmissão (e, se pedido, a repassa a outros). */
export class Watch {
  private control!: DataConnection;
  private parentConn?: DataConnection; // canal de sinalização com o relay, se houver
  private incoming?: Incoming;
  private parent = '';
  private opts?: EncodeOpts;
  private children = new Map<string, { conn: DataConnection; out: Outgoing }>();
  private watchdog = 0;
  private closed = false;
  stream?: MediaStream;
  title = '';

  onstream: (stream: MediaStream) => void = () => {};
  onstatus: (text: string) => void = () => {};
  onend: (reason: string) => void = () => {};

  constructor(
    private peer: Peer,
    private settings: Settings,
    readonly pub: string, // id de quem transmite
    private allow: (id: string) => boolean, // o id pertence a alguém da sala?
  ) {}

  start(): void {
    this.onstatus('Conectando à transmissão…');
    this.control = this.peer.connect(this.pub, {
      reliable: true,
      metadata: { role: 'watch' },
    });
    const opened = window.setTimeout(() => {
      if (!this.control.open) this.finish('Não foi possível conectar à transmissão.');
    }, 12000);
    this.control.on('open', () => {
      clearTimeout(opened);
      this.onstatus('Aguardando vídeo…');
    });
    this.control.on('data', (d) => this.onControl(d as Msg));
    this.control.on('close', () => this.finish('A transmissão foi encerrada.'));
    this.control.on('error', () => this.finish('A transmissão foi encerrada.'));
  }

  private onControl(msg: Msg): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'assign') {
      if (typeof msg.parent !== 'string' || !msg.opts || typeof msg.opts !== 'object') return;
      // Parâmetros vindos da rede: limitados a faixas razoáveis antes de usar.
      this.opts = {
        maxBitrate: Math.min(50_000_000, Math.max(200_000, Number(msg.opts.maxBitrate) || 4_000_000)),
        maxFps: Math.min(120, Math.max(5, Number(msg.opts.maxFps) || 30)),
        mode: msg.opts.mode === 'detail' ? 'detail' : 'motion',
        codec: 'auto',
      };
      this.title = typeof msg.title === 'string' ? msg.title.slice(0, 80) : '';
      this.connectTo(msg.parent.slice(0, 64));
    } else if (msg.t === 'sdp' || msg.t === 'ice') {
      if (this.parent === HOST) void this.incoming?.handle(msg);
    } else if (msg.t === 'end') {
      this.finish('A transmissão foi encerrada.');
    }
  }

  private connectTo(parent: string): void {
    this.dropIncoming();
    this.parent = parent;
    let send: (m: Msg) => void;
    if (parent === HOST) {
      send = (m) => this.control.open && this.control.send(m);
    } else if (!this.allow(parent)) {
      // Só aceitamos ser redirecionados para outro participante da sala.
      this.parent = '';
      return this.reportBadParent(parent);
    } else {
      const conn = this.peer.connect(parent, { reliable: true, metadata: { role: 'relay', pub: this.pub } });
      this.parentConn = conn;
      conn.on('data', (d) => void this.incoming?.handle(d as Msg));
      conn.on('close', () => this.parentConn === conn && this.reportBadParent());
      send = (m) => conn.open && conn.send(m);
    }

    const incoming = new Incoming(send, iceServers(this.settings));
    this.incoming = incoming;
    incoming.onstream = (stream) => {
      this.stream = stream;
      this.onstream(stream);
      for (const child of this.children.values()) void child.out.replaceStream(stream);
    };
    incoming.onstate = (state) => {
      if (this.incoming !== incoming) return;
      if (state === 'connected') {
        clearTimeout(this.watchdog);
        this.sendStatus(true);
        this.onstatus('');
      } else if (state === 'failed') {
        this.reportBadParent();
      } else if (state === 'disconnected') {
        // Quem nos enviava sumiu (fechou o app, caiu a rede): não espera o timeout longo do ICE.
        window.setTimeout(() => {
          if (this.incoming === incoming && incoming.pc.connectionState !== 'connected') this.reportBadParent();
        }, DEAD_AFTER_MS);
      }
    };
    clearTimeout(this.watchdog);
    this.watchdog = window.setTimeout(() => {
      if (this.incoming === incoming && incoming.pc.connectionState !== 'connected') this.reportBadParent();
    }, LINK_TIMEOUT_MS);
  }

  /** O caminho atual não fechou: pede outro ao host. */
  private reportBadParent(forced?: string): void {
    const failed = forced ?? this.parent;
    if (this.closed || !failed) return;
    this.dropIncoming();
    if (failed === HOST) {
      this.onstatus('Sem rota de rede direta até quem transmite (NAT restrito). Tentando novamente…');
      window.setTimeout(() => !this.closed && this.control.open && this.control.send({ t: 'need-parent', failed }), 3000);
    } else {
      this.onstatus('Reconectando…');
      if (this.control.open) this.control.send({ t: 'need-parent', failed });
    }
  }

  private dropIncoming(): void {
    clearTimeout(this.watchdog);
    this.incoming?.close();
    this.incoming = undefined;
    const conn = this.parentConn;
    this.parentConn = undefined;
    conn?.close();
    this.parent = '';
  }

  private sendStatus(receiving: boolean): void {
    if (this.control?.open) this.control.send({ t: 'status', receiving });
  }

  // ---- relay: repassa o que estamos recebendo para outro espectador ----
  async serveChild(conn: DataConnection): Promise<void> {
    if (this.closed || !this.stream || !this.opts) return conn.close();
    const stream = this.stream;
    const opts: EncodeOpts = { ...this.opts, codec: 'auto' };
    const vs = stream.getVideoTracks()[0]?.getSettings() ?? {};
    const mime = await pickCodec(opts, vs.width ?? 1920, vs.height ?? 1080);
    const begin = () => {
      const out = new Outgoing(stream, (m) => conn.open && conn.send(m), opts, iceServers(this.settings), mime);
      this.children.set(conn.peer, { conn, out });
      conn.on('data', (d) => void out.handle(d as Msg));
      conn.on('close', () => {
        out.close();
        if (this.children.get(conn.peer)?.out === out) this.children.delete(conn.peer);
      });
    };
    if (conn.open) begin();
    else conn.on('open', begin);
  }

  /** Conexões deste espectador: a que recebe e as que repassam (rota e consumo do TURN). */
  pcs(): RTCPeerConnection[] {
    return [...(this.incoming ? [this.incoming.pc] : []), ...[...this.children.values()].map((c) => c.out.pc)];
  }

  stats(): Promise<InStats | null> {
    return this.incoming ? this.incoming.stats() : Promise.resolve(null);
  }

  get via(): string {
    return this.parent === HOST ? 'direto' : this.parent ? 'via relay' : '';
  }

  get relaying(): number {
    return this.children.size;
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.close();
    this.onend(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.watchdog);
    for (const c of this.children.values()) c.out.close();
    this.children.clear();
    this.incoming?.close();
    this.parentConn?.close();
    if (this.control?.open) this.control.close();
  }
}
