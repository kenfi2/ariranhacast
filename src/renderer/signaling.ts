import Peer from 'peerjs';
import type { Settings } from './types';

export const ID_PREFIX = 'ariranhacast-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I/L

export function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

let ownIce: RTCIceServer[] = []; // TURN/STUN das nossas Configurações
let roomIce: RTCIceServer[] = []; // TURN repassado por quem criou a sala

/** Aceita só servidores STUN/TURN bem formados (o dado vem de um arquivo, de uma URL ou da sala). */
function cleanIce(raw: unknown): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  for (const x of (Array.isArray(raw) ? raw : [raw]).slice(0, 8)) {
    if (!x || typeof x !== 'object') continue;
    const urls = [(x as any).urls]
      .flat()
      .filter((u): u is string => typeof u === 'string' && u.length < 300 && /^(stun|stuns|turn|turns):[\w.\-\[\]:]+(\?transport=(udp|tcp))?$/i.test(u))
      .slice(0, 8);
    if (!urls.length) continue;
    const server: RTCIceServer = { urls };
    if (typeof (x as any).username === 'string') server.username = (x as any).username.slice(0, 500);
    if (typeof (x as any).credential === 'string') server.credential = (x as any).credential.slice(0, 500);
    out.push(server);
  }
  return out;
}

/**
 * Lê o campo de TURN das Configurações: um JSON de RTCIceServer[] ou uma URL que
 * devolve esse JSON (serviços de TURN entregam credenciais assim).
 */
export async function loadIce(settings: Settings): Promise<{ ok: boolean; error?: string }> {
  ownIce = [];
  roomIce = [];
  const text = settings.iceServers.trim();
  if (!text) return { ok: true };
  try {
    let parsed: unknown;
    if (/^https:\/\//i.test(text)) {
      // Só HTTPS: as credenciais do TURN não devem trafegar em claro.
      const res = await fetch(text, { signal: AbortSignal.timeout(8000), credentials: 'omit', redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      parsed = await res.json();
    } else {
      parsed = JSON.parse(text);
    }
    ownIce = cleanIce(parsed);
    return ownIce.length ? { ok: true } : { ok: false, error: 'nenhum servidor na resposta' };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** O que o criador da sala repassa aos participantes para todos usarem o mesmo TURN. */
export function shareableIce(): RTCIceServer[] {
  return ownIce;
}

export function setRoomIce(servers: RTCIceServer[]): void {
  roomIce = cleanIce(servers);
}

export function hasTurn(): boolean {
  return [...ownIce, ...roomIce].some((s) => [s.urls].flat().some((u) => /^turns?:/i.test(String(u))));
}

/** Preferências de rede ajustáveis em Configurações (lidas por quem envia vídeo). */
/**
 * relayEconomy: menos qualidade quando a conexão passa pelo TURN.
 * smoothMs: atraso de reprodução (buffer) do vídeo assistido. 0 = latência mínima (cada quadro é
 * exibido assim que chega, bom para jogos); um pouco de buffer deixa filmes mais fluidos em
 * redes instáveis (Wi-Fi, celular), sem engasgos nem "piscadas".
 */
export const net = { relayEconomy: true, smoothMs: 0 };

/** Só para testes: força todo o tráfego pelo TURN, simulando uma rede que não fecha conexão direta. */
export const relayOnly = new URLSearchParams(location.search).has('relayonly');
export const icePolicy: RTCIceTransportPolicy = relayOnly ? 'relay' : 'all';

export function iceServers(_settings?: Settings): RTCIceServer[] {
  return [...DEFAULT_ICE, ...ownIce, ...roomIce];
}

/** Cria o peer de sinalização. O vídeo nunca passa por esse servidor. */
export function makePeer(settings: Settings, id?: string): Peer {
  const options: Record<string, unknown> = { debug: 1, config: { iceServers: iceServers(settings), iceTransportPolicy: icePolicy } };
  const server = settings.server.trim();
  if (server) {
    const m = server.replace(/^\w+:\/\//, '').match(/^([^:/]+)(?::(\d+))?(\/.*)?$/);
    if (m) {
      const port = m[2] ? Number(m[2]) : 443;
      options.host = m[1];
      options.port = port;
      options.path = m[3] ?? '/';
      options.secure = port === 443;
    }
  }
  return id ? new Peer(id, options) : new Peer(options);
}
