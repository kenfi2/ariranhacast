import type { Lobby } from "./lobby";

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>;
  // Cada provedor só aparece no app se o Client ID e o segredo estiverem configurados.
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string; // wrangler secret put DISCORD_CLIENT_SECRET
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string; // wrangler secret put GOOGLE_CLIENT_SECRET
}

export type User = {
  id: string; // "<provedor>:<id na conta>", ex.: "discord:1234"
  name: string;
  avatar: string | null; // URL https do avatar ou null
  provider: string;
};

/** Sala listada no lobby. Quem hospeda publica; some quando o WebSocket de quem hospeda fecha. */
export type Room = {
  code: string; // código da sala (PeerJS)
  name: string;
  locked: boolean; // tem senha
  host: User;
  count: number; // pessoas na sala
  members: string[]; // nomes
  live: number; // quantas transmissões ao vivo
  proto: number; // versão do protocolo da sala (app incompatível vê aviso)
  createdAt: number;
  updatedAt: number;
};
