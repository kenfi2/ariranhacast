// Janela transparente por cima do jogo: mostra quem está falando. Só exibe; não recebe cliques.
interface Row { name: string; color: string; speaking: boolean; muted: boolean }
interface Cfg { corner: string; mode: 'speaking' | 'all' }
const api = (window as unknown as { overlay: { onRows(cb: (r: Row[]) => void): void; onConfig(cb: (c: Cfg) => void): void } }).overlay;
const list = document.getElementById('list')!;
let cfg: Cfg = { corner: 'tr', mode: 'speaking' };
let rows: Row[] = [];

function render(): void {
  document.body.dataset.corner = cfg.corner;
  list.replaceChildren();
  for (const r of rows) {
    if (cfg.mode === 'speaking' && !r.speaking) continue;
    const el = document.createElement('div');
    el.className = 'row' + (r.speaking ? ' speaking' : '') + (r.muted ? ' muted' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.setProperty('--c', r.color);
    dot.textContent = (r.name[0] ?? '?').toUpperCase();
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    el.append(dot, name);
    list.append(el);
  }
}
api.onRows((r) => { rows = Array.isArray(r) ? r : []; render(); });
api.onConfig((c) => { cfg = c; render(); });
