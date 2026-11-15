import { MAX_EMOTE, MAX_STICKER, sniffImage, STICKER_SIDE } from './chatutil';

/**
 * Biblioteca pessoal de figurinhas e emotes. Fica só neste PC (IndexedDB do app) e continua
 * existindo entre uma sala e outra; nada é enviado a ninguém até você usar no chat.
 */
export interface Sticker {
  id: string; // hash do conteúdo (a mesma imagem não entra duas vezes)
  mime: string;
  data: Uint8Array;
  at: number;
}
export interface MyEmote {
  name: string;
  mime: string;
  data: Uint8Array;
  at: number;
}

export const MAX_STICKERS = 200;
export const MAX_MY_EMOTES = 50;

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('ariranhacast', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('stickers', { keyPath: 'id' });
      req.result.createObjectStore('emotes', { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run<T>(store: 'stickers' | 'emotes', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function hashOf(data: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reduz uma imagem para caber como figurinha/emote. GIFs e WebPs animados passam como estão se couberem. */
async function fit(raw: Uint8Array, side: number, maxBytes: number): Promise<{ mime: string; data: Uint8Array } | null> {
  const mime = sniffImage(raw);
  if (!mime) return null;
  const animated = mime === 'image/gif' || (mime === 'image/webp' && raw.byteLength <= maxBytes);
  if (animated) return raw.byteLength <= maxBytes ? { mime, data: raw } : null;
  try {
    const bmp = await createImageBitmap(new Blob([raw as BlobPart], { type: mime }));
    if (raw.byteLength <= maxBytes && Math.max(bmp.width, bmp.height) <= side) return { mime, data: raw };
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const type of ['image/webp', 'image/png']) {
      const out = new Uint8Array(await (await canvas.convertToBlob({ type, quality: 0.9 })).arrayBuffer());
      const got = sniffImage(out);
      if (got && out.byteLength <= maxBytes) return { mime: got, data: out };
    }
  } catch {
    /* imagem corrompida */
  }
  return null;
}

export const listStickers = async (): Promise<Sticker[]> => (await run<Sticker[]>('stickers', 'readonly', (s) => s.getAll())).sort((a, b) => b.at - a.at);

/** Guarda uma imagem como figurinha. Devolve 'full' se a biblioteca está cheia e null se a imagem não serve. */
export async function addSticker(raw: Uint8Array): Promise<Sticker | 'full' | null> {
  const img = await fit(raw, STICKER_SIDE, MAX_STICKER);
  if (!img) return null;
  const id = await hashOf(img.data);
  const all = await listStickers();
  const old = all.find((s) => s.id === id);
  if (!old && all.length >= MAX_STICKERS) return 'full';
  const st: Sticker = { id, mime: img.mime, data: img.data, at: Date.now() };
  await run('stickers', 'readwrite', (s) => s.put(st));
  return st;
}

export const removeSticker = (id: string): Promise<undefined> => run('stickers', 'readwrite', (s) => s.delete(id));

export const listMyEmotes = async (): Promise<MyEmote[]> => (await run<MyEmote[]>('emotes', 'readonly', (s) => s.getAll())).sort((a, b) => a.name.localeCompare(b.name));

export async function saveMyEmote(name: string, raw: Uint8Array): Promise<MyEmote | 'full' | null> {
  if (!/^[a-z0-9_]{2,24}$/.test(name)) return null;
  const img = await fit(raw, 96, MAX_EMOTE);
  if (!img) return null;
  const all = await listMyEmotes();
  if (!all.some((e) => e.name === name) && all.length >= MAX_MY_EMOTES) return 'full';
  const e: MyEmote = { name, mime: img.mime, data: img.data, at: Date.now() };
  await run('emotes', 'readwrite', (s) => s.put(e));
  return e;
}

export const removeMyEmote = (name: string): Promise<undefined> => run('emotes', 'readwrite', (s) => s.delete(name));
