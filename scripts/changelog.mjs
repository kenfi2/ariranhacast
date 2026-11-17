// Lê o CHANGELOG.md e devolve as versões como dados: [{ version, date, items: [{ text, only? }] }].
// O texto é sempre escrito à mão. A release (dist.mjs e o GitHub Actions) falha se a versão do
// package.json não tiver seção no CHANGELOG.md.
//
// Também funciona pela linha de comando:
//   node scripts/changelog.mjs notes [versão]   texto da release (Markdown); erro se não houver seção
//   node scripts/changelog.mjs check [versão]   só confere se a seção existe
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

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

export function loadChangelog(version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) {
  const file = join(root, 'CHANGELOG.md');
  let list = existsSync(file) ? parse(readFileSync(file, 'utf8')) : [];
  // Versões mais novas que a do pacote ficam de fora (rascunho da próxima ainda não lançada).
  list = list.filter((e) => !newer(e.version, version) && e.items.length > 0);
  list.sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
  return list.slice(0, MAX_VERSIONS);
}

export function entryFor(version) {
  const e = loadChangelog(version).find((x) => x.version === version);
  if (!e) throw new Error(`O CHANGELOG.md não tem a seção "## ${version}" (com pelo menos uma linha "- "). Escreva as novidades antes de lançar.`);
  return e;
}

export function releaseNotes(version) {
  const e = entryFor(version);
  return e.items.map((i) => `- ${i.only === 'pc' ? '**PC:** ' : i.only === 'android' ? '**Android:** ' : ''}${i.text}`).join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, v] = process.argv.slice(2);
  const version = v || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  try {
    if (cmd === 'check') entryFor(version);
    else if (cmd === 'notes') process.stdout.write(`${releaseNotes(version)}\n`);
    else if (cmd === 'json') process.stdout.write(`${JSON.stringify(loadChangelog(version), null, 2)}\n`);
    else {
      console.error('uso: node scripts/changelog.mjs check|notes|json [versão]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
