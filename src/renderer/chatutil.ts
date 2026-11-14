import type { ChatImage, ChatMessage, Emote } from './types';

/** Tudo o que chega da rede (texto, imagens, emotes) é validado aqui antes de ser guardado ou exibido. */
export const MAX_TEXT = 2000;
export const MAX_IMAGE = 4 * 1024 * 1024; // GIFs animados passam como estão
export const MAX_EMOTE = 128 * 1024;
export const MAX_EMOTES = 50;
export const MAX_LOG = 200;
const LOG_IMAGE_BYTES = 12 * 1024 * 1024; // memória máxima com imagens no histórico
const HISTORY_IMAGE_BYTES = 4 * 1024 * 1024; // imagens reenviadas a quem entra

const EMOTE_NAME = /^[a-z0-9_]{2,24}$/;

/** Texto do chat: mantém quebras de linha, remove controles e caracteres que invertem a direção do texto. */
export function cleanChatText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' ? c : c === '‍' || c === '️' ? c : ''))
    .slice(0, MAX_TEXT);
}

export function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

/** Identifica a imagem pelos primeiros bytes (o "tipo" declarado por quem envia não vale). */
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number) => b[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return 'image/gif';
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp';
  return null;
}

export function cleanImage(raw: unknown, maxBytes = MAX_IMAGE): ChatImage | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = toBytes((raw as { data?: unknown }).data);
  if (!data || data.byteLength < 16 || data.byteLength > maxBytes) return null;
  const mime = sniffImage(data);
  return mime ? { mime, data } : null;
}

export function cleanEmote(raw: unknown, by: string): Emote | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name.toLowerCase() : '';
  if (!EMOTE_NAME.test(name)) return null;
  const img = cleanImage(raw, MAX_EMOTE);
  return img ? { name, mime: img.mime, data: img.data, by } : null;
}

/** Mensagem recebida do anfitrião. */
export function cleanMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id.replace(/[^\w-]/g, '').slice(0, 40) : '';
  if (!id) return null;
  const text = cleanChatText(m.text);
  const img = m.img ? cleanImage(m.img) : null;
  if (!text && !img && !m.expired) return null;
  return {
    id,
    from: typeof m.from === 'string' ? m.from.slice(0, 64) : '',
    name: (typeof m.name === 'string' ? m.name.replace(/[\p{Cc}\p{Cf}]/gu, '') : '').slice(0, 24) || 'Convidado',
    ts: typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : Date.now(),
    text,
    img: img ?? undefined,
    expired: m.expired === true && !img ? true : undefined,
  };
}

/** Mantém o histórico dentro de limites: poucas mensagens e pouca memória com imagens. */
export function trimLog(log: ChatMessage[]): void {
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  let total = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const img = log[i].img;
    if (!img) continue;
    total += img.data.byteLength;
    if (total > LOG_IMAGE_BYTES) {
      log[i] = { ...log[i], img: undefined, expired: true };
    }
  }
}

/** Histórico para quem acabou de entrar: texto completo e imagens só das mensagens mais recentes. */
export function historyFor(log: ChatMessage[]): ChatMessage[] {
  let total = 0;
  const out: ChatMessage[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i];
    if (m.img && total + m.img.data.byteLength <= HISTORY_IMAGE_BYTES) {
      total += m.img.data.byteLength;
      out.push(m);
    } else if (m.img) {
      out.push({ ...m, img: undefined, expired: true });
    } else {
      out.push(m);
    }
  }
  return out.reverse();
}
