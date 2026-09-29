(function () {
  'use strict';
  // Microphone / camera / speaker choice, shared by the call panel (group-calls.js) and the meeting
  // page (meet-room.js). Choices are remembered per device (browser storage) and used as
  // "ideal" constraints, so an unplugged device falls back to the system default.
  const KEYS = { audioinput: 'nc.device.mic', videoinput: 'nc.device.camera', audiooutput: 'nc.device.speaker' };
  const LABELS = { audioinput: 'Microphone', videoinput: 'Camera', audiooutput: 'Speaker' };
  const read = kind => { try { return localStorage.getItem(KEYS[kind]) || ''; } catch { return ''; } };
  const write = (kind, id) => { try { if (id) localStorage.setItem(KEYS[kind], id); else localStorage.removeItem(KEYS[kind]); } catch { /* not remembered */ } };
  const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  window.NovaDevices = {
    canPickSpeaker,
    chosen: read,
    // getUserMedia constraint for one kind: the remembered device if any (falling back to default).
    audio() { const id = read('audioinput'); return id ? { deviceId: { ideal: id } } : true; },
    // 720p when the camera can: the browser's default (640x480) is too small for the three simulcast
    // sizes (sfu-client.js) — the smallest would be 160 wide.
    video() { const id = read('videoinput'); return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, ...(id ? { deviceId: { ideal: id } } : {}) }; },
    // Plays remote sound on the chosen speaker (where the browser supports choosing one).
    applySpeaker(el) {
      const id = read('audiooutput');
      if (canPickSpeaker && el && id && el.sinkId !== id) el.setSinkId(id).catch(() => {});
    },
    // Fills a <select> for one kind. Device names only appear once the page has been allowed to use
    // the microphone/camera; before that they're numbered.
    async fill(select, kind) {
      if (!select || !navigator.mediaDevices?.enumerateDevices) return;
      let devices = [];
      try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications'); } catch { /* none */ }
      const current = read(kind);
      const def = new Option('System default', '');
      select.replaceChildren(def, ...devices.map((d, i) => new Option(d.label || `${LABELS[kind]} ${i + 1}`, d.deviceId)));
      select.value = devices.some(d => d.deviceId === current) ? current : '';
      select.disabled = !devices.length;
    },
    // Wires up a set of selects: fills them, remembers changes and reports them (onChange(kind, id)),
    // and refreshes them when devices are plugged in or out.
    bind(selects, onChange = () => {}) {
      const refresh = () => Object.entries(selects).forEach(([kind, sel]) => this.fill(sel, kind));
      Object.entries(selects).forEach(([kind, sel]) => {
        if (!sel) return;
        if (kind === 'audiooutput' && !canPickSpeaker) { sel.closest('label')?.setAttribute('hidden', ''); return; }
        sel.addEventListener('change', () => { write(kind, sel.value); onChange(kind, sel.value); });
      });
      navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
      refresh();
      return { refresh };
    },
  };
})();
