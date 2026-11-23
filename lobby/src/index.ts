import { enabledProviders, PROVIDERS } from "./providers";
import type { Env, User } from "./types";
export { Lobby } from "./lobby";

const APP_SCHEME = "ariranhacast";
const SAFE_STATE = /^[A-Za-z0-9_-]{16,128}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Página mostrada no navegador ao fim do login. `redirect` = link para voltar ao app. */
function page(title: string, message: string, status = 200, redirect?: string, extras: { href: string; label: string }[] = []): Response {
  const link = redirect ? escapeHtml(redirect) : "";
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${redirect ? `<meta http-equiv="refresh" content="0;url=${link}">` : ""}
<title>AriranhaCast</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e7e9ee;font-family:"Segoe UI",system-ui,sans-serif}
  main{text-align:center;max-width:420px;padding:24px}
  h1{font-size:22px;margin:0 0 8px} p{color:#8b93a3;line-height:1.5}
  a{display:inline-block;margin-top:12px;padding:10px 18px;border-radius:8px;background:#5b6be6;color:#fff;text-decoration:none;font-weight:600}
  a.ghost{background:transparent;border:1px solid #2a2f3a;color:#e7e9ee;font-weight:400}
</style></head>
<body><main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  ${redirect ? `<a href="${link}">Abrir o AriranhaCast</a>` : ""}
  ${extras.map((x) => `<p><a class="ghost" href="${escapeHtml(x.href)}">${escapeHtml(x.label)}</a></p>`).join("")}
</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Set-Cookie": "oauth=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/auth",
    },
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Volta do provedor (?code=…&state=…): troca o código, lê a conta e cria a sessão deste aparelho. */
async function callback(req: Request, url: URL, env: Env, lobby: DurableObjectStub<import("./lobby").Lobby>): Promise<Response> {
  const [cookieState, appState, providerId, target] = (req.headers.get("Cookie")?.match(/(?:^|;\s*)oauth=([^;]+)/)?.[1] ?? "").split(".");
  const provider = PROVIDERS.find((p) => p.id === providerId);

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    console.log(`login ${providerId ?? "?"}: o provedor devolveu erro`, oauthError, url.searchParams.get("error_description") ?? "");
    if (oauthError === "access_denied") return page("Login cancelado", "Você pode fechar esta aba e tentar de novo pelo app.");
    return page("Falha no login", `O provedor recusou o pedido (${oauthError.slice(0, 60)}). Tente de novo pelo app.`, 400);
  }
  if (!provider || !cookieState || !appState || cookieState !== url.searchParams.get("state"))
    return page("Sessão expirada", "Volte ao AriranhaCast e clique em Entrar de novo.", 400);
  const clientId = provider.clientId(env);
  const clientSecret = provider.clientSecret(env);
  if (!clientId || !clientSecret) return page("Erro", "Este login não está disponível.", 400);

  const tokenRes = await fetch(provider.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "AriranhaCast-Lobby (https://github.com/kenfi2/ariranhacast, 1.0)" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code: url.searchParams.get("code") ?? "",
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  const tok = await tokenRes.json<{ access_token?: string; error?: string; error_description?: string }>().catch(() => ({}) as { access_token?: string; error?: string; error_description?: string });
  if (!tokenRes.ok || !tok.access_token) {
    // Aparece em "npx wrangler tail" e na aba Logs do Worker. Nunca inclui o segredo.
    console.log(`login ${provider.id}: troca do código falhou`, tokenRes.status, tok.error ?? "", tok.error_description ?? "", "redirect_uri:", `${url.origin}/auth/callback`);
    const code = String(tok.error ?? `HTTP ${tokenRes.status}`).slice(0, 60);
    const hint =
      code === "invalid_client" ? "Client ID ou Client Secret errado no servidor." :
      code === "invalid_grant" ? "O código expirou ou o endereço de retorno não confere com o cadastrado." :
      tokenRes.status === 429 ? "Limite de requisições do provedor; tente de novo em alguns minutos." : "";
    return page("Falha no login", `O ${provider.label} recusou o login (${code}). ${hint}`, 401);
  }

  const meRes = await fetch(provider.userinfo, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json", "User-Agent": "AriranhaCast-Lobby (https://github.com/kenfi2/ariranhacast, 1.0)" } });
  const info = meRes.ok ? provider.toUser(await meRes.json().catch(() => null)) : null;
  if (!info) {
    console.log(`login ${provider.id}: leitura da conta falhou`, meRes.status);
    return page("Falha no login", `Não foi possível ler sua conta do ${provider.label} (HTTP ${meRes.status}). Tente de novo.`, 502);
  }

  const user: User = { ...info, id: `${provider.id}:${info.id}`, provider: provider.id };
  const sessionToken = await lobby.createSession(user);
  // Servidores do Discord: para mostrar primeiro as salas de quem está nos mesmos servidores.
  if (provider.groups) {
    try {
      await lobby.saveGuilds(user.id, await provider.groups(tok.access_token));
    } catch (e) {
      console.log(`login ${provider.id}: lista de servidores falhou`, String(e));
    }
  }

  // Login pela versão web: volta para o site, com o token no fragmento (#), que não vai ao servidor
  // nem aparece no Referer. Endereço fixo do próprio lobby: nada de redirecionar para fora.
  if (target === "web") {
    const back = `${url.origin}/web/#auth?token=${sessionToken}&app_state=${encodeURIComponent(appState)}`;
    return page("Login concluído", "Voltando para o AriranhaCast…", 200, back);
  }
  const deepLink = `${APP_SCHEME}://auth?token=${sessionToken}&app_state=${encodeURIComponent(appState)}`;
  return page("Login concluído", "Voltando para o AriranhaCast… pode fechar esta aba.", 200, deepLink);
}

/** Arquivo da versão web, com cabeçalhos de segurança (a página também traz o próprio CSP). */
async function webAsset(req: Request, assets: Fetcher): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
  const res = await assets.fetch(req);
  const out = new Response(res.body, res);
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()");
  // index.html sempre fresco (o app.js muda a cada versão).
  if ((res.headers.get("Content-Type") ?? "").startsWith("text/html")) out.headers.set("Cache-Control", "no-cache");
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const lobby = env.LOBBY.getByName("main");

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    switch (url.pathname) {
      // Quais botões de login o app mostra.
      case "/auth/providers":
        return json(enabledProviders(env).map((p) => ({ id: p.id, label: p.label })));

      // 1) O app abre esta URL no navegador, com o provedor e um app_state aleatório gerado por ele.
      case "/auth/login": {
        const provider = enabledProviders(env).find((p) => p.id === url.searchParams.get("provider"));
        const appState = url.searchParams.get("app_state") ?? "";
        if (!provider || !SAFE_STATE.test(appState)) return page("Erro", "Abra o login pelo AriranhaCast.", 400);

        const state = randomHex(16);
        const auth = new URL(provider.authorize);
        auth.search = new URLSearchParams({
          client_id: provider.clientId(env)!,
          redirect_uri: `${url.origin}/auth/callback`,
          response_type: "code",
          scope: provider.scope,
          state,
          ...provider.extraAuthParams,
        }).toString();

        return new Response(null, {
          status: 302,
          headers: {
            Location: auth.toString(),
            "Set-Cookie": `oauth=${state}.${appState}.${provider.id}.${url.searchParams.get("target") === "web" ? "web" : "app"}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth`,
            "Cache-Control": "no-store",
          },
        });
      }

      // 2) O provedor volta aqui com ?code=...&state=...
      case "/auth/callback":
        try {
          return await callback(req, url, env, lobby);
        } catch (e) {
          console.log("login: erro inesperado", String(e));
          return page("Falha no login", "Erro ao falar com o provedor. Tente de novo em instantes.", 502);
        }

      // O app valida o token salvo e pega nome/avatar.
      case "/me": {
        const token = bearer(req);
        const user = token ? await lobby.getSession(token) : null;
        return user ? json(user) : json({ error: "unauthorized" }, 401);
      }

      case "/auth/logout": {
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        const token = bearer(req);
        if (token) await lobby.deleteSession(token);
        return json({ ok: true });
      }

      // WebSocket do lobby; a autenticação acontece dentro do Durable Object.
      case "/lobby":
        return lobby.fetch(req);

      default: {
        // Link de convite clicável (o Discord não deixa clicar em ariranhacast://): abre o app na sala.
        const m = /^\/entrar\/([A-Za-z0-9]{4,16})\/?$/.exec(url.pathname);
        if (m) {
          const code = m[1].toUpperCase();
          const download = /^https:\/\//.test(env.DOWNLOAD_URL ?? "") ? env.DOWNLOAD_URL! : "https://github.com/kenfi2/ariranhacast/releases/latest";
          const extras = [{ href: download, label: "Ainda não tenho o app" }];
          if (env.ASSETS) extras.unshift({ href: `/web/#entrar/${code}`, label: "Assistir no navegador" });
          return page(`Sala ${code}`, "Abrindo o AriranhaCast… Se nada acontecer, toque no botão abaixo.", 200, `${APP_SCHEME}://entrar/${code}`, extras);
        }
        // Versão web: o site do AriranhaCast.
        if (env.ASSETS && (url.pathname === "/" || url.pathname === "/web")) return Response.redirect(`${url.origin}/web/`, 302);
        if (env.ASSETS && url.pathname.startsWith("/web/")) return webAsset(req, env.ASSETS);
        return json({ error: "not found" }, 404);
      }
    }
  },
} satisfies ExportedHandler<Env>;
