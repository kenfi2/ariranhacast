# Lobby do AriranhaCast

Servidor da **conta** (login com Discord ou Google) e da **lista de salas abertas**. Roda de graça na Cloudflare (Workers + Durable Objects). Voz e vídeo continuam diretos entre os aparelhos: aqui só passam login e a lista.

- Login obrigatório no app quando `ariranhacast.lobbyUrl` está preenchido no `package.json`.
- Cada aparelho tem a sua sessão (60 dias): a mesma conta fica logada no PC e no celular ao mesmo tempo.
- Quem hospeda uma sala a publica; ela some da lista quando quem hospeda fecha o app ou cai. Se outro participante assume a sala, ele passa a publicá-la.
- Nenhum segredo vai dentro do app: os segredos OAuth ficam só na Cloudflare.

## 1. Publicar o servidor (uma vez)

No terminal do PC, dentro desta pasta (`lobby/`):

```powershell
npm install
npx wrangler login     # abre o navegador para entrar na Cloudflare (conta grátis)
npx wrangler deploy    # no final mostra o endereço: https://ariranhacast-lobby.<sua-conta>.workers.dev
```

## 2. Login com Discord

1. https://discord.com/developers/applications → **New Application** ("AriranhaCast").
2. **OAuth2** → copie o **Client ID** e clique em **Reset Secret** para gerar o **Client Secret**.
3. **OAuth2 → Redirects** → adicione `https://ariranhacast-lobby.<sua-conta>.workers.dev/auth/callback`.
4. Cole o Client ID em `wrangler.jsonc` (`DISCORD_CLIENT_ID`) e rode:
   ```powershell
   npx wrangler secret put DISCORD_CLIENT_SECRET
   ```

Com o Discord, o app também lê **a lista de servidores** da pessoa (escopo `guilds`, liberado sem aprovação). Ela fica só no servidor do lobby e serve para mostrar primeiro as salas de quem está num servidor em comum, com o nome do servidor e um filtro. Ninguém vê a lista de servidores de outra pessoa: cada um só vê os servidores **em comum**. Quem já estava logado antes desta versão precisa sair e entrar de novo uma vez.

## 3. Login com Google (opcional)

1. https://console.cloud.google.com → crie um projeto → **APIs e serviços → Tela de consentimento OAuth**: tipo **Externo**, nome "AriranhaCast", escopos `openid` e `profile` (não precisam de verificação). Publique o app (senão só contas de teste entram).
2. **Credenciais → Criar credenciais → ID do cliente OAuth** → tipo **Aplicativo da Web**.
3. **URIs de redirecionamento autorizados**: `https://ariranhacast-lobby.<sua-conta>.workers.dev/auth/callback`.
4. Cole o ID do cliente em `wrangler.jsonc` (`GOOGLE_CLIENT_ID`) e rode:
   ```powershell
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

Depois de mudar o `wrangler.jsonc`, rode `npx wrangler deploy` de novo. Só aparecem no app os provedores com ID e segredo configurados. Para outro provedor (GitHub, Twitch…), acrescente uma entrada em `src/providers.ts`.

## 3b. Avisos num canal do Discord (opcional)

Quando alguém **que é membro do servidor do webhook** abre uma sala, o lobby posta no canal (salas de quem não está no servidor não aparecem): "🟢 **Mathias** abriu a sala **aoba** 🔒" com um link que abre o app direto na sala. Quando a sala fecha (e fica fechada por 30 segundos), a mensagem vira "⚫ ~~Sala aoba de Mathias~~ encerrada". Nada de @everyone: o aviso nunca menciona ninguém.

1. No Discord, no canal desejado: **Editar canal → Integrações → Webhooks → Novo webhook** → **Copiar URL do webhook**.
2. Na pasta `lobby/`:
   ```powershell
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```
   e cole a URL. A URL do webhook funciona como uma senha (quem tem pode postar no canal): não coloque em arquivo nenhum.
3. Opcional: em `wrangler.jsonc`, `"DOWNLOAD_URL"` muda o link "Ainda não tenho o app" da página de convite (padrão: a última release no GitHub).

O link do aviso é `https://<lobby>/entrar/CODIGO`: uma página que abre `ariranhacast://entrar/CODIGO` (o Discord não deixa clicar em links `ariranhacast://`). Serve também para mandar convite em qualquer chat.

## 4. Ligar no app

No `package.json` da raiz, preencha:

```json
"ariranhacast": {
  "updateUrl": "...",
  "lobbyUrl": "https://ariranhacast-lobby.<sua-conta>.workers.dev"
}
```

O PC e o APK Android leem esse endereço no build. Teste: abra `<endereço>/auth/providers` no navegador; deve listar os provedores configurados.

## 5. Deploy automático (opcional)

O workflow `.github/workflows/deploy-lobby.yml` publica o servidor a cada push que mexer em `lobby/`. Os segredos do Discord/Google continuam guardados na Cloudflare (passos 2 e 3), não precisam ir para o GitHub. Em Settings → Secrets and variables → Actions do repositório, crie:

| Secret | Onde pegar |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → modelo **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | painel da Cloudflare → Workers & Pages (lateral direita) |

## Desenvolver

```powershell
npm run dev                                    # servidor local em http://localhost:8787
cd .. && npm run build && npx electron . --lc-lobby=http://localhost:8787   # app de PC usando o servidor local
```

## Rotas

| Rota | Para quê |
|---|---|
| `GET /auth/providers` | provedores disponíveis (botões de login) |
| `GET /auth/login?provider=…&app_state=…` | começa o login (aberta no navegador pelo app) |
| `GET /auth/callback` | volta do provedor → `ariranhacast://auth?token=…&app_state=…` |
| `GET /me` | dados da conta (`Authorization: Bearer <token>`) |
| `POST /auth/logout` | encerra a sessão deste aparelho |
| `GET /lobby` (WebSocket, subprotocolos `ariranhacast`, `<token>`) | lista de salas ao vivo |
| `GET /entrar/CODIGO` | página que abre o app na sala (links de convite e avisos no Discord) |

Mensagens do WebSocket: o servidor manda `{type:"welcome", user, rooms}` e `{type:"rooms", rooms}`; o app manda `{type:"set_room", code, name, locked, count, members, live, proto}`, `{type:"close_room"}` e `"ping"` (responde `"pong"` sem gastar cota).

## Limites do plano gratuito

100 mil requisições/dia nos Durable Objects (cada mudança numa sala é uma). Se estourar, para de funcionar até 00:00 UTC (21h em Brasília), sem cobrança. O app continua abrindo sem o lobby (com a conta salva) e dá para entrar por código.
