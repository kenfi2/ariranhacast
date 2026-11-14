import { Broadcast } from './broadcast';
import { Cams } from './cams';
import { availableCodecs } from './codecs';
import { PROTO, Room } from './room';
import { checkNetwork } from './netcheck';
import { hasTurn, loadIce, normalizeCode } from './signaling';
import type { CodecChoice, EncodeOpts, RosterEntry, Settings, SourceInfo, UpdaterState } from './types';
import { Voice, type NsMode } from './voice';
import { mountVoicePanel } from './voicePanel';
import { formatBytes, TurnMeter } from './turnmeter';
import { Watch } from './watch';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const testing = params.has('auto');
const log = (...a: unknown[]) => console.log('[LC]', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// ---------- ícones da barra de controles ----------
const svg = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const SLASH = '<path d="M4 4l16 16"/>';
const ICON = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"/>',
  headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4.5" height="7" rx="1.6"/><rect x="16.5" y="13" width="4.5" height="7" rx="1.6"/>',
  cam: '<rect x="2.5" y="6" width="12.5" height="12" rx="2.5"/><path d="M15 10.5l6.5-3.5v10L15 13.5z"/>',
  screen: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>',
  hangup: '<path d="M3.5 14.2c4.8-4.6 12.2-4.6 17 0l-2.3 2.4-3.2-1.5v-2.6c-1.9-.6-4.1-.6-6 0v2.6l-3.2 1.5z"/>',
};

// ---------- configurações ----------
function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem('ariranhacast.settings') ?? '{}');
  } catch {
    /* usa padrão */
  }
  return {
    name: params.get('name') ?? saved.name ?? `Convidado${Math.floor(Math.random() * 900 + 100)}`,
    server: params.get('server') ?? saved.server ?? '',
    iceServers: params.get('ice') ?? saved.iceServers ?? '',
    hotMic: typeof saved.hotMic === 'string' ? saved.hotMic : 'Ctrl+Shift+M',
    hotDeaf: typeof saved.hotDeaf === 'string' ? saved.hotDeaf : 'Ctrl+Shift+D',
  };
}
let settings = loadSettings();
let appVersion = '';
void window.ariranhacast.appVersion().then((v) => {
  appVersion = v;
  $('app-version').textContent = `versão ${v}`;
});
window.ariranhacast.onUpdate((text) => toast(text));

// ---- atualização automática: verificando, baixando, pronta (com botão de reiniciar) ----
let updHideTimer = 0;
let updArmed = false;
let lastUpd: UpdaterState = { state: 'disabled', reason: 'dev' };
const UPD_OFF: Record<string, string> = {
  portatil: 'Atualização automática indisponível: a versão portátil não se atualiza sozinha. Instale pelo instalador.',
  'sem-url': 'Atualização automática desligada nesta versão.',
  dev: 'Atualização automática indisponível em modo de desenvolvimento.',
};

function renderUpdater(s: UpdaterState): void {
  lastUpd = s;
  clearTimeout(updHideTimer);
  updArmed = false;
  const box = $('upd');
  const btn = $<HTMLButtonElement>('upd-btn');
  const bar = $('upd-bar');
  const text = $('upd-text');
  box.dataset.state = s.state;
  box.hidden = s.state === 'disabled';
  $('upd-spin').hidden = !(s.state === 'checking' || s.state === 'available' || s.state === 'downloading');
  bar.hidden = s.state !== 'downloading';
  btn.hidden = !(s.state === 'ready' || s.state === 'error');
  btn.disabled = false;
  switch (s.state) {
    case 'checking':
      text.textContent = 'Verificando atualizações…';
      break;
    case 'uptodate':
      text.textContent = 'Você está na versão mais recente ✓';
      updHideTimer = window.setTimeout(() => (box.hidden = true), 5000);
      break;
    case 'available':
      text.textContent = `Versão ${s.version} encontrada. Começando o download…`;
      break;
    case 'downloading':
      text.textContent = `Baixando a versão ${s.version}… ${s.percent}%`;
      ($('upd-bar').firstElementChild as HTMLElement).style.width = `${s.percent}%`;
      break;
    case 'ready':
      text.textContent = `Versão ${s.version} pronta para instalar.`;
      btn.textContent = 'Reiniciar e atualizar';
      break;
    case 'error':
      text.textContent = `Não consegui atualizar: ${s.message}`;
      btn.textContent = 'Tentar de novo';
      break;
  }
  const set = $('upd-set-text');
  const check = $<HTMLButtonElement>('btn-upd-check');
  check.hidden = s.state === 'disabled';
  check.disabled = s.state === 'checking' || s.state === 'downloading' || s.state === 'ready';
  set.textContent = s.state === 'disabled' ? (UPD_OFF[s.reason] ?? '') : `Versão instalada: ${$('app-version').textContent?.replace('versão ', '') ?? ''}`;
}

$('upd-btn').onclick = () => {
  const btn = $<HTMLButtonElement>('upd-btn');
  if (lastUpd.state === 'error') return void window.ariranhacast.updaterCheck();
  if (lastUpd.state !== 'ready') return;
  if (room && !updArmed) {
    // Reiniciar derruba a sala: pede uma segunda confirmação em vez de sair sem avisar.
    updArmed = true;
    btn.textContent = 'Você está numa sala. Clique de novo para sair e reiniciar';
    setTimeout(() => {
      if (updArmed && lastUpd.state === 'ready') {
        updArmed = false;
        btn.textContent = 'Reiniciar e atualizar';
      }
    }, 6000);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Reiniciando…';
  void window.ariranhacast.updaterInstall();
};
$('btn-upd-check').onclick = () => void window.ariranhacast.updaterCheck();
window.ariranhacast.onUpdater((s) => {
  renderUpdater(s);
  if (s.state === 'ready') toast(`Versão ${s.version} baixada. Clique em "Reiniciar e atualizar" quando quiser.`);
});
void window.ariranhacast.updaterState().then(renderUpdater);

$('btn-settings').onclick = () => {
  $<HTMLInputElement>('set-name').value = settings.name;
  $<HTMLInputElement>('set-server').value = settings.server;
  $<HTMLTextAreaElement>('set-ice').value = settings.iceServers;
  $<HTMLInputElement>('set-hot-mic').value = settings.hotMic;
  $<HTMLInputElement>('set-hot-deaf').value = settings.hotDeaf;
  void refreshFirewall();
  $<HTMLDialogElement>('dlg-settings').showModal();
};

const FW_TEXT: Record<string, string> = {
  ok: '✓ Firewall do Windows: liberado para o AriranhaCast.',
  missing: '⚠ Firewall do Windows: o app ainda não foi liberado. Isso pode barrar a conexão dos amigos.',
  blocked: '⚠ Firewall do Windows: este programa está bloqueado.',
};
async function refreshFirewall(): Promise<void> {
  const st = await window.ariranhacast.firewallStatus().catch(() => 'unknown' as const);
  const row = $('fw-row');
  row.hidden = !FW_TEXT[st];
  if (row.hidden) return;
  $('fw-text').textContent = FW_TEXT[st];
  $<HTMLButtonElement>('btn-fw').hidden = st === 'ok';
}
$('btn-fw').onclick = async () => {
  const btn = $<HTMLButtonElement>('btn-fw');
  btn.disabled = true;
  btn.textContent = 'Aguardando permissão…';
  const st = await window.ariranhacast.firewallFix().catch(() => 'unknown' as const);
  btn.disabled = false;
  btn.textContent = 'Liberar no Firewall';
  await refreshFirewall();
  toast(st === 'ok' ? 'Firewall liberado.' : 'Não foi possível liberar (a permissão foi negada?).');
};
$<HTMLDialogElement>('dlg-settings').addEventListener('close', () => {
  const ice = $<HTMLTextAreaElement>('set-ice').value.trim();
  if (ice && !/^https:\/\//i.test(ice)) {
    try {
      JSON.parse(ice);
    } catch {
      return toast('O campo de TURN precisa ser um JSON válido ou uma URL https://; nada foi salvo.');
    }
  }
  settings = {
    name: $<HTMLInputElement>('set-name').value.trim() || settings.name,
    server: $<HTMLInputElement>('set-server').value.trim(),
    iceServers: ice,
    hotMic: $<HTMLInputElement>('set-hot-mic').value,
    hotDeaf: $<HTMLInputElement>('set-hot-deaf').value,
  };
  localStorage.setItem('ariranhacast.settings', JSON.stringify(settings));
  if (room) void applyHotkeys();
});

// Campos de atalho: clique e pressione a combinação. Backspace limpa.
for (const id of ['set-hot-mic', 'set-hot-deaf']) {
  const input = $<HTMLInputElement>(id);
  input.onkeydown = (e) => {
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') return void (input.value = '');
    if (['Control', 'Shift', 'Alt', 'Meta', 'Tab', 'Escape'].includes(e.key)) return;
    const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.code) ? e.code : '';
    if (!key) return;
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    if (!mods.length && !key.startsWith('F')) return; // exige Ctrl/Alt/Shift, exceto teclas de função
    input.value = [...mods, key].join('+');
  };
}

async function applyHotkeys(): Promise<void> {
  const r = await window.ariranhacast.setHotkeys({ mic: settings.hotMic, deaf: settings.hotDeaf });
  const failed = [settings.hotMic && !r.mic && settings.hotMic, settings.hotDeaf && !r.deaf && settings.hotDeaf].filter(Boolean);
  if (failed.length) toast(`Atalho indisponível (já usado por outro programa): ${failed.join(', ')}`);
}

/** Bipe curto ao mudar o microfone/as vozes por atalho, para confirmar sem olhar a janela. */
function cue(on: boolean): void {
  try {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.frequency.value = on ? 880 : 440;
    gain.gain.setValueAtTime(0.08, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.15);
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.16);
    osc.onended = () => void ac.close();
  } catch {
    /* sem áudio */
  }
}

window.ariranhacast.onHotkey(async (which) => {
  if (!room || !voice) return;
  if (which === 'leave') return leaveRoom();
  if (which === 'mic') {
    await voice.setMic(!voice.micOn);
    cue(voice.micOn);
  } else {
    voice.setDeafened(!voice.deafened);
    cue(!voice.deafened);
  }
  updateControls();
});

$('btn-netcheck').onclick = async () => {
  const out = $('netcheck-out');
  const btn = $<HTMLButtonElement>('btn-netcheck');
  btn.disabled = true;
  out.hidden = false;
  out.textContent = 'Testando… (alguns segundos)';
  const draft: Settings = { ...settings, iceServers: $<HTMLTextAreaElement>('set-ice').value.trim() };
  // Dentro de uma sala, testa com o TURN em uso (recarregar descartaria o que a sala repassou).
  const ice = room ? { ok: true as const, error: '' } : await loadIce(draft);
  const result = await checkNetwork();
  out.textContent = (ice.ok ? '' : `✗ TURN: não foi possível ler a configuração (${ice.error}).\n`) + result;
  btn.disabled = false;
  if (testing || params.has('netcheck')) log('netcheck', out.textContent.replace(/\n/g, ' | '));
};

function show(view: 'home' | 'room'): void {
  $('view-home').hidden = view !== 'home';
  $('view-room').hidden = view !== 'room';
}

let toastTimer = 0;
function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 6000);
}

// ---------- estado da sala ----------
interface Watching {
  watch: Watch;
  stream?: MediaStream;
  status: string;
  volume: number;
  statsOn: boolean;
  statsText: string;
}

let room: Room | null = null;
let voice: Voice | null = null;
let cams: Cams | null = null;
let broadcast: Broadcast | null = null;
let unmountVoice: () => void = () => {};
const watches = new Map<string, Watching>();
/** Transmissões que o usuário escolheu assistir: retomadas sozinhas se a conexão cair. */
const wantWatch = new Map<string, number>(); // id → última tentativa
const turnMeter = new TurnMeter();
let focusKey = '';
let pollTimer = 0;
let busy = false;

// Tentativa de entrar/criar em andamento: mostra o progresso e permite cancelar.
interface Attempt {
  create: boolean;
  room: Room | null;
  cancelled: boolean;
}
let attempt: Attempt | null = null;
let attemptTimer = 0;

function connectingText(create: boolean, secs: number): string {
  if (create) return secs < 6 ? 'Abrindo a sala…' : `Ainda abrindo a sala… (${secs} s)`;
  if (secs < 3) return 'Procurando a sala…';
  if (secs < 8) return `Conectando com quem hospeda… (${secs} s)`;
  return `Ainda tentando; redes restritas podem levar até 15 s… (${secs} s)`;
}

function setConnecting(on: boolean, create = false): void {
  const bc = $<HTMLButtonElement>('btn-create');
  const bj = $<HTMLButtonElement>('btn-join');
  bc.disabled = bj.disabled = on;
  for (const id of ['create-pass', 'join-code', 'join-pass']) $<HTMLInputElement>(id).disabled = on;
  bc.textContent = on && create ? 'Criando…' : 'Criar sala';
  bj.textContent = on && !create ? 'Conectando…' : 'Entrar';
  bc.classList.toggle('busy', on && create);
  bj.classList.toggle('busy', on && !create);
  $('home-status').hidden = !on;
  clearInterval(attemptTimer);
  if (on) {
    const t0 = Date.now();
    const update = () => ($('home-status-text').textContent = connectingText(create, Math.floor((Date.now() - t0) / 1000)));
    update();
    attemptTimer = window.setInterval(update, 500);
  }
}

function endAttempt(a: Attempt): void {
  if (attempt !== a) return; // uma tentativa mais nova já assumiu a tela
  attempt = null;
  busy = false;
  setConnecting(false);
}

$('btn-cancel').onclick = () => {
  const a = attempt;
  if (!a) return;
  a.cancelled = true;
  a.room?.leave();
  endAttempt(a);
  toast('Conexão cancelada.');
};

async function enterRoom(create: boolean, code?: string, password = ''): Promise<void> {
  if (room || busy) return;
  busy = true;
  const my: Attempt = { create, room: null, cancelled: false };
  attempt = my;
  setConnecting(true, create);
  const ice = await loadIce(settings);
  if (my.cancelled) return;
  if (!ice.ok) toast(`Não foi possível carregar o servidor TURN das Configurações (${ice.error}). Seguindo sem ele.`);
  const r = new Room(settings, appVersion || '0', password);
  my.room = r;
  try {
    if (create) await r.create(code);
    else await r.join(code!);
  } catch (e: any) {
    endAttempt(my);
    if (!my.cancelled) toast(e?.message ?? String(e));
    log('room fail', String(e?.message ?? e));
    return;
  }
  if (my.cancelled) {
    r.leave(); // deu certo, mas a pessoa já tinha cancelado
    return;
  }
  endAttempt(my);
  room = r;
  const inRoomNow = (id: string) => r.isMember(id);
  voice = new Voice(r.peer, settings.name, inRoomNow);
  cams = new Cams(r.peer, inRoomNow);
  cams.onchange = () => {
    renderTiles();
    updateControls();
  };
  unmountVoice = mountVoicePanel($('voice-box'), voice, () => {
    updateSpeaking();
    updateControls();
  });
  r.onroster = onRoster;
  r.onend = (reason) => leaveRoom(reason);
  r.onstatus = (text) => {
    $('room-status').textContent = text;
    $('room-status').hidden = !text;
    if (testing && text) log('room status', text);
  };
  r.oncommand = () => {
    if (voice?.micOn) {
      void voice.setMic(false).then(updateControls);
      toast('Quem hospeda a sala desligou o seu microfone.');
    }
  };
  r.onwatch = (conn) => (broadcast ? broadcast.accept(conn, r.nameOf(conn.peer)) : conn.close());
  r.onrelay = (conn, pub) => {
    const w = watches.get(pub);
    if (w) void w.watch.serveChild(conn);
    else conn.close();
  };
  $('room-code').textContent = r.code;
  show('room');
  onRoster(r.roster);
  $('room-status').hidden = true;
  updateControls();
  void applyHotkeys();
  pollTimer = window.setInterval(() => void poll(), 1000);
  log('room ready', r.code, r.isHost ? 'host' : 'member');
}

function leaveRoom(reason?: string): void {
  if (!room) return;
  clearInterval(pollTimer);
  stopShare();
  wantWatch.clear();
  for (const id of [...watches.keys()]) stopWatch(id);
  void window.ariranhacast.setHotkeys(null);
  turnMeter.flush();
  unmountVoice();
  unmountVoice = () => {};
  voice?.close();
  cams?.close();
  room.leave();
  room = null;
  voice = null;
  cams = null;
  focusKey = '';
  $('stage').replaceChildren();
  tiles.clear();
  if (document.fullscreenElement) void document.exitFullscreen();
  show('home');
  updateControls();
  if (reason) toast(reason);
  log('room left', reason ?? '');
}

function onRoster(list: RosterEntry[]): void {
  if (!room) return;
  voice?.setRoster(list);
  cams?.setRoster(list);
  for (const id of [...watches.keys()]) {
    if (!list.find((p) => p.id === id)?.screen) stopWatch(id);
  }
  for (const id of [...wantWatch.keys()]) {
    if (!list.some((p) => p.id === id)) wantWatch.delete(id); // quem transmitia saiu da sala
  }
  renderTiles();
  if (testing && params.get('auto') === 'join') {
    for (const p of list) if (p.screen && p.id !== room.selfId && !watches.has(p.id) && !wantWatch.has(p.id)) startWatch(p.id);
  }
}

$('btn-create').onclick = () => void enterRoom(true, undefined, $<HTMLInputElement>('create-pass').value);
$<HTMLFormElement>('join-form').onsubmit = (e) => {
  e.preventDefault();
  const code = normalizeCode($<HTMLInputElement>('join-code').value);
  if (code.length < 4) return toast('Digite o código da sala.');
  void enterRoom(false, code, $<HTMLInputElement>('join-pass').value);
};
$('btn-leave').onclick = () => leaveRoom();
$('btn-copy').onclick = async () => {
  await navigator.clipboard.writeText(room?.code ?? '');
  toast('Código copiado.');
};
$('btn-panel').onclick = () => ($('room-side').hidden = !$('room-side').hidden);

// ---------- barra de controles ----------
function updateControls(): void {
  const mic = $('btn-mic');
  const micOn = !!voice?.micOn;
  mic.innerHTML = svg(ICON.mic + (micOn ? '' : SLASH));
  mic.classList.toggle('muted', !micOn);
  mic.title = micOn ? 'Desligar microfone' : 'Ligar microfone';

  const deaf = $('btn-deaf');
  const deafened = !!voice?.deafened;
  deaf.innerHTML = svg(ICON.headset + (deafened ? SLASH : ''));
  deaf.classList.toggle('muted', deafened);
  deaf.title = deafened ? 'Voltar a ouvir as vozes' : 'Silenciar as vozes';

  const cam = $('btn-cam');
  const camOn = !!cams?.local;
  cam.innerHTML = svg(ICON.cam + (camOn ? '' : SLASH));
  cam.classList.toggle('active', camOn);
  cam.title = camOn ? 'Desligar câmera' : 'Ligar câmera';

  const screen = $('btn-screen');
  screen.innerHTML = svg(ICON.screen);
  screen.classList.toggle('active', !!broadcast);
  screen.title = broadcast ? 'Parar de transmitir' : 'Transmitir tela';

  $('btn-leave').innerHTML = svg(ICON.hangup);
  void window.ariranhacast.setInRoom(!!room, micOn);
}

$('btn-mic').onclick = async () => {
  if (!voice) return;
  await voice.setMic(!voice.micOn);
  if (voice.micError) toast(voice.micError);
  updateControls();
};
$('btn-deaf').onclick = () => {
  voice?.setDeafened(!voice.deafened);
  updateControls();
};
$('btn-cam').onclick = async () => {
  if (!cams || !room) return;
  await cams.setCam(!cams.local);
  if (cams.error) toast(cams.error);
  room.setState({ cam: !!cams.local });
  updateControls();
};
$('btn-screen').onclick = () => {
  if (broadcast) stopShare();
  else openShare(false);
};

// ---------- grade de participantes ----------
interface Tile {
  root: HTMLDivElement;
  video: HTMLVideoElement;
  body: HTMLDivElement; // avatar ou texto central
  tag: HTMLDivElement;
  tools: HTMLDivElement;
  stats: HTMLPreElement;
  mode: string;
}
const tiles = new Map<string, Tile>();

function color(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 42%)`;
}

function makeTile(key: string, kind: 'user' | 'screen'): Tile {
  const root = el('div', `tile ${kind}`);
  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  video.hidden = true;
  const body = el('div', 'center');
  const tag = el('div', 'tag');
  const tools = el('div', 'tools');
  const stats = el('pre', 'stats');
  stats.hidden = true;
  root.append(video, body, tag, stats, tools);
  tools.onclick = (e) => e.stopPropagation();
  root.onclick = () => {
    focusKey = focusKey === key ? '' : key;
    applyFocus();
  };
  root.ondblclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.requestFullscreen();
  };
  $('stage').append(root);
  const tile: Tile = { root, video, body, tag, tools, stats, mode: '' };
  tiles.set(key, tile);
  return tile;
}

function setVideo(tile: Tile, stream: MediaStream | undefined, muted: boolean): void {
  if (tile.video.srcObject !== (stream ?? null)) {
    tile.video.srcObject = stream ?? null;
    if (stream) void tile.video.play().catch(() => {});
  }
  tile.video.muted = muted;
  tile.video.hidden = !stream;
}

function toolButton(text: string, onclick: () => void): HTMLButtonElement {
  const b = el('button', '', text);
  b.onclick = onclick;
  return b;
}

function renderTiles(): void {
  if (!room) return;
  const me = room.selfId;
  const wanted = new Set<string>();

  for (const p of room.roster) {
    // --- participante (avatar ou webcam) ---
    const ukey = `user:${p.id}`;
    wanted.add(ukey);
    const ut = tiles.get(ukey) ?? makeTile(ukey, 'user');
    const camStream = p.id === me ? cams?.local : p.cam ? cams?.remote.get(p.id) : undefined;
    setVideo(ut, camStream, true);
    const userMode = `avatar:${room.isHost && p.id !== me}`;
    if (ut.mode !== userMode) {
      ut.mode = userMode;
      const avatar = el('div', 'avatar', p.name.trim().charAt(0).toUpperCase() || '?');
      avatar.style.background = color(p.id);
      ut.body.replaceChildren(avatar);
      ut.tools.replaceChildren();
      if (room.isHost && p.id !== me) {
        ut.tools.append(
          toolButton('Silenciar', () => room?.muteMember(p.id)),
          toolButton('Remover', () => room?.kick(p.id)),
        );
      }
    }
    ut.body.hidden = !!camStream;
    ut.tag.textContent = (p.id === me ? `${p.name} (você)` : p.name) + (p.id === room.hostId ? ' · hospeda a sala' : '');

    // --- transmissão de tela ---
    if (!p.screen) continue;
    const skey = `screen:${p.id}`;
    wanted.add(skey);
    const st = tiles.get(skey) ?? makeTile(skey, 'screen');
    st.tag.textContent = p.id === me ? `Sua transmissão · ${p.title}` : `${p.name} · ${p.title}`;
    const w = watches.get(p.id);
    const mode = p.id === me ? 'mine' : w ? 'watching' : 'idle';
    if (st.mode !== mode) {
      st.mode = mode;
      st.tools.replaceChildren();
      st.stats.hidden = true;
      if (mode === 'idle') {
        const btn = el('button', 'primary', 'Assistir');
        btn.onclick = (e) => {
          e.stopPropagation();
          startWatch(p.id);
        };
        st.body.replaceChildren(el('span', 'badge', 'AO VIVO'), el('strong', '', `${p.name} está transmitindo`), btn);
      } else if (mode === 'mine') {
        st.body.replaceChildren();
        st.tools.append(toolButton('Parar', stopShare));
      } else {
        st.body.replaceChildren(el('span', 'status'));
        const vol = el('input');
        vol.type = 'range';
        vol.min = '0';
        vol.max = '1';
        vol.step = '0.01';
        vol.value = String(w!.volume);
        vol.title = 'Volume da transmissão';
        vol.oninput = () => {
          w!.volume = Number(vol.value);
          st.video.volume = w!.volume;
        };
        st.tools.append(
          vol,
          toolButton('Estatísticas', () => {
            w!.statsOn = !w!.statsOn;
            st.stats.hidden = !w!.statsOn;
          }),
          toolButton('Grade', () => {
            focusKey = '';
            applyFocus();
          }),
          toolButton('Tela cheia', () => void st.root.requestFullscreen()),
          toolButton('Parar de assistir', () => quitWatch(p.id)),
        );
      }
    }
    if (mode === 'mine') {
      setVideo(st, localScreen ?? undefined, true);
      st.body.hidden = true;
    } else if (mode === 'watching') {
      setVideo(st, w!.stream, false);
      st.video.volume = w!.volume;
      const sink = voice?.prefs.streamSinkId ?? '';
      if (st.root.dataset.sink !== sink) {
        st.root.dataset.sink = sink;
        void (st.video as any).setSinkId?.(sink).catch(() => {});
      }
      const status = st.body.querySelector('.status');
      if (status) status.textContent = w!.status;
      st.body.hidden = !!w!.stream && !w!.status;
      st.stats.textContent = w!.statsText;
    } else {
      setVideo(st, undefined, true);
      st.body.hidden = false;
    }
  }

  for (const [key, tile] of [...tiles]) {
    if (wanted.has(key)) continue;
    tile.video.srcObject = null;
    tile.root.remove();
    tiles.delete(key);
    if (focusKey === key) focusKey = '';
  }
  applyFocus();
  updateSpeaking();
}

function applyFocus(): void {
  if (focusKey && !tiles.has(focusKey)) focusKey = '';
  $('stage').classList.toggle('focused', !!focusKey);
  for (const [key, tile] of tiles) tile.root.classList.toggle('focus', key === focusKey);
}

function updateSpeaking(): void {
  if (!room || !voice) return;
  const speaking = voice.speakingIds();
  for (const p of room.roster) {
    const on = speaking.has(p.id === room.selfId ? 'self' : p.id);
    tiles.get(`user:${p.id}`)?.root.classList.toggle('speaking', on);
  }
}

document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fullscreen', !!document.fullscreenElement));

// ---------- assistir ----------
function startWatch(id: string): void {
  if (!room || watches.has(id)) return;
  const r = room;
  wantWatch.set(id, Date.now());
  const watch = new Watch(room.peer, settings, id, (peerId) => r.isMember(peerId));
  const w: Watching = { watch, status: '', volume: 1, statsOn: false, statsText: '' };
  watches.set(id, w);
  watch.onstatus = (t) => {
    w.status = t;
    renderTiles();
    if (testing && t) log('watch status', t);
  };
  watch.onstream = (stream) => {
    w.stream = stream;
    renderTiles();
  };
  watch.onend = (reason) => {
    if (watches.get(id) === w) {
      watches.delete(id);
      renderTiles();
      if (testing) log('watch end', reason);
      // Se quem transmite continua na sala transmitindo, o poll() retoma sozinho.
      if (!room?.roster.find((p) => p.id === id)?.screen) toast(reason);
    }
  };
  if (!focusKey) focusKey = `screen:${id}`;
  renderTiles();
  watch.start();
}

/** Chamado pelo usuário: deixa de assistir e não retoma sozinho. */
function quitWatch(id: string): void {
  wantWatch.delete(id);
  stopWatch(id);
}

function stopWatch(id: string): void {
  const w = watches.get(id);
  if (!w) return;
  watches.delete(id);
  w.watch.close();
  renderTiles();
}

// ---------- transmitir a tela ----------
let selected: SourceInfo | null = null;
let switching = false;
let localScreen: MediaStream | null = null;

async function refreshSources(): Promise<void> {
  const sources = await window.ariranhacast.getSources();
  for (const kind of ['screen', 'window'] as const) {
    const grid = $(kind === 'screen' ? 'grid-screens' : 'grid-windows');
    grid.replaceChildren();
    for (const s of sources.filter((x) => x.kind === kind)) {
      const btn = el('button', 'source' + (selected?.id === s.id ? ' selected' : ''));
      const img = document.createElement(s.thumbnail ? 'img' : 'div');
      if (s.thumbnail) (img as HTMLImageElement).src = s.thumbnail;
      else img.className = 'noimg';
      btn.append(img, el('span', '', s.name));
      btn.onclick = () => {
        selected = s;
        document.querySelectorAll('.source.selected').forEach((e) => e.classList.remove('selected'));
        btn.classList.add('selected');
        $<HTMLButtonElement>('btn-start').disabled = false;
      };
      grid.append(btn);
    }
  }
  if (selected && !sources.some((s) => s.id === selected!.id)) selected = null;
  $<HTMLButtonElement>('btn-start').disabled = !selected;
}

function openShare(isSwitch: boolean): void {
  switching = isSwitch;
  $('btn-start').textContent = isSwitch ? 'Trocar fonte' : 'Transmitir';
  const codecSel = $<HTMLSelectElement>('opt-codec');
  if (!codecSel.options.length) {
    const labels: Record<string, string> = { auto: 'Automático', H265: 'H.265 (HEVC)', H264: 'H.264' };
    for (const c of availableCodecs()) codecSel.add(new Option(labels[c] ?? c, c));
  }
  $<HTMLDialogElement>('dlg-share').showModal();
  void refreshSources();
}

$('btn-refresh').onclick = () => void refreshSources();
$('btn-share-cancel').onclick = () => $<HTMLDialogElement>('dlg-share').close();
$('btn-switch').onclick = () => openShare(true);

function autoBitrateKbps(height: number, fps: number): number {
  const h = height || 1440;
  const base = h <= 720 ? 2500 : h <= 1080 ? 4500 : 8000;
  return fps > 30 ? Math.round(base * 1.7) : base;
}

type AudioMode = 'auto' | 'system' | 'none';

function readOpts(): { opts: EncodeOpts; height: number; audio: AudioMode; maxDirect: number } {
  const height = Number($<HTMLSelectElement>('opt-res').value);
  const maxFps = Number($<HTMLSelectElement>('opt-fps').value);
  const chosen = Number($<HTMLSelectElement>('opt-bitrate').value);
  return {
    height,
    audio: $<HTMLSelectElement>('opt-audio').value as AudioMode,
    maxDirect: Number(params.get('maxdirect') ?? $<HTMLSelectElement>('opt-direct').value),
    opts: {
      maxBitrate: (chosen || autoBitrateKbps(height, maxFps)) * 1000,
      maxFps,
      mode: $<HTMLSelectElement>('opt-mode').value as EncodeOpts['mode'],
      codec: $<HTMLSelectElement>('opt-codec').value as CodecChoice,
    },
  };
}

// Áudio por aplicativo: o PCM vem do audiocap.exe (via processo principal) e vira uma
// faixa de áudio WebRTC através de um AudioWorklet.
let pcmCtx: AudioContext | null = null;
let pcmNode: AudioWorkletNode | null = null;

async function pcmTrack(): Promise<MediaStreamTrack> {
  if (!pcmCtx) {
    pcmCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await pcmCtx.audioWorklet.addModule('pcm-worklet.js');
  }
  await pcmCtx.resume();
  pcmNode?.disconnect();
  const node = new AudioWorkletNode(pcmCtx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  const dest = pcmCtx.createMediaStreamDestination();
  dest.channelCount = 2;
  node.connect(dest);
  pcmNode = node;
  window.ariranhacast.onPcm((chunk) => {
    const copy = chunk.slice().buffer;
    node.port.postMessage(copy, [copy]);
  });
  return dest.stream.getAudioTracks()[0];
}

function stopAppAudio(): void {
  pcmNode?.disconnect();
  pcmNode = null;
  void window.ariranhacast.stopAudioCap();
}

async function capture(source: SourceInfo, height: number, fps: number, audio: AudioMode, mode: EncodeOpts['mode']): Promise<{ stream: MediaStream; note: string }> {
  let note = '';
  let appTrack: MediaStreamTrack | null = null;
  let system = audio === 'system';
  if (audio === 'auto') {
    const r = await window.ariranhacast.startAudioCap(source.id);
    if (r.ok) {
      appTrack = await pcmTrack();
    } else {
      system = true;
      note = `Captura de áudio por aplicativo indisponível (${r.reason ?? 'erro'}); usando o áudio do sistema inteiro.`;
    }
  } else {
    stopAppAudio();
  }

  await window.ariranhacast.selectSource(source.id, system);
  const video: MediaTrackConstraints = { frameRate: { ideal: fps, max: fps } };
  if (height) {
    video.height = { max: height };
    video.width = { max: Math.round((height * 21) / 9) };
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video,
      // restrictOwnAudio: no modo "sistema inteiro", tira do áudio o que o próprio AriranhaCast toca.
      audio: system
        ? ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints)
        : false,
    });
  } catch (e) {
    if (appTrack) stopAppAudio();
    throw e;
  }
  if (system) {
    const track = stream.getAudioTracks()[0];
    if (track && (track.getSettings() as any).restrictOwnAudio !== true) {
      note += (note ? ' ' : '') + 'As vozes do chat podem entrar no áudio transmitido (eco). Em "Saída das vozes", escolha um dispositivo diferente do padrão do Windows.';
    }
    if (!track) note += (note ? ' ' : '') + 'O sistema não entregou áudio para esta captura.';
  }
  if (appTrack) stream.addTrack(appTrack);
  applyHints(stream, mode);
  return { stream, note };
}

function applyHints(stream: MediaStream, mode: EncodeOpts['mode']): void {
  for (const t of stream.getVideoTracks()) t.contentHint = mode === 'motion' ? 'motion' : 'detail';
  for (const t of stream.getAudioTracks()) t.contentHint = 'music';
}

/** Vídeo sintético para testar sem captura de tela real. */
function fakeStream(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;
  let n = 0;
  setInterval(() => {
    n++;
    ctx.fillStyle = `hsl(${n % 360} 60% 20%)`;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#fff';
    ctx.font = '64px monospace';
    ctx.fillText(`quadro ${n}`, 60 + ((n * 4) % 700), 360);
  }, 16);
  const stream = canvas.captureStream(60);
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  gain.gain.value = 0.02;
  const dest = ac.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  return stream;
}

$('btn-start').onclick = async () => {
  if (!selected || !room) return;
  const { opts, height, audio, maxDirect } = readOpts();
  const btn = $<HTMLButtonElement>('btn-start');
  btn.disabled = true;
  try {
    const { stream, note } = await capture(selected, height, opts.maxFps, audio, opts.mode);
    if (switching && broadcast && localScreen) {
      const old = localScreen;
      await broadcast.replaceStream(stream, selected.name);
      old.getTracks().forEach((t) => t.stop());
      setLocalScreen(stream, selected.name, note);
    } else {
      await goLive(stream, opts, selected.name, maxDirect, note);
    }
    $<HTMLDialogElement>('dlg-share').close();
  } catch (e: any) {
    toast(`Não foi possível capturar: ${e?.message ?? e}`);
  } finally {
    btn.disabled = !selected;
  }
};

function setLocalScreen(stream: MediaStream, title: string, note: string): void {
  localScreen = stream;
  $('live-title').textContent = title;
  $('stream-note').textContent = note;
  $('stream-note').hidden = !note;
  startMeter(stream);
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (localScreen === stream) {
      stopShare();
      toast('A janela transmitida foi fechada.');
    }
  });
  room?.setState({ screen: true, title });
  renderTiles();
}

async function goLive(stream: MediaStream, opts: EncodeOpts, title: string, maxDirect: number, note = ''): Promise<void> {
  if (!room) return;
  const b = new Broadcast(settings, stream, opts, title, maxDirect);
  b.onchange = renderViewers;
  b.onerror = (m) => {
    if (!hasTurn()) toast(m);
    log('broadcast error', m);
  };
  await b.start();
  broadcast = b;
  $('mystream').hidden = false;
  void window.ariranhacast.setStreaming(true);
  setLocalScreen(stream, title, note);
  updateControls();
  renderViewers();
  log('live', title);
}

function stopShare(): void {
  if (!broadcast) return;
  broadcast.stop();
  broadcast = null;
  localScreen?.getTracks().forEach((t) => t.stop());
  localScreen = null;
  stopAppAudio();
  stopMeter();
  $('mystream').hidden = true;
  void window.ariranhacast.setStreaming(false);
  room?.setState({ screen: false, title: '' });
  renderTiles();
  updateControls();
}

function renderViewers(): void {
  if (!broadcast) return;
  const rows = broadcast.rows();
  $('viewer-count').textContent = String(rows.length);
  $('viewer-list').replaceChildren(
    ...rows.map((r) => {
      const li = el('li');
      const name = el('div', 'name');
      name.append(el('span', 'dot' + (r.receiving ? ' on' : '')), document.createTextNode(`${r.name} · ${r.via}`));
      li.append(name);
      const s = r.stats;
      if (s) {
        const limit = s.limited !== 'none' ? ` · limitado: ${s.limited}` : '';
        li.append(el('div', 'detail', `${s.width}x${s.height}@${s.fps} · ${(s.kbps / 1000).toFixed(1)} Mbps · ${s.codec} ${s.hardware ? 'GPU' : 'CPU'} · ${s.rttMs} ms · ${s.turn ? 'TURN' : 'direto'}${limit}`));
      }
      return li;
    }),
  );
  if (testing) log('broadcast rows', rows.map((r) => `${r.name}:${r.via}:${r.receiving}:${r.stats?.codec ?? ''}:${r.stats?.kbps ?? 0}kbps`));
}

// Medidor de nível: confirma que o áudio está sendo capturado sem tocá-lo de volta.
let meterCtx: AudioContext | null = null;
let meterTimer = 0;

function stopMeter(): void {
  clearInterval(meterTimer);
  void meterCtx?.close();
  meterCtx = null;
  $('audio-level').style.width = '0';
}

function startMeter(stream: MediaStream): void {
  stopMeter();
  const state = $('audio-state');
  const track = stream.getAudioTracks()[0];
  if (!track) {
    state.textContent = 'Sem áudio nesta transmissão.';
    return;
  }
  meterCtx = new AudioContext();
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 1024;
  meterCtx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let lastSound = 0;
  meterTimer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const x of buf) peak = Math.max(peak, Math.abs(x));
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    $('audio-level').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    if (db > -55) lastSound = Date.now();
    state.textContent = Date.now() - lastSound < 1500 ? 'Capturando áudio.' : 'Silêncio — toque algum som para testar.';
  }, 80);
}

// ---------- atualização periódica (estatísticas de quem assistimos) ----------
let pollCount = 0;

/** Rota de cada conexão (direta ou TURN) e quanto do nosso tráfego passou pelo TURN. */
async function sampleRoutes(): Promise<void> {
  // Referências fixadas no início: a sala pode ser deixada enquanto as leituras estão em curso.
  const v = voice;
  const c = cams;
  const b = broadcast;
  if (!v || !c) return;
  const viaTurn = new Set<string>();
  for (const [id, pc] of v.pcs()) if (await turnMeter.sample(pc)) viaTurn.add(id);
  v.turnIds = viaTurn;
  for (const pc of c.pcs()) await turnMeter.sample(pc);
  for (const w of [...watches.values()]) for (const pc of w.watch.pcs()) await turnMeter.sample(pc);
  for (const pc of b?.pcs() ?? []) await turnMeter.sample(pc);
  const usage = $('turn-usage');
  usage.hidden = !hasTurn() && !turnMeter.monthBytes;
  usage.textContent = `TURN: ${formatBytes(turnMeter.sessionBytes)} nesta sessão · ${formatBytes(turnMeter.monthBytes)} no mês (só o tráfego deste PC)`;
  if (pollCount % 10 === 0) turnMeter.flush();
}

async function poll(): Promise<void> {
  pollCount++;
  // Retoma transmissões que o usuário estava assistindo e caíram (rede que piscou, troca de quem hospeda).
  if (room) {
    for (const [id, last] of wantWatch) {
      const p = room.roster.find((x) => x.id === id);
      if (p?.screen && !watches.has(id) && Date.now() - last > 3000) startWatch(id);
    }
  }
  if (pollCount % 2 === 0) await sampleRoutes();
  for (const [id, w] of [...watches]) {
    if (!w.statsOn && !testing) continue;
    const s = await w.watch.stats();
    if (!s) continue;
    w.statsText = [
      `${s.width}x${s.height} @ ${s.fps} fps`,
      `${(s.kbps / 1000).toFixed(2)} Mbps · ${s.codec}`,
      `decoder: ${s.decoder || '—'}`,
      `ping: ${s.rttMs} ms · buffer: ${s.bufferMs} ms`,
      `pacotes perdidos: ${s.lost} · quadros descartados: ${s.dropped}`,
      `rota: ${w.watch.via} · ${s.turn ? 'pelo TURN' : 'sem TURN'}` + (w.watch.relaying ? ` · repassando para ${w.watch.relaying}` : ''),
    ].join('\n');
    const tile = tiles.get(`screen:${id}`);
    if (tile) tile.stats.textContent = w.statsText;
    if (testing) log('watch stats', `${settings.name} ${s.width}x${s.height}@${s.fps} ${s.kbps}kbps ${s.codec} ${w.watch.via} relaying=${w.watch.relaying} audio=${w.stream?.getAudioTracks().length ?? 0}`);
  }
  if (testing && voice && cams && room) {
    log('voice', settings.name, `mic=${voice.micOn} ns=${voice.prefs.mode} err=${voice.micError}`, voice.rows().filter((r) => !r.self).map((r) => `${r.name}:${r.connected ? 'ok' : 'x'}:${r.speaking ? 'fala' : '-'}`));
    log('turn', settings.name, `hasTurn=${hasTurn()} session=${turnMeter.sessionBytes} voiceTurn=${voice.turnIds.size} idpeer=${room.peer.disconnected ? 'disc' : 'conn'}${room.peer.destroyed ? '+destroyed' : ''} pcs=${voice.pcs().map(([, pc]) => pc.connectionState).join('/')} host=${room.isHost} roster=${room.roster.map((p) => p.name).join('/')}`);
    log('cams', settings.name, `local=${!!cams.local} err=${cams.error} remote=${cams.remote.size}`, `tiles=${tiles.size}`);
  }
}

// ---------- modo de teste automatizado ----------
if (testing) {
  const code = params.get('code') ?? 'TEST01';
  const isHost = params.get('auto') === 'host';
  void (async () => {
    await enterRoom(isHost, code, params.get('pass') ?? '');
    const state = { room, voice, cams } as { room: Room | null; voice: Voice | null; cams: Cams | null };
    if (!state.room || !state.voice || !state.cams) return;
    const { room: r, voice: v, cams: c } = state;
    if (params.has('mic')) {
      if (params.get('ns')) v.prefs.mode = params.get('ns') as NsMode;
      await v.setMic(true);
    }
    if (params.has('cam')) {
      await c.setCam(true);
      r.setState({ cam: !!c.local });
    }
    if (isHost && params.has('realcap')) {
      // teste da captura de tela real (primeira tela), sem áudio
      const src = (await window.ariranhacast.getSources()).find((x) => x.kind === 'screen');
      const opts: EncodeOpts = { maxBitrate: 3_000_000, maxFps: 30, mode: 'motion', codec: 'auto' };
      if (!src) return log('realcap', 'nenhuma tela');
      try {
        const { stream } = await capture(src, 720, 30, 'none', 'motion');
        const vs = stream.getVideoTracks()[0].getSettings();
        log('realcap', `ok ${vs.width}x${vs.height}`);
        await goLive(stream, opts, src.name, 5);
      } catch (e) {
        log('realcap', `falhou ${String(e)}`);
      }
    } else if (isHost) {
      const stream = fakeStream();
      const opts: EncodeOpts = { maxBitrate: 4_000_000, maxFps: 60, mode: 'motion', codec: 'auto' };
      applyHints(stream, opts.mode);
      await goLive(stream, opts, 'teste', Number(params.get('maxdirect') ?? 5));
    }
    updateControls();
    // ações roteirizadas: "leave@12,kick@8,mute@6" (segundos após entrar)
    for (const item of (params.get('act') ?? '').split(',').filter(Boolean)) {
      const [what, at] = item.split('@');
      window.setTimeout(() => {
        const cur = room as Room | null;
        if (!cur) return;
        const other = cur.roster.find((p) => p.id !== cur.selfId);
        log('act', what);
        if (what === 'leave') leaveRoom();
        else if (what === 'kick' && other) cur.kick(other.id);
        else if (what === 'mute' && other) cur.muteMember(other.id);
      }, Number(at) * 1000);
    }
  })();
}

updateControls();
if (params.has('netcheck')) $('btn-netcheck').click();
