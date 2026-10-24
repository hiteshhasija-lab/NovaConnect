const test = require('node:test');
const assert = require('node:assert/strict');
const { auditFilters, auditCsv, csvCell, ACTIONS, GROUPS } = require('../src/audit');

test('every action belongs to a group the filter offers', () => {
  for (const action of Object.keys(ACTIONS)) assert.ok(GROUPS[action.split('.')[0]], action);
});

test('filters become bound conditions; anything else is ignored', () => {
  const f = auditFilters({ group: 'auth', person: '7', from: '2026-10-01', to: '2026-10-24', before: '500' });
  assert.equal(f.sql, 'WHERE action LIKE ? AND actor_id = ? AND at >= ? AND at <= ? AND id < ?');
  assert.deepEqual(f.params, ['auth.%', 7, '2026-10-01 00:00:00', '2026-10-24 23:59:59', 500]);
  assert.deepEqual(f.applied, { group: 'auth', person: 7, from: '2026-10-01', to: '2026-10-24' });
  const bad = auditFilters({ group: "auth'; drop table x", person: '-1', from: '01/10/2026', before: 'x' });
  assert.equal(bad.sql, '');
  assert.deepEqual(bad.params, []);
  assert.equal((f.sql.match(/\?/g) || []).length, f.params.length);
});

test('CSV quotes what needs quoting and defuses spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell(null), '');
  const csv = auditCsv([{ id: 1, at: '2026-10-24 10:00:00', actor_id: null, actor_name: null, action: 'auth.login_failed', target_type: 'user', target_id: null, target_name: '@admin', ip: '10.0.0.5', user_agent: 'curl', details: '{"via":"web"}' }]);
  const [head, row] = csv.trim().split('\r\n');
  assert.equal(head, 'id,at,actor_id,actor_name,action,target_type,target_id,target_name,ip,user_agent,details');
  assert.equal(row, '1,2026-10-24 10:00:00Z,,,auth.login_failed,user,,\'@admin,10.0.0.5,curl,"{""via"":""web""}"');
});
