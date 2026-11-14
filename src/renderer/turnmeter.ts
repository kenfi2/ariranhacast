import { routeOf, type Route } from './link';

/**
 * Soma o tráfego deste PC que passou pelo servidor TURN. É uma estimativa do nosso
 * lado: o total da conta (incluindo o que outros participantes trafegam entre si)
 * só aparece no painel do serviço de TURN.
 */
export class TurnMeter {
  private last = new WeakMap<RTCPeerConnection, number>();
  private key = `ariranhacast.turn.${new Date().toISOString().slice(0, 7)}`;
  monthBytes = Number(localStorage.getItem(this.key)) || 0;
  sessionBytes = 0;
  private dirty = 0;

  /** Lê a rota da conexão e contabiliza o que trafegou por TURN desde a última leitura. */
  async sample(pc: RTCPeerConnection): Promise<Route | null> {
    if (pc.connectionState !== 'connected') return null;
    const report = await pc.getStats().catch(() => null);
    const route = report && routeOf(report);
    if (!route) return null;
    const before = this.last.get(pc) ?? route.bytes; // a 1ª leitura só marca o ponto de partida
    this.last.set(pc, route.bytes);
    if (route.relay && route.bytes > before) {
      const delta = route.bytes - before;
      this.monthBytes += delta;
      this.sessionBytes += delta;
      this.dirty += delta;
    }
    return route;
  }

  /** Grava o acumulado do mês (chamado de tempos em tempos, não a cada amostra). */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = 0;
    localStorage.setItem(this.key, String(Math.round(this.monthBytes)));
  }
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} kB`;
}
