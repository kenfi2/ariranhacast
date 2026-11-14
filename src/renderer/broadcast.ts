import type { DataConnection } from 'peerjs';
import { pickCodec } from './codecs';
import { Outgoing, type OutStats } from './link';
import { iceServers } from './signaling';
import type { EncodeOpts, Msg, Quality, Settings } from './types';

const HOST = 'host';
const DEAD_AFTER_MS = 5000;

interface Viewer {
  id: string;
  name: string;
  conn: DataConnection;
  parent: string | null; // 'host', id de um relay, ou null enquanto não atribuído
  out?: Outgoing;
  receiving: boolean;
  bad: Set<string>; // relays que não conseguiram conexão com este espectador
  stats?: OutStats | null;
  deadSince?: number;
  quality: Quality;
}

export interface ViewerRow {
  id: string;
  name: string;
  via: string; // 'direto' ou nome do relay
  receiving: boolean;
  quality: Quality;
  stats?: OutStats | null;
}

/** Lado de quem transmite a tela: atende quem pede para assistir e monta a árvore de relay. */
export class Broadcast {
  private viewers = new Map<string, Viewer>();
  private codecMime = 'video/H264';
  private timer = 0;
  onchange: () => void = () => {};
  onerror: (message: string) => void = () => {};

  constructor(
    private settings: Settings,
    public stream: MediaStream,
    public opts: EncodeOpts,
    public title: string,
    private maxDirect: number,
    private maxPerRelay = 2,
  ) {}

  async start(): Promise<void> {
    const vs = this.stream.getVideoTracks()[0]?.getSettings() ?? {};
    this.codecMime = await pickCodec(this.opts, vs.width ?? 1920, vs.height ?? 1080);
    this.timer = window.setInterval(() => void this.poll(), 1000);
  }

  /** Um participante pediu para assistir (canal de dados com role "watch"). */
  accept(conn: DataConnection, name: string): void {
    const v: Viewer = {
      id: conn.peer,
      name: name.slice(0, 24),
      conn,
      parent: null,
      receiving: false,
      bad: new Set(),
      quality: 'high',
    };
    const begin = () => {
      this.viewers.get(v.id)?.conn.close();
      this.viewers.set(v.id, v);
      this.assign(v);
      this.onchange();
    };
    if (conn.open) begin();
    else conn.on('open', begin);
    conn.on('data', (data) => this.onMessage(v, data as Msg));
    conn.on('close', () => this.remove(v));
    conn.on('error', () => this.remove(v));
  }

  private onMessage(v: Viewer, msg: Msg): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'sdp' || msg.t === 'ice') {
      void v.out?.handle(msg);
    } else if (msg.t === 'status') {
      v.receiving = msg.receiving === true;
      this.onchange();
    } else if (msg.t === 'quality') {
      if (msg.q === 'high' || msg.q === 'med' || msg.q === 'low') {
        v.quality = msg.q;
        void v.out?.setQuality(msg.q);
        this.onchange();
      }
    } else if (msg.t === 'need-parent') {
      if (typeof msg.failed === 'string') v.bad.add(msg.failed.slice(0, 64));
      this.assign(v);
      this.onchange();
    }
  }

  private childrenOf(id: string): Viewer[] {
    return [...this.viewers.values()].filter((x) => x.parent === id);
  }

  /**
   * Topologia: até `maxDirect` espectadores recebem direto do host (um encode cada).
   * Os demais recebem de um espectador direto, que repassa o que está assistindo.
   * Isso limita o custo de GPU e de upload do host com 5–10 pessoas na sala.
   */
  private assign(v: Viewer): void {
    v.out?.close();
    v.out = undefined;
    v.receiving = false;

    let parent = HOST;
    if (this.childrenOf(HOST).filter((x) => x !== v).length >= this.maxDirect) {
      const relays = this.childrenOf(HOST)
        .filter((r) => r !== v && r.receiving && !v.bad.has(r.id))
        .map((r) => ({ r, load: this.childrenOf(r.id).filter((x) => x !== v).length }))
        .filter((x) => x.load < this.maxPerRelay)
        .sort((a, b) => a.load - b.load);
      if (relays.length) parent = relays[0].r.id;
      // sem relay disponível: atende direto mesmo acima do limite, para ninguém ficar sem imagem
    }
    // Quem vira filho de relay não pode ter filhos próprios (árvore de 2 níveis).
    if (parent !== HOST) for (const child of this.childrenOf(v.id)) this.assign(child);

    v.parent = parent;
    this.sendTo(v, { t: 'assign', parent, opts: this.opts, title: this.title });
    if (parent === HOST) {
      v.out = new Outgoing(this.stream, (m) => this.sendTo(v, m), this.opts, iceServers(this.settings), this.codecMime);
      void v.out.setQuality(v.quality);
      v.out.onstate = (state) => {
        if (state === 'failed') this.onerror(`Sem rota de rede até ${v.name} (NAT restrito). Um servidor TURN resolve.`);
      };
    }
  }

  paused = false;

  /** Pausa a imagem (os espectadores veem um aviso) sem encerrar a transmissão nem renegociar. */
  setPaused(on: boolean): void {
    this.paused = on;
    for (const t of this.stream.getVideoTracks()) t.enabled = !on;
    for (const v of this.viewers.values()) this.sendTo(v, { t: 'paused', on });
  }

  private remove(v: Viewer): void {
    if (this.viewers.get(v.id) !== v) return;
    this.viewers.delete(v.id);
    v.out?.close();
    for (const orphan of this.childrenOf(v.id)) this.assign(orphan);
    // Vagou um slot direto: promove alguém que estava via relay.
    if (v.parent === HOST) {
      const relayed = [...this.viewers.values()].find((x) => x.parent && x.parent !== HOST);
      if (relayed && this.childrenOf(HOST).length < this.maxDirect) this.assign(relayed);
    }
    this.onchange();
  }

  private sendTo(v: Viewer, msg: Msg): void {
    if (v.conn.open) v.conn.send(msg);
  }

  private lastRebalance = 0;

  /**
   * Quando vários espectadores chegam juntos, ainda não há quem possa repassar e todos
   * são atendidos direto. Assim que houver um relay pronto, move os excedentes (um por
   * vez) para trás dele, voltando ao limite de conexões diretas.
   */
  private rebalance(): void {
    const direct = this.childrenOf(HOST);
    if (direct.length <= this.maxDirect || Date.now() - this.lastRebalance < 5000) return;
    const excess = [...direct].reverse().find((v) => v.receiving && this.childrenOf(v.id).length === 0);
    if (!excess) return;
    const relayReady = direct.some(
      (r) => r !== excess && r.receiving && !excess.bad.has(r.id) && this.childrenOf(r.id).length < this.maxPerRelay,
    );
    if (!relayReady) return;
    this.lastRebalance = Date.now();
    this.assign(excess);
  }

  private async poll(): Promise<void> {
    this.rebalance();
    for (const v of [...this.viewers.values()]) {
      // Espectador que caiu sem se despedir: o canal de controle perde conectividade.
      const state = v.conn.peerConnection?.connectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        v.deadSince ??= Date.now();
        if (Date.now() - v.deadSince > DEAD_AFTER_MS) {
          this.remove(v);
          v.conn.close();
          continue;
        }
      } else {
        v.deadSince = undefined;
      }
      v.stats = v.out ? await v.out.stats() : null;
    }
    this.onchange();
  }

  /** Troca a fonte capturada sem derrubar ninguém. */
  async replaceStream(stream: MediaStream, title: string): Promise<void> {
    this.stream = stream;
    this.title = title;
    for (const v of this.viewers.values()) await v.out?.replaceStream(stream);
  }

  /** Conexões de envio diretas (para medir rota e consumo do TURN). */
  pcs(): RTCPeerConnection[] {
    return [...this.viewers.values()].flatMap((v) => (v.out ? [v.out.pc] : []));
  }

  get count(): number {
    return this.viewers.size;
  }

  rows(): ViewerRow[] {
    return [...this.viewers.values()].map((v) => ({
      id: v.id,
      name: v.name,
      via: v.parent === HOST || !v.parent ? 'direto' : `via ${this.viewers.get(v.parent)?.name ?? 'relay'}`,
      receiving: v.receiving,
      quality: v.quality,
      stats: v.stats,
    }));
  }

  stop(): void {
    clearInterval(this.timer);
    for (const v of this.viewers.values()) {
      this.sendTo(v, { t: 'end' });
      v.out?.close();
    }
    this.viewers.clear();
  }
}
