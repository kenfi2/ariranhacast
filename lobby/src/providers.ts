import type { Env, Guild, User } from "./types";

/** Provedores de login (OAuth2). Para incluir outro, basta acrescentar uma entrada aqui. */
export interface Provider {
  id: string;
  label: string;
  authorize: string;
  token: string;
  userinfo: string;
  scope: string;
  extraAuthParams?: Record<string, string>;
  clientId(env: Env): string | undefined;
  clientSecret(env: Env): string | undefined;
  toUser(raw: any): Omit<User, "provider"> | null;
  /** Grupos do usuário no provedor (Discord: servidores). Opcional. */
  groups?(accessToken: string): Promise<Guild[]>;
}

const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, max) : "";

const httpsUrl = (v: unknown): string | null => {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
};

export const PROVIDERS: Provider[] = [
  {
    id: "discord",
    label: "Discord",
    authorize: "https://discord.com/oauth2/authorize",
    token: "https://discord.com/api/oauth2/token",
    userinfo: "https://discord.com/api/v10/users/@me",
    scope: "identify guilds",
    clientId: (env) => env.DISCORD_CLIENT_ID,
    clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
    toUser: (u) => {
      const id = str(u?.id, 32);
      if (!/^\d{5,25}$/.test(id)) return null;
      const avatar = /^(a_)?[0-9a-f]{32}$/.test(String(u?.avatar)) ? `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.png?size=128` : null;
      return { id, name: str(u?.global_name, 24) || str(u?.username, 24) || "Usuário", avatar };
    },
    groups: async (accessToken) => {
      const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
        headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "AriranhaCast-Lobby (https://github.com/kenfi2/ariranhacast, 1.0)" },
      });
      if (!res.ok) throw new Error(`guilds HTTP ${res.status}`);
      const list = (await res.json()) as unknown;
      if (!Array.isArray(list)) return [];
      return list.slice(0, 250).flatMap((g): Guild[] => {
        const id = str(g?.id, 25);
        if (!/^\d{5,25}$/.test(id)) return [];
        const icon = /^(a_)?[0-9a-f]{32}$/.test(String(g?.icon)) ? `https://cdn.discordapp.com/icons/${id}/${g.icon}.png?size=64` : null;
        return [{ id, name: str(g?.name, 60) || "Servidor", icon }];
      });
    },
  },
  {
    id: "google",
    label: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid profile",
    extraAuthParams: { prompt: "select_account" },
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    toUser: (u) => {
      const id = str(u?.sub, 64);
      if (!id) return null;
      const pic = httpsUrl(u?.picture);
      return { id, name: str(u?.given_name, 24) || str(u?.name, 24) || "Usuário", avatar: pic && new URL(pic).hostname.endsWith(".googleusercontent.com") ? pic : null };
    },
  },
];

export function enabledProviders(env: Env): Provider[] {
  return PROVIDERS.filter((p) => p.clientId(env) && p.clientSecret(env));
}
