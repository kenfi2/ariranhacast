// Ajusta o executável do Electron depois de copiado para a pasta do app:
//  1. "fuses": desliga modos do Electron que permitiriam usar o AriranhaCast.exe para rodar
//     código arbitrário (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect).
//  2. ícone e identificação (nome que aparece no Gerenciador de Tarefas e no firewall).
// Tudo em JavaScript puro, sem precisar de Windows para empacotar.
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { readFileSync, writeFileSync } from 'node:fs';
import * as ResEdit from 'resedit';

export async function hardenExe(exePath, version) {
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
  });

  const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(readFileSync(new URL('../assets/icon.ico', import.meta.url)));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groups[0]?.id ?? 1,
    groups[0]?.lang ?? 1033,
    icon.icons.map((i) => i.data),
  );
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const [major, minor, patch] = version.split('.').map(Number);
    vi.setFileVersion(major, minor, patch, 0, 1033);
    vi.setProductVersion(major, minor, patch, 0, 1033);
    vi.setStringValues(
      { lang: 1033, codepage: 1200 },
      { ProductName: 'AriranhaCast', FileDescription: 'AriranhaCast', CompanyName: 'AriranhaCast', OriginalFilename: 'AriranhaCast.exe', InternalName: 'AriranhaCast', LegalCopyright: '' },
    );
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
}

if (process.argv[2]) await hardenExe(process.argv[2], process.argv[3] ?? '0.0.0');
