import { MAX_EMOTE, MAX_IMAGE, MAX_TEXT, sniffImage } from './chatutil';
import type { Room } from './room';
import type { ChatImage, ChatMessage, Emote, GifItem } from './types';

/** Chat de texto da sala: links, imagens, GIFs, emojis, emotes da sala e formatação simples. */
export interface ChatDeps {
  room: Room;
  color(id: string): string;
  toast(text: string): void;
  giphyKey(): string;
  onUnread(count: number): void;
  isOpen(): boolean;
}

const EMOJI: Record<string, string> = {
  smile: '😄', joy: '😂', rofl: '🤣', grin: '😁', wink: '😉', heart_eyes: '😍', kiss: '😘', thinking: '🤔', cry: '😢', sob: '😭',
  angry: '😠', rage: '🤬', skull: '💀', clown: '🤡', sunglasses: '😎', sleepy: '😴', scream: '😱', sweat: '😅', upside: '🙃', eyes: '👀',
  thumbsup: '👍', thumbsdown: '👎', ok: '👌', clap: '👏', pray: '🙏', muscle: '💪', wave: '👋', facepalm: '🤦', shrug: '🤷', fire: '🔥',
  heart: '❤️', broken_heart: '💔', star: '⭐', sparkles: '✨', tada: '🎉', '100': '💯', poop: '💩', rocket: '🚀', gg: '🏆', gamepad: '🎮',
  beer: '🍺', pizza: '🍕', coffee: '☕', check: '✅', x: '❌', warning: '⚠️', zzz: '💤', brain: '🧠', otter: '🦦', salute: '🫡',
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const TOKEN = /(https?:\/\/[^\s<>"']+)|:([a-z0-9_]{2,24}):|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|`([^`\n]+)`|\*([^*\n]+)\*/g;

export function mountChat(root: HTMLElement, deps: ChatDeps): { destroy(): void; opened(): void } {
  const { room } = deps;
  const urls = new Map<Uint8Array, string>(); // imagem → blob URL (liberados ao sair)
  const blobUrl = (img: { mime: string; data: Uint8Array }): string => {
    let u = urls.get(img.data);
    if (!u) {
      u = URL.createObjectURL(new Blob([img.data as BlobPart], { type: img.mime }));
      urls.set(img.data, u);
    }
    return u;
  };

  root.replaceChildren();
  const list = el('div', 'chat-list');
  const typing = el('div', 'chat-typing');
  const preview = el('div', 'chat-preview');
  preview.hidden = true;
  const picker = el('div', 'chat-picker');
  picker.hidden = true;
  const bar = el('div', 'chat-bar');
  const input = el('textarea', 'chat-input');
  input.rows = 1;
  input.maxLength = MAX_TEXT;
  input.placeholder = 'Mensagem';
  input.title = 'Enter envia · Shift+Enter quebra linha · cole ou arraste imagens';
  const file = el('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/gif,image/webp';
  file.hidden = true;
  const bImg = el('button', 'ghost small', '🖼');
  bImg.title = 'Enviar imagem (também dá para colar ou arrastar)';
  const bGif = el('button', 'ghost small', 'GIF');
  bGif.title = 'Procurar GIF';
  const bEmo = el('button', 'ghost small', '😄');
  bEmo.title = 'Emojis e emotes da sala';
  const bSend = el('button', 'primary small', 'Enviar');
  for (const b of [bImg, bGif, bEmo, bSend]) b.type = 'button';
  bar.append(bImg, bGif, bEmo, input, bSend, file);
  root.append(list, typing, preview, picker, bar);

  let pendingImg: ChatImage | null = null;
  let unread = 0;
  let lastFrom = '';
  let lastTs = 0;

  // ---------- render ----------
  function renderText(text: string, into: HTMLElement): void {
    let pos = 0;
    const onlyEmote = /^\s*(?::[a-z0-9_]{2,24}:\s*){1,3}$/.test(text);
    for (const m of text.matchAll(TOKEN)) {
      const i = m.index ?? 0;
      if (i > pos) into.append(text.slice(pos, i));
      pos = i + m[0].length;
      if (m[1]) {
        const url = m[1].replace(/[),.;!?]+$/, '');
        pos -= m[1].length - url.length;
        const a = el('a', 'chat-link', url.length > 70 ? url.slice(0, 67) + '…' : url);
        a.title = url;
        a.href = '#';
        a.onclick = (e) => {
          e.preventDefault();
          void window.ariranhacast.openExternal(url);
        };
        into.append(a);
      } else if (m[2]) {
        const emote = room.emotes.get(m[2]);
        if (emote) {
          const img = el('img', 'emote' + (onlyEmote ? ' big' : ''));
          img.src = blobUrl(emote);
          img.alt = img.title = `:${emote.name}:`;
          into.append(img);
        } else if (EMOJI[m[2]]) into.append(EMOJI[m[2]]);
        else into.append(m[0]);
      } else if (m[3]) into.append(el('strong', '', m[3]));
      else if (m[4]) into.append(el('s', '', m[4]));
      else if (m[5]) into.append(el('code', '', m[5]));
      else if (m[6]) into.append(el('em', '', m[6]));
    }
    if (pos < text.length) into.append(text.slice(pos));
  }

  function lightbox(src: string): void {
    const box = el('div', 'lightbox');
    const img = el('img');
    img.src = src;
    box.append(img);
    box.onclick = () => box.remove();
    document.body.append(box);
  }

  function addMessage(m: ChatMessage, scroll: boolean): void {
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const grouped = m.from === lastFrom && m.ts - lastTs < 5 * 60_000;
    lastFrom = m.from;
    lastTs = m.ts;
    const row = el('div', 'chat-msg' + (grouped ? ' grouped' : ''));
    row.dataset.id = m.id;
    if (!grouped) {
      const head = el('div', 'chat-head');
      const name = el('span', 'chat-name', m.name);
      name.style.color = deps.color(m.from);
      head.append(name, el('span', 'chat-time', new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })));
      row.append(head);
    }
    if (m.text) {
      const body = el('div', 'chat-text');
      renderText(m.text, body);
      row.append(body);
    }
    if (m.img) {
      const img = el('img', 'chat-img');
      const src = blobUrl(m.img);
      img.src = src;
      img.alt = 'imagem';
      img.onclick = () => lightbox(src);
      img.onload = () => {
        if (stick) list.scrollTop = list.scrollHeight;
      };
      row.append(img);
    } else if (m.expired) {
      row.append(el('div', 'chat-expired', '(imagem antiga, não está mais disponível)'));
    }
    if (m.from === room.selfId || room.isHost) {
      const del = el('button', 'chat-del', '×');
      del.title = 'Apagar mensagem';
      del.onclick = () => room.deleteChat(m.id);
      row.append(del);
    }
    list.append(row);
    if (scroll && (stick || m.from === room.selfId)) list.scrollTop = list.scrollHeight;
  }

  function renderAll(): void {
    list.replaceChildren();
    lastFrom = '';
    lastTs = 0;
    for (const m of room.chatLog) addMessage(m, false);
    list.scrollTop = list.scrollHeight;
  }

  // ---------- quem está digitando ----------
  const typers = new Map<string, number>();
  function renderTyping(): void {
    const now = Date.now();
    for (const [id, t] of typers) if (now - t > 4000) typers.delete(id);
    const names = [...typers.keys()].map((id) => room.nameOf(id)).filter(Boolean);
    typing.textContent = !names.length ? '' : names.length === 1 ? `${names[0]} está digitando…` : names.length <= 3 ? `${names.join(', ')} estão digitando…` : 'Várias pessoas estão digitando…';
  }
  const typingTimer = window.setInterval(renderTyping, 1000);
  let lastTyping = 0;

  // ---------- imagem pendente ----------
  function setPending(img: ChatImage | null): void {
    pendingImg = img;
    preview.replaceChildren();
    preview.hidden = !img;
    if (!img) return;
    const pic = el('img');
    pic.src = blobUrl(img);
    const x = el('button', 'ghost small', 'Remover');
    x.type = 'button';
    x.onclick = () => setPending(null);
    preview.append(pic, el('span', 'muted', `${Math.round(img.data.byteLength / 1024)} KB`), x);
  }

  /** Imagens grandes (que não são GIF) são reduzidas para caber no limite. */
  async function prepareImage(blob: Blob): Promise<ChatImage | null> {
    let data = new Uint8Array(await blob.arrayBuffer());
    let mime = sniffImage(data);
    if (!mime) return deps.toast('Esse arquivo não é uma imagem PNG, JPEG, GIF ou WebP.'), null;
    if (data.byteLength > MAX_IMAGE) {
      if (mime === 'image/gif') return deps.toast('GIF grande demais (máximo 4 MB).'), null;
      try {
        const bmp = await createImageBitmap(new Blob([data as BlobPart], { type: mime }));
        const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
        const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
        canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        data = new Uint8Array(await out.arrayBuffer());
        mime = 'image/jpeg';
      } catch {
        return deps.toast('Não consegui reduzir a imagem.'), null;
      }
      if (data.byteLength > MAX_IMAGE) return deps.toast('Imagem grande demais (máximo 4 MB).'), null;
    }
    return { mime, data };
  }

  async function takeFile(f: Blob | null | undefined): Promise<void> {
    if (!f) return;
    const img = await prepareImage(f);
    if (img) setPending(img);
    input.focus();
  }

  // ---------- enviar ----------
  function send(): void {
    const text = input.value;
    if (!text.trim() && !pendingImg) return;
    if (!room.sendChat(text, pendingImg ?? undefined)) return deps.toast('Sem conexão com a sala no momento; a mensagem não foi enviada.');
    input.value = '';
    input.style.height = '';
    setPending(null);
    picker.hidden = true;
  }

  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
    if (Date.now() - lastTyping > 2500 && input.value) {
      lastTyping = Date.now();
      room.sendTyping();
    }
  };
  input.onpaste = (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      void takeFile(item.getAsFile());
    }
  };
  root.ondragover = (e) => e.preventDefault();
  root.ondrop = (e) => {
    e.preventDefault();
    void takeFile([...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/')));
  };
  bSend.onclick = send;
  bImg.onclick = () => file.click();
  file.onchange = () => {
    void takeFile(file.files?.[0]);
    file.value = '';
  };

  // ---------- emojis e emotes ----------
  function insert(text: string): void {
    const s = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, s) + text + input.value.slice(input.selectionEnd ?? s);
    input.focus();
    input.selectionStart = input.selectionEnd = s + text.length;
  }

  function showEmojis(): void {
    picker.replaceChildren();
    picker.dataset.kind = 'emoji';
    const emotes = el('div', 'pick-grid');
    for (const e of room.emotes.values()) {
      const b = el('button', 'pick');
      b.type = 'button';
      const img = el('img');
      img.src = blobUrl(e);
      b.title = `:${e.name}:`;
      b.append(img);
      b.onclick = () => insert(`:${e.name}: `);
      emotes.append(b);
    }
    const add = el('button', 'ghost small', '+ Adicionar emote');
    add.type = 'button';
    const emoteFile = el('input');
    emoteFile.type = 'file';
    emoteFile.accept = file.accept;
    emoteFile.hidden = true;
    add.onclick = () => emoteFile.click();
    emoteFile.onchange = async () => {
      const f = emoteFile.files?.[0];
      emoteFile.value = '';
      if (!f) return;
      const data = await shrinkEmote(f);
      if (!data) return deps.toast('Não deu para usar essa imagem como emote (máximo 128 KB; GIF animado precisa já ser pequeno).');
      const suggested = f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
      askName(suggested, (name) => {
        if (!room.addEmote(name, data)) deps.toast('Não foi possível adicionar (nome já usado por outra pessoa, ou a sala já tem 50 emotes).');
      });
    };
    const head = el('div', 'pick-head');
    head.append(el('span', 'muted', room.emotes.size ? 'Emotes da sala' : 'A sala ainda não tem emotes'), add, emoteFile);
    const grid = el('div', 'pick-grid');
    for (const [name, ch] of Object.entries(EMOJI)) {
      const b = el('button', 'pick', ch);
      b.type = 'button';
      b.title = `:${name}:`;
      b.onclick = () => insert(ch);
      grid.append(b);
    }
    picker.append(head, emotes, el('div', 'muted pick-sub', 'Emojis'), grid);
  }

  function askName(suggested: string, done: (name: string) => void): void {
    const row = el('div', 'pick-head');
    const name = el('input');
    name.maxLength = 24;
    name.placeholder = 'nome_do_emote';
    name.value = suggested;
    const ok = el('button', 'primary small', 'Salvar emote');
    ok.type = 'button';
    ok.onclick = () => {
      const n = name.value.toLowerCase();
      if (!/^[a-z0-9_]{2,24}$/.test(n)) return deps.toast('Nome do emote: 2 a 24 letras minúsculas, números ou _.');
      done(n);
      showEmojis();
    };
    row.append(name, ok);
    picker.prepend(row);
    name.focus();
  }

  async function shrinkEmote(f: Blob): Promise<Uint8Array | null> {
    const raw = new Uint8Array(await f.arrayBuffer());
    const mime = sniffImage(raw);
    if (!mime) return null;
    if (raw.byteLength <= MAX_EMOTE) return raw;
    if (mime === 'image/gif') return null;
    try {
      const bmp = await createImageBitmap(new Blob([raw as BlobPart], { type: mime }));
      const scale = Math.min(1, 96 / Math.max(bmp.width, bmp.height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      return out.byteLength <= MAX_EMOTE ? out : null;
    } catch {
      return null;
    }
  }

  bEmo.onclick = () => {
    const open = picker.hidden || picker.dataset.kind !== 'emoji';
    picker.hidden = !open;
    if (open) showEmojis();
  };

  // ---------- GIFs ----------
  let gifSeq = 0;
  async function searchGifs(q: string, grid: HTMLElement): Promise<void> {
    const seq = ++gifSeq;
    grid.replaceChildren(el('span', 'muted', 'Procurando…'));
    const r = await window.ariranhacast.gifSearch(deps.giphyKey(), q);
    if (seq !== gifSeq) return;
    grid.replaceChildren();
    if (!r.ok) return void grid.append(el('span', 'muted', r.error ?? 'Não deu para buscar.'));
    if (!r.items.length) return void grid.append(el('span', 'muted', 'Nada encontrado.'));
    for (const g of r.items as GifItem[]) {
      const b = el('button', 'gif');
      b.type = 'button';
      const img = el('img');
      img.src = g.thumb;
      img.alt = b.title = g.title;
      b.append(img);
      b.onclick = async () => {
        b.disabled = true;
        const got = await window.ariranhacast.gifFetch(g.url);
        b.disabled = false;
        if (!got.ok || !got.data) return deps.toast(got.error ?? 'Não consegui baixar o GIF.');
        const data = new Uint8Array(got.data);
        const mime = sniffImage(data);
        if (!mime) return deps.toast('O arquivo recebido não é uma imagem.');
        if (!room.sendChat('', { mime, data })) return deps.toast('Sem conexão com a sala no momento.');
        picker.hidden = true;
      };
      grid.append(b);
    }
  }

  bGif.onclick = () => {
    const open = picker.hidden || picker.dataset.kind !== 'gif';
    picker.hidden = !open;
    if (!open) return;
    picker.replaceChildren();
    picker.dataset.kind = 'gif';
    if (!deps.giphyKey()) {
      picker.append(
        el('p', 'muted', 'Para procurar GIFs aqui dentro, cole uma chave gratuita do Giphy em Configurações > Chat. Sem chave, você ainda pode colar ou arrastar qualquer GIF (até 4 MB) direto no chat.'),
      );
      return;
    }
    const q = el('input');
    q.placeholder = 'Procurar GIF…';
    const grid = el('div', 'gif-grid');
    let t = 0;
    q.oninput = () => {
      clearTimeout(t);
      t = window.setTimeout(() => void searchGifs(q.value, grid), 450);
    };
    picker.append(q, grid, el('div', 'muted pick-sub', 'Powered by GIPHY'));
    q.focus();
    void searchGifs('', grid);
  };

  // ---------- eventos da sala ----------
  room.onchat = (m) => {
    typers.delete(m.from);
    renderTyping();
    addMessage(m, true);
    if (m.from !== room.selfId && (!deps.isOpen() || !document.hasFocus())) {
      deps.onUnread(++unread);
      void window.ariranhacast.flash();
    }
  };
  room.onchatdel = (id) => {
    list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
  };
  room.onhistory = renderAll;
  room.onemote = () => {
    if (!picker.hidden && picker.dataset.kind === 'emoji') showEmojis();
    renderAll(); // mensagens que citavam o emote antes de ele chegar
  };
  room.ontyping = (id) => {
    typers.set(id, Date.now());
    renderTyping();
  };
  renderAll();

  return {
    opened() {
      unread = 0;
      deps.onUnread(0);
      list.scrollTop = list.scrollHeight;
      input.focus();
    },
    destroy() {
      clearInterval(typingTimer);
      room.onchat = room.onchatdel = room.ontyping = room.onemote = () => {};
      room.onhistory = () => {};
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
      root.replaceChildren();
    },
  };
}
