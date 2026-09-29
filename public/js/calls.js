(function () {
  'use strict';
  // The call panel's shared helpers. The calls themselves are in group-calls.js (1:1 chats, group
  // chats, channel meetings, all through the SFU).
  // Mute/camera buttons show an icon; these keep the icon, label and pressed state in sync.
  // Used by group-calls.js.
  window.setCallToggle = function (button, off, label) {
    button.setAttribute('aria-pressed', String(off));
    button.setAttribute('aria-label', label); button.title = label;
    const [on, offIcon] = button.querySelectorAll('svg');
    if (on && offIcon) { on.hidden = off; offIcon.hidden = !off; } else button.textContent = label;
  };
  // Call panel view controls: Maximize fills the window, Full
  // screen uses the whole display, and double-clicking any video shows just that video full screen.
  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.getElementById('callPanel');
    const max = document.getElementById('callMaximize'), full = document.getElementById('callFullscreen');
    if (!panel || !max || !full) return;
    const setMax = on => {
      panel.classList.toggle('nc-call-max', on);
      max.setAttribute('aria-pressed', String(on));
      max.title = on ? 'Restore' : 'Maximize'; max.setAttribute('aria-label', on ? 'Restore call size' : 'Maximize call');
      max.querySelector('.icon-max').hidden = on; max.querySelector('.icon-restore').hidden = !on;
    };
    max.onclick = () => setMax(!panel.classList.contains('nc-call-max'));
    full.hidden = !document.fullscreenEnabled;
    full.onclick = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else panel.requestFullscreen().catch(() => {}); };
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement && panel.contains(document.fullscreenElement);
      full.title = on ? 'Exit full screen' : 'Full screen'; full.setAttribute('aria-label', full.title);
    });
    panel.addEventListener('dblclick', e => {
      const video = e.target.closest('video');
      if (!video || !document.fullscreenEnabled) return;
      if (document.fullscreenElement === video) document.exitFullscreen().catch(() => {});
      else video.requestFullscreen().catch(() => {});
    });
    // A call ending hides the panel: leave full screen and go back to the normal size.
    new MutationObserver(() => {
      if (!panel.hidden) return;
      if (document.fullscreenElement && panel.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
      setMax(false);
    }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  });
})();
