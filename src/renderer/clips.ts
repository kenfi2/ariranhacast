/**
 * Replay: mantém os últimos segundos de uma transmissão em memória para salvar um clipe.
 * Dois gravadores se revezam, defasados em `seconds`: a qualquer momento o mais antigo tem
 * entre `seconds` e 2×`seconds` de vídeo, e é ele que vira o clipe. Nada vai para o disco
 * até a pessoa pedir.
 */
export interface ClipResult {
  data: ArrayBuffer;
  ext: 'mp4' | 'webm';
  seconds: number;
}

const TYPES: Array<[string, 'mp4' | 'webm']> = [
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm'],
];

interface Take {
  rec: MediaRecorder;
  chunks: Blob[];
  started: number;
}

export class ClipBuffer {
  private takes: Take[] = [];
  private timer = 0;
  private mime = '';
  private ext: 'mp4' | 'webm' = 'webm';
  private closed = false;

  /** Assinatura das faixas gravadas: se a transmissão ganhar/perder faixas, o replay é recriado. */
  readonly key: string;
  private stream: MediaStream;

  static keyOf(source: MediaStream): string {
    return source.id + ':' + source.getTracks().filter((t) => t.readyState === 'live').map((t) => t.id).join(',');
  }

  constructor(
    source: MediaStream,
    private seconds: number,
  ) {
    this.key = ClipBuffer.keyOf(source);
    // Cópia com as faixas atuais: o gravador para se a lista de faixas mudar durante a gravação.
    this.stream = new MediaStream(source.getTracks().filter((t) => t.readyState === 'live'));
    const hit = TYPES.find(([m]) => MediaRecorder.isTypeSupported(m));
    if (!hit) throw new Error('gravação não suportada');
    [this.mime, this.ext] = hit;
    this.begin();
    this.timer = window.setInterval(() => this.rotate(), seconds * 1000);
  }

  private begin(): void {
    try {
      const rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
      const take: Take = { rec, chunks: [], started: Date.now() };
      rec.ondataavailable = (e) => {
        if (e.data.size) take.chunks.push(e.data);
      };
      rec.onerror = (e) => console.log('[LC] clip rec error', String((e as any).error ?? e));
      rec.start(1000);
      this.takes.push(take);
    } catch {
      /* a faixa acabou ou o formato foi recusado: fica sem replay */
    }
  }

  private rotate(): void {
    if (this.closed) return;
    this.begin();
    while (this.takes.length > 2) this.discard(this.takes.shift()!);
  }

  private discard(t: Take): void {
    t.rec.ondataavailable = null;
    if (t.rec.state !== 'inactive') t.rec.stop();
    t.chunks.length = 0;
  }

  get ready(): boolean {
    return this.takes.some((t) => t.rec.state === 'recording');
  }

  /** Fecha o gravador mais antigo e devolve o que ele tem; o replay continua com o outro. */
  save(): Promise<ClipResult | null> {
    const take = this.takes.find((t) => t.rec.state === 'recording');
    if (!take) return Promise.resolve(null);
    this.takes = this.takes.filter((t) => t !== take);
    if (!this.takes.length) this.begin();
    return new Promise((resolve) => {
      const finish = async () => {
        const blob = new Blob(take.chunks, { type: this.mime });
        take.chunks.length = 0;
        resolve(blob.size ? { data: await blob.arrayBuffer(), ext: this.ext, seconds: Math.round((Date.now() - take.started) / 1000) } : null);
      };
      take.rec.onstop = () => void finish();
      take.rec.onerror = () => resolve(null);
      take.rec.stop();
    });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const t of this.takes) this.discard(t);
    this.takes = [];
  }
}
