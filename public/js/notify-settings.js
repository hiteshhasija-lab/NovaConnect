(function () {
  'use strict';
  // Notification level for one chat or channel (Teams-style), shared by the channel header
  // (channel-tools.js) and the chat menu (chat-header.js). The levels themselves are applied in
  // workspace.js when a message arrives.
  const LEVELS = [
    ['all', 'All activity', 'Sound, desktop notification and unread dot for every new message.'],
    ['mentions', 'Mentions only', 'Alerts only when someone @mentions you. The unread dot still shows.'],
    ['off', 'Off', 'No alerts and no unread dot. @mentions still appear in Activity.'],
  ];
  window.NovaNotify = {
    // Icon for a level (Bootstrap Icons name) and a short label, for headers and the sidebar.
    icon: level => (level === 'off' ? 'bell-slash' : level === 'mentions' ? 'at' : 'bell'),
    label: level => (LEVELS.find(l => l[0] === level) || LEVELS[0])[1],
    // Opens the chooser; onSave(level) returns a promise (the dialog shows its error, if any).
    open({ title, level = 'all', onSave }) {
      const d = document.createElement('dialog'); d.className = 'channel-dialog notify-dialog';
      d.innerHTML = '<header><h2></h2><button type="button" aria-label="Close">×</button></header><div class="channel-dialog-body"><form><fieldset><legend class="visually-hidden">Notify me about</legend></fieldset><p class="notify-error" role="alert"></p><button type="submit">Save</button></form></div>';
      d.querySelector('h2').textContent = title;
      const set = d.querySelector('fieldset');
      for (const [value, name, hint] of LEVELS) {
        const row = document.createElement('label'); row.className = 'notify-option';
        const input = document.createElement('input'); input.type = 'radio'; input.name = 'level'; input.value = value; input.checked = value === level;
        const text = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = name;
        const small = document.createElement('small'); small.textContent = hint; text.append(strong, small);
        row.append(input, text); set.append(row);
      }
      document.body.append(d);
      d.querySelector('header button').onclick = () => d.close();
      d.addEventListener('close', () => d.remove());
      d.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const chosen = d.querySelector('input[name=level]:checked')?.value || 'all';
        const btn = d.querySelector('button[type=submit]'); btn.disabled = true;
        try { await onSave(chosen); d.close(); }
        catch (err) { d.querySelector('.notify-error').textContent = err.message || 'Could not save.'; btn.disabled = false; }
      };
      d.showModal();
      d.querySelector('input[name=level]:checked')?.focus();
    },
  };
})();
