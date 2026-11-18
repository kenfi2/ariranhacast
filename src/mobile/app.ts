// AriranhaCast no Android: a mesma sala do app de PC (Room, Voice, Watch), com uma tela
// pensada para o celular. O celular fala, ouve, usa o chat e assiste às transmissões;
// não transmite e não repassa vídeo para ninguém (é sempre uma "folha" da árvore).
import { measurePc } from '../renderer/link';
import { clampLimit, DEFAULT_LIMIT, PROTO, Room } from '../renderer/room';
import { LobbyClient, type LobbyRoom, type PublishedRoom, type Session } from '../shared/lobby';
import { loadIce, net, normalizeCode } from '../renderer/signaling';
import { playSfx, type Sfx } from '../renderer/sounds';
import type { ChatMessage, Quality, RosterEntry, Settings } from '../renderer/types';
import { GATE_MAX_DB, GATE_MIN_DB, loadVoicePrefs, Voice, type GateMode, type NsMode, type VoicePrefs } from '../renderer/voice';
import { Watch } from '../renderer/watch';
import { forPlatform, parseNotes, renderChangelog, shouldShowAfterUpdate, type ChangeEntry } from '../shared/changelog';
import { callStart, callStop, deviceStatus, fetchText, installUpdate, keepScreenOn, native, onAppLink, onFullscreenExit, openBrowser, setFullscreen, setSpeaker } from './native';

declare const __VERSION__: string;
declare const __LOBBY_URL__: string;
declare const __UPDATE_URL__: string;
declare const __CHANGELOG__: ChangeEntry[];
const VERSION = `${__VERSION__}-android`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
const svg = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const SLASH = '<path d="M4 4l16 16"/>';
const ICON = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"/>',
  headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4.5" height="7" rx="1.6"/><rect x="16.5" y="13" width="4.5" height="7" rx="1.6"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  earpiece: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 5.5h3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  hangup: '<path d="M3 14.5c5-5 13-5 18 0l-2.6 2.6-3.4-1.8v-2.6a10 10 0 0 0-6 0v2.6l-3.4 1.8z"/>',
};

// ---------- preferências ----------
const store = {
  get name(): string {
    return localStorage.getItem('ariranhacast.name') ?? '';
  },
  set name(v: string) {
    localStorage.setItem('ariranhacast.name', v);
  },
  get ice(): string {
    return localStorage.getItem('ariranhacast.ice') ?? '';
  },
  set ice(v: string) {
    localStorage.setItem('ariranhacast.ice', v);
  },
  get quality(): Quality {
    const q = localStorage.getItem('ariranhacast.quality');
    return q === 'high' || q === 'low' ? q : 'med';
  },
  set quality(v: Quality) {
    localStorage.setItem('ariranhacast.quality', v);
  },
  get streamVolume(): number {
    const v = Number(localStorage.getItem('ariranhacast.svol') ?? '1');
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  },
  set streamVolume(v: number) {
    localStorage.setItem('ariranhacast.svol', String(v));
  },
  /** Reprodução suave (buffer): ligada por padrão no celular, onde o Wi-Fi/4G oscila mais. */
  get smooth(): boolean {
    return localStorage.getItem('ariranhacast.smooth') !== '0';
  },
  set smooth(v: boolean) {
    localStorage.setItem('ariranhacast.smooth', v ? '1' : '0');
    net.smoothMs = v ? 200 : 0;
  },
  get bgVideo(): boolean {
    return localStorage.getItem('ariranhacast.bgvideo') === '1';
  },
  set bgVideo(v: boolean) {
    localStorage.setItem('ariranhacast.bgvideo', v ? '1' : '0');
  },
  /** Volume que você deu a cada pessoa (pelo nome, que é o que se mantém entre as salas). */
  volumes(): Record<string, number> {
    try {
      const o = JSON.parse(localStorage.getItem('ariranhacast.volumes') ?? '{}');
      return o && typeof o === 'object' ? o : {};
    } catch {
      return {};
    }
  },
  setVolume(name: string, v: number): void {
    const o = this.volumes();
    if (v === 1) delete o[name];
    else o[name] = v;
    localStorage.setItem('ariranhacast.volumes', JSON.stringify(o));
  },
  recent(): { code: string; at: number }[] {
    try {
      const list = JSON.parse(localStorage.getItem('ariranhacast.recent') ?? '[]');
      return Array.isArray(list) ? list.filter((r) => typeof r?.code === 'string').slice(0, 5) : [];
    } catch {
      return [];
    }
  },
  remember(code: string): void {
    const list = [{ code, at: Date.now() }, ...this.recent().filter((r) => r.code !== code)].slice(0, 5);
    localStorage.setItem('ariranhacast.recent', JSON.stringify(list));
  },
};

const SESSION_KEY = 'ariranhacast.session';
const lobby = new LobbyClient(__LOBBY_URL__, {
  load(): Session | null {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  save(sess: Session | null): void {
    if (sess) localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    else localStorage.removeItem(SESSION_KEY);
  },
});
const testingParams = new URLSearchParams(location.search).has('server'); // testes automáticos: sem conta
const lobbyOn = (): boolean => lobby.enabled && !testingParams;
const needsLogin = (): boolean => lobbyOn() && !lobby.state.user;
/** Com conta: o nome vem dela, com "(celular)" para não confundir com a mesma pessoa no PC. */
function myName(): string {
  const u = lobby.state.user;
  return u ? `${u.name.slice(0, 14)} (celular)` : store.name || `Convidado${Math.floor(Math.random() * 900 + 100)}`;
}

function settings(): Settings {
  return {
    name: myName(),
    server: new URLSearchParams(location.search).get('server') ?? '', // só para testes
    iceServers: store.ice,
    hotMic: '',
    hotDeaf: '',
    hotClip: '',
    hotVoice: '',
    voiceSeconds: 0,
    giphyKey: '',
    relayEconomy: true,
    turnLimitGb: 0,
    overlayOn: false,
    overlayCorner: 'tr',
    overlayMode: 'speaking',
    clipSeconds: 0,
    clipWatched: false,
    smoothPlayback: true,
  };
}

net.smoothMs = store.smooth ? 200 : 0;

// ---------- estado ----------
let room: Room | null = null;
let voice: Voice | null = null;
let cfg: Settings = settings();
let watch: Watch | null = null;
let watchingId = '';
let wantWatch = ''; // a pessoa quer assistir a esta transmissão (retoma sozinho se cair)
let speakerOn = true;
let unread = 0;
let pollTimer = 0;
let statsTimer = 0;
let attempt: { cancelled: boolean; room: Room | null } | null = null;

let toastTimer = 0;
function toast(text: string, ms = 3500): void {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

function show(screen: 'home' | 'connecting' | 'room'): void {
  for (const s of ['home', 'connecting', 'room']) $(s).hidden = s !== screen;
}

function color(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

function sfx(kind: Sfx): void {
  if (voice) playSfx(kind, voice.prefs.sounds, '');
}

// ---------- conta e salas abertas (lobby) ----------
// Com servidor de lobby configurado, entrar com uma conta é obrigatório. O login abre no navegador
// do sistema e volta pelo link ariranhacast://auth?… (a sessão é deste aparelho).
let roomTitle = '';
let publishedKey = 'null';
let pendingCode = '';

const LOCK_ICON = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';

function avatar(user: { id: string; name: string; avatar: string | null }, cls: string): HTMLElement {
  const box = el('span', cls);
  const letter = () => {
    box.replaceChildren();
    box.textContent = (user.name.trim()[0] ?? '?').toUpperCase();
    box.style.background = color(user.id);
  };
  if (user.avatar) {
    const img = el('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = letter;
    img.src = user.avatar;
    box.append(img);
  } else letter();
  return box;
}

function publishLobby(): void {
  if (!lobbyOn()) return;
  lobby.setPresence(room?.code ?? null, 'android', !!room?.roster.find((p) => p.id === room!.selfId)?.screen); // aparece no "Online agora" de quem tem servidor em comum
  let data: PublishedRoom | null = null;
  if (room?.isHost && room.code) {
    data = {
      code: room.code,
      name: roomTitle,
      locked: room.hasPassword,
      count: Math.max(1, room.roster.length),
      max: room.limit,
      members: room.roster.map((p) => p.name),
      people: room.roster.map((p) => ({ name: p.name, avatar: p.avatar || null })),
      live: room.roster.filter((p) => p.screen).length,
      proto: PROTO,
    };
  }
  const key = JSON.stringify(data);
  if (key === publishedKey) return;
  publishedKey = key;
  lobby.publish(data);
}

function lobbyRoomItem(r: LobbyRoom): HTMLLIElement {
  const li = el('li', 'lobby-room');
  li.dataset.code = r.code;
  const title = el('div', 'lr-title');
  title.append(el('span', 'lr-name', r.name));
  if (r.locked) title.insertAdjacentHTML('beforeend', svg(LOCK_ICON));
  if (r.live) title.append(el('span', 'lr-live', 'AO VIVO'));
  const sub = el('div', 'lr-sub');
  sub.append(avatar(r.host, 'avatar small'), el('span', '', `${r.count}/${r.max} pessoas · ${r.members.join(', ') || r.host.name}`));
  // Servidor do Discord em comum com quem hospeda.
  const shared = r.guilds.map((id) => lobby.state.guilds.find((g) => g.id === id)).filter((g): g is NonNullable<typeof g> => !!g);
  let chips: HTMLElement | null = null;
  if (shared.length) {
    chips = el('div', 'lr-guilds');
    const chip = el('span', 'guild-chip');
    if (shared[0].icon) {
      const img = el('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = shared[0].icon;
      img.onerror = () => img.remove();
      chip.append(img);
    }
    chip.append(el('span', '', shared[0].name));
    chips.append(chip);
    if (shared.length > 1) chips.append(el('span', 'muted', `+${shared.length - 1}`));
  }
  const actions = el('div', 'lr-actions');
  const join = el('button', 'primary', 'Entrar');
  join.type = 'button';
  let pass: HTMLInputElement | null = null;
  if (r.count >= r.max) {
    join.disabled = true;
    join.textContent = 'Cheia';
  } else if (r.proto !== PROTO) {
    join.disabled = true;
    join.textContent = r.proto > PROTO ? 'Atualize o app' : 'Versão antiga';
  } else {
    if (r.locked) {
      pass = el('input');
      pass.type = 'password';
      pass.maxLength = 64;
      pass.placeholder = 'Senha';
      actions.append(pass);
    }
    join.onclick = () => {
      if (pass && !pass.value) {
        pass.focus();
        return toast('Essa sala tem senha.');
      }
      if (saveHome()) void enter(false, r.code, pass?.value ?? '', r.name);
    };
  }
  actions.append(join);
  li.append(title, sub, ...(chips ? [chips] : []), actions);
  return li;
}

function renderLobby(): void {
  const on = lobbyOn();
  const gated = needsLogin();
  $('login').hidden = !gated;
  $('home-main').hidden = gated;
  $('lobby').hidden = !on;
  $('account').hidden = !on || !lobby.state.user;
  $('name-label').hidden = on;
  $('room-name-label').hidden = !on;
  const u = lobby.state.user;
  if (u) {
    $('acc-name').textContent = u.name;
    $('acc-avatar').replaceWith(Object.assign(avatar(u, 'avatar'), { id: 'acc-avatar' }));
  }
  if (gated) {
    const box = $('login-providers');
    const ids = lobby.state.providers.map((p) => p.id).join(',');
    if (box.dataset.ids !== ids) {
      box.dataset.ids = ids;
      box.replaceChildren(
        ...lobby.state.providers.map((p) => {
          const b = el('button', `p-${p.id}`, `Entrar com ${p.label}`);
          b.type = 'button';
          b.onclick = () =>
            void openBrowser(lobby.loginUrl(p.id)).then((ok) => {
              if (ok) $('login-wait').hidden = false;
              else toast('Não foi possível abrir o navegador.');
            });
          return b;
        }),
      );
    }
    $('login-offline').hidden = lobby.state.providers.length > 0;
    return;
  }
  if (!on) return;
  const st = lobby.state.status;
  // Primeiro as salas de quem está num servidor do Discord seu.
  const rooms = lobby.state.rooms
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.guilds.length > 0) - Number(a.r.guilds.length > 0) || a.i - b.i)
    .map((x) => x.r);
  const n = rooms.length;
  $('lobby-status').textContent = st === 'online' ? `· ${n}` : st === 'offline' ? '· sem conexão' : '· conectando…';
  $('lobby-empty').hidden = st !== 'online' || n > 0;
  // A lista é refeita a cada mudança: guarda a senha que estava sendo digitada.
  const typed = new Map<string, string>();
  for (const input of document.querySelectorAll<HTMLInputElement>('#lobby-list input')) {
    const code = input.closest<HTMLElement>('li')?.dataset.code ?? '';
    if (input.value) typed.set(code, input.value);
  }
  $('lobby-list').replaceChildren(...rooms.map(lobbyRoomItem));
  for (const li of document.querySelectorAll<HTMLElement>('#lobby-list li')) {
    const input = li.querySelector('input');
    if (input) input.value = typed.get(li.dataset.code ?? '') ?? '';
  }
}

let hadUser = false;
lobby.onchange = (st) => {
  if (st.status === 'online') publishedKey = 'null'; // reconectou: o cliente já republica o que hospedamos
  publishLobby();
  renderLobby();
  if (!hadUser && st.user) {
    $('login-wait').hidden = true;
    if (pendingCode && !room) {
      const code = pendingCode;
      pendingCode = '';
      void enter(false, code);
    }
  }
  hadUser = !!st.user;
};
lobby.onerror = (text) => toast(text, 5000);

onAppLink((url) => {
  if (/^ariranhacast:\/\/auth[/?]/i.test(url)) {
    void lobby.completeLogin(url);
    return;
  }
  const m = /^ariranhacast:\/\/(?:entrar|join)\/([A-Za-z0-9]{4,16})\/?$/i.exec(url);
  if (!m) return;
  const code = normalizeCode(m[1]);
  if (room) return toast(room.code === code ? 'Você já está nessa sala.' : `Convite para a sala ${code}: saia da sala atual para entrar.`);
  if (needsLogin()) {
    pendingCode = code;
    return toast('Entre com a sua conta para abrir o convite.');
  }
  void enter(false, code);
});

$('btn-logout').onclick = () => {
  if (room) return toast('Saia da sala antes de sair da conta.');
  void lobby.logout();
};

// ---------- atualização do app ----------
// Cada release publica o APK e o latest-android.json ({version, apk, sha256}). O app confere ao
// abrir; com versão nova, mostra "Atualizar": baixa, confere o SHA-256 e abre o instalador do Android.
let lastUpdateCheck = 0;
let updateInfo: { version: string; apk: string; sha256: string; notes: string[] } | null = null;

function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

async function checkUpdate(): Promise<void> {
  if (!native || !/^https:\/\//.test(__UPDATE_URL__)) return;
  lastUpdateCheck = Date.now();
  try {
    const j = JSON.parse(await fetchText(`${__UPDATE_URL__}latest-android.json`));
    const version = String(j?.version ?? '');
    const apk = String(j?.apk ?? '');
    const sha256 = String(j?.sha256 ?? '').toLowerCase();
    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^AriranhaCast-Android-[\d.]+\.apk$/.test(apk) || !/^[0-9a-f]{64}$/.test(sha256)) return;
    if (!newer(version, __VERSION__)) return;
    const notes = Array.isArray(j?.notes) ? j.notes.slice(0, 40).map(String) : [];
    updateInfo = { version, apk, sha256, notes };
    $('update-text').textContent = `Versão ${version} disponível.`;
    $('update-bar').hidden = false;
  } catch {
    /* sem rede ou release sem o arquivo: tenta na próxima vez */
  }
}

// ---------- novidades ----------
const CHANGELOG = forPlatform(__CHANGELOG__, 'android');
function openNews(justUpdated = false): void {
  const info = updateInfo;
  let pending: ChangeEntry | undefined;
  if (info) {
    const items = parseNotes(info.notes).filter((i) => i.only !== 'pc');
    pending = { version: info.version, date: '', items: items.length ? items : [{ text: 'Correções e melhorias.' }] };
  }
  $('news-title').textContent = justUpdated ? `Atualizado para a ${__VERSION__}` : pending ? `Versão ${pending.version} disponível` : 'Novidades';
  const intro = $('news-intro');
  intro.hidden = !(justUpdated || pending);
  intro.textContent = justUpdated ? 'Veja o que mudou. Esta lista fica sempre em "Novidades", na tela inicial.' : 'Toque em "Atualizar agora" para baixar e instalar.';
  renderChangelog($('news-list'), CHANGELOG, __VERSION__, pending);
  $('news-install').hidden = !pending;
  $('news').hidden = false;
}
$('btn-news').onclick = () => openNews();
$('btn-update-news').onclick = () => openNews();
$('btn-news-close').onclick = () => ($('news').hidden = true);
$('news-install').onclick = () => {
  $('news').hidden = true;
  $('btn-update').click();
};
if (shouldShowAfterUpdate(__VERSION__) && CHANGELOG.some((e) => e.version === __VERSION__)) setTimeout(() => openNews(true), 600);

$('btn-update').onclick = async () => {
  const info = updateInfo;
  if (!info) return;
  const btn = $<HTMLButtonElement>('btn-update');
  btn.disabled = true;
  $('update-text').textContent = 'Baixando…';
  try {
    await installUpdate(`${__UPDATE_URL__}${info.apk}`, info.sha256, (pct) => {
      $('update-text').textContent = pct >= 0 ? `Baixando… ${pct}%` : 'Baixando…';
    });
    $('update-text').textContent = 'Confirme a instalação na tela do Android.';
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    $('update-text').textContent = `Versão ${info.version} disponível.`;
    toast(/permita/i.test(msg) ? msg : `Não foi possível atualizar: ${msg}`, 7000);
  } finally {
    btn.disabled = false;
  }
};

// ---------- início ----------
function renderHome(): void {
  $<HTMLInputElement>('name').value = store.name;
  $<HTMLTextAreaElement>('ice').value = store.ice;
  $('version').textContent = `versão ${VERSION}`;
  const list = $('recent');
  list.replaceChildren();
  for (const r of store.recent()) {
    const li = el('li', '', r.code);
    li.append(el('span', '', new Date(r.at).toLocaleDateString('pt-BR')));
    li.onclick = () => {
      $<HTMLInputElement>('code').value = r.code;
      void enter(false, r.code);
    };
    list.append(li);
  }
  if (list.childElementCount) list.prepend(el('h3', '', 'Salas recentes'));
}

function saveHome(): boolean {
  store.ice = $<HTMLTextAreaElement>('ice').value.trim();
  if (lobbyOn()) return !!lobby.state.user;
  const name = $<HTMLInputElement>('name').value.trim().slice(0, 24);
  if (!name) {
    toast('Digite seu nome.');
    $('name').focus();
    return false;
  }
  store.name = name;
  store.ice = $<HTMLTextAreaElement>('ice').value.trim();
  return true;
}

$<HTMLFormElement>('join-form').onsubmit = (e) => {
  e.preventDefault();
  if (!saveHome()) return;
  const code = normalizeCode($<HTMLInputElement>('code').value);
  if (code.length < 4) return toast('Digite o código da sala.');
  void enter(false, code, $<HTMLInputElement>('pass').value);
};
$('btn-create').onclick = () => {
  if (saveHome()) void enter(true, undefined, '', $<HTMLInputElement>('room-name').value);
};
$('btn-cancel').onclick = () => {
  if (!attempt) return;
  attempt.cancelled = true;
  attempt.room?.leave();
  attempt = null;
  show('home');
};

// ---------- entrar / sair ----------
async function enter(create: boolean, code?: string, password = '', title = ''): Promise<void> {
  if (room || attempt) return;
  if (needsLogin()) return toast('Entre com a sua conta primeiro.');
  const my = { cancelled: false, room: null as Room | null };
  attempt = my;
  cfg = settings();
  $('connecting-text').textContent = create ? 'Criando a sala…' : `Entrando na sala ${code}…`;
  show('connecting');
  const ice = await loadIce(cfg);
  if (my.cancelled) return;
  if (!ice.ok) toast(`TURN das configurações inválido (${ice.error}); seguindo sem ele.`);
  let limit = DEFAULT_LIMIT;
  if (create) {
    limit = clampLimit(Math.round(Number($<HTMLInputElement>('room-limit').value)));
    localStorage.setItem('ariranhacast.limit', String(limit));
    $<HTMLInputElement>('room-limit').value = String(limit);
  }
  const r = new Room(cfg, VERSION, password, limit, lobby.state.user?.avatar ?? '');
  my.room = r;
  try {
    if (create) await r.create();
    else await r.join(code!);
  } catch (e: any) {
    attempt = null;
    if (my.cancelled) return;
    show('home');
    const msg = String(e?.message ?? e);
    if (/senha/i.test(msg)) $('pass-label').hidden = false;
    toast(msg, 6000);
    return;
  }
  attempt = null;
  if (my.cancelled) return r.leave();
  room = r;
  roomTitle = title.trim() || lobby.state.rooms.find((x) => x.code === r.code)?.name || '';
  store.remember(r.code);
  voice = new Voice(r.peer, cfg.name, (id) => r.isMember(id));
  if (voice.prefs.mode === 'ai') await voice.setMode('standard'); // a supressão por IA pesa no celular
  voice.onchange = () => {
    syncVoiceState();
    renderPeople();
    renderBar();
  };
  r.onroster = onRoster;
  r.onend = (reason) => leave(reason);
  r.onstatus = (t) => ($('room-status').textContent = t);
  r.oncommand = () => {
    if (voice?.micOn) {
      void voice.setMic(false);
      toast('Quem hospeda a sala desligou o seu microfone.');
    }
  };
  r.onchat = (m) => {
    addMsg(m);
    if ($('chat').hidden) {
      unread++;
      renderBadge();
    }
  };
  r.onhistory = renderChat;
  r.onchatdel = (id) => document.querySelector(`#msgs li[data-id="${CSS.escape(id)}"]`)?.remove();
  personEls.clear();
  appliedVol.clear();
  $('people').replaceChildren();
  $('btn-code').textContent = r.code;
  $('room-status').textContent = '';
  show('room');
  renderChat();
  onRoster(r.roster);

  // Microfone ligado ao entrar (como no PC). Depois dele, o serviço que mantém a chamada viva.
  await voice.setMic(true);
  if (voice.micError) toast(voice.micError, 5000);
  const err = await callStart(`Sala ${r.code}`);
  if (err) toast(err, 6000);
  const dev = await deviceStatus();
  speakerOn = !dev.headset;
  await setSpeaker(speakerOn);
  renderBar();
  pollTimer = window.setInterval(() => void poll(), 2000);
}

function leave(reason?: string): void {
  if (!room) return;
  clearInterval(pollTimer);
  stopWatch();
  wantWatch = '';
  sfx('leave');
  voice?.close();
  voice = null;
  room.leave();
  room = null;
  roomTitle = '';
  publishLobby();
  rosterIds = null;
  sentState = '';
  unread = 0;
  renderBadge();
  $('chat').hidden = true;
  $('person').hidden = true;
  $('msgs').replaceChildren();
  void callStop();
  renderHome();
  show('home');
  if (reason) toast(reason, 5000);
}

$('btn-leave').onclick = () => leave();
$('btn-code').onclick = async () => {
  if (!room) return;
  try {
    await navigator.clipboard.writeText(room.code);
    toast(`Código ${room.code} copiado.`);
  } catch {
    toast(`Código da sala: ${room.code}`);
  }
};

// ---------- pessoas ----------
let rosterIds: Set<string> | null = null;
let rosterLive = new Set<string>();
function onRoster(list: RosterEntry[]): void {
  if (!room || !voice) return;
  const me = room.selfId;
  const ids = new Set(list.map((p) => p.id));
  const live = new Set(list.filter((p) => p.screen).map((p) => p.id));
  if (rosterIds && ids.has(me)) {
    if ([...ids].some((id) => id !== me && !rosterIds!.has(id))) sfx('join');
    else if ([...rosterIds].some((id) => id !== me && !ids.has(id))) sfx('leave');
    else if ([...live].some((id) => id !== me && !rosterLive.has(id))) sfx('live');
  }
  if (ids.has(me)) {
    rosterIds = ids;
    rosterLive = live;
  }
  voice.peerState = new Map(list.map((p) => [p.id, { muted: p.muted, deaf: p.deaf }]));
  voice.setRoster(list);
  if (watchingId && !live.has(watchingId)) stopWatch();
  if (wantWatch && !ids.has(wantWatch)) wantWatch = '';
  renderStreams();
  renderPeople();
}

let sentState = '';
function syncVoiceState(): void {
  if (!room || !voice) return;
  const st = { muted: !voice.micOn, deaf: voice.deafened };
  const key = `${st.muted}${st.deaf}`;
  if (key === sentState) return;
  sentState = key;
  room.setState(st);
}

// A lista é atualizada no lugar (só o que mudou), não recriada: o indicador de fala muda
// várias vezes por segundo e recriar tudo a cada vez gasta bateria à toa.
const personEls = new Map<string, { li: HTMLLIElement; name: HTMLElement; small: HTMLElement; icons: HTMLElement; key: string }>();
function renderPeople(): void {
  if (!room || !voice) return;
  const rows = new Map(voice.rows().map((r) => [r.self ? room!.selfId : r.id, r]));
  const list = $('people');
  $('count').textContent = `(${room.roster.length})`;
  const vols = store.volumes();
  const seen = new Set<string>();
  room.roster.forEach((p, i) => {
    seen.add(p.id);
    const self = p.id === room!.selfId;
    const r = rows.get(p.id);
    let e = personEls.get(p.id);
    if (!e) {
      const li = el('li', self ? 'self' : '');
      const av = el('div', 'avatar', p.name.trim().charAt(0).toUpperCase() || '?');
      av.style.background = color(p.id);
      const who = el('div', 'who');
      const name = el('span');
      const small = el('small');
      who.append(name, small);
      const icons = el('div', 'icons');
      li.append(av, who, icons);
      if (!self) li.onclick = () => openPerson(p.id);
      e = { li, name, small, icons, key: '' };
      personEls.set(p.id, e);
    }
    if (list.children[i] !== e.li) list.insertBefore(e.li, list.children[i] ?? null);
    e.li.classList.toggle('speaking', !!r?.speaking);
    const muted = self ? !voice!.micOn : p.muted;
    const deaf = self ? voice!.deafened : p.deaf;
    const vol = self ? 1 : (r?.volume ?? 1);
    const detail = self
      ? voice!.micError || ''
      : !r?.connected
        ? 'conectando…'
        : [r.link ? `${r.link.rttMs} ms` : '', r.turn ? 'via TURN' : '', p.id === room!.hostId ? 'hospeda a sala' : '', vol === 0 ? 'silenciado para você' : vol < 1 ? `volume ${Math.round(vol * 100)}%` : ''].filter(Boolean).join(' · ');
    const key = `${p.name}|${detail}|${muted}|${deaf}`;
    if (key === e.key) return;
    e.key = key;
    e.name.textContent = self ? `${p.name} (você)` : p.name;
    e.small.textContent = detail;
    e.small.hidden = !detail;
    e.icons.innerHTML =
      (muted ? `<span title="Microfone desligado">${svg(ICON.mic + SLASH)}</span>` : '') + (deaf ? `<span title="Não está ouvindo">${svg(ICON.headset + SLASH)}</span>` : '');
    // volume salvo para esta pessoa (vale ao reencontrá-la em outra sala)
    if (!self && r && vols[p.name] !== undefined && r.volume === 1 && !appliedVol.has(p.id)) {
      appliedVol.add(p.id);
      voice!.setVolume(p.id, vols[p.name]);
    }
  });
  for (const [id, e] of personEls) {
    if (seen.has(id)) continue;
    e.li.remove();
    personEls.delete(id);
    appliedVol.delete(id);
  }
}
const appliedVol = new Set<string>();

// ---------- pessoa (volume só para você) ----------
let personId = '';
function openPerson(id: string): void {
  const p = room?.roster.find((x) => x.id === id);
  const r = voice?.rows().find((x) => x.id === id);
  if (!p || !voice) return;
  personId = id;
  $('p-name').textContent = p.name;
  $('p-info').textContent = r?.link ? `Ping ${r.link.rttMs} ms · perda ${r.link.lossPct.toFixed(1)}% · ${r.turn ? 'via TURN' : 'conexão direta'}` : r?.connected ? '' : 'Conectando…';
  const vol = r?.volume ?? 1;
  $<HTMLInputElement>('p-vol').value = String(vol);
  syncPerson(vol);
  $('person').hidden = false;
}
function syncPerson(vol: number): void {
  $('p-vol-txt').textContent = `${Math.round(vol * 100)}%`;
  $('btn-p-mute').textContent = vol === 0 ? 'Voltar a ouvir' : 'Silenciar só para mim';
}
function setPersonVolume(vol: number): void {
  const p = room?.roster.find((x) => x.id === personId);
  if (!p || !voice) return;
  voice.setVolume(personId, vol);
  store.setVolume(p.name, vol);
  appliedVol.add(personId);
  syncPerson(vol);
  renderPeople();
}
$<HTMLInputElement>('p-vol').oninput = () => setPersonVolume(Number($<HTMLInputElement>('p-vol').value));
$('btn-p-mute').onclick = () => {
  const now = Number($<HTMLInputElement>('p-vol').value);
  const next = now === 0 ? 1 : 0;
  $<HTMLInputElement>('p-vol').value = String(next);
  setPersonVolume(next);
};
$('btn-person-close').onclick = () => ($('person').hidden = true);

// ---------- barra ----------
function renderBar(): void {
  const mic = $('btn-mic');
  const micOn = !!voice?.micOn;
  mic.innerHTML = svg(ICON.mic + (micOn ? '' : SLASH));
  mic.className = `round${micOn ? '' : ' off'}`;
  const deaf = $('btn-deaf');
  deaf.innerHTML = svg(ICON.headset + (voice?.deafened ? SLASH : ''));
  deaf.className = `round${voice?.deafened ? ' off' : ''}`;
  const spk = $('btn-speaker');
  spk.innerHTML = svg(speakerOn ? ICON.speaker : ICON.earpiece);
  spk.className = `round${speakerOn ? ' on' : ''}`;
  spk.hidden = !native;
  const chat = $('btn-chat');
  if (!chat.querySelector('svg')) chat.insertAdjacentHTML('afterbegin', svg(ICON.chat));
  $('btn-leave').innerHTML = svg(ICON.hangup);
}

$('btn-mic').onclick = async () => {
  if (!voice) return;
  const wasDeaf = voice.deafened;
  await voice.setMic(!voice.micOn);
  if (voice.micError) toast(voice.micError);
  else sfx(wasDeaf && !voice.deafened ? 'undeafen' : voice.micOn ? 'unmute' : 'mute');
  renderBar();
};
$('btn-deaf').onclick = () => {
  if (!voice) return;
  voice.setDeafened(!voice.deafened);
  sfx(voice.deafened ? 'deafen' : 'undeafen');
  renderBar();
};
$('btn-speaker').onclick = async () => {
  speakerOn = !speakerOn;
  const r = await setSpeaker(speakerOn);
  if (!r.ok && speakerOn) toast('Não foi possível trocar para o alto-falante.');
  toast(speakerOn ? 'Alto-falante' : r.headset ? 'Fone de ouvido' : 'Auricular (no ouvido)', 1500);
  renderBar();
};

// ---------- transmissões ----------
function renderStreams(): void {
  if (!room) return;
  const live = room.roster.filter((p) => p.screen && p.id !== room!.selfId);
  $('streams-box').hidden = !live.length;
  const list = $('streams');
  list.replaceChildren();
  for (const p of live) {
    const li = el('li');
    const who = el('div', 'who');
    who.append(el('strong', '', p.name), el('small', '', p.title || 'Tela'));
    const btn = el('button', watchingId === p.id ? '' : 'primary', watchingId === p.id ? 'Assistindo' : 'Assistir');
    btn.disabled = watchingId === p.id;
    btn.onclick = () => {
      wantWatch = p.id;
      startWatch(p.id);
    };
    li.append(el('span', 'live', 'AO VIVO'), who, btn);
    list.append(li);
  }
}

function startWatch(id: string): void {
  if (!room) return;
  stopWatch();
  const r = room;
  const w = new Watch(r.peer, cfg, id, (peerId) => r.isMember(peerId), true);
  watch = w;
  watchingId = id;
  w.quality = store.quality;
  $<HTMLSelectElement>('quality').value = store.quality;
  w.onstatus = (t) => ($('viewer-status').textContent = t);
  w.onstream = (stream) => {
    const v = $<HTMLVideoElement>('video');
    v.srcObject = stream;
    v.volume = store.streamVolume;
    keepScreenOn(true);
    void v.play().catch(() => {});
    w.setQuality(store.quality); // o canal com quem transmite já está aberto
  };
  w.onpaused = (on) => ($('viewer-status').textContent = on ? 'Transmissão pausada' : '');
  w.onend = (reason) => {
    if (watch !== w) return;
    stopWatch();
    if (!room?.roster.find((p) => p.id === id)?.screen) {
      wantWatch = '';
      toast(reason);
    }
  };
  $('viewer').hidden = false;
  renderStreams();
  w.start();
  clearInterval(statsTimer);
  statsTimer = window.setInterval(async () => {
    if (watch !== w) return;
    const s = await w.stats();
    if (!s || !s.width) return;
    $('viewer-status').textContent = `${s.width}×${s.height} · ${Math.round(s.fps)} fps · ${s.codec} · ${(s.kbps / 1000).toFixed(1)} Mbps · ${w.via}${s.turn ? ' · TURN' : ''}${s.decoder && /software|libvpx|ffmpeg|dav1d/i.test(s.decoder) ? ' · decodificação por software' : ''}`;
  }, 2000);
}

function stopWatch(): void {
  clearInterval(statsTimer);
  watch?.close();
  watch = null;
  watchingId = '';
  const v = $<HTMLVideoElement>('video');
  v.srcObject = null;
  keepScreenOn(false);
  $('viewer').hidden = true;
  setFull(false);
  renderStreams();
}

$<HTMLSelectElement>('quality').onchange = () => {
  store.quality = $<HTMLSelectElement>('quality').value as Quality;
  watch?.setQuality(store.quality);
  if (watch && watch.via !== 'direto') toast('Você recebe por outra pessoa da sala; a qualidade segue a dela.');
};
$('btn-stopwatch').onclick = () => {
  wantWatch = '';
  stopWatch();
};
// Tela cheia de verdade: o requestFullscreen do WebView só ocupa a área do app (as barras do
// Android continuam lá). No app, o vídeo ocupa a página inteira e o Android esconde as barras de
// status e de navegação (modo imersivo) e gira para paisagem; o botão voltar sai da tela cheia.
let full = false;
function setFull(on: boolean): void {
  if (on === full) return;
  full = on;
  $('viewer').classList.toggle('full', on);
  $('btn-full').textContent = on ? 'Sair da tela cheia' : 'Tela cheia';
  if (native) return void setFullscreen(on);
  if (on) void $('viewer').requestFullscreen().catch(() => {});
  else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}
$('btn-full').onclick = (e) => {
  e.stopPropagation();
  setFull(!full);
};
onFullscreenExit(() => setFull(false));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && full && !native) setFull(false);
});
let toolsTimer = 0;
$('viewer').onclick = () => {
  if (!full) return;
  $('viewer').classList.add('tools');
  clearTimeout(toolsTimer);
  toolsTimer = window.setTimeout(() => $('viewer').classList.remove('tools'), 3000);
};

// Com o app em segundo plano o vídeo não aparece: para de receber (economiza bateria e internet)
// e retoma ao voltar. A voz continua.
document.addEventListener('visibilitychange', () => {
  if (!room) return;
  if (document.hidden) {
    if (watch && !store.bgVideo) stopWatch();
  } else if (wantWatch && !watch) {
    startWatch(wantWatch);
  }
});

async function poll(): Promise<void> {
  publishLobby();
  if (!room || !voice) return;
  // retoma a transmissão que caiu (rede que piscou, troca de Wi-Fi para 4G)
  if (!document.hidden && wantWatch && !watch && room.roster.find((p) => p.id === wantWatch)?.screen) startWatch(wantWatch);
  for (const [id, pc] of voice.pcs()) {
    const q = await measurePc(pc).catch(() => null);
    if (q) voice.links.set(id, q);
  }
  renderPeople();
}

// ---------- chat ----------
const blobUrls = new Map<string, string>();
function addMsg(m: ChatMessage): void {
  const list = $('msgs');
  const li = el('li');
  li.dataset.id = m.id;
  const name = el('b', '', m.name);
  name.style.color = color(m.from);
  li.append(name);
  if (m.text) li.append(document.createTextNode(m.text));
  li.append(el('time', '', new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })));
  if (m.img && !m.expired) {
    const url = URL.createObjectURL(new Blob([m.img.data as BlobPart], { type: m.img.mime }));
    blobUrls.set(m.id, url);
    const img = el('img', m.sticker ? 'sticker' : '');
    img.src = url;
    img.alt = '';
    li.append(img);
  } else if (m.img || m.expired) {
    li.append(el('div', 'muted', '[imagem]'));
  }
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.append(li);
  while (list.childElementCount > 200) {
    const first = list.firstElementChild as HTMLElement;
    const url = blobUrls.get(first.dataset.id ?? '');
    if (url) URL.revokeObjectURL(url);
    first.remove();
  }
  if (atBottom) list.scrollTop = list.scrollHeight;
}
function renderChat(): void {
  for (const url of blobUrls.values()) URL.revokeObjectURL(url);
  blobUrls.clear();
  $('msgs').replaceChildren();
  for (const m of room?.chatLog ?? []) addMsg(m);
}
function renderBadge(): void {
  $('chat-badge').hidden = !unread;
  $('chat-badge').textContent = unread > 99 ? '99+' : String(unread);
}
$('btn-chat').onclick = () => {
  $('chat').hidden = false;
  unread = 0;
  renderBadge();
  $('msgs').scrollTop = $('msgs').scrollHeight;
};
$('btn-chat-close').onclick = () => ($('chat').hidden = true);
$<HTMLFormElement>('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('chat-input');
  const text = input.value.trim();
  if (!text || !room) return;
  if (room.sendChat(text)) input.value = '';
};
$('chat-input').oninput = () => room?.sendTyping();

// Botão "voltar" do Android: fecha o chat / sai da tela cheia antes de qualquer outra coisa.
window.addEventListener('popstate', () => {
  if (!$('news').hidden) $('news').hidden = true;
  else if (!$('person').hidden) $('person').hidden = true;
  else if (!$('settings').hidden) closeSettings();
  else if (!$('chat').hidden) $('chat').hidden = true;
  history.pushState(null, '', location.href);
});
history.pushState(null, '', location.href);

window.addEventListener('beforeunload', () => {
  room?.leave();
  void callStop();
});

// ---------- configurações ----------
// Fora da sala as preferências de voz são lidas e gravadas direto (o Voice as lê ao entrar);
// dentro da sala passam pelo Voice, que aplica na hora.
function vprefs(): VoicePrefs {
  return voice?.prefs ?? loadVoicePrefs();
}
function vstore(patch: Partial<VoicePrefs>): void {
  localStorage.setItem('ariranhacast.voice', JSON.stringify({ ...loadVoicePrefs(), ...patch }));
}
let gateTimer = 0;
function openSettings(): void {
  const p = vprefs();
  $<HTMLSelectElement>('s-ns').value = p.mode === 'off' ? 'off' : 'standard';
  $<HTMLSelectElement>('s-gate').value = p.gate;
  $<HTMLInputElement>('s-gate-db').value = String(p.gateDb);
  $<HTMLInputElement>('s-vol').value = String(p.volume);
  $<HTMLInputElement>('s-sounds').checked = p.sounds;
  $<HTMLSelectElement>('s-quality').value = store.quality;
  $<HTMLInputElement>('s-svol').value = String(store.streamVolume);
  $<HTMLInputElement>('s-bg').checked = store.bgVideo;
  $<HTMLInputElement>('s-smooth').checked = store.smooth;
  void deviceStatus().then((d) => ($('s-about').textContent = `AriranhaCast ${VERSION}${d.model ? ` · ${d.model}` : ''}${d.sdk ? ` · Android API ${d.sdk}` : ''}`));
  syncSettings();
  $('settings').hidden = false;
  clearInterval(gateTimer);
  gateTimer = window.setInterval(drawGate, 60);
}
function closeSettings(): void {
  clearInterval(gateTimer);
  $('settings').hidden = true;
}
function syncSettings(): void {
  const p = vprefs();
  $('s-gate-box').hidden = p.gate === 'off';
  $('s-gate-db').hidden = p.gate !== 'manual';
  $('s-vol-txt').textContent = `${Math.round(p.volume * 100)}%`;
  $('s-svol-txt').textContent = `${Math.round(store.streamVolume * 100)}%`;
}
const pct = (db: number): number => Math.max(0, Math.min(100, ((db - GATE_MIN_DB) / (GATE_MAX_DB - GATE_MIN_DB)) * 100));
function drawGate(): void {
  if ($('s-gate-box').hidden) return;
  const live = !!voice && voice.micOn;
  const thr = live ? voice!.gateThreshold() : vprefs().gateDb;
  $('s-gate-mark').style.left = `${pct(thr)}%`;
  $('s-gate-mark').hidden = !live && vprefs().gate !== 'manual';
  $('s-gate-fill').style.width = live ? `${pct(voice!.selfDb())}%` : '0%';
  $('s-gate-fill').classList.toggle('open', live && voice!.gateIsOpen);
  $('s-gate-note').textContent = live
    ? 'Barra = seu microfone agora; risco = limiar. Verde: a sala ouve. Cinza: abaixo do limiar, não é enviado.'
    : 'Dentro de uma sala, com o microfone ligado, a barra mostra o nível ao vivo.';
}
$('btn-gear-home').innerHTML = svg(ICON.gear);
$('btn-gear-room').innerHTML = svg(ICON.gear);
$('btn-gear-home').onclick = openSettings;
$('btn-gear-room').onclick = openSettings;
$('btn-settings-close').onclick = closeSettings;
$<HTMLSelectElement>('s-ns').onchange = () => {
  const mode = $<HTMLSelectElement>('s-ns').value as NsMode;
  if (voice) void voice.setMode(mode);
  else vstore({ mode });
};
$<HTMLSelectElement>('s-gate').onchange = () => {
  const gate = $<HTMLSelectElement>('s-gate').value as GateMode;
  if (voice) voice.setGateMode(gate);
  else vstore({ gate });
  syncSettings();
};
$<HTMLInputElement>('s-gate-db').oninput = () => {
  const db = Number($<HTMLInputElement>('s-gate-db').value);
  if (voice) voice.setGateDb(db);
  else vstore({ gateDb: db });
};
$<HTMLInputElement>('s-vol').oninput = () => {
  const v = Number($<HTMLInputElement>('s-vol').value);
  if (voice) voice.setMasterVolume(v);
  else vstore({ volume: v });
  syncSettings();
};
$<HTMLInputElement>('s-sounds').onchange = () => {
  const on = $<HTMLInputElement>('s-sounds').checked;
  if (voice) voice.setSounds(on);
  else vstore({ sounds: on });
};
$<HTMLSelectElement>('s-quality').onchange = () => {
  store.quality = $<HTMLSelectElement>('s-quality').value as Quality;
  $<HTMLSelectElement>('quality').value = store.quality;
  watch?.setQuality(store.quality);
};
$<HTMLInputElement>('s-svol').oninput = () => {
  store.streamVolume = Number($<HTMLInputElement>('s-svol').value);
  $<HTMLVideoElement>('video').volume = store.streamVolume;
  syncSettings();
};
$<HTMLInputElement>('s-bg').onchange = () => (store.bgVideo = $<HTMLInputElement>('s-bg').checked);
$<HTMLInputElement>('s-smooth').onchange = () => {
  store.smooth = $<HTMLInputElement>('s-smooth').checked;
  // O buffer é definido quando o vídeo começa a chegar: reabre a transmissão atual para aplicar.
  if (watch && watchingId) {
    const id = watchingId;
    stopWatch();
    startWatch(id);
  }
};

// Relatório para colar numa conversa quando algo der errado (sem dados pessoais além dos nomes da sala).
$('btn-report').onclick = async () => {
  const d = await deviceStatus();
  const lines = [`AriranhaCast ${VERSION} · ${d.model} · API ${d.sdk} · ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? ''}`];
  if (room && voice) {
    lines.push(`Sala ${room.code} · ${room.roster.length} pessoas · ${room.isHost ? 'hospedando' : 'convidado'}`);
    lines.push(`Microfone: ${voice.micOn ? 'ligado' : 'desligado'}${voice.micError ? ` (${voice.micError})` : ''} · supressão ${voice.prefs.mode} · sensibilidade ${voice.prefs.gate}`);
    for (const r of voice.rows()) {
      if (r.self) continue;
      lines.push(`- ${r.name}: ${r.connected ? 'conectado' : 'conectando'}${r.link ? ` · ${r.link.rttMs} ms · perda ${r.link.lossPct.toFixed(1)}% · jitter ${r.link.jitterMs.toFixed(0)} ms` : ''}${r.turn ? ' · TURN' : ''}`);
    }
    if (watch) {
      const s = await watch.stats();
      if (s) lines.push(`Assistindo: ${s.width}x${s.height} · ${Math.round(s.fps)} fps · ${s.codec} · ${(s.kbps / 1000).toFixed(1)} Mbps · ${watch.via}${s.turn ? ' · TURN' : ''} · decodificador ${s.decoder || '?'} · ${s.rttMs} ms · buffer ${s.bufferMs} ms · pacotes perdidos ${s.lost} · quadros descartados ${s.dropped}`);
    }
  } else lines.push('Fora de sala.');
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Relatório copiado. Cole na conversa.');
  } catch {
    toast(text, 10000);
  }
};

renderHome();
renderBar();
show('home');
$<HTMLInputElement>('room-limit').value = String(clampLimit(Number(localStorage.getItem('ariranhacast.limit') ?? DEFAULT_LIMIT)));
renderLobby();
void lobby.start();
void checkUpdate();
// Ao voltar para o app (estava em segundo plano), confere de novo, no máximo a cada 6 h.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck > 6 * 3600_000) void checkUpdate();
});
