import type Peer from 'peerjs';
import type { MediaConnection } from 'peerjs';
import type { RosterEntry } from './types';

const CAM_BITRATE = 700_000;

/**
 * Webcams em malha: quem liga a câmera envia o vídeo direto para cada participante
 * (360p, ~0,7 Mbps por pessoa). É separado da transmissão de tela e do áudio.
 */
export class Cams {
  local?: MediaStream;
  error = '';
  readonly remote = new Map<string, MediaStream>();
  private outgoing = new Map<string, MediaConnection>();
  private incoming = new Map<string, MediaConnection>();
  private roster: RosterEntry[] = [];
  private timer: number;
  onchange: () => void = () => {};

  constructor(
    private peer: Peer,
    private allow: (id: string) => boolean, // o id pertence a alguém da sala?
  ) {
    // Refaz chamadas que caíram (rede que piscou, participante que reentrou).
    this.timer = window.setInterval(() => this.dial(), 3000);
    peer.on('call', (call) => {
      if ((call.metadata as { role?: string } | undefined)?.role !== 'cam') return;
      if (!this.allow(call.peer)) return call.close();
      this.incoming.get(call.peer)?.close();
      this.incoming.set(call.peer, call);
      call.answer(); // só recebe
      call.on('stream', (stream) => {
        if (this.incoming.get(call.peer) !== call) return;
        this.remote.set(call.peer, stream);
        this.onchange();
      });
      const gone = () => {
        if (this.incoming.get(call.peer) !== call) return;
        this.incoming.delete(call.peer);
        this.remote.delete(call.peer);
        this.onchange();
      };
      call.on('close', gone);
      call.on('error', gone);
    });
  }

  async setCam(on: boolean): Promise<void> {
    this.error = '';
    if (!on) {
      for (const call of this.outgoing.values()) call.close();
      this.outgoing.clear();
      this.local?.getTracks().forEach((t) => t.stop());
      this.local = undefined;
      return this.onchange();
    }
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
      });
      this.local.getVideoTracks()[0].contentHint = 'motion';
      this.dial();
    } catch (e: any) {
      this.local = undefined;
      this.error = e?.name === 'NotFoundError' ? 'Nenhuma câmera encontrada.' : `Câmera indisponível (${e?.name ?? e}).`;
    }
    this.onchange();
  }

  setRoster(list: RosterEntry[]): void {
    this.roster = list;
    const ids = new Set(list.map((p) => p.id));
    for (const [id, call] of [...this.outgoing]) {
      if (!ids.has(id)) {
        call.close();
        this.outgoing.delete(id);
      }
    }
    // Quem desligou a câmera (ou saiu) deixa de ter vídeo, mesmo que a conexão demore a fechar.
    for (const id of [...this.remote.keys()]) {
      if (!list.find((p) => p.id === id)?.cam) {
        this.remote.delete(id);
        this.incoming.get(id)?.close();
        this.incoming.delete(id);
      }
    }
    this.dial();
    this.onchange();
  }

  private dial(): void {
    if (!this.local) return;
    for (const p of this.roster) {
      if (p.id === this.peer.id || this.outgoing.has(p.id)) continue;
      const call = this.peer.call(p.id, this.local, { metadata: { role: 'cam' } });
      if (!call) continue;
      this.outgoing.set(p.id, call);
      const gone = () => {
        if (this.outgoing.get(p.id) === call) this.outgoing.delete(p.id);
      };
      call.on('close', gone);
      call.on('error', gone);
      window.setTimeout(() => void this.limit(call), 1500);
    }
  }

  private async limit(call: MediaConnection): Promise<void> {
    for (const sender of call.peerConnection?.getSenders() ?? []) {
      if (sender.track?.kind !== 'video') continue;
      const p = sender.getParameters();
      if (!p.encodings?.length) continue;
      p.encodings[0].maxBitrate = CAM_BITRATE;
      await sender.setParameters(p).catch(() => {});
    }
  }

  /** Conexões de webcam (para medir rota e consumo do TURN). */
  pcs(): RTCPeerConnection[] {
    return [...this.outgoing.values(), ...this.incoming.values()].flatMap((c) => (c.peerConnection ? [c.peerConnection] : []));
  }

  close(): void {
    clearInterval(this.timer);
    for (const call of [...this.outgoing.values(), ...this.incoming.values()]) call.close();
    this.outgoing.clear();
    this.incoming.clear();
    this.remote.clear();
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = undefined;
  }
}
