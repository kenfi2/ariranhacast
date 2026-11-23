// Versão web com o visual do PC: a mesma página do app (src/renderer) rodando no navegador.
// No Electron, `window.ariranhacast` vem do preload e fala com o processo principal; aqui ele é
// implementado com o que o navegador oferece. O que só existe no app instalado (captura de jogo,
// áudio por aplicativo, atalhos globais, overlay, atualizador, firewall) responde "indisponível"
// e a interface esconde essas opções (classe is-web no <html>).
import { LobbyClient, type LobbyState, type PublishedRoom, type Session } from '../shared/lobby';
import type { AriranhaBridge, GifItem, SourceInfo } from '../renderer/types';

declare const __VERSION__: string;

const PENDING_KEY = 'ariranhacast.pending-login'; // o mesmo da versão web do Android (/web/m/)
const SESSION_KEY = 'ariranhacast.session';
const GIF_HOSTS = /^(?:media\d*|i)\.giphy\.com$/;
const CODE_RE = /^[A-Z0-9]{4,16}$/;

// Celular/tablet: a versão com a cara do app Android (coluna única, toque).
const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
if (touchOnly && !new URLSearchParams(location.search).has('pc')) {
  location.replace(`m/${location.search}${location.hash}`);
  throw new Error('versão para celular'); // não roda o resto da página
}

document.documentElement.classList.add('is-web');

// Token do login e convite chegam no fragmento (#auth?… / #entrar/CÓDIGO): lê e tira da barra de endereço.
const hash = location.hash;
if (hash) history.replaceState(null, '', location.pathname + location.search);
const inviteMatch = /^#(?:entrar|join)\/([A-Za-z0-9]{4,16})\/?$/i.exec(hash);
let pendingInvite = inviteMatch ? inviteMatch[1].toUpperCase() : '';
if (pendingInvite) sessionStorage.setItem('ariranhacast.pending-invite', pendingInvite);
else pendingInvite = sessionStorage.getItem('ariranhacast.pending-invite') ?? '';

const lobby = new LobbyClient(location.origin, {
  load(): Session | null {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  save(s: Session | null): void {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  },
}, /^(?:localhost|127\.0\.0\.1)$/.test(location.hostname)); // http só no teste local (wrangler dev)
let onLobby: (s: LobbyState) => void = () => {};
let onLobbyError: (t: string) => void = () => {};
lobby.onchange = (s) => onLobby(s);
lobby.onerror = (t) => onLobbyError(t);

const testing = new URLSearchParams(location.search).has('auto'); // testes automáticos: sem conta
async function startLobby(): Promise<void> {
  if (testing) return;
  if (/^#auth\?/.test(hash)) {
    try {
      lobby.pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null');
    } catch {
      lobby.pending = null;
    }
    sessionStorage.removeItem(PENDING_KEY);
    if (await lobby.completeLogin(`ariranhacast://auth?${hash.slice(6)}`)) return;
  }
  await lobby.start();
}
void startLobby();

// Tela ligada enquanto transmite (quando o navegador deixa).
let wake: { release(): Promise<void> } | null = null;

/** "Fonte" única: quem escolhe a tela, janela ou aba é o próprio navegador, ao começar. */
export const WEB_SOURCE: SourceInfo = { id: 'web:display', name: 'Escolher no navegador', kind: 'screen', thumbnail: '' };

function download(data: ArrayBuffer, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const none = async (): Promise<void> => {};
const no = async (): Promise<boolean> => false;

const bridge: AriranhaBridge = {
  web: true,
  getSources: async () => [WEB_SOURCE],
  selectSource: none,
  setStreaming: async (on) => {
    try {
      if (on && !wake) wake = await (navigator as any).wakeLock?.request('screen');
      if (!on && wake) {
        await wake.release();
        wake = null;
      }
    } catch {
      /* sem wake lock */
    }
  },
  platform: async () => 'web',
  startAudioCap: async () => ({ ok: false, reason: 'só no app instalado' }),
  stopAudioCap: none,
  gameCapAvailable: no,
  gameCapStart: async () => ({ ok: false, reason: 'só no app instalado' }),
  noCursorAvailable: no,
  gameCapStop: none,
  onGameCap: () => {},
  onPcm: () => {},
  setHotkeys: async () => ({ mic: true, deaf: true, clip: true, voice: true }), // atalhos globais: só no app
  onHotkey: () => {},
  setInRoom: none,
  appVersion: async () => `${__VERSION__}-web`,
  onUpdate: () => {},
  updaterState: async () => ({ state: 'disabled' }) as any,
  updaterCheck: none,
  updaterInstall: no,
  onUpdater: () => {},
  firewallStatus: async () => 'na' as any,
  firewallFix: async () => 'na' as any,
  gfxGet: async () => {
    throw new Error('só no app instalado');
  },
  gfxSet: async () => {
    throw new Error('só no app instalado');
  },
  relaunch: async () => location.reload(),
  quit: none,
  openExternal: async (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return false;
      return !!window.open(u.toString(), '_blank', 'noopener,noreferrer');
    } catch {
      return false;
    }
  },
  // Clipes: o navegador baixa o arquivo (pasta Downloads).
  saveClip: async (data, ext, voice) => {
    const kind = ext === 'mp4' || ext === 'm4a' ? ext : 'webm';
    if (!(data instanceof ArrayBuffer) || data.byteLength < 200) return { ok: false, error: 'clipe vazio' };
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const name = `${voice ? 'Voz' : 'Clipe'} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${kind}`;
    download(data, name, kind === 'webm' ? (voice ? 'audio/webm' : 'video/webm') : kind === 'm4a' ? 'audio/mp4' : 'video/mp4');
    return { ok: true, path: name };
  },
  showClip: none,
  yellowBorder: no,
  flash: none,
  gifSearch: async (key, query) => {
    if (typeof key !== 'string' || !/^[\w-]{16,64}$/.test(key)) return { ok: false, items: [], error: 'Falta a chave do Giphy (Configurações).' };
    const q = String(query ?? '').trim().slice(0, 80);
    const url = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(q)}&limit=18&rating=pg-13&lang=pt`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=18&rating=pg-13`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { ok: false, items: [], error: res.status === 401 || res.status === 403 ? 'Chave do Giphy recusada.' : `Giphy respondeu ${res.status}.` };
      const json = (await res.json()) as { data?: any[] };
      const items = await Promise.all(
        (json.data ?? []).slice(0, 18).map(async (g): Promise<GifItem | null> => {
          const thumb: string = g?.images?.fixed_width_small?.url ?? g?.images?.fixed_width?.url ?? '';
          const full: string = g?.images?.fixed_height?.url ?? g?.images?.downsized?.url ?? '';
          try {
            if (!GIF_HOSTS.test(new URL(thumb).hostname) || !GIF_HOSTS.test(new URL(full).hostname)) return null;
            const r = await fetch(thumb, { signal: AbortSignal.timeout(8000) });
            const b = await r.blob();
            if (!r.ok || b.size > 600_000) return null;
            return { id: String(g.id).slice(0, 40), title: String(g.title ?? '').slice(0, 80), thumb: await toDataUrl(new Blob([b], { type: 'image/gif' })), url: full };
          } catch {
            return null;
          }
        }),
      );
      return { ok: true, items: items.filter((x): x is GifItem => !!x) };
    } catch {
      return { ok: false, items: [], error: 'Sem conexão com o Giphy.' };
    }
  },
  gifFetch: async (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !GIF_HOSTS.test(u.hostname)) throw new Error('host');
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      const data = await r.arrayBuffer();
      if (!r.ok || data.byteLength > 4 * 1024 * 1024) throw new Error('size');
      return { ok: true, data };
    } catch {
      return { ok: false, error: 'Não consegui baixar o GIF.' };
    }
  },
  setOverlay: none,
  pushOverlay: () => {},
  onDeepLink: () => {},
  // Convite (#entrar/CÓDIGO): entregue depois do login; a página abre o "Entrar com código" preenchido.
  // Espera a conta carregar; sem login, a página guarda o convite e o código continua no
  // sessionStorage (o login sai do site e volta), sendo entregue de novo na volta.
  pendingDeepLink: async () => {
    if (!pendingInvite) return '';
    for (let i = 0; i < 100 && lobby.enabled && !testing && (lobby.state.status === 'disabled' || (lobby.state.status === 'connecting' && !lobby.state.user)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const c = pendingInvite;
    pendingInvite = '';
    if (lobby.state.user) sessionStorage.removeItem('ariranhacast.pending-invite');
    return c;
  },
  logError: async (text) => console.error('[AriranhaCast]', text),
  openLogs: no,
  lobbyState: async () => lobby.state,
  // O login sai da página (Discord) e volta para /web/#auth?…; o estado fica no sessionStorage.
  lobbyLogin: async (provider) => {
    if (!lobby.state.providers.some((p) => p.id === provider)) return false;
    const url = lobby.loginUrl(provider, true);
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(lobby.pending));
    location.assign(url);
    return true;
  },
  lobbyLogout: () => lobby.logout(),
  lobbyPublish: async (room: PublishedRoom | null) => lobby.publish(room),
  lobbyPresence: async (code, live) => lobby.setPresence(typeof code === 'string' && CODE_RE.test(code.toUpperCase()) ? code.toUpperCase() : null, 'web', live === true),
  // O lobby começa antes de a página se inscrever: entrega o estado atual logo ao inscrever.
  onLobby: (cb) => {
    onLobby = cb;
    queueMicrotask(() => cb(lobby.state));
  },
  onLobbyError: (cb) => {
    onLobbyError = cb;
  },
};

(window as any).ariranhacast = bridge;
