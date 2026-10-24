const test = require('node:test');
const assert = require('node:assert/strict');
const { editVersions } = require('../src/editHistory');

test('versions newest first, each with the time it was written', () => {
  const msg = { body: 'v3', metadata: null, created_at: '2026-10-24 10:00:00', edits_untracked: 0 };
  const edits = [
    { body: 'v1', metadata: null, replaced_at: '2026-10-24 10:05:00' },
    { body: 'v2', metadata: null, replaced_at: '2026-10-24 10:09:00' },
  ];
  const v = editVersions(msg, edits);
  assert.deepEqual(v.map((x) => [x.body, x.written_at, x.current, x.original]), [
    ['v3', '2026-10-24 10:09:00', true, false],
    ['v2', '2026-10-24 10:05:00', false, false],
    ['v1', '2026-10-24 10:00:00', false, true],
  ]);
});

test('an announcement version carries its banner', () => {
  const banner = JSON.stringify({ announcement: { headline: 'Old headline', subhead: '', theme: 'red' } });
  const v = editVersions({ body: '', metadata: JSON.stringify({ announcement: { headline: 'New', subhead: '', theme: 'red' } }), created_at: '2026-10-24 10:00:00' },
    [{ body: '', metadata: banner, replaced_at: '2026-10-24 11:00:00' }]);
  assert.equal(v[0].announcement.headline, 'New');
  assert.equal(v[1].announcement.headline, 'Old headline');
});

test('edited before history was kept: the oldest known version is not called the original', () => {
  const v = editVersions({ body: 'now', metadata: null, created_at: '2026-10-01 09:00:00', edits_untracked: 1 }, []);
  assert.equal(v.length, 1);
  assert.equal(v[0].current, true);
  assert.equal(v[0].original, false);
  assert.equal(v[0].written_at, null);
  const w = editVersions({ body: 'now', created_at: '2026-10-01 09:00:00', edits_untracked: 1 }, [{ body: 'before', replaced_at: '2026-10-25 09:00:00' }]);
  assert.deepEqual(w.map((x) => [x.body, x.original, x.written_at]), [['now', false, '2026-10-25 09:00:00'], ['before', false, null]]);
});
