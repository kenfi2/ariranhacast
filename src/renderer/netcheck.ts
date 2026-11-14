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

/**
 * Diagnóstico de rede: descobre se este PC consegue conexões diretas.
 * NAT simétrico = cada destino vê uma porta pública diferente, então o outro lado não
 * consegue "adivinhar" por onde entrar; é o caso típico de CGNAT e exige TURN.
 */
export async function checkNetwork(): Promise<string> {
  const lines: string[] = [];
  const stun = await gather({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }],
  });
  const udp = stun.filter((c) => c.protocol === 'udp');
  const v6 = udp.some((c) => c.type === 'host' && c.address.includes(':') && !/^f[cde]/i.test(c.address) && !c.address.startsWith('::1'));
  const srflx = udp.filter((c) => c.type === 'srflx' && !c.address.includes(':'));

  let restricted = false;
  if (!srflx.length) {
    restricted = true;
    lines.push('✗ Endereço público: não obtido. UDP parece bloqueado (firewall, VPN ou rede corporativa).');
  } else {
    lines.push(`✓ Endereço público: ${mask(srflx[0].address)}`);
    // Mesma porta local vista com portas públicas diferentes por servidores diferentes?
    const byBase = new Map<string, Set<number>>();
    for (const c of srflx) {
      const base = `${c.relatedAddress}:${c.relatedPort}`;
      (byBase.get(base) ?? byBase.set(base, new Set()).get(base)!).add(c.port);
    }
    restricted = [...byBase.values()].some((ports) => ports.size > 1);
    lines.push(
      restricted
        ? '✗ Tipo de NAT: simétrico (típico de CGNAT). Conexão direta só fecha se o outro lado tiver rede aberta.'
        : '✓ Tipo de NAT: compatível com conexão direta.',
    );
  }
  lines.push(v6 ? '✓ IPv6: disponível (ajuda quando o outro lado também tem).' : '– IPv6: não disponível.');

  if (hasTurn()) {
    const relay = await gather({ iceServers: iceServers(), iceTransportPolicy: 'relay' });
    lines.push(relay.some((c) => c.type === 'relay') ? '✓ TURN: configurado e respondendo.' : '✗ TURN: configurado, mas não respondeu (credenciais ou endereço).');
  } else {
    lines.push('– TURN: não configurado.');
  }

  lines.push('');
  lines.push(
    restricted
      ? hasTurn()
        ? 'Resultado: rede restrita, mas com TURN as conexões devem fechar.'
        : 'Resultado: rede restrita. Sem TURN, só conecta com quem tiver rede aberta.'
      : 'Resultado: esta rede aceita conexão direta. Se alguém não conecta, a restrição está do lado dele.',
  );
  return lines.join('\n');
}
