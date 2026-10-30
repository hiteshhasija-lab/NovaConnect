const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCriteria, whereFor, terms, describe, caseCsv } = require('../src/ediscovery');

test('criteria: ids from a form or saved JSON, bad ones dropped; both options on unless said otherwise', () => {
  const c = parseCriteria({ people: ['3', '3', 'x'], channels: '9', chats: '12, 15,abc', from: '2026-10-01', to: 'soon', words: ' budget "q3 plan" ' }).value;
  assert.deepEqual(c, { people: [3], channels: [9], chats: [12, 15], from: '2026-10-01', to: '', words: 'budget "q3 plan"', include_preserved: true, include_versions: true });
  assert.equal(parseCriteria({ include_preserved: false, include_versions: 'on' }).value.include_preserved, false);
  assert.match(parseCriteria({ from: '2026-10-10', to: '2026-10-01' }).error, /before/);
  assert.equal(parseCriteria({ people: Array.from({ length: 80 }, (_, i) => i + 1) }).value.people.length, 50);
});

test('words and quoted phrases, at most 10', () => {
  assert.deepEqual(terms('budget "q3 plan" 100%'), ['budget', 'q3 plan', '100%']);
  assert.equal(terms(Array.from({ length: 15 }, (_, i) => 'w' + i).join(' ')).length, 10);
});

test('sources are any-of, conditions all-of, every value bound, wildcards literal', () => {
  const c = parseCriteria({ people: [3], channels: [9], words: '50%_off', from: '2026-10-01' }).value;
  const live = whereFor(c, 'live');
  assert.equal((live.sql.match(/\?/g) || []).length, live.params.length);
  assert.match(live.sql, /^WHERE m\.deleted = 0 AND \(\(m\.user_id IN \(\?\) OR EXISTS/);
  assert.match(live.sql, / OR m\.channel_id IN \(\?\)\)/);
  assert.ok(live.params.includes('%50\\%\\_off%'));
  assert.match(live.sql, /message_edits/);       // earlier versions are searched too
  const kept = whereFor(c, 'preserved');
  assert.equal((kept.sql.match(/\?/g) || []).length, kept.params.length);
  assert.match(kept.sql, /p\.author_id IN/);
  assert.equal(whereFor(parseCriteria({}).value, 'preserved').sql, '');
  assert.equal(describe(parseCriteria({}).value), 'everywhere');
});

test('CSV: one row per message, spreadsheet formulas defused', () => {
  const csv = caseCsv([{ source: 'live', message_id: 7, written_at: '2026-10-24 10:00:00', author: 'Ann', author_username: 'ann', place: 'T › #general', reply_to: null,
    announcement: null, text: '=cmd|"/c calc"!A1', edited: true, versions: [{ replaced_at: '2026-10-24 10:05:00', body: 'first' }], files: [{ id: 3, name: 'a.pdf' }] }]);
  const [head, row] = csv.trim().split('\r\n');
  assert.ok(head.startsWith('source,message_id,written_at_utc'));
  assert.ok(row.includes(`"'=cmd|""/c calc""!A1"`));
  assert.ok(row.includes('[2026-10-24 10:05:00] first') && row.includes('a.pdf (#3)'));
});
