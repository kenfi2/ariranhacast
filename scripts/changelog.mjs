// Lê o CHANGELOG.md e devolve as versões como dados: [{ version, date, items: [{ text, only? }] }].
// Se a versão atual do package.json não tiver seção, monta uma com os títulos dos commits desde a
// tag anterior (precisa do histórico do git; no GitHub Actions: checkout com fetch-depth: 0).
//
// Também funciona pela linha de comando:
//   node scripts/changelog.mjs notes [versão]   texto da release (Markdown) da versão
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ITEM = 300;
const MAX_VERSIONS = 60;

function parse(md) {
  const out = [];
  let cur = null;
  const body = md.replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:\((\d{2}\/\d{2}\/\d{4})\))?/.exec(line);
    if (h) {
      cur = { version: h[1], date: h[2] ?? '', items: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const it = /^[-*]\s+(.+)$/.exec(line);
    if (it) cur.items.push(item(it[1]));
    else if (line && cur.items.length) cur.items[cur.items.length - 1].text += ` ${line}`; // linha quebrada
  }
  return out;
}

function item(text) {
  const m = /^(PC|Android):\s*(.+)$/i.exec(text.trim());
  const only = m ? (m[1].toLowerCase() === 'pc' ? 'pc' : 'android') : undefined;
  let t = (m ? m[2] : text).trim().slice(0, MAX_ITEM);
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return only ? { text: t, only } : { text: t };
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// Títulos dos commits desde a última tag "vX.Y.Z" anterior a esta versão, já limpos.
function fromCommits(version) {
  try {
    const tags = git('tag', '--list', 'v*.*.*', '--sort=-v:refname').split('\n').filter(Boolean);
    const prev = tags.find((t) => t !== `v${version}` && newer(version, t.slice(1)));
    const range = prev ? `${prev}..HEAD` : 'HEAD';
    const subjects = git('log', '--no-merges', '--format=%s', range).split('\n');
    const seen = new Set();
    const items = [];
    for (let s of subjects) {
      s = s
        .replace(/\s*\(#\d+\)\s*$/, '') // número do PR
        .replace(/\s*\(\d+\.\d+\.\d+\)\s*$/, '') // "(0.8.6)" no fim
        .replace(/^(AriranhaCast\s+)?\d+\.\d+\.\d+:\s*/, '') // "0.7.0: ..."
        .trim();
      if (!s || /^(update version|bump|wip|merge)\b/i.test(s) || /^(workflow|build|ci|docs?)\s*:/i.test(s)) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(item(s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.')));
    }
    return items;
  } catch {
    return []; // sem git (ex.: pasta baixada como .zip)
  }
}

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function today() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export function loadChangelog(version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) {
  const file = join(root, 'CHANGELOG.md');
  let list = existsSync(file) ? parse(readFileSync(file, 'utf8')) : [];
  // Versões mais novas que a do pacote ficam de fora (rascunho da próxima ainda não lançada).
  list = list.filter((e) => !newer(e.version, version));
  if (!list.some((e) => e.version === version)) {
    const items = fromCommits(version);
    list.unshift({ version, date: today(), items: items.length ? items : [{ text: 'Correções e melhorias.' }], auto: true });
  }
  list.sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
  return list.slice(0, MAX_VERSIONS);
}

export function releaseNotes(version) {
  const e = loadChangelog(version).find((x) => x.version === version);
  if (!e) return '';
  return e.items.map((i) => `- ${i.only === 'pc' ? '**PC:** ' : i.only === 'android' ? '**Android:** ' : ''}${i.text}`).join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, v] = process.argv.slice(2);
  if (cmd === 'notes') process.stdout.write(`${releaseNotes(v || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)}\n`);
  else if (cmd === 'json') process.stdout.write(`${JSON.stringify(loadChangelog(v || undefined), null, 2)}\n`);
  else {
    console.error('uso: node scripts/changelog.mjs notes|json [versão]');
    process.exit(1);
  }
}
