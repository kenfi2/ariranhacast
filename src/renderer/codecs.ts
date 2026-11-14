import type { CodecChoice, EncodeOpts } from './types';

const MIME: Record<Exclude<CodecChoice, 'auto'>, string> = {
  AV1: 'video/AV1',
  H265: 'video/H265',
  H264: 'video/H264',
  VP9: 'video/VP9',
  VP8: 'video/VP8',
};

function sendCodecs(): RTCRtpCodec[] {
  return RTCRtpSender.getCapabilities('video')?.codecs ?? [];
}

export function availableCodecs(): CodecChoice[] {
  const have = new Set(sendCodecs().map((c) => c.mimeType.toLowerCase()));
  const list = (Object.keys(MIME) as Exclude<CodecChoice, 'auto'>[]).filter((k) =>
    have.has(MIME[k].toLowerCase()),
  );
  return ['auto', ...list];
}

async function hardware(mime: string, opts: EncodeOpts, width: number, height: number): Promise<boolean> {
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: { contentType: mime, width, height, bitrate: opts.maxBitrate, framerate: opts.maxFps },
    });
    return info.supported && info.powerEfficient;
  } catch {
    return false;
  }
}

/**
 * Decide o codec de envio. No automático: AV1 se a GPU tiver encoder AV1 (melhor para
 * tela), senão H.264 (encoder por hardware em praticamente qualquer GPU; e o fallback
 * por software dele é o mais leve).
 */
export async function pickCodec(opts: EncodeOpts, width: number, height: number): Promise<string> {
  const have = new Set(sendCodecs().map((c) => c.mimeType.toLowerCase()));
  if (opts.codec !== 'auto' && have.has(MIME[opts.codec].toLowerCase())) return MIME[opts.codec];
  if (have.has('video/av1') && (await hardware('video/AV1', opts, width, height))) return MIME.AV1;
  if (have.has('video/h264')) return MIME.H264;
  return MIME.VP8;
}

/** Coloca o codec escolhido em primeiro; os demais ficam como fallback de negociação. */
export function preferCodec(transceiver: RTCRtpTransceiver, mime: string): void {
  const order = (codecs: RTCRtpCodec[]): RTCRtpCodec[] => {
    const want = mime.toLowerCase();
    const aux = (c: RTCRtpCodec) => /rtx|red|ulpfec|flexfec/i.test(c.mimeType);
    const first = codecs.filter((c) => c.mimeType.toLowerCase() === want);
    const rest = codecs.filter((c) => c.mimeType.toLowerCase() !== want && !aux(c));
    return [...first, ...rest, ...codecs.filter(aux)];
  };
  for (const caps of [RTCRtpSender.getCapabilities('video'), RTCRtpReceiver.getCapabilities('video')]) {
    if (!caps) continue;
    try {
      transceiver.setCodecPreferences(order(caps.codecs));
      return;
    } catch {
      /* tenta a outra lista de capacidades */
    }
  }
}
