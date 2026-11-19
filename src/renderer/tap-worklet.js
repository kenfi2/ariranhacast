// Depuração do áudio: copia o que entra (estéreo, float32) em blocos de 100 ms para a página,
// que manda gravar em WAV. Não altera o som. Roda na thread de áudio.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 4800; // 100 ms a 48 kHz
    this.buf = new Float32Array(this.frames * 2);
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const n = input[0]?.length ?? 128;
    const l = input[0];
    const r = input[1] ?? input[0];
    for (let i = 0; i < n; i++) {
      // Sem canais (faixa muda/parada): grava zeros para manter a linha do tempo.
      this.buf[this.pos * 2] = l ? l[i] : 0;
      this.buf[this.pos * 2 + 1] = r ? r[i] : 0;
      if (++this.pos === this.frames) {
        const out = this.buf;
        this.port.postMessage(out.buffer, [out.buffer]);
        this.buf = new Float32Array(this.frames * 2);
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
