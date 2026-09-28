(function () {
  'use strict';
  // In-call extras shared by the call panel (group-calls.js: 1:1, group and channel calls) and the
  // meeting page (meet-room.js): participant list, raise hand, reactions, in-call chat and the
  // active-speaker ring. The server side is the sfu:participants / sfu:hand / sfu:reaction /
  // sfu:chat / sfu:active-speaker handlers in meet-signaling.js, available in any call room.
  //
  // Each page passes its own elements (els), how to find a participant's tile (tileFor, tiles)
  // and, optionally, where reactions should float while a screen is being presented.
  window.createCallExtras = function ({ socket, request, notify, els, tiles, tileFor, reactionHost = () => null, fallbackHost }) {
    const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'];
    const panels = [[els.participantsBtn, els.participantsPanel], [els.reactionsBtn, els.reactionsPanel], [els.chatBtn, els.chatPanel]];
    const buttons = [els.participantsBtn, els.handBtn, els.reactionsBtn, els.chatBtn];
    let ctx = null;                // { roomId, peerId, userId, hand } while in a call
    const seen = new Set();        // chat messages already shown (history and live can overlap)
    let unreadChat = 0, refreshTimer = null;
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
    // Participant list, refreshed (debounced) whenever someone joins/leaves or changes state.
    function refresh() {
      clearTimeout(refreshTimer);
      const mine = ctx;
      refreshTimer = setTimeout(async () => {
        if (!mine || ctx !== mine) return;
        let list, speaker;
        try { ({ participants: list, speaker } = await request('sfu:participants', { roomId: mine.roomId })); } catch { return; }
        if (ctx !== mine) return;
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
    for (const event of ['sfu:peer-joined', 'sfu:peer-left', 'sfu:producer-paused']) socket.on(event, () => { if (ctx) refresh(); });

    return {
      // Call once you are in the room (you know your own peerId there).
      start({ roomId, peerId, userId = null }) {
        const mine = ctx = { roomId, peerId, userId, hand: false };
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
        for (const [btn, panel] of panels) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
        buttons.forEach(b => { b.hidden = true; });
        els.chatMessages.replaceChildren(); els.participantList.replaceChildren(); els.notices.replaceChildren();
        unreadChat = 0; badge(els.chatBadge, 0); badge(els.participantsBadge, 0);
        setHand(false);
      },
      refresh,
    };
  };
})();
