# AriranhaCast

Sala de voz P2P para um grupo pequeno de amigos, com webcam e transmissão de tela de baixa
latência. Mesmo pipeline do Discord: WebRTC (libwebrtc do Chromium) sobre UDP, encoder por
hardware, bitrate adaptativo.

## Usar

- **Criar sala** gera um código de 6 caracteres; os amigos usam **Entrar** com esse código.
  A senha é opcional: se a sala tiver, quem entra precisa digitá-la.
- Barra de controles: microfone, silenciar vozes, câmera, transmitir tela, sair.
- Qualquer participante pode transmitir a tela, e mais de um ao mesmo tempo. Quem quiser ver
  clica em **Assistir** no bloco da transmissão.
- Clique em um bloco para ampliá-lo (clique de novo para voltar à grade); duplo clique = tela cheia.
- **Painel** (à direita): supressão de ruído, dispositivos, volume por pessoa e, para quem
  transmite, medidor de áudio e lista de quem está assistindo.
- **Quem hospeda a sala** (quem criou, ou quem assumiu depois) pode silenciar ou remover alguém:
  passe o mouse sobre o bloco da pessoa. Se quem hospeda sai ou cai, o participante mais antigo
  assume o código; a voz entre os demais não é interrompida.
- **Reconexão**: se a sua rede piscar, o app volta sozinho à sala (até 2 minutos) e retoma as
  transmissões que você estava assistindo.
- **Atalhos globais** (Configurações): ligar/desligar o microfone (padrão Ctrl+Shift+M) e
  silenciar as vozes (Ctrl+Shift+D). Valem com o jogo em primeiro plano, enquanto você está numa sala.
- **Bandeja**: numa sala, fechar a janela só a esconde. O ícone da bandeja reabre, muda o
  microfone, sai da sala ou fecha o app.
- **Volumes e saídas separados** (Painel): volume geral das vozes, volume por pessoa, volume de
  cada transmissão, e dispositivo de saída das vozes e das transmissões.
- **Rota**: o Painel mostra, por pessoa, se a conexão é direta ou via TURN, e quanto do seu
  tráfego passou pelo TURN na sessão e no mês.
- Todos precisam da **mesma versão**: quem tenta entrar com versão incompatível recebe um aviso.

## Como funciona

| Peça | Implementação |
|---|---|
| Sala | código → ID no servidor de sinalização (PeerJS). Só lista de participantes e SDP/ICE passam por ele |
| Voz | malha: uma conexão Opus direta entre cada par de participantes |
| Supressão de ruído | Sem supressão · Padrão (WebRTC) · IA (RNNoise em WebAssembly, na thread de áudio) |
| Webcam | malha: 360p, ~0,7 Mbps por espectador |
| Captura de tela | `getDisplayMedia` do Electron (Windows Graphics Capture / DXGI) |
| Áudio da transmissão | `native/audiocap.exe` (C++, WASAPI process loopback): janela → só o aplicativo dela; tela inteira → tudo menos o AriranhaCast. Se falhar, cai para o loopback do sistema inteiro |
| Codec de tela | Automático: AV1 se a GPU tiver encoder AV1, senão H.264. Manual: AV1, H.265, H.264, VP9, VP8 |
| Transporte | SRTP/UDP direto entre os PCs, controle de congestionamento do libwebrtc |
| 5–10 espectadores | até N conexões diretas (padrão 5); os demais recebem de um espectador direto, que repassa (relay). Se o relay sai, quem transmite reatribui em ~5 s |

"Fluidez (jogos)" mantém o FPS e reduz a resolução quando a banda aperta; "Nitidez" faz o contrário.
O Krisp é proprietário e licenciado; o RNNoise é o equivalente de código aberto.

## Limites conhecidos

- **Áudio por aplicativo** exige Windows 10 2004 ou mais novo. Captura o processo dono da janela
  e seus filhos; jogos cujo som sai por outro processo (alguns launchers, apps UWP) podem ficar
  mudos — use "Sistema inteiro" nesses casos.
- **Modo "Sistema inteiro"**: entra tudo o que toca na saída padrão do Windows.
- **NAT restrito / CGNAT**: tudo é conexão direta entre os PCs. Quando duas redes não fecham
  ligação direta, é preciso um servidor TURN para retransmitir. Veja "Quando alguém não conecta".
- **Sinalização**: por padrão usa a nuvem pública gratuita do PeerJS. Para não depender dela,
  rode `npx peerjs --port 9000` em qualquer máquina acessível e informe `host:9000` em Configurações
  (todos na sala precisam usar o mesmo).
- **Relay** recodifica o vídeo no PC do espectador que repassa: +1 geração de compressão e
  algumas dezenas de ms para quem está no segundo nível.

## Quando alguém não conecta

1. Cada um abre **Configurações → Testar minha rede**. "NAT simétrico" ou "endereço público não
   obtido" indica o lado restrito. Duas redes restritas não se conectam sem TURN.
2. Quem **cria a sala** configura um TURN em Configurações (campo "Servidor TURN"): cole o JSON
   de `iceServers` ou a URL de credenciais que o serviço fornece. Os participantes recebem o
   mesmo servidor automaticamente ao entrar, então só o criador precisa configurar.
3. Rode o teste de novo: deve aparecer "TURN: configurado e respondendo".

O tráfego só passa pelo TURN nos pares que não fecham conexão direta. Uma transmissão 1080p60
retransmitida consome cerca de 3,5 GB por hora por espectador; a voz é desprezível. Alternativa
sem TURN: todos entrarem numa mesma rede virtual (Tailscale, ZeroTier, Hamachi), que o WebRTC
usa como rota direta.

## Instalar e atualizar

`npm run dist` gera em `release/` o instalador (`AriranhaCast-Setup-<versão>.exe`, instala só para
o usuário, sem administrador), a versão portátil (`.zip`) e o `SHA256SUMS.txt`. O app não é
assinado digitalmente, então o Windows mostra o aviso do SmartScreen na primeira execução
("Mais informações" → "Executar assim mesmo").

Atualização automática (já configurada para `https://github.com/kenfi2/ariranhacast/releases/latest/download/`; fica desligada se `updateUrl` ficar vazio): preencha `ariranhacast.updateUrl` em `package.json`
com uma pasta HTTPS que você controla, rode `npm run dist` e publique nessa pasta o instalador
e o `latest.yml`. Os apps instalados passam a checar essa pasta, baixar a versão nova, conferir
o SHA-512 e instalar ao fechar. Quem controla essa pasta controla o que roda no PC dos seus
amigos: proteja-a. Só funciona no app instalado pelo instalador, não no portátil.

Firewall do Windows: na primeira abertura o app pergunta se pode liberar o programa (pedido de administrador do
Windows). Quem recusar pode liberar depois em Configurações.

Segurança: veja `SEGURANCA.md`.

## Desenvolver

```
npm install
npm start            # compila e abre
npm run typecheck
npm run dist         # instalador + portátil em release/ (Windows, Linux ou macOS)
scripts/test-local.sh 3 1 20   # Linux: sala com host transmitindo + 3 membros, relay forçado
TURN=1 scripts/test-local.sh 2 5 18   # idem, com TURN local (antes: npm i --no-save node-turn)
HOSTX="--lc-act=leave@30" scripts/test-local.sh 3 5 44   # quem hospeda sai: outro assume
```

Código (`src/renderer`): `room.ts` (sala, entrada com versão e senha, troca de quem hospeda, reconexão), `voice.ts` + `voicePanel.ts` (voz e
supressão de ruído), `cams.ts` (webcams), `broadcast.ts` / `watch.ts` (transmitir / assistir e
relay), `link.ts` (WebRTC de vídeo), `codecs.ts`, `app.ts` (interface). `src/main.ts` é o processo
principal (captura, ponte com o `audiocap.exe`). `native/` tem o módulo C++ e como compilá-lo.
