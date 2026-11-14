# Segurança do AriranhaCast

Revisão feita sobre o código da versão 0.3.0. Diz o que foi verificado, o que foi corrigido
e o que continua sendo risco por causa do desenho do app.

## Modelo de ameaça

O AriranhaCast é um app entre amigos, sem servidor próprio. Quem pode tentar algo contra você:

1. **Um participante da sala** (ou alguém que descobriu o código).
2. **O servidor de sinalização** (por padrão a nuvem pública do PeerJS) e quem estiver no caminho.
3. **Um arquivo adulterado** do próprio AriranhaCast (instalador ou zip trocado no caminho).
4. **Outro programa no seu PC** tentando usar o AriranhaCast como ferramenta.

## Injeção de código

| Verificação | Resultado |
|---|---|
| Texto vindo da rede (nomes, títulos, mensagens) inserido como HTML | Não ocorre. Tudo entra por `textContent`. O único `innerHTML` do app é com ícones fixos do próprio código. |
| `eval`, `new Function`, `document.write`, scripts remotos | Não existem no código do app. |
| Política de conteúdo (CSP) | `default-src 'none'`; scripts e estilos só do próprio app; sem `unsafe-inline`; sem frames, objetos ou formulários. Mesmo que um texto malicioso chegasse à página, não executaria. |
| Página com acesso ao Node.js | Não. `contextIsolation`, `sandbox` e `nodeIntegration: false`. A página só enxerga as 12 funções expostas em `src/preload.ts`. |
| Navegação e janelas | Bloqueadas (`will-navigate`, `will-redirect`, `window.open`, `<webview>`). A janela nunca carrega nada além da página do app. |
| Permissões do Chromium | Só microfone/câmera, captura de tela, escolha de saída de áudio, tela cheia e copiar texto. O resto é negado. |
| Canal página → sistema (IPC) | Cada chamada confere que veio da janela e da página do app; todos os parâmetros são validados (formato do id de tela/janela, atalhos, booleanos). |
| Execução de programas | Só `native/audiocap.exe`, com caminho fixo, sem shell, e argumentos sempre numéricos (número da janela ou do processo). Não há como injetar comandos. |
| Mensagens dos outros participantes | Tratadas como dado não confiável: tipos conferidos, tamanhos limitados, lista de participantes saneada, SDP/ICE malformado ignorado, parâmetros de vídeo limitados a faixas válidas, limite de 30 mensagens por segundo por participante. |
| Nomes com caracteres invisíveis (inverter direção do texto para se passar por outra pessoa) | Removidos. |

## Quem pode se conectar a você

- Voz, webcam e transmissão só aceitam conexões de quem está na lista da sala.
- Sala com senha: quem entra prova que conhece a senha sem enviá-la (HMAC-SHA-256 sobre um
  desafio aleatório), e quem hospeda também prova que a conhece. A senha nunca passa pelo
  servidor de sinalização.
- Versões incompatíveis são recusadas na entrada.
- Limite de 16 pessoas por sala.

## Malware e integridade dos arquivos

- O Electron do pacote é o binário oficial 45.3.2; o SHA-256 do download foi conferido com a
  lista oficial do projeto.
- `audiocap.exe` é compilado do código em `native/audiocap.cpp` (incluído). Não usa rede nem
  arquivos; só lê áudio e escreve na saída padrão.
- O executável tem os "fuses" do Electron desligados para `ELECTRON_RUN_AS_NODE`,
  `NODE_OPTIONS` e `--inspect`: outro programa não consegue usar o `AriranhaCast.exe` para rodar
  JavaScript arbitrário. O app de exemplo do Electron (`default_app.asar`) foi removido.
- Dependências que entram no app: `peerjs`, `@sapphi-red/web-noise-suppressor` (RNNoise),
  `electron-updater`. O `npm audit` não aponta vulnerabilidade em nenhuma delas; os alertas
  restantes são de ferramentas de build, que não vão no pacote.
- O app não coleta nem envia dados a terceiros além do necessário para conectar: o servidor de
  sinalização e, se configurado, o servidor TURN.
- Argumentos de teste (`--lc-*`) são ignorados no app distribuído, exceto `--lc-profile` e
  `--lc-name`. As ferramentas de desenvolvedor ficam desligadas.

Confira o `SHA256SUMS.txt` ao repassar o instalador: se o hash do arquivo que o amigo recebeu
for igual, o arquivo é o mesmo que foi gerado.

## Riscos que continuam (do desenho, não de bugs)

1. **Seu IP fica visível para quem está na sala.** É inerente à conexão direta (o Discord
   esconde porque tudo passa pelos servidores dele). Só entre com quem você confia. Dá para
   esconder forçando todo o tráfego pelo TURN, ao custo de latência e franquia.
2. **O app não é assinado digitalmente.** O Windows não tem como atestar a origem; por isso o
   aviso do SmartScreen. Quem recebe o arquivo depende de recebê-lo de você e do hash.
   Assinatura de código exige um certificado pago.
3. **Servidor de sinalização de terceiros.** A nuvem do PeerJS vê os códigos de sala, os IPs e
   os dados de conexão. A mídia é cifrada de ponta a ponta entre os PCs (DTLS-SRTP), mas um
   servidor de sinalização malicioso poderia, em teoria, se colocar no meio de uma conexão.
   Um servidor próprio com TLS elimina essa dependência.
4. **Código sem senha.** Quem tiver o código entra. São 6 caracteres aleatórios (cerca de 887
   milhões de combinações); para salas sensíveis, use senha. Senhas fracas podem ser testadas
   offline por quem conseguir se passar pela sala; use algo que não seja adivinhável.
5. **Remover não é banir.** Quem foi removido pode entrar de novo se ainda tiver o código (e a
   senha). Para barrar de vez, crie outra sala.
6. **Quem assume a sala ganha os controles.** Se quem hospeda sai, o participante mais antigo
   passa a poder silenciar e remover.
7. **Repasse de vídeo.** Quem assiste via relay recebe o vídeo recodificado por outro
   participante, que tecnicamente poderia alterá-lo. "Conexões diretas: Todas" evita o repasse.
8. **Atualização automática**, se você ligar: quem controla a pasta de atualização controla o
   que é instalado nos PCs. O download é conferido por SHA-512, mas contra um arquivo da mesma
   pasta. Use HTTPS (obrigatório) e proteja o acesso de escrita.
9. **TURN**: as credenciais que você configura são repassadas aos participantes da sua sala,
   que poderiam usá-las para gastar sua franquia.

## O que não foi possível verificar

- O comportamento no Windows do app endurecido (sandbox, permissões, fuses, ícone no
  executável). A estrutura do executável foi validada e os testes rodaram em Linux.
- O instalador e a atualização automática de ponta a ponta.
- Uma auditoria independente. Esta revisão foi feita por quem escreveu o código.
