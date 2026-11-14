import type { NsMode, Voice } from './voice';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Painel de voz (microfone, supressão de ruído, dispositivos, quem está falando). */
export function mountVoicePanel(container: HTMLElement, voice: Voice, onupdate: () => void = () => {}): () => void {
  container.replaceChildren();
  const title = el('h3', '', 'Voz');

  const error = el('div', 'warn');

  const nsLabel = el('label', '', 'Supressão de ruído');
  const ns = el('select');
  ns.add(new Option('Sem supressão', 'off'));
  ns.add(new Option('Padrão (WebRTC)', 'standard'));
  ns.add(new Option('IA (RNNoise)', 'ai'));
  ns.value = voice.prefs.mode;
  ns.onchange = () => void voice.setMode(ns.value as NsMode);
  nsLabel.append(ns);

  const micLabel = el('label', '', 'Microfone');
  const micSel = el('select');
  micSel.onchange = () => void voice.setMicDevice(micSel.value);
  micLabel.append(micSel);

  const outLabel = el('label', '', 'Saída das vozes');
  const outSel = el('select');
  outSel.onchange = () => voice.setSink(outSel.value);
  outLabel.append(outSel);

  const streamOutLabel = el('label', '', 'Saída das transmissões');
  const streamOutSel = el('select');
  streamOutSel.onchange = () => voice.setStreamSink(streamOutSel.value);
  streamOutLabel.append(streamOutSel);

  const masterLabel = el('label', '', 'Volume das vozes');
  const master = el('input');
  master.type = 'range';
  master.min = '0';
  master.max = '1';
  master.step = '0.01';
  master.value = String(voice.prefs.volume);
  master.oninput = () => voice.setMasterVolume(Number(master.value));
  masterLabel.append(master);

  const list = el('ul', 'voice-list');
  container.append(title, error, nsLabel, micLabel, outLabel, streamOutLabel, masterLabel, list);

  const fill = (sel: HTMLSelectElement, devices: MediaDeviceInfo[], current: string, fallback: string) => {
    sel.replaceChildren(new Option('Padrão do sistema', ''));
    devices
      .filter((d) => d.deviceId && d.deviceId !== 'default')
      .forEach((d, i) => sel.add(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
    sel.value = [...sel.options].some((o) => o.value === current) ? current : '';
  };
  const fillDevices = async () => {
    const { mics, outputs } = await voice.devices();
    fill(micSel, mics, voice.prefs.micId, 'Microfone');
    fill(outSel, outputs, voice.prefs.sinkId, 'Saída');
    fill(streamOutSel, outputs, voice.prefs.streamSinkId, 'Saída');
  };
  void fillDevices();
  let hadMic = voice.micOn;
  navigator.mediaDevices.addEventListener('devicechange', fillDevices);

  const sliders = new Map<string, HTMLLIElement>();
  const render = () => {
    if (voice.micOn && !hadMic) void fillDevices(); // os nomes dos dispositivos só aparecem após a permissão
    hadMic = voice.micOn;
    error.textContent = voice.micError;
    error.hidden = !voice.micError;

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
        r.name + (r.self && !voice.micOn ? ' · mudo' : '') + (!r.connected ? ' · conectando…' : r.self ? '' : r.turn ? ' · via TURN' : ' · direto');
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
    navigator.mediaDevices.removeEventListener('devicechange', fillDevices);
    voice.onchange = () => {};
    container.replaceChildren();
  };
}
