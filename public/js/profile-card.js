// The profile card Teams shows when you click anyone's avatar/name — a centered <dialog>
// (matching channel-tools.js's own dialog() pattern) rather than an anchored popover, since
// that's how Teams itself presents it. Fetches fresh from /api/users/:id/profile every open
// so it always reflects current status/status message, never a stale cached copy.
window.createProfileCard = function ({ api, escapeHtml, avatarHtml, presence, onMessage }) {
  const STATUS_LABELS = { online: 'Available', away: 'Appear away', brb: 'Be right back', busy: 'Busy', dnd: 'Do not disturb', offline: 'Appear offline' };
  let dialog = null;

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
        '<div class="profile-card-contact">' +
          (u.email ? '<div><i class="bi bi-envelope"></i> <a href="mailto:' + escapeHtml(u.email) + '">' + escapeHtml(u.email) + '</a></div>' : '') +
          '<div><i class="bi bi-at"></i> ' + escapeHtml(u.username) + '</div>' +
        '</div>' +
        '<div class="profile-card-actions"><button type="button" class="btn btn-sm btn-primary profile-card-message-btn"><i class="bi bi-chat-dots me-1"></i>Message</button></div>';
      const msgBtn = myDialog.querySelector('.profile-card-message-btn');
      if (msgBtn) msgBtn.onclick = () => { myDialog.close(); onMessage(u.id); };
    } catch (e) {
      if (myDialog.isConnected) myDialog.querySelector('.profile-card-body').textContent = e.message || 'Could not load this person.';
    }
  }

  return { open, close };
};
