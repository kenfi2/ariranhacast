// Navegador (versão web): vídeo/áudio com som só toca depois de um clique na página. Quando o play
// é recusado, o vídeo toca sem som e o som volta no primeiro clique ou tecla (vale para as vozes
// também). No Electron o play nunca é recusado e nada disso acontece.
const waiting = new Map<HTMLMediaElement, boolean>(); // elemento → estava sem som antes
const contexts = new Set<AudioContext>();
let banner: HTMLButtonElement | null = null;

function showBanner(on: boolean): void {
  if (on && !banner) {
    banner = document.createElement('button');
    banner.type = 'button';
    banner.className = 'autoplay-banner';
    banner.textContent = '🔇 Clique em qualquer lugar para ativar o som';
    document.body.append(banner);
  } else if (!on && banner) {
    banner.remove();
    banner = null;
  }
}

function unlock(): void {
  for (const ctx of contexts) if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  if (!waiting.size) return;
  for (const [el, wasMuted] of waiting) {
    el.muted = wasMuted;
    void el.play().catch(() => {});
  }
  waiting.clear();
  showBanner(false);
}
for (const ev of ['pointerdown', 'keydown'] as const) document.addEventListener(ev, unlock, { capture: true });

/** play() que, se o navegador bloquear o som, toca sem som (vídeo) e espera o primeiro clique. */
export function playMedia(el: HTMLMediaElement): void {
  void el.play().catch((e) => {
    if (e?.name !== 'NotAllowedError') return;
    waiting.set(el, el.muted);
    if (el instanceof HTMLVideoElement) {
      el.muted = true;
      void el.play().catch(() => {});
    }
    showBanner(true);
  });
}

/** AudioContext criado antes de um clique começa suspenso: retoma no primeiro clique. */
export function trackAudioContext(ctx: AudioContext): void {
  contexts.add(ctx);
  if (ctx.state === 'suspended') showBanner(true);
}
