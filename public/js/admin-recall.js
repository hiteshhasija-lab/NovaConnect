// Recall page (views/admin-recall.ejs): "select all", and a last check before removing.
(function () {
  const all = document.getElementById('recallAll');
  const picks = () => [...document.querySelectorAll('.recall-pick')];
  if (all) all.addEventListener('change', () => picks().forEach(p => { p.checked = all.checked; }));
  const form = document.getElementById('recallForm');
  if (form) form.addEventListener('submit', (e) => {
    const n = picks().filter(p => p.checked).length;
    if (!n) { e.preventDefault(); alert('Tick the messages to remove.'); return; }
    if (!confirm('Remove ' + n + ' message(s) for everyone? This cannot be undone.')) e.preventDefault();
  });
})();
