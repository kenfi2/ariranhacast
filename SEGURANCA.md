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

## Liberação no Firewall do Windows (0.3.1)

Ao abrir, o app confere (sem permissão especial) se existe uma regra de entrada do Firewall para o
`AriranhaCast.exe`. Se não existir, pergunta uma vez e, só se a pessoa aceitar, cria a regra com o
pedido de administrador do próprio Windows (UAC).

- O script é montado na memória, usa só o caminho do próprio executável (`process.execPath`) e vai ao
  PowerShell por `-EncodedCommand`: nenhum arquivo é gravado nem executado, então outro programa não
  tem o que trocar entre a escolha e a execução.
- A regra vale só para esse programa (entrada, todos os perfis de rede). Regras antigas do Windows para o
  mesmo caminho (inclusive a de bloqueio criada ao fechar o aviso da primeira execução) são substituídas.
- Se a pessoa recusar, o app não pergunta de novo; o botão fica em Configurações.
- O desinstalador não pede administrador e por isso não remove a regra. Ela fica inofensiva (aponta para
  um programa que não existe mais) e pode ser apagada em "Firewall do Windows com Segurança Avançada".
- Não foi testado em um Windows real (só em Linux): se o pedido não aparecer, o app segue funcionando e
  o botão em Configurações mostra o estado.


## Novidades da 0.4.0 e o que elas mudam na segurança

- **Chat.** Texto, imagens e emotes chegam de outras pessoas da sala, então são tratados como não confiáveis: o texto é exibido só como texto (nunca como HTML), com caracteres de controle removidos; imagens são aceitas apenas se os primeiros bytes forem de PNG, JPEG, GIF ou WebP (o tipo declarado é ignorado), com limite de 4 MB (emotes: 128 KB) e de 16 MB por pessoa por minuto. Quem hospeda define autor e horário de cada mensagem, então ninguém consegue escrever em nome de outro. O chat fica só na memória e some ao sair; não é criptografado além do que o WebRTC já faz, e quem hospeda a sala vê tudo.
- **Links.** Um clique abre o link no navegador padrão, e só `http://`/`https://`. O app não carrega prévias nem imagens de links, para não revelar seu IP a sites de terceiros. Cuidado normal com links continua valendo.
- **GIFs.** A busca é opcional e usa a sua chave do Giphy; o Giphy vê o seu IP e o que você procura. O GIF escolhido é baixado pelo seu PC e enviado aos amigos pela sala, então eles não falam com o Giphy.
- **Overlay.** É uma segunda janela do próprio app, transparente, que ignora cliques e só recebe nomes e estado de fala.
- **Clipes.** O replay fica só na memória; nada é gravado em disco até você pedir. Ao clipar a transmissão de outra pessoa você está gravando a tela dela: combine antes. Os arquivos só são gravados em Vídeos/AriranhaCast.
- **Link de convite.** O app registra `ariranhacast://` no Windows. Só o formato `ariranhacast://entrar/CODIGO` é aceito, e ele apenas preenche o código e tenta entrar; senha nunca vai no link.
- **Instância única.** Abrir o app de novo só traz a janela existente para frente.
- **Não verificado em Windows real:** overlay sobre jogos, clipes em H.264/MP4 (no Linux de teste sai WebM), registro do link de convite, e o workflow de release.

## Novidades da 0.5.0

- **Clipe de voz.** O replay guarda na memória o áudio da conversa (o seu microfone quando ligado e as vozes dos outros) e só grava em disco quando você pede. Você estará gravando outras pessoas: avise antes. Ninguém na sala é notificado automaticamente.
- **Figurinhas e emotes pessoais.** Ficam no armazenamento local do app (IndexedDB), só neste PC. Passam pelas mesmas verificações das imagens do chat (tipo conferido pelos bytes, limite de 1 MB por figurinha e 128 KB por emote). Só o dono de um emote (ou quem hospeda) consegue tirá-lo da sala.
- **Teste de microfone.** O retorno toca só no seu PC; durante o teste o envio para a sala fica cortado.
- **Não verificado em Windows real:** o retorno do microfone na saída escolhida, o formato do clipe de voz (deve sair .m4a; no Linux de teste saiu .webm) e a ausência da borda amarela no Windows 11.
