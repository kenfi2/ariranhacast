// Confere os arquivos do OBS (native/obs) contra os SHA-256 registrados antes de empacotar:
// um arquivo trocado ou corrompido não chega ao instalador.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function checkObs(dir = 'native/obs') {
  const lines = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
  if (lines.length !== 6) throw new Error('native/obs/SHA256SUMS.txt deveria listar 6 arquivos');
  for (const line of lines) {
    const [hash, name] = line.split(/\s+\*?/);
    const got = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
    if (got !== hash) throw new Error(`native/obs/${name}: SHA-256 diferente do registrado`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkObs();
  console.log('arquivos do OBS conferidos');
}
