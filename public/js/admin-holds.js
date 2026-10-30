// Legal hold admin page (views/admin-holds.ejs): shows only the target field for the chosen kind of
// hold, and asks before a hold is released.
(function () {
  const scope = document.getElementById('holdScope');
  const sync = () => document.querySelectorAll('.hold-target').forEach(el => { el.hidden = el.dataset.scope !== scope.value; });
  if (scope) { scope.addEventListener('change', sync); sync(); }
  document.querySelectorAll('.hold-release-form').forEach(f => f.addEventListener('submit', (e) => {
    if (!confirm('Release the hold "' + f.dataset.name + '"? Its messages can then be deleted and expire again. What it preserved is kept.')) e.preventDefault();
  }));
})();
