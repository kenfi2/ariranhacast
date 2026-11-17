import { DurableObject } from "cloudflare:workers";
import type { Env, Room, User } from "./types";

type Attachment = { user: User; room?: Room };

const SESSION_TTL_MS = 60 * 24 * 3600_000; // 60 dias sem precisar logar de novo
const MAX_MESSAGE = 4096;
const CODE_RE = /^[A-Z0-9]{4,16}$/;

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

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ user } satisfies Attachment);
    server.send(JSON.stringify({ type: "welcome", user, rooms: this.rooms() }));

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
        const members = Array.isArray(msg.members) ? msg.members.slice(0, 16).map((m) => clean(m, 24)).filter(Boolean) : [];
        const room: Room = {
          code,
          name: clean(msg.name, 40) || `Sala de ${att.user.name}`,
          locked: msg.locked === true,
          host: att.user,
          count: int(msg.count, 1, 16),
          members,
          live: int(msg.live, 0, 16),
          proto: int(msg.proto, 0, 1000),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        };
        // Só reenvia a lista se algo visível mudou.
        const changed = !prev || JSON.stringify({ ...prev, updatedAt: 0 }) !== JSON.stringify({ ...room, updatedAt: 0 });
        ws.serializeAttachment({ user: att.user, room } satisfies Attachment);
        if (changed) this.broadcastRooms();
        break;
      }
      case "close_room": {
        if (att.room) {
          ws.serializeAttachment({ user: att.user } satisfies Attachment);
          this.broadcastRooms();
        }
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

  private broadcastRooms(except?: WebSocket): void {
    const msg = JSON.stringify({ type: "rooms", rooms: this.rooms(except) });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(msg);
      } catch {
        /* socket morrendo; o close dele chega depois */
      }
    }
  }
}
