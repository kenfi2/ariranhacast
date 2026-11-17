# Arquivos do OBS Studio (captura de jogo)

Estes seis arquivos são do **OBS Studio 33.0.1** (sem nenhuma modificação), tirados de
`OBS-Studio-33.0.1-Windows-x64.zip`, da release oficial
https://github.com/obsproject/obs-studio/releases/tag/33.0.1 (pasta `core/win-capture/data/`).

| Arquivo | Para quê |
| --- | --- |
| `graphics-hook64.dll` / `graphics-hook32.dll` | O módulo que entra no jogo e copia os quadros (jogos de 64 e 32 bits) |
| `inject-helper64.exe` / `inject-helper32.exe` | Carrega o módulo no jogo, no modo compatível com anti-cheat do OBS |
| `get-graphics-offsets64.exe` / `get-graphics-offsets32.exe` | Descobre os endereços do DirectX deste Windows (o hook precisa deles) |

Todos têm assinatura digital válida da **OBS Project, LLC** (DigiCert). Confira no Windows:
botão direito > Propriedades > Assinaturas Digitais. Os SHA-256 estão em `SHA256SUMS.txt` e são
conferidos de novo a cada build (`scripts/check-obs.mjs`).

O AriranhaCast não usa nenhum código do OBS além destes programas: o `gamecap.exe`
(`native/gamecap.cpp`) só conversa com eles pelo protocolo público do hook (objetos nomeados do
Windows), do mesmo jeito que o plugin "win-capture" do OBS.

## Licença

O OBS Studio é software livre sob a **GNU GPL versão 2 ou posterior**. O código-fonte exato destes
arquivos está na tag `33.0.1` de https://github.com/obsproject/obs-studio (pastas
`plugins/win-capture/graphics-hook`, `plugins/win-capture/inject-helper`,
`plugins/win-capture/get-graphics-offsets` e `shared/`). Texto da licença:
https://github.com/obsproject/obs-studio/blob/33.0.1/COPYING

## Atualizar

Baixe o zip da nova versão do OBS, troque os seis arquivos, rode `sha256sum *.exe *.dll >
SHA256SUMS.txt` e confira que `HOOK_VER_MAJOR` em `shared/obs-hook-config/graphics-hook-ver.h`
continua 1 e que `struct hook_info` não mudou (o `gamecap.cpp` tem uma cópia).
