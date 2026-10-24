const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnnouncement, announcementOf, searchText } = require('../src/announcement');

test('no headline is an ordinary post; a headline makes an announcement', () => {
  assert.equal(parseAnnouncement({}), null);
  assert.equal(parseAnnouncement({ headline: '   ', subhead: '' }), null);
  assert.deepEqual(parseAnnouncement({ headline: '  Office  closed\nFriday ', subhead: ' Back Monday ', theme: 'green' }).value,
    { headline: 'Office closed Friday', subhead: 'Back Monday', theme: 'green' });
});

test('a subheading needs a headline; lengths are capped; unknown colours fall back to blue', () => {
  assert.match(parseAnnouncement({ subhead: 'only this' }).error, /headline/);
  assert.match(parseAnnouncement({ headline: 'x'.repeat(121) }).error, /120/);
  assert.match(parseAnnouncement({ headline: 'ok', subhead: 'y'.repeat(201) }).error, /200/);
  assert.equal(parseAnnouncement({ headline: 'ok', theme: 'url(javascript:1)' }).value.theme, 'blue');
  assert.equal(parseAnnouncement({ headline: 'ok', theme: ['red'] }).value.theme, 'blue');
  assert.equal(parseAnnouncement({ headline: 42 }), null);
});

test('reading it back from a row, and what search indexes', () => {
  const row = { body: 'Details below', metadata: JSON.stringify({ announcement: { headline: 'Release day', subhead: 'v2', theme: 'red' } }) };
  assert.equal(announcementOf(row).headline, 'Release day');
  assert.equal(searchText(row), 'Release day\nv2\nDetails below');
  assert.equal(searchText({ body: 'plain', metadata: null }), 'plain');
  assert.equal(searchText({ body: 'gif', metadata: '{"gifUrl":"https://x"}' }), 'gif');
  assert.equal(announcementOf({ metadata: 'not json' }), null);
  assert.equal(searchText({ body: '', metadata: JSON.stringify({ announcement: { headline: 'Only a headline', subhead: '' } }) }), 'Only a headline');
});
