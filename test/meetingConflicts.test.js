const test = require('node:test');
const assert = require('node:assert/strict');
const { groupConflicts, overlaps } = require('../src/meetingConflicts');

test('touching meetings do not overlap; any shared minute does', () => {
  assert.equal(overlaps('2026-11-02 10:00:00', '2026-11-02 11:00:00', '2026-11-02 11:00:00', '2026-11-02 12:00:00'), false);
  assert.equal(overlaps('2026-11-02 10:00:00', '2026-11-02 11:00:00', '2026-11-02 10:59:00', '2026-11-02 12:00:00'), true);
  assert.equal(overlaps('2026-11-02 10:00:00', '2026-11-02 11:00:00', '2026-11-02 09:00:00', '2026-11-02 13:00:00'), true);
});

test('grouped per person, you first; titles only of meetings you are in; occurrences counted', () => {
  const occ = [
    { start_at: '2026-11-02 10:00:00', end_at: '2026-11-02 11:00:00' },
    { start_at: '2026-11-09 10:00:00', end_at: '2026-11-09 11:00:00' },
    { start_at: '2026-11-16 10:00:00', end_at: '2026-11-16 11:00:00' },
  ];
  const busy = [
    { user_id: 2, meeting_id: 50, title: 'Board review', start_at: '2026-11-02 10:30:00', end_at: '2026-11-02 12:00:00', all_day: 0 },
    { user_id: 2, meeting_id: 51, title: 'Dentist', start_at: '2026-11-16 00:00:00', end_at: '2026-11-17 00:00:00', all_day: 1 },
    { user_id: 1, meeting_id: 50, title: 'Board review', start_at: '2026-11-02 10:30:00', end_at: '2026-11-02 12:00:00', all_day: 0 },
    { user_id: 3, meeting_id: 52, title: 'Lunch', start_at: '2026-11-02 12:00:00', end_at: '2026-11-02 13:00:00', all_day: 0 },
  ];
  const people = [{ id: 1, full_name: 'Zed Viewer' }, { id: 2, full_name: 'Ann Other' }, { id: 3, full_name: 'Bea Free' }];
  const out = groupConflicts(occ, busy, people, 1, new Set([50]));
  assert.deepEqual(out.map((p) => [p.full_name, p.is_me, p.occurrences_affected]), [['Zed Viewer', true, 1], ['Ann Other', false, 2]]);
  assert.equal(out[0].items[0].title, 'Board review');
  assert.equal(out[1].items[0].title, 'Board review');   // the viewer is in it, so the title may be shown
  assert.equal(out[1].items[1].title, null);              // someone else's meeting: busy only
  assert.equal(out[1].items[1].all_day, true);
});
