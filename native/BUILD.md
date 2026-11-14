# audiocap.exe

Captura de áudio por aplicativo (WASAPI process loopback). O binário incluído foi
gerado por compilação cruzada:

    python3 -m ziglang c++ -target x86_64-windows-gnu -O2 -s -fno-exceptions -fno-rtti \
      -o audiocap.exe audiocap.cpp -lole32 -lmmdevapi -luser32

No Windows, com o MSVC ("x64 Native Tools Command Prompt"):

    cl /O2 /EHsc audiocap.cpp ole32.lib mmdevapi.lib user32.lib

Teste isolado (grava 48 kHz estéreo s16le; abra no Audacity como "dados brutos"):

    audiocap --include-pid <PID do jogo> > teste.raw
