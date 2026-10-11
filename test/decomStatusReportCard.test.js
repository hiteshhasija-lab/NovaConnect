const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/js/workspace.js'), 'utf8');
const start = source.indexOf('  function decomStatusReportCardHtml(meta)');
const end = source.indexOf('  function decomSummaryCardHtml(meta)', start);
assert.ok(start > 0 && end > start, 'status report card source found');
const context = vm.createContext({
  escapeHtml: (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  Date, Number, String, Array,
});
vm.runInContext(source.slice(start, end), context);

const done = {
  id: 68, number: 'CHG0000068', status: 'closed', approvalStatus: 'approved', step: 'Completed: VM destroyed and CI retired',
  ci: { name: 'DECOM-TEST-24', ciNumber: 'CI0000024', status: 'retired' }, requestedBy: 'Hitesh Hasija', assignedTo: 'Alex Admin',
  assignmentGroup: 'IRO-Build/Decom', approvedBy: 'Hitesh Hasija', submittedAt: '2026-10-08 18:38:22', approvedAt: '2026-10-08 18:40:13',
  poweredOffAt: '2026-10-08 18:43:04', soakEndsAt: '2026-10-08 18:48:04', destroyedAt: '2026-10-08 18:49:48', completedAt: '2026-10-08 18:50:08',
  tasksDone: 7, tasksTotal: 7, novadeskChangeUrl: 'https://nova.example/changes/68',
};

test('a completed decommission shows who, when and how it ended', () => {
  const html = context.decomStatusReportCardHtml({ query: 'DECOM-TEST-24', kind: 'server', matches: [done] });
  for (const v of ['CHG0000068', 'DECOM-TEST-24', 'Completed: VM destroyed and CI retired', 'Hitesh Hasija', 'Alex Admin', 'Submitted', 'Approved', 'Powered off', 'Soak period ended', 'Destroyed', 'Completed', '7 of 7 done', 'View Change']) {
    assert.ok(html.includes(v), v);
  }
  assert.ok(!html.includes('Cancelled'), 'no cancelled row for a completed Change');
  assert.ok(!html.includes('2026-10-08 18:38:22'), 'raw UTC text is converted for display');
});

test('a Change still waiting for approval shows only what exists so far', () => {
  const html = context.decomStatusReportCardHtml({ query: 'CHG0000069', kind: 'change', matches: [{
    number: 'CHG0000069', status: 'draft', approvalStatus: 'pending', step: 'Waiting for approval', ci: { name: 'SRV1', status: 'in_use' },
    requestedBy: 'Hitesh Hasija', submittedAt: '2026-10-09 10:00:00', tasksDone: 0, tasksTotal: 7 }] });
  assert.ok(html.includes('Waiting for approval'));
  for (const v of ['Approved', 'Powered off', 'Destroyed', 'Completed', 'Cancelled', 'Soak period']) assert.ok(!html.includes('>' + v + '<'), v);
  assert.ok(!html.includes('View Change'));
});

test('a running soak period says when it ends', () => {
  const html = context.decomStatusReportCardHtml({ query: 'SRV1', matches: [{ ...done, status: 'in_progress', step: 'VM powered off; soak period running',
    destroyedAt: null, completedAt: null, tasksDone: 4 }] });
  assert.ok(html.includes('Soak period ends'));
  assert.ok(!html.includes('Soak period ended'));
});

test('nothing found, and a server with no decommission', () => {
  assert.match(context.decomStatusReportCardHtml({ query: 'NOPE', matches: [] }), /No server or Change called/);
  const known = context.decomStatusReportCardHtml({ query: 'PLAIN', ci: { name: 'PLAIN', ciNumber: 'CI9', status: 'in_use' }, matches: [] });
  assert.match(known, /no decommission has been requested/);
});

test('values are escaped', () => {
  const html = context.decomStatusReportCardHtml({ query: '<img src=x onerror=1>', matches: [{ ...done, requestedBy: '<b>x</b>', step: '"><script>' }] });
  assert.ok(!html.includes('<img'), 'query escaped');
  assert.ok(!html.includes('<script>') && !html.includes('<b>x</b>'));
});
