// Novidades de cada versão (vêm do CHANGELOG.md, embutido no app pelo build).
export type Platform = 'pc' | 'android';
export interface ChangeItem {
  text: string;
  only?: Platform;
}
export interface ChangeEntry {
  version: string;
  date: string;
  items: ChangeItem[];
}

export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// Só as linhas que valem para esta plataforma; versões que ficaram vazias saem da lista.
export function forPlatform(list: ChangeEntry[], p: Platform): ChangeEntry[] {
  return list
    .map((e) => ({ ...e, items: e.items.filter((i) => !i.only || i.only === p) }))
    .filter((e) => e.items.length > 0);
}

// Texto "- linha" (releaseNotes do latest.yml / notes do latest-android.json) → itens.
export function parseNotes(raw: unknown): ChangeItem[] {
  const lines = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/\r?\n/) : [];
  const out: ChangeItem[] = [];
  for (const l of lines) {
    const t = l
      .replace(/<[^>]*>/g, '') // por garantia: nunca vira HTML
      .replace(/^\s*[-*]\s+/, '')
      .trim()
      .slice(0, 300);
    if (!t) continue;
    const m = /^(PC|Android):\s*(.+)$/i.exec(t);
    const text = (m ? m[2] : t).trim();
    const cap = text.charAt(0).toUpperCase() + text.slice(1);
    out.push(m ? { text: cap, only: m[1].toLowerCase() === 'pc' ? 'pc' : 'android' } : { text: cap });
    if (out.length >= 40) break;
  }
  return out;
}

// Monta a lista da página (sempre com textContent, nunca innerHTML).
export function renderChangelog(root: HTMLElement, list: ChangeEntry[], current: string, pending?: ChangeEntry): void {
  root.replaceChildren();
  const all = pending && !list.some((e) => e.version === pending.version) ? [pending, ...list] : list;
  for (const e of all) {
    const sec = document.createElement('section');
    sec.className = 'news-ver';
    const h = document.createElement('h3');
    h.textContent = `Versão ${e.version}`;
    if (e.version === current) sec.classList.add('cur');
    if (pending && e.version === pending.version) sec.classList.add('next');
    const tag = document.createElement('span');
    tag.className = 'news-tag';
    tag.textContent = pending && e.version === pending.version ? 'nova' : e.version === current ? 'a sua' : '';
    if (tag.textContent) h.append(' ', tag);
    if (e.date) {
      const d = document.createElement('span');
      d.className = 'news-date';
      d.textContent = e.date;
      h.append(d);
    }
    const ul = document.createElement('ul');
    for (const i of e.items) {
      const li = document.createElement('li');
      li.textContent = i.text;
      ul.append(li);
    }
    sec.append(h, ul);
    root.append(sec);
  }
}

// Mostra sozinha uma vez depois de atualizar (não na primeira instalação).
const SEEN_KEY = 'ariranhacast.seenVersion';
export function shouldShowAfterUpdate(current: string): boolean {
  let seen: string | null = null;
  let oldUser = false;
  try {
    seen = localStorage.getItem(SEEN_KEY);
    // Primeira versão com esta página: quem já usava o app (tem outras configurações salvas)
    // também deve ver as novidades; só quem acabou de instalar não.
    if (!seen) for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith('ariranhacast.')) oldUser = true;
    localStorage.setItem(SEEN_KEY, current);
  } catch {
    return false;
  }
  return seen ? newerVersion(current, seen) : oldUser;
}
