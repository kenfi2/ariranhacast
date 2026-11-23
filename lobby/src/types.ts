import type { Lobby } from "./lobby";

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>;
  /** Versão web (assistir pelo site): arquivos gerados por scripts/build-mobile.mjs --web em lobby/public. */
  ASSETS?: Fetcher;
  // Cada provedor só aparece no app se o Client ID e o segredo estiverem configurados.
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string; // wrangler secret put DISCORD_CLIENT_SECRET
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string; // wrangler secret put GOOGLE_CLIENT_SECRET
  /** Webhook de um canal do Discord: avisa quando uma sala abre/fecha. wrangler secret put DISCORD_WEBHOOK_URL */
  DISCORD_WEBHOOK_URL?: string;
  /** Página para baixar o app (aparece no link de convite). */
  DOWNLOAD_URL?: string;
}

/** Servidor do Discord do usuário (só ele recebe a própria lista). */
export type Guild = { id: string; name: string; icon: string | null };

export type User = {
  id: string; // "<provedor>:<id na conta>", ex.: "discord:1234"
  name: string;
  avatar: string | null; // URL https do avatar ou null
  provider: string;
};

/** Alguém online no lobby, como outra pessoa vê (só aparece quem tem servidor do Discord em comum). */
export type Online = {
  id: string;
  name: string;
  avatar: string | null;
  room: string | null; // código da sala em que está, ou null (na tela inicial)
  live: boolean; // transmitindo a tela
  devices: string[]; // "pc", "android", "web"
  guilds: string[]; // servidores em comum
};

/** Sala listada no lobby. Quem hospeda publica; some quando o WebSocket de quem hospeda fecha. */
export type Room = {
  code: string; // código da sala (PeerJS)
  name: string;
  locked: boolean; // tem senha
  host: User;
  count: number; // pessoas na sala
  max: number; // limite de pessoas escolhido por quem criou a sala
  members: string[]; // nomes (apps antigos)
  people: { name: string; avatar: string | null }[]; // quem está, com a foto da conta
  live: number; // quantas transmissões ao vivo
  proto: number; // versão do protocolo da sala (app incompatível vê aviso)
  private?: boolean; // não aparece na lista global: só para quem tem servidor do Discord em comum com quem hospeda
  guilds?: string[]; // servidores do Discord em comum entre quem hospeda e quem vê (calculado por pessoa)
  createdAt: number;
  updatedAt: number;
};
