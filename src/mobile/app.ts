// AriranhaCast no Android: a mesma sala do app de PC (Room, Voice, Watch), com uma tela
// pensada para o celular. O celular fala, ouve, usa o chat e assiste às transmissões;
// não transmite e não repassa vídeo para ninguém (é sempre uma "folha" da árvore).
import { measurePc } from '../renderer/link';
import { Room } from '../renderer/room';
import { loadIce, normalizeCode } from '../renderer/signaling';
import { playSfx, type Sfx } from '../renderer/sounds';
import type { ChatMessage, Quality, RosterEntry, Settings } from '../renderer/types';
import { Voice } from '../renderer/voice';
import { Watch } from '../renderer/watch';
import { callStart, callStop, deviceStatus, native, setSpeaker } from './native';

declare const __VERSION__: string;
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

function settings(): Settings {
  return {
    name: store.name || `Convidado${Math.floor(Math.random() * 900 + 100)}`,
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
  };
}

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
  if (saveHome()) void enter(true);
};
$('btn-cancel').onclick = () => {
  if (!attempt) return;
  attempt.cancelled = true;
  attempt.room?.leave();
  attempt = null;
  show('home');
};

// ---------- entrar / sair ----------
async function enter(create: boolean, code?: string, password = ''): Promise<void> {
  if (room || attempt) return;
  const my = { cancelled: false, room: null as Room | null };
  attempt = my;
  cfg = settings();
  $('connecting-text').textContent = create ? 'Criando a sala…' : `Entrando na sala ${code}…`;
  show('connecting');
  const ice = await loadIce(cfg);
  if (my.cancelled) return;
  if (!ice.ok) toast(`TURN das configurações inválido (${ice.error}); seguindo sem ele.`);
  const r = new Room(cfg, VERSION, password);
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
  rosterIds = null;
  sentState = '';
  unread = 0;
  renderBadge();
  $('chat').hidden = true;
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

function renderPeople(): void {
  if (!room || !voice) return;
  const rows = new Map(voice.rows().map((r) => [r.self ? room!.selfId : r.id, r]));
  const list = $('people');
  list.replaceChildren();
  $('count').textContent = `(${room.roster.length})`;
  for (const p of room.roster) {
    const self = p.id === room.selfId;
    const r = rows.get(p.id);
    const li = el('li');
    li.classList.toggle('speaking', !!r?.speaking);
    const av = el('div', 'avatar', p.name.trim().charAt(0).toUpperCase() || '?');
    av.style.background = color(p.id);
    const who = el('div', 'who', self ? `${p.name} (você)` : p.name);
    const detail = self
      ? voice.micError || ''
      : !r?.connected
        ? 'conectando…'
        : [r.link ? `${r.link.rttMs} ms` : '', r.turn ? 'via TURN' : '', p.id === room.hostId ? 'hospeda a sala' : ''].filter(Boolean).join(' · ');
    if (detail) who.append(el('small', '', detail));
    const icons = el('div', 'icons');
    const muted = self ? !voice.micOn : p.muted;
    const deaf = self ? voice.deafened : p.deaf;
    if (muted) icons.insertAdjacentHTML('beforeend', `<span title="Microfone desligado">${svg(ICON.mic + SLASH)}</span>`);
    if (deaf) icons.insertAdjacentHTML('beforeend', `<span title="Não está ouvindo">${svg(ICON.headset + SLASH)}</span>`);
    li.append(av, who, icons);
    list.append(li);
  }
}

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
  $('viewer').hidden = true;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
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
$('btn-full').onclick = async () => {
  const box = $('viewer');
  if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
  try {
    await box.requestFullscreen();
    await (screen.orientation as any).lock?.('landscape').catch(() => {});
  } catch {
    /* sem tela cheia */
  }
};
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) (screen.orientation as any).unlock?.();
});
let toolsTimer = 0;
$('viewer').onclick = () => {
  if (!document.fullscreenElement) return;
  $('viewer').classList.add('tools');
  clearTimeout(toolsTimer);
  toolsTimer = window.setTimeout(() => $('viewer').classList.remove('tools'), 3000);
};

// Com o app em segundo plano o vídeo não aparece: para de receber (economiza bateria e internet)
// e retoma ao voltar. A voz continua.
document.addEventListener('visibilitychange', () => {
  if (!room) return;
  if (document.hidden) {
    if (watch) stopWatch();
  } else if (wantWatch && !watch) {
    startWatch(wantWatch);
  }
});

async function poll(): Promise<void> {
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
  if (!$('chat').hidden) $('chat').hidden = true;
  history.pushState(null, '', location.href);
});
history.pushState(null, '', location.href);

window.addEventListener('beforeunload', () => {
  room?.leave();
  void callStop();
});

renderHome();
renderBar();
show('home');
