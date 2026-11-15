import { loadVoicePrefs, type NsMode, type Voice, type VoicePrefs } from './voice';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Painel de voz da sala: volume geral, teste de microfone e a lista de quem está na chamada. */
export function mountVoicePanel(container: HTMLElement, voice: Voice, onupdate: () => void = () => {}): () => void {
  container.replaceChildren();
  const title = el('h3', '', 'Voz');
  const error = el('div', 'warn');

  const masterLabel = el('label', '', 'Volume das vozes');
  const master = el('input');
  master.type = 'range';
  master.min = '0';
  master.max = '1';
  master.step = '0.01';
  master.value = String(voice.prefs.volume);
  master.oninput = () => voice.setMasterVolume(Number(master.value));
  masterLabel.append(master);

  // Teste de microfone: retorno ao vivo enquanto estiver ligado.
  const testBox = el('div', 'voice-test');
  const testBtn = el('button', 'ghost', 'Testar microfone');
  testBtn.type = 'button';
  const testMeter = el('div', 'meter');
  const testLevel = el('div');
  testMeter.append(testLevel);
  const testNote = el('div', 'muted');
  testBox.append(testBtn, testMeter, testNote);
  testBtn.onclick = () => void voice.setMonitor(!voice.monitoring);
  const levelTimer = window.setInterval(() => {
    if (voice.monitoring) testLevel.style.width = `${Math.round(voice.selfLevel() * 100)}%`;
  }, 60);

  const more = el('div', 'muted', 'Microfone, saídas e supressão de ruído ficam em Configurações > Voz.');
  const list = el('ul', 'voice-list');
  container.append(title, error, masterLabel, testBox, list, more);

  const sliders = new Map<string, HTMLLIElement>();
  const render = () => {
    error.textContent = voice.micError;
    error.hidden = !voice.micError;
    testBtn.textContent = voice.monitoring ? 'Parar teste' : 'Testar microfone';
    testBtn.classList.toggle('active', voice.monitoring);
    testMeter.hidden = !voice.monitoring;
    testNote.textContent = voice.monitoring ? 'Você está se ouvindo ao vivo. Enquanto o teste está ligado, a sala não te ouve. Use fone para não dar microfonia.' : '';

    const rows = voice.rows();
    for (const id of [...sliders.keys()]) {
      if (!rows.some((r) => r.id === id)) {
        sliders.get(id)!.remove();
        sliders.delete(id);
      }
    }
    for (const r of rows) {
      let li = sliders.get(r.id);
      if (!li) {
        li = el('li');
        const head = el('div', 'name');
        head.append(el('span', 'dot'), el('span', 'who'));
        li.append(head);
        if (!r.self) {
          const vol = el('input');
          vol.type = 'range';
          vol.min = '0';
          vol.max = '1';
          vol.step = '0.01';
          vol.value = String(r.volume);
          vol.title = 'Volume deste participante';
          vol.oninput = () => voice.setVolume(r.id, Number(vol.value));
          li.append(vol);
        }
        sliders.set(r.id, li);
        list.append(li);
      }
      li.querySelector('.who')!.textContent =
        r.name + (r.self && voice.monitoring ? ' · em teste' : r.self && !voice.micOn ? ' · mudo' : '') + (!r.connected ? ' · conectando…' : r.self ? '' : r.turn ? ' · via TURN' : ' · direto');
      let sig = li.querySelector<HTMLElement>('.sig');
      if (!sig) {
        sig = document.createElement('span');
        sig.className = 'sig';
        li.querySelector('.who')!.after(sig);
      }
      const q = r.link;
      sig.hidden = !q;
      if (q) {
        sig.dataset.level = String(q.level);
        sig.textContent = `${q.rttMs} ms`;
        sig.title = `Ping ${q.rttMs} ms · perda ${q.lossPct}% · jitter ${q.jitterMs} ms`;
      }
      li.querySelector('.dot')!.className = 'dot' + (r.speaking ? ' speaking' : r.connected ? ' on' : '');
      li.classList.toggle('speaking', r.speaking);
    }
  };
  voice.onchange = () => {
    render();
    onupdate();
  };
  render();

  return () => {
    clearInterval(levelTimer);
    void voice.setMonitor(false);
    voice.onchange = () => {};
    container.replaceChildren();
  };
}

/**
 * Aba "Voz" das Configurações: microfone, saídas e supressão de ruído. Funciona fora de sala
 * (grava as preferências) e, dentro de uma sala, aplica na hora.
 */
export function mountVoiceSettings(container: HTMLElement, current: () => Voice | null): () => void {
  container.replaceChildren();
  const prefs = (): VoicePrefs => current()?.prefs ?? loadVoicePrefs();
  const store = (patch: Partial<VoicePrefs>): void => {
    localStorage.setItem('ariranhacast.voice', JSON.stringify({ ...loadVoicePrefs(), ...patch }));
  };

  const nsLabel = el('label', '', 'Supressão de ruído');
  const ns = el('select');
  ns.add(new Option('Sem supressão', 'off'));
  ns.add(new Option('Padrão (WebRTC)', 'standard'));
  ns.add(new Option('IA (RNNoise)', 'ai'));
  ns.onchange = () => {
    const v = current();
    if (v) void v.setMode(ns.value as NsMode);
    else store({ mode: ns.value as NsMode });
  };
  nsLabel.append(ns);

  const micLabel = el('label', '', 'Microfone');
  const micSel = el('select');
  micSel.onchange = () => {
    const v = current();
    if (v) void v.setMicDevice(micSel.value);
    else store({ micId: micSel.value });
  };
  micLabel.append(micSel);

  const outLabel = el('label', '', 'Saída das vozes');
  const outSel = el('select');
  outSel.onchange = () => {
    const v = current();
    if (v) v.setSink(outSel.value);
    else store({ sinkId: outSel.value });
  };
  outLabel.append(outSel);

  const streamOutLabel = el('label', '', 'Saída do áudio das transmissões');
  const streamOutSel = el('select');
  streamOutSel.onchange = () => {
    const v = current();
    if (v) v.setStreamSink(streamOutSel.value);
    else store({ streamSinkId: streamOutSel.value });
  };
  streamOutLabel.append(streamOutSel);

  const note = el('p', 'muted', 'As mudanças valem na hora, sem precisar salvar. O volume das vozes e o teste de microfone ficam no painel de voz da sala.');
  container.append(nsLabel, micLabel, outLabel, streamOutLabel, note);

  const fill = (sel: HTMLSelectElement, devices: MediaDeviceInfo[], cur: string, fallback: string) => {
    sel.replaceChildren(new Option('Padrão do sistema', ''));
    devices
      .filter((d) => d.deviceId && d.deviceId !== 'default')
      .forEach((d, i) => sel.add(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  };
  let asked = false;
  const refresh = async (): Promise<void> => {
    let all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    // Os nomes dos dispositivos só aparecem depois que o microfone foi aberto uma vez.
    if (!asked && all.some((d) => d.kind === 'audioinput') && all.every((d) => !d.label)) {
      asked = true;
      try {
        (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
        all = await navigator.mediaDevices.enumerateDevices();
      } catch {
        /* sem microfone ou sem permissão: mostra a lista sem nomes */
      }
    }
    const p = prefs();
    ns.value = p.mode;
    fill(micSel, all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications'), p.micId, 'Microfone');
    const outs = all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
    fill(outSel, outs, p.sinkId, 'Saída');
    fill(streamOutSel, outs, p.streamSinkId, 'Saída');
  };
  const onDevices = () => void refresh();
  navigator.mediaDevices.addEventListener('devicechange', onDevices);
  void refresh();
  return () => navigator.mediaDevices.removeEventListener('devicechange', onDevices);
}
