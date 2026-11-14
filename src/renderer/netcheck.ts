import { hasTurn, iceServers } from './signaling';

interface Cand {
  type: string;
  address: string;
  port: number;
  relatedAddress: string;
  relatedPort: number;
  protocol: string;
}

function gather(config: RTCConfiguration, ms = 5000): Promise<Cand[]> {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection(config);
    const found: Cand[] = [];
    const done = () => {
      pc.onicecandidate = null;
      pc.close();
      resolve(found);
    };
    const timer = setTimeout(done, ms);
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        clearTimeout(timer);
        return done();
      }
      const c = e.candidate;
      found.push({
        type: c.type ?? '',
        address: c.address ?? '',
        port: c.port ?? 0,
        relatedAddress: c.relatedAddress ?? '',
        relatedPort: c.relatedPort ?? 0,
        protocol: c.protocol ?? '',
      });
    };
    pc.createDataChannel('probe');
    void pc.createOffer().then((o) => pc.setLocalDescription(o));
  });
}

const mask = (ip: string) => (ip.includes(':') ? ip.split(':').slice(0, 3).join(':') + ':…' : ip.split('.').slice(0, 2).join('.') + '.x.x');

export interface NetInfo {
  publicIp: string; // mascarado
  udp: boolean;
  nat: 'aberto' | 'simétrico' | 'desconhecido';
  v6Address: boolean; // tem endereço IPv6 global na placa
  v6Works: boolean; // conseguiu de fato sair para a internet por IPv6
  turn: 'ok' | 'falhou' | 'sem';
}

/** Teste real de IPv6: tenta alcançar endereços que só existem em IPv6. Ter o endereço na placa não basta. */
async function probeV6(): Promise<boolean> {
  const tryOne = async (url: string): Promise<boolean> => {
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) });
      return true;
    } catch {
      return false;
    }
  };
  const results = await Promise.all([tryOne('https://ipv6.google.com/generate_204'), tryOne('https://api6.ipify.org/')]);
  return results.some(Boolean);
}

export async function probeNetwork(): Promise<NetInfo> {
  const [stun, v6Works] = await Promise.all([
    gather({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] }),
    probeV6(),
  ]);
  const udp = stun.filter((c) => c.protocol === 'udp');
  const v6Address = udp.some((c) => c.address.includes(':') && !/^f[cde]/i.test(c.address) && !c.address.startsWith('::1'));
  const srflx = udp.filter((c) => c.type === 'srflx' && !c.address.includes(':'));
  let nat: NetInfo['nat'] = 'desconhecido';
  if (srflx.length) {
    // Mesma porta local vista com portas públicas diferentes por servidores diferentes?
    const byBase = new Map<string, Set<number>>();
    for (const c of srflx) {
      const base = `${c.relatedAddress}:${c.relatedPort}`;
      (byBase.get(base) ?? byBase.set(base, new Set()).get(base)!).add(c.port);
    }
    nat = [...byBase.values()].some((ports) => ports.size > 1) ? 'simétrico' : 'aberto';
  }
  let turn: NetInfo['turn'] = 'sem';
  if (hasTurn()) {
    const relay = await gather({ iceServers: iceServers(), iceTransportPolicy: 'relay' });
    turn = relay.some((c) => c.type === 'relay') ? 'ok' : 'falhou';
  }
  return { publicIp: srflx.length ? mask(srflx[0].address) : '', udp: srflx.length > 0, nat, v6Address, v6Works, turn };
}

/**
 * Diagnóstico de rede: descobre se este PC consegue conexões diretas.
 * NAT simétrico = cada destino vê uma porta pública diferente, então o outro lado não
 * consegue "adivinhar" por onde entrar; é o caso típico de CGNAT e exige TURN (ou IPv6 nos dois lados).
 */
export function describeNetwork(n: NetInfo): string {
  const lines: string[] = [];
  const restricted = !n.udp || n.nat === 'simétrico';
  if (!n.udp) lines.push('✗ Endereço público: não obtido. UDP parece bloqueado (firewall, VPN ou rede corporativa).');
  else {
    lines.push(`✓ Endereço público: ${n.publicIp}`);
    lines.push(
      n.nat === 'simétrico'
        ? '✗ Tipo de NAT: simétrico (típico de CGNAT). Por IPv4, conexão direta só fecha se o outro lado tiver rede aberta.'
        : '✓ Tipo de NAT: compatível com conexão direta.',
    );
  }
  lines.push(
    n.v6Works
      ? '✓ IPv6: funcionando de verdade (testado). Se o outro lado também tiver, a conexão direta fecha mesmo com CGNAT.'
      : n.v6Address
        ? '✗ IPv6: o PC tem endereço, mas não saiu para a internet por ele (roteador/operadora bloqueando).'
        : '– IPv6: não disponível nesta rede.',
  );
  lines.push(n.turn === 'ok' ? '✓ TURN: configurado e respondendo.' : n.turn === 'falhou' ? '✗ TURN: configurado, mas não respondeu (credenciais ou endereço).' : '– TURN: não configurado.');
  lines.push('');
  lines.push(
    !restricted
      ? 'Resultado: esta rede aceita conexão direta. Se alguém não conecta, a restrição está do lado dele.'
      : n.v6Works
        ? 'Resultado: IPv4 restrito, mas o IPv6 funciona. Conecta direto com quem também tiver IPv6 ou rede aberta.'
        : n.turn === 'ok'
          ? 'Resultado: rede restrita; as conexões fecham pelo TURN (que consome a franquia).'
          : 'Resultado: rede restrita e sem IPv6. Sem TURN, só conecta com quem tiver rede aberta. Vale pedir IPv6 ou IP público à operadora.',
  );
  return lines.join('\n');
}

export async function checkNetwork(): Promise<string> {
  return describeNetwork(await probeNetwork());
}
