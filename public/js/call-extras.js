(function () {
  'use strict';
  // In-call extras shared by the call panel (group-calls.js: 1:1, group and channel calls) and the
  // meeting page (meet-room.js): participant list, raise hand, reactions, in-call chat and the
  // active-speaker ring. The server side is the sfu:participants / sfu:hand / sfu:reaction /
  // sfu:chat / sfu:active-speaker handlers in meet-signaling.js, available in any call room.
  //
  // Each page passes its own elements (els), how to find a participant's tile (tileFor, tiles)
  // and, optionally, where reactions should float while a screen is being presented.
  // extraPanels: more [button, panel] pairs (e.g. device settings) that open/close with the others.
  //
  // Pin and spotlight (Teams "Pin for me" / "Spotlight for everyone"): a pin is yours alone; a
  // spotlight comes from the server (sfu:spotlight) and is the same for everyone. Your pin wins over
  // the spotlight for you. onFocus(peerId | null) tells the page whose video to show large; the page
  // calls decorate(tile, peerId) for each tile it creates, which adds the tile's pin button.
  //
  // Live captions: els.captionsBtn turns them on for you, els.captionsBox shows them; micTrack()
  // is your microphone track (null when not in a call), and the page calls micChanged() when you
  // mute, unmute or switch microphone.
  // onRoomState(state): the room's current sfu:participants answer (e.g. Together mode, who may
  // switch it), after each refresh.
  window.createCallExtras = function ({ socket, request, notify, els, tiles, tileFor, reactionHost = () => null, fallbackHost, extraPanels = [], onFocus = () => {}, micTrack = () => null, onRoomState = () => {} }) {
    const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'];
    const panels = [[els.participantsBtn, els.participantsPanel], [els.reactionsBtn, els.reactionsPanel], [els.chatBtn, els.chatPanel], ...extraPanels];
    const buttons = [els.participantsBtn, els.handBtn, els.reactionsBtn, els.chatBtn, els.captionsBtn, ...extraPanels.map(([btn]) => btn)].filter(Boolean);
    let ctx = null;                // { roomId, peerId, userId, hand } while in a call
    const seen = new Set();        // chat messages already shown (history and live can overlap)
    let unreadChat = 0, refreshTimer = null;
    let pinned = null, spotlight = null, canSpotlight = false, lastFocus;
    const initials = name => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
    const ours = roomId => ctx && roomId === ctx.roomId;

    function badge(el, n) { el.textContent = String(n); el.hidden = !n; }
    function openPanel(button) {
      for (const [btn, panel] of panels) {
        const open = btn === button && panel.hidden;
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
      }
      if (button === els.chatBtn && !els.chatPanel.hidden) { unreadChat = 0; badge(els.chatBadge, 0); els.chatInput.focus(); }
      if (button === els.participantsBtn && !els.participantsPanel.hidden) refresh();
    }
    // A short notice (hand raised, chat preview while the chat is closed).
    function notice(text) {
      const el = document.createElement('div'); el.className = 'nc-call-notice'; el.textContent = text;
      els.notices.appendChild(el);
      while (els.notices.children.length > 3) els.notices.firstElementChild.remove();
      setTimeout(() => el.remove(), 4500);
    }
    function applyFocus() {
      tiles().forEach(t => {
        const id = t.dataset.peerId;
        t.classList.toggle('nc-pinned', id === pinned);
        t.classList.toggle('nc-spotlit', !!spotlight && (id === spotlight || (id === 'local' && spotlight === ctx?.peerId)));
        const pin = t.querySelector('.nc-tile-pin');
        if (pin) { const on = id === pinned; pin.setAttribute('aria-pressed', String(on)); pin.title = on ? 'Unpin' : 'Pin for me'; pin.setAttribute('aria-label', pin.title); }
      });
      const focus = ctx ? (pinned || spotlight) : null;
      if (focus !== lastFocus) { lastFocus = focus; onFocus(focus); }
    }
    function togglePin(peerId) {
      if (!ctx || peerId === ctx.peerId) return;
      pinned = pinned === peerId ? null : peerId;
      applyFocus(); refresh();
    }
    function setSpotlight(peerId) {
      if (!ctx) return;
      request('sfu:spotlight', { roomId: ctx.roomId, peerId }).catch(e => notify(e));
    }
    // ---- Live captions (roadmap 2.8) ----
    // Each speaker's own browser turns their speech into text (Web Speech API: Chrome, Edge,
    // partly Safari; on-device where the browser offers it) and sends it to the room; the server
    // relays it only to people who turned captions on. Transcribing runs only while someone in the
    // call wants captions and your microphone is on. If this browser can't transcribe, the others
    // are told once instead of seeing nothing.
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let captionsOn = false, captionsWanted = false, rec = null, recBroken = !Recognition, toldUnavailable = false, lastInterim = 0;
    const captionLines = new Map(); // peerId -> { el, who, text, timer }
    function paintCaptionsBtn() {
      if (!els.captionsBtn) return;
      els.captionsBtn.setAttribute('aria-pressed', String(captionsOn));
      els.captionsBtn.title = captionsOn ? 'Turn off live captions' : 'Turn on live captions';
      els.captionsBtn.setAttribute('aria-label', els.captionsBtn.title);
      els.captionsBtn.classList.toggle('nc-active', captionsOn);
    }
    function clearCaptions() {
      captionLines.forEach(l => clearTimeout(l.timer)); captionLines.clear();
      if (els.captionsBox) { els.captionsBox.replaceChildren(); els.captionsBox.hidden = true; }
    }
    function showCaption({ peerId, fullName, text, final, unavailable }) {
      if (!captionsOn || !els.captionsBox || (!text && !unavailable)) return;
      let line = captionLines.get(peerId);
      if (!line) {
        const el = document.createElement('div'); el.className = 'nc-caption-line';
        const who = document.createElement('b'); const said = document.createElement('span');
        el.append(who, said); line = { el, who, said, timer: null }; captionLines.set(peerId, line);
      }
      line.who.textContent = (peerId === ctx?.peerId ? 'You' : fullName) + ': ';
      line.said.textContent = unavailable ? 'live captions aren\u2019t available in their browser' : text;
      line.el.classList.toggle('nc-caption-unavailable', !!unavailable);
      els.captionsBox.append(line.el); els.captionsBox.hidden = false; // latest speaker at the bottom
      clearTimeout(line.timer);
      line.timer = setTimeout(() => { line.el.remove(); captionLines.delete(peerId); if (!captionLines.size) els.captionsBox.hidden = true; }, final || unavailable ? 7000 : 12000);
      while (els.captionsBox.children.length > 3) {
        const first = els.captionsBox.firstElementChild;
        for (const [id, l] of captionLines) if (l.el === first) { clearTimeout(l.timer); captionLines.delete(id); }
        first.remove();
      }
    }
    const sendCaption = line => { if (ctx) socket.emit('sfu:caption', { roomId: ctx.roomId, ...line }); };
    function updateTranscriber() {
      const track = ctx ? micTrack() : null;
      const speaking = !!ctx && captionsWanted && !!track && track.enabled && track.readyState === 'live';
      if (speaking && recBroken && !toldUnavailable) { toldUnavailable = true; sendCaption({ unavailable: true }); notice('Live captions can\u2019t be produced in this browser, so others won\u2019t see captions for you.'); }
      if (speaking && !recBroken && !rec) startTranscribing(track);
      else if (!speaking && rec) stopTranscribing();
    }
    async function startTranscribing(track) {
      const r = rec = new Recognition();
      r.continuous = true; r.interimResults = true; r.lang = navigator.language || 'en-US';
      // On-device recognition where the browser has it (nothing leaves the machine); otherwise the
      // browser's own speech service (Chrome: Google's).
      try { if (typeof Recognition.available === 'function' && await Recognition.available({ langs: [r.lang], processLocally: true }) === 'available') r.processLocally = true; } catch { /* service default */ }
      if (rec !== r) return;
      r.onresult = e => {
        let finals = '', interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finals += t; else interim += t; }
        if (finals.trim()) sendCaption({ text: finals.trim(), final: true });
        else if (interim.trim() && Date.now() - lastInterim > 300) { lastInterim = Date.now(); sendCaption({ text: interim.trim(), final: false }); }
      };
      r.onerror = e => {
        if (!['not-allowed', 'service-not-allowed', 'network', 'audio-capture', 'language-not-supported'].includes(e.error)) return;
        recBroken = true; rec = null;
        updateTranscriber(); // tells the others once
      };
      // Browsers end recognition after a pause or a minute; carry on while still wanted.
      r.onend = () => { if (rec === r) { rec = null; if (!recBroken) setTimeout(updateTranscriber, 250); } };
      try { r.start(track); } catch { try { r.start(); } catch { if (rec === r) rec = null; } }
    }
    function stopTranscribing() { const r = rec; rec = null; try { r?.abort(); } catch { /* already stopped */ } }
    function setCaptionsOn(on) {
      if (!ctx) return;
      captionsOn = on; paintCaptionsBtn();
      if (!on) clearCaptions();
      const mine = ctx;
      request('sfu:captions', { roomId: ctx.roomId, on }).then(({ wanted }) => { if (ctx === mine) { captionsWanted = wanted; updateTranscriber(); } }).catch(e => notify(e));
    }
    els.captionsBtn?.addEventListener('click', () => setCaptionsOn(!captionsOn));
    socket.on('sfu:captions-state', ({ roomId, wanted }) => {
      if (!ours(roomId)) return;
      const was = captionsWanted; captionsWanted = wanted;
      if (wanted && !was) notice('Live captions are on: what you say is shown as text to people who turned them on.');
      updateTranscriber();
    });
    socket.on('sfu:caption', line => { if (ours(line.roomId)) showCaption(line); });

    // Participant list, refreshed (debounced) whenever someone joins/leaves or changes state.
    function refresh() {
      clearTimeout(refreshTimer);
      const mine = ctx;
      refreshTimer = setTimeout(async () => {
        if (!mine || ctx !== mine) return;
        let list, speaker, spot, may, captions, state;
        try { state = await request('sfu:participants', { roomId: mine.roomId }); ({ participants: list, speaker, spotlight: spot, canSpotlight: may, captions } = state); } catch { return; }
        if (ctx !== mine) return;
        onRoomState(state);
        if (!!captions !== captionsWanted) { captionsWanted = !!captions; updateTranscriber(); }
        spotlight = spot || null; canSpotlight = !!may;
        if (pinned && !list.some(p => p.peerId === pinned)) pinned = null;
        applyFocus();
        // Speaker changes are only announced as they happen; this catches someone joining mid-talk.
        if (speaker && !tiles().some(t => t.classList.contains('nc-speaking'))) tileFor(speaker)?.classList.add('nc-speaking');
        badge(els.participantsBadge, list.length);
        els.participantCount.textContent = String(list.length);
        els.participantList.replaceChildren(...list.sort((a, b) => (b.hand - a.hand) || a.fullName.localeCompare(b.fullName)).map(p => {
          const row = document.createElement('div'); row.className = 'nc-participant-item';
          const av = document.createElement('span'); av.className = 'nc-participant-avatar'; av.textContent = initials(p.fullName);
          const info = document.createElement('div'); info.className = 'nc-participant-info';
          const name = document.createElement('div'); name.className = 'nc-participant-name'; name.textContent = p.fullName + (p.peerId === mine.peerId ? ' (You)' : '');
          const st = document.createElement('div'); st.className = 'nc-participant-status';
          const icon = (cls, label) => { const i = document.createElement('i'); i.className = 'bi ' + cls; i.setAttribute('role', 'img'); i.setAttribute('aria-label', label); i.title = label; return i; };
          if (p.hand) { const h = document.createElement('span'); h.textContent = '✋'; h.setAttribute('role', 'img'); h.setAttribute('aria-label', 'Hand raised'); st.append(h); }
          st.append(p.micOff ? icon('bi-mic-mute-fill', 'Muted') : icon('bi-mic-fill', 'Microphone on'));
          st.append(p.camOff ? icon('bi-camera-video-off-fill', 'Camera off') : icon('bi-camera-video-fill', 'Camera on'));
          info.append(name, st); row.append(av, info);
          // Pin (for you) and spotlight (for everyone, if you may): a small action per person.
          const act = document.createElement('div'); act.className = 'nc-participant-actions';
          const action = (label, pressed, run) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'nc-participant-action'; b.textContent = label; b.setAttribute('aria-pressed', String(pressed)); b.setAttribute('aria-label', label + ': ' + p.fullName); b.onclick = run; return b; };
          if (p.peerId !== mine.peerId) act.append(action(p.peerId === pinned ? 'Unpin' : 'Pin', p.peerId === pinned, () => togglePin(p.peerId)));
          if (canSpotlight) act.append(action(p.peerId === spotlight ? 'Stop spotlight' : 'Spotlight', p.peerId === spotlight, () => setSpotlight(p.peerId === spotlight ? null : p.peerId)));
          if (act.childElementCount) row.append(act);
          return row;
        }));
      }, 250);
    }
    function setHand(raised) {
      if (ctx) ctx.hand = raised;
      els.handBtn.setAttribute('aria-pressed', String(raised));
      els.handBtn.title = raised ? 'Lower hand' : 'Raise hand'; els.handBtn.setAttribute('aria-label', els.handBtn.title);
      els.handBtn.classList.toggle('nc-active', raised);
    }
    function flyReaction(peerId, emoji) {
      const host = reactionHost(peerId) || tileFor(peerId) || fallbackHost;
      if (!host) return;
      const el = document.createElement('span'); el.className = 'nc-float-reaction'; el.textContent = emoji; el.setAttribute('aria-hidden', 'true');
      el.style.left = (20 + Math.random() * 60) + '%';
      host.appendChild(el);
      el.addEventListener('animationend', () => el.remove());
      setTimeout(() => el.remove(), 3500);
    }
    // quiet: from the history loaded on joining — no unread badge or notice for those.
    function addChatMessage(m, quiet = false) {
      const key = m.messageId || (m.at + '|' + m.peerId + '|' + m.text);
      if (seen.has(key)) return;
      seen.add(key);
      const mine = m.peerId === ctx.peerId || (ctx.userId != null && m.userId === ctx.userId);
      const row = document.createElement('div'); row.className = 'nc-chat-message' + (mine ? ' local' : '');
      const who = document.createElement('span'); who.className = 'nc-chat-sender'; who.textContent = mine ? 'You' : m.fullName;
      const text = document.createElement('div'); text.className = 'nc-chat-text'; text.textContent = m.text;
      const time = document.createElement('span'); time.className = 'nc-chat-time'; time.textContent = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      row.append(who, text, time);
      els.chatMessages.appendChild(row); els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
      if (els.chatPanel.hidden && !mine && !quiet) { badge(els.chatBadge, ++unreadChat); notice(m.fullName + ': ' + m.text.slice(0, 80)); }
    }

    els.reactionGrid.replaceChildren(...REACTIONS.map(e => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'nc-reaction-btn'; b.textContent = e; b.setAttribute('aria-label', 'React ' + e);
      b.onclick = () => { if (ctx) request('sfu:reaction', { roomId: ctx.roomId, emoji: e }).catch(err => notify(err)); };
      return b;
    }));
    for (const [btn, panel] of panels) {
      btn.addEventListener('click', () => { if (ctx) openPanel(btn); });
      panel.querySelector('.nc-btn-close')?.addEventListener('click', () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
    }
    els.handBtn.addEventListener('click', () => {
      if (!ctx) return;
      const raised = !ctx.hand; setHand(raised);
      request('sfu:hand', { roomId: ctx.roomId, raised }).catch(e => { setHand(!raised); notify(e); });
    });
    els.chatForm.addEventListener('submit', e => {
      e.preventDefault();
      const input = els.chatInput;
      if (!ctx || !input.value.trim()) return;
      const text = input.value; input.value = '';
      request('sfu:chat', { roomId: ctx.roomId, text }).catch(err => { input.value = text; notify(err); });
    });
    socket.on('sfu:hand', ({ roomId, peerId, fullName, raised }) => {
      if (!ours(roomId)) return;
      tileFor(peerId)?.classList.toggle('nc-hand', raised);
      if (peerId === ctx.peerId) setHand(raised);
      else if (raised) notice(fullName + ' raised their hand');
      refresh();
    });
    socket.on('sfu:reaction', ({ roomId, peerId, emoji }) => { if (ours(roomId)) flyReaction(peerId, emoji); });
    socket.on('sfu:chat', m => { if (ours(m.roomId)) addChatMessage(m); });
    socket.on('sfu:active-speaker', ({ roomId, peerId }) => {
      if (!ours(roomId)) return;
      tiles().forEach(t => t.classList.remove('nc-speaking'));
      if (peerId) tileFor(peerId)?.classList.add('nc-speaking');
    });
    socket.on('sfu:spotlight', ({ roomId, peerId, fullName, byName }) => {
      if (!ours(roomId)) return;
      const was = spotlight; spotlight = peerId || null;
      if (spotlight && spotlight !== was) notice(peerId === ctx.peerId ? byName + ' spotlighted you' : byName + ' spotlighted ' + fullName);
      else if (!spotlight && was) notice('Spotlight ended');
      applyFocus(); refresh();
    });
    // Someone left: drop your pin on them (the spotlight comes back cleared with the next refresh).
    socket.on('sfu:peer-left', ({ peerId }) => {
      if (!ctx) return;
      if (pinned === peerId) pinned = null;
      if (spotlight === peerId) spotlight = null;
      applyFocus();
    });
    for (const event of ['sfu:peer-joined', 'sfu:peer-left', 'sfu:producer-paused']) socket.on(event, () => { if (ctx) refresh(); });

    return {
      // Call once you are in the room (you know your own peerId there).
      start({ roomId, peerId, userId = null }) {
        const mine = ctx = { roomId, peerId, userId, hand: false };
        pinned = spotlight = null; canSpotlight = false; lastFocus = undefined; applyFocus();
        captionsOn = captionsWanted = false; toldUnavailable = false; recBroken = !Recognition; paintCaptionsBtn(); clearCaptions();
        buttons.forEach(b => { b.hidden = false; });
        setHand(false);
        refresh();
        // What was said before you joined (or before this device joined).
        request('sfu:chat-history', { roomId }).then(({ messages }) => {
          if (ctx === mine) messages.forEach(m => addChatMessage(m, true));
        }).catch(() => {});
      },
      // A message posted in the chat/channel itself while you're in its call (not via the call).
      addExternal({ userId, fullName, text, messageId }) {
        if (ctx) addChatMessage({ peerId: null, userId, fullName, text, messageId, at: new Date().toISOString() });
      },
      stop() {
        ctx = null; clearTimeout(refreshTimer); seen.clear();
        pinned = spotlight = null; applyFocus();
        stopTranscribing(); captionsOn = captionsWanted = false; paintCaptionsBtn(); clearCaptions();
        for (const [btn, panel] of panels) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
        buttons.forEach(b => { b.hidden = true; });
        els.chatMessages.replaceChildren(); els.participantList.replaceChildren(); els.notices.replaceChildren();
        unreadChat = 0; badge(els.chatBadge, 0); badge(els.participantsBadge, 0);
        setHand(false);
      },
      refresh,
      notice,
      // A new tile: give it the pin button (not your own tile) and its pin/spotlight marks.
      decorate(tile, peerId) {
        if (!tile || tile.querySelector('.nc-tile-pin') || peerId === 'local' || (ctx && peerId === ctx.peerId)) { applyFocus(); return; }
        const b = document.createElement('button'); b.type = 'button'; b.className = 'nc-tile-pin';
        b.innerHTML = '<i class="bi bi-pin-angle-fill" aria-hidden="true"></i>';
        b.addEventListener('click', e => { e.stopPropagation(); togglePin(peerId); });
        b.addEventListener('dblclick', e => e.stopPropagation());
        tile.appendChild(b);
        applyFocus();
      },
      // A tile went away or was replaced: re-check what's shown large.
      retile: applyFocus,
      // You muted, unmuted or switched microphone: start/stop transcribing your speech.
      micChanged() { if (rec) stopTranscribing(); updateTranscriber(); },
    };
  };
})();
