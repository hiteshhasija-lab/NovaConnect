// The profile card Teams shows when you click anyone's avatar/name — a centered <dialog>
// (matching channel-tools.js's own dialog() pattern) rather than an anchored popover, since
// that's how Teams itself presents it. Fetches fresh from /api/users/:id/profile every open
// so it always reflects current status/status message, never a stale cached copy.
window.createProfileCard = function ({ api, escapeHtml, avatarHtml, presence, onMessage, vip }) {
  const STATUS_LABELS = { online: 'Available', away: 'Appear away', brb: 'Be right back', busy: 'Busy', dnd: 'Do not disturb', offline: 'Appear offline', incall: 'In a call', inmeeting: 'In a meeting', presenting: 'Presenting', ooo: 'Out of office' };
  let dialog = null;
  // ' until Fri, Oct 30, 5:00 PM' in this browser's time zone, from the database's UTC text time.
  function untilLabel(until) {
    const d = until ? new Date(String(until).replace(' ', 'T') + 'Z') : null;
    return d && !Number.isNaN(d.getTime()) ? ' until ' + d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  }

  function close() { if (dialog) dialog.close(); }

  async function open(userId) {
    close();
    const myDialog = document.createElement('dialog');
    dialog = myDialog;
    myDialog.className = 'profile-card-dialog';
    myDialog.innerHTML = '<button type="button" class="profile-card-close" aria-label="Close">×</button><div class="profile-card-body">Loading…</div>';
    document.body.appendChild(myDialog);
    myDialog.querySelector('.profile-card-close').onclick = () => myDialog.close();
    myDialog.addEventListener('close', () => { myDialog.remove(); if (dialog === myDialog) dialog = null; });
    myDialog.showModal();

    try {
      const u = await api('/api/users/' + userId + '/profile');
      if (!myDialog.isConnected) return; // this exact card was closed (or replaced) before the fetch finished
      const status = presence(u.id) || u.status || 'offline';
      const label = STATUS_LABELS[status] || 'Appear offline';
      myDialog.querySelector('.profile-card-body').innerHTML =
        '<div class="profile-card-header">' + avatarHtml(u, '3.2rem') +
          '<div><h2>' + escapeHtml(u.full_name) + '</h2>' + (u.title ? '<div class="profile-card-title">' + escapeHtml(u.title) + '</div>' : '') + '</div>' +
        '</div>' +
        '<div class="profile-card-status"><span class="presence-dot presence-' + status + '"></span>' + escapeHtml(label) + '</div>' +
        (u.status_message ? '<div class="profile-card-status-message"><i class="bi bi-chat-left-quote"></i> ' + escapeHtml(u.status_message) + '</div>' : '') +
        (u.out_of_office ? '<div class="profile-card-ooo"><i class="bi bi-airplane"></i> <div><strong>Out of office' + escapeHtml(untilLabel(u.out_of_office.until)) + '</strong>' +
          (u.out_of_office.message ? '<div>' + escapeHtml(u.out_of_office.message) + '</div>' : '') + '</div></div>' : '') +
        '<div class="profile-card-contact">' +
          (u.email ? '<div><i class="bi bi-envelope"></i> <a href="mailto:' + escapeHtml(u.email) + '">' + escapeHtml(u.email) + '</a></div>' : '') +
          '<div><i class="bi bi-at"></i> ' + escapeHtml(u.username) + '</div>' +
        '</div>' +
        '<div class="profile-card-actions"><button type="button" class="btn btn-sm btn-primary profile-card-message-btn"><i class="bi bi-chat-dots me-1"></i>Message</button>' +
          (vip && Number(u.id) !== Number(vip.self) ? '<button type="button" class="btn btn-sm btn-outline-secondary profile-card-vip-btn"></button>' : '') + '</div>';
      const msgBtn = myDialog.querySelector('.profile-card-message-btn');
      if (msgBtn) msgBtn.onclick = () => { myDialog.close(); onMessage(u.id); };
      // VIP people (vip-rules.js): a star to add or remove this person from your own list.
      const vipBtn = myDialog.querySelector('.profile-card-vip-btn');
      const drawVip = () => {
        const on = vip.has(u.id);
        vipBtn.innerHTML = '<i class="bi ' + (on ? 'bi-star-fill' : 'bi-star') + ' me-1"></i>' + (on ? 'VIP' : 'Add to VIPs');
        vipBtn.setAttribute('aria-pressed', String(on));
        vipBtn.title = on ? 'Their messages always reach you. Click to remove.' : 'Their messages will reach you even while you are Do not disturb or have muted the chat.';
      };
      if (vipBtn) {
        drawVip();
        vipBtn.onclick = () => { vipBtn.disabled = true; vip.set(u.id, !vip.has(u.id)).then(drawVip).catch(vip.notify).finally(() => { vipBtn.disabled = false; }); };
      }
    } catch (e) {
      if (myDialog.isConnected) myDialog.querySelector('.profile-card-body').textContent = e.message || 'Could not load this person.';
    }
  }

  return { open, close };
};
