// Toca o PCM (s16le estéreo 48 kHz) que chega do audiocap.exe. Roda na thread de áudio.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000; // 1 s de buffer circular
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      const pcm = new Int16Array(e.data);
      const frames = pcm.length >> 1;
      for (let i = 0; i < frames; i++) {
        this.left[this.write] = pcm[i * 2] / 32768;
        this.right[this.write] = pcm[i * 2 + 1] / 32768;
        this.write = (this.write + 1) % this.size;
      }
      this.count += frames;
      // Atrasou demais (acima de 250 ms): descarta o excesso para não perder a sincronia com o vídeo.
      if (this.count > 12000) {
        const drop = this.count - 2400;
        this.read = (this.read + drop) % this.size;
        this.count -= drop;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (!this.playing && this.count >= 1920) this.playing = true; // 40 ms de folga
    if (!this.playing || this.count < n) {
      this.playing = false;
      return true; // silêncio
    }
    for (let i = 0; i < n; i++) {
      out[0][i] = this.left[this.read];
      if (out[1]) out[1][i] = this.right[this.read];
      this.read = (this.read + 1) % this.size;
    }
    this.count -= n;
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
