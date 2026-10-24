const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSearchQuery, localDayStart } = require('../src/searchQuery');

test('plain words stay free text, with words to highlight', () => {
  const q = parseSearchQuery('deploy plan');
  assert.equal(q.text, 'deploy plan');
  assert.deepEqual(q.terms, ['deploy', 'plan']);
  assert.equal(q.hasFilters, false);
});

test('from:, in: and has: are taken out of the text; quoted values keep their spaces', () => {
  const q = parseSearchQuery('budget from:"Jane Doe" from:me in:#general in:@jdoe has:file has:LINK');
  assert.equal(q.text, 'budget');
  assert.deepEqual(q.from, ['Jane Doe', 'me']);
  assert.deepEqual(q.in, ['#general', '@jdoe']);
  assert.deepEqual(q.has, { file: true, link: true });
  assert.deepEqual(q.applied.map((f) => f.label), ['From: Jane Doe', 'From: me', 'In: #general', 'In: @jdoe', 'Has a file', 'Has a link']);
});

test('keys are case-insensitive', () => {
  const q = parseSearchQuery('FROM:me In:general');
  assert.deepEqual(q.from, ['me']);
  assert.deepEqual(q.in, ['general']);
});

test('dates mean whole days in the searcher\'s time zone: after includes, before excludes, on is one day', () => {
  // US Central summer time: Date.getTimezoneOffset() = 300, local midnight = 05:00 UTC.
  const q = parseSearchQuery('after:2026-10-01 before:2026-10-15', { tzOffsetMinutes: 300 });
  assert.equal(q.after.sql, '2026-10-01 05:00:00');
  assert.equal(q.before.sql, '2026-10-15 05:00:00');
  assert.equal(q.after.ts, Date.UTC(2026, 9, 1, 5) / 1000);
  const on = parseSearchQuery('on:2026-10-20', { tzOffsetMinutes: -330 });   // India: midnight = 18:30 UTC the day before
  assert.equal(on.after.sql, '2026-10-19 18:30:00');
  assert.equal(on.before.sql, '2026-10-20 18:30:00');
});

test('several dates narrow to the tightest window', () => {
  const q = parseSearchQuery('after:2026-01-01 after:2026-03-01 before:2026-12-01 on:2026-06-10');
  assert.equal(q.after.sql, '2026-06-10 00:00:00');
  assert.equal(q.before.sql, '2026-06-11 00:00:00');
});

test('anything not understood stays in the text instead of disappearing', () => {
  const q = parseSearchQuery('after:2026-02-30 before:soon has:video color:red from: ratio 3:2');
  assert.equal(q.after, null);
  assert.equal(q.before, null);
  assert.equal(q.hasFilters, false);
  assert.equal(q.text, 'after:2026-02-30 before:soon has:video color:red from: ratio 3:2');
});

test('only filters, no words: still a search (newest matching first), with nothing to highlight', () => {
  const q = parseSearchQuery('from:me has:file');
  assert.equal(q.text, '');
  assert.deepEqual(q.terms, []);
  assert.equal(q.hasFilters, true);
});

test('a time zone outside the real range is ignored rather than trusted', () => {
  assert.equal(parseSearchQuery('on:2026-01-01', { tzOffsetMinutes: 99999 }).after.sql, '2026-01-01 00:00:00');
  assert.equal(parseSearchQuery('on:2026-01-01', { tzOffsetMinutes: 1.5 }).after.sql, '2026-01-01 00:00:00');
});

test('localDayStart rejects impossible days', () => {
  assert.equal(localDayStart('2026-13-01', 0), null);
  assert.equal(localDayStart('2026-02-29', 0), null);
  assert.equal(localDayStart('2028-02-29', 0), Date.UTC(2028, 1, 29));
});

test('highlight words skip one-letter words and quotes, at most 10', () => {
  const q = parseSearchQuery('"a quick" b fox ' + Array.from({ length: 15 }, (_, i) => 'w' + i).join(' '));
  assert.ok(!q.terms.includes('a') && !q.terms.includes('b'));
  assert.ok(q.terms.includes('quick') && q.terms.includes('fox'));
  assert.equal(q.terms.length, 10);
});
