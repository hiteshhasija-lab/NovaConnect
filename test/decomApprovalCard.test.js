const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/js/workspace.js'), 'utf8');
const start = source.indexOf('  function decomApprovalCardHtml(meta)');
const end = source.indexOf('  // Deliberately styled apart', start);
const context = vm.createContext({ escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;') });
vm.runInContext(source.slice(start, end), context);
for (const status of ['pending', 'approved', 'rejected']) {
  test(`approval card retains details when ${status}`, () => {
    const html = context.decomApprovalCardHtml({ status, changeNumber: 'CHG0000061', ciName: 'DECOM-TEST-20', ciCategory: 'Development Server', changeType: 'Normal', risk: 'Low', plannedStart: '2026-10-01T18:00:00Z', requestedBy: 'Requester', assignmentGroup: 'IRO-Build/Decom', assignedTo: 'Alex Admin', novadeskChangeUrl: 'https://example.test/change/61' });
    for (const value of ['CHG0000061', 'DECOM-TEST-20', 'Development Server', 'Normal', 'Low', 'Scheduled', 'Requester', 'IRO-Build/Decom', 'Alex Admin', 'View Change']) assert.ok(html.includes(value), value);
    assert.equal((html.match(/ disabled/g) || []).length, status === 'pending' ? 0 : 2);
    assert.ok(html.includes(status === 'approved' ? '>Approved</button>' : '>Approve</button>'));
    assert.ok(html.includes(status === 'rejected' ? '>Rejected</button>' : '>Reject</button>'));
  });
}
test('resolved cards do not wire action handlers', () => {
  for (const status of ['approved', 'rejected']) {
    context.wireDecomApprovalCard({ querySelector() { assert.fail('Resolved card must not wire actions'); } }, { metadata: { status } });
  }
});
test('CTASK action says Complete before action and Completed afterward', () => {
  const first = source.indexOf('  function decomPrecheckTaskCardHtml(meta)');
  const last = source.indexOf('  function wireDecomPrecheckTaskCard', first);
  vm.runInContext(source.slice(first, last), context);
  const pending = context.decomPrecheckTaskCardHtml({ status: 'pending', taskDescription: 'DNS cleanup' });
  assert.match(pending, />Complete<\/button>/);
  assert.match(pending, />Skip<\/button>/);
  assert.doesNotMatch(pending, />Completed<\/button>/);
  assert.match(context.decomPrecheckTaskCardHtml({ status: 'completed' }), /Completed/);
  assert.match(context.decomPrecheckTaskCardHtml({ status: 'skipped' }), /Skipped/);
});
