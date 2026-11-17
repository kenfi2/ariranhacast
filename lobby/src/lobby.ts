import { DurableObject } from "cloudflare:workers";
import type { Env, Guild, Online, Room, User } from "./types";

/** room = sala publicada (só quem hospeda); at/device = onde a pessoa está (todo mundo informa). */
type Attachment = { user: User; room?: Room; at?: string | null; device?: string };

const SESSION_TTL_MS = 60 * 24 * 3600_000; // 60 dias sem precisar logar de novo
const MAX_MESSAGE = 4096;
const CODE_RE = /^[A-Z0-9]{4,16}$/;
/** Quanto tempo uma sala pode sumir da lista (troca de quem hospeda, rede piscando) antes do aviso "encerrada". */
const CLOSE_GRACE_MS = 30_000;

/** Texto seguro para mensagem do Discord: sem markdown, menções ou links. */
function discordText(s: string): string {
  return s.replace(/[\\*_~`|>#\[\]()@:<]/g, (c) => `\\${c}`).replace(/https?\/\//gi, "");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Texto vindo do app: tira caracteres de controle/formatação (inclusive os que invertem o texto) e limita o tamanho. */
function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, max) : "";
}

const int = (v: unknown, min: number, max: number) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v as number)) : min);

/**
 * Um único objeto ("main") guarda as sessões (SQLite) e os WebSockets do lobby.
 * Cada aparelho tem a sua sessão: a mesma conta pode estar no PC e no celular ao mesmo tempo.
 * Usa a API de hibernação: conectado e sem mensagens, não gasta tempo de execução.
 */
export class Lobby extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY,
      user       TEXT NOT NULL,
      expires    INTEGER NOT NULL
    )`);
    // Servidores do Discord de cada conta (atualizados a cada login).
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS accounts(
      user_id TEXT PRIMARY KEY,
      guilds  TEXT NOT NULL
    )`);
    // Salas anunciadas no canal do Discord (webhook): para marcar como encerradas depois.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS announced(
      code       TEXT PRIMARY KEY,
      message_id TEXT,
      name       TEXT NOT NULL,
      host       TEXT NOT NULL,
      gone_since INTEGER
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    // "ping" → "pong" sem acordar o objeto (keep-alive grátis).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- sessões (chamadas via RPC pelo Worker) ----------

  async createSession(user: User): Promise<string> {
    const token = randomHex(32);
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE expires < ?", now);
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions(token_hash, user, expires) VALUES (?, ?, ?)",
      await sha256(token), JSON.stringify(user), now + SESSION_TTL_MS,
    );
    return token;
  }

  async getSession(token: string): Promise<User | null> {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const row = this.ctx.storage.sql
      .exec<{ user: string }>("SELECT user FROM sessions WHERE token_hash = ? AND expires > ?", await sha256(token), Date.now())
      .toArray()[0];
    return row ? (JSON.parse(row.user) as User) : null;
  }

  async saveGuilds(userId: string, guilds: Guild[]): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO accounts(user_id, guilds) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET guilds = excluded.guilds",
      userId, JSON.stringify(guilds.slice(0, 250)),
    );
  }

  private guildsOf(userId: string): Guild[] {
    const row = this.ctx.storage.sql.exec<{ guilds: string }>("SELECT guilds FROM accounts WHERE user_id = ?", userId).toArray()[0];
    try {
      return row ? (JSON.parse(row.guilds) as Guild[]) : [];
    } catch {
      return [];
    }
  }

  async deleteSession(token: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(token)) return;
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
  }

  // ---------- WebSocket do lobby ----------

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });

    // O app conecta com: new WebSocket(url, ["ariranhacast", token])
    const [proto, token] = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim());
    if (proto !== "ariranhacast" || !token) return new Response("unauthorized", { status: 401 });
    const user = await this.getSession(token);
    if (!user) return new Response("unauthorized", { status: 401 });

    // Endereço público do lobby, para os links dos avisos no Discord.
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta(k, v) VALUES ('origin', ?)", new URL(req.url).origin);

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ user } satisfies Attachment);
    const guilds = this.guildsOf(user.id);
    const cache = new Map<string, Set<string>>();
    server.send(JSON.stringify({ type: "welcome", user, guilds, rooms: this.roomsFor(user, this.rooms(), cache), online: this.onlineFor(user, cache) }));
    this.broadcastRooms(undefined, server); // os outros veem que esta pessoa ficou online

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "ariranhacast" },
    });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return ws.close(1009, "message too big");

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.close(1003, "invalid json");
    }
    if (!msg || typeof msg !== "object") return ws.close(1003, "invalid message");

    const att = ws.deserializeAttachment() as Attachment;

    switch (msg.type) {
      // Quem hospeda publica (ou atualiza) a sala. Também é usado por quem assume a sala depois.
      case "set_room": {
        const code = clean(msg.code, 16).toUpperCase();
        if (!CODE_RE.test(code)) return ws.send(JSON.stringify({ type: "error", message: "invalid code" }));
        const now = Date.now();
        const prev = att.room?.code === code ? att.room : undefined;
        const members = Array.isArray(msg.members) ? msg.members.slice(0, 20).map((m) => clean(m, 24)).filter(Boolean) : [];
        const room: Room = {
          code,
          name: clean(msg.name, 40) || `Sala de ${att.user.name}`,
          locked: msg.locked === true,
          host: att.user,
          count: int(msg.count, 1, 50),
          max: msg.max === undefined ? 16 : int(msg.max, 2, 50),
          members,
          live: int(msg.live, 0, 16),
          proto: int(msg.proto, 0, 1000),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        };
        // Só reenvia a lista se algo visível mudou.
        const changed = !prev || JSON.stringify({ ...prev, updatedAt: 0 }) !== JSON.stringify({ ...room, updatedAt: 0 });
        ws.serializeAttachment({ ...att, room } satisfies Attachment);
        if (changed) this.broadcastRooms();
        if (!prev) await this.announceOpen(room);
        break;
      }
      case "close_room": {
        if (att.room) {
          ws.serializeAttachment({ ...att, room: undefined } satisfies Attachment);
          this.broadcastRooms();
        }
        break;
      }
      // Onde a pessoa está agora (sala em que entrou, ou nenhuma) e de que aparelho.
      case "presence": {
        const at = typeof msg.room === "string" && CODE_RE.test(msg.room.toUpperCase()) ? msg.room.toUpperCase() : null;
        const device = msg.device === "android" ? "android" : "pc";
        if (att.at === at && att.device === device) break;
        ws.serializeAttachment({ ...att, at, device } satisfies Attachment);
        this.broadcastRooms();
        break;
      }
      default:
        ws.send(JSON.stringify({ type: "error", message: "unknown message type" }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close(1000, "bye");
    } catch {
      /* já fechado */
    }
    this.broadcastRooms(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastRooms(ws);
  }

  // ---------- helpers ----------

  /** Salas abertas. Se duas conexões publicam o mesmo código (troca de quem hospeda), vale a mais recente. */
  private rooms(except?: WebSocket): Room[] {
    const byCode = new Map<string, Room>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const room = (ws.deserializeAttachment() as Attachment | null)?.room;
      if (!room) continue;
      const cur = byCode.get(room.code);
      if (!cur || room.updatedAt > cur.updatedAt) byCode.set(room.code, room);
    }
    return [...byCode.values()].sort((a, b) => b.count - a.count || a.createdAt - b.createdAt);
  }

  /** A lista como `viewer` a vê: cada sala com os servidores do Discord em comum com quem hospeda. */
  private roomsFor(viewer: User, rooms: Room[], cache: Map<string, Set<string>>): Room[] {
    const ids = (userId: string) => {
      let set = cache.get(userId);
      if (!set) cache.set(userId, (set = new Set(this.guildsOf(userId).map((g) => g.id))));
      return set;
    };
    const mine = ids(viewer.id);
    return rooms.map((r) => {
      if (!mine.size) return { ...r, guilds: [] };
      const theirs = ids(r.host.id);
      return { ...r, guilds: [...mine].filter((g) => theirs.has(g)).slice(0, 10) };
    });
  }

  /**
   * "Online agora" como `viewer` vê: quem está conectado ao lobby e tem algum servidor do Discord
   * em comum com ele (cada conta uma vez, juntando PC e celular). Sem servidor em comum, não aparece.
   */
  private onlineFor(viewer: User, cache: Map<string, Set<string>>, gone?: WebSocket): Online[] {
    const ids = (userId: string) => {
      let set = cache.get(userId);
      if (!set) cache.set(userId, (set = new Set(this.guildsOf(userId).map((g) => g.id))));
      return set;
    };
    const mine = ids(viewer.id);
    if (!mine.size) return [];
    const byUser = new Map<string, Online>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === gone) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.user || a.user.id === viewer.id) continue;
      let o = byUser.get(a.user.id);
      if (!o) {
        const shared = [...ids(a.user.id)].filter((g) => mine.has(g));
        if (!shared.length) continue;
        byUser.set(a.user.id, (o = { id: a.user.id, name: a.user.name, avatar: a.user.avatar, room: null, devices: [], guilds: shared.slice(0, 10) }));
      }
      const device = a.device ?? "pc";
      if (!o.devices.includes(device)) o.devices.push(device);
      o.room ??= a.at ?? a.room?.code ?? null;
    }
    return [...byUser.values()].sort((x, y) => Number(!!y.room) - Number(!!x.room) || x.name.localeCompare(y.name, "pt-BR")).slice(0, 100);
  }

  /** Manda a lista de salas e o "online agora" para todos. `gone` = conexão que está fechando; `skip` = não enviar para ela. */
  private broadcastRooms(gone?: WebSocket, skip?: WebSocket): void {
    const rooms = this.rooms(gone);
    const cache = new Map<string, Set<string>>();
    const perUser = new Map<string, string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === gone || ws === skip) continue;
      const user = (ws.deserializeAttachment() as Attachment | null)?.user;
      if (!user) continue;
      let msg = perUser.get(user.id);
      if (!msg) perUser.set(user.id, (msg = JSON.stringify({ type: "rooms", rooms: this.roomsFor(user, rooms, cache), online: this.onlineFor(user, cache, gone) })));
      try {
        ws.send(msg);
      } catch {
        /* socket morrendo; o close dele chega depois */
      }
    }
    this.trackClosed(rooms);
  }

  // ---------- avisos no canal do Discord (webhook) ----------

  private webhook(): string | null {
    const url = this.env.DISCORD_WEBHOOK_URL ?? "";
    return /^https:\/\/(?:discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(url) ? url : null;
  }

  private openText(code: string, name: string, host: string, locked: boolean): string {
    const origin = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'origin'").toArray()[0]?.v ?? "";
    const link = origin ? `\n<${origin}/entrar/${code}>` : "";
    return `🟢 **${discordText(host)}** abriu a sala **${discordText(name)}**${locked ? " 🔒" : ""}${link}`;
  }

  private async send(method: "POST" | "PATCH", path: string, content: string): Promise<{ id?: string } | null> {
    const hook = this.webhook();
    if (!hook) return null;
    try {
      const res = await fetch(`${hook}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        // Ao criar: flags 4 = sem prévia do link. Ao editar, só o texto (a edição não aceita trocar flags).
        body: JSON.stringify(method === "POST" ? { content: content.slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4 } : { content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) {
        console.log("webhook do Discord falhou", res.status, await res.text().catch(() => ""));
        return null;
      }
      return method === "POST" ? await res.json<{ id?: string }>().catch(() => null) : {};
    } catch (e) {
      console.log("webhook do Discord falhou", String(e));
      return null;
    }
  }

  /** Servidor do Discord dono do webhook (perguntado ao Discord uma vez e guardado). */
  private async webhookGuild(): Promise<string | null> {
    const hook = this.webhook();
    if (!hook) return null;
    const key = `webhook_guild:${hook.split("/").slice(-2, -1)[0]}`;
    const cached = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", key).toArray()[0]?.v;
    if (cached) return cached;
    try {
      const res = await fetch(hook);
      const info = res.ok ? await res.json<{ guild_id?: string }>() : null;
      const id = typeof info?.guild_id === "string" && /^\d+$/.test(info.guild_id) ? info.guild_id : null;
      if (id) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)", key, id);
      else console.log("webhook do Discord: não deu para saber o servidor", res.status);
      return id;
    } catch (e) {
      console.log("webhook do Discord: não deu para saber o servidor", String(e));
      return null;
    }
  }

  /** Sala nova (ou que voltou dentro do prazo) → avisa no canal; se já estava anunciada, só tira o "sumiu". */
  private async announceOpen(room: Room): Promise<void> {
    if (!this.webhook()) return;
    // Só avisa salas de quem é membro do servidor onde o webhook foi criado.
    const guild = await this.webhookGuild();
    if (!guild || !this.guildsOf(room.host.id).some((g) => g.id === guild)) return;
    const prev = this.ctx.storage.sql.exec<{ message_id: string | null }>("SELECT message_id FROM announced WHERE code = ?", room.code).toArray()[0];
    if (prev) {
      this.ctx.storage.sql.exec("UPDATE announced SET gone_since = NULL, name = ?, host = ? WHERE code = ?", room.name, room.host.name, room.code);
      return;
    }
    // Marca antes de enviar, para não anunciar duas vezes se outra mensagem chegar no meio.
    this.ctx.storage.sql.exec("INSERT INTO announced(code, message_id, name, host, gone_since) VALUES (?, NULL, ?, ?, NULL)", room.code, room.name, room.host.name);
    const msg = await this.send("POST", "?wait=true", this.openText(room.code, room.name, room.host.name, room.locked));
    if (msg?.id && /^\d+$/.test(msg.id)) this.ctx.storage.sql.exec("UPDATE announced SET message_id = ? WHERE code = ?", msg.id, room.code);
  }

  /** Salas anunciadas que sumiram da lista: marca a hora e agenda a confirmação. */
  private trackClosed(rooms: Room[]): void {
    if (!this.webhook()) return;
    const open = new Set(rooms.map((r) => r.code));
    const now = Date.now();
    let pending = false;
    for (const row of this.ctx.storage.sql.exec<{ code: string; gone_since: number | null }>("SELECT code, gone_since FROM announced").toArray()) {
      if (open.has(row.code)) {
        if (row.gone_since !== null) this.ctx.storage.sql.exec("UPDATE announced SET gone_since = NULL WHERE code = ?", row.code);
      } else {
        if (row.gone_since === null) this.ctx.storage.sql.exec("UPDATE announced SET gone_since = ? WHERE code = ?", now, row.code);
        pending = true;
      }
    }
    if (pending) {
      console.log("salas anunciadas sumiram da lista; confirmação agendada");
      void this.ctx.storage.setAlarm(now + CLOSE_GRACE_MS + 1000);
    }
  }

  /** Passado o prazo, edita o aviso para "encerrada". */
  async alarm(): Promise<void> {
    const open = new Set(this.rooms().map((r) => r.code));
    const limit = Date.now() - CLOSE_GRACE_MS;
    let pending = false;
    for (const row of this.ctx.storage.sql
      .exec<{ code: string; message_id: string | null; name: string; host: string; gone_since: number | null }>("SELECT * FROM announced WHERE gone_since IS NOT NULL")
      .toArray()) {
      if (open.has(row.code)) {
        this.ctx.storage.sql.exec("UPDATE announced SET gone_since = NULL WHERE code = ?", row.code);
      } else if (row.gone_since! <= limit) {
        console.log("sala encerrada", row.code, row.message_id ? "editando o aviso" : "sem id do aviso");
        this.ctx.storage.sql.exec("DELETE FROM announced WHERE code = ?", row.code);
        if (row.message_id) await this.send("PATCH", `/messages/${row.message_id}`, `⚫ ~~Sala **${discordText(row.name)}** de **${discordText(row.host)}**~~ encerrada`);
      } else pending = true;
    }
    if (pending) await this.ctx.storage.setAlarm(Date.now() + CLOSE_GRACE_MS);
  }
}
