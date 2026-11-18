# audiocap.exe

Captura de áudio por aplicativo (WASAPI process loopback). O binário incluído foi
gerado por compilação cruzada:

    python3 -m ziglang c++ -target x86_64-windows-gnu -O2 -s -fno-exceptions -fno-rtti \
      -o audiocap.exe audiocap.cpp -lole32 -lmmdevapi -luser32

No Windows, com o MSVC ("x64 Native Tools Command Prompt"):

    cl /O2 /EHsc audiocap.cpp ole32.lib mmdevapi.lib user32.lib

Teste isolado (grava 48 kHz estéreo s16le; abra no Audacity como "dados brutos"):

    audiocap --include-pid <PID do jogo> > teste.raw

# gamecap.exe

Captura de jogo no estilo do OBS (ver o cabeçalho de `gamecap.cpp` e `obs/LEIA-ME.md`). O
binário incluído foi gerado por compilação cruzada:

    python3 -m ziglang c++ -target x86_64-windows-gnu -O2 -s -fno-exceptions -fno-rtti \
      -o gamecap.exe gamecap.cpp -ld3d11 -ldxgi -lwinmm -lshell32

No Windows, com o MSVC:

    cl /O2 /EHsc /std:c++17 gamecap.cpp d3d11.lib dxgi.lib winmm.lib shell32.lib user32.lib advapi32.lib

Teste isolado (com o jogo aberto; o HWND decimal sai, por exemplo, do Spy++ ou do
`desktopCapturer`): `gamecap --hwnd <HWND> --parent <PID de qualquer processo seu> --obs obs`.
Deve imprimir `HOOKED`, `TEX` e uma linha `FRAME` por quadro.

Captura sem o cursor (sem hook, usada na captura normal de janela/tela):
`gamecap --mode window --hwnd <HWND> --parent <PID>` (Windows Graphics Capture) ou
`gamecap --mode screen --point <x>,<y> --parent <PID>` (Desktop Duplication do monitor que contém o ponto).
