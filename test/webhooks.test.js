const test = require('node:test');
const assert = require('node:assert/strict');
const { hashSecret, newSecret, secretMatches, parsePayload, parseName } = require('../src/webhooks');

test('secrets: random, stored only as a hash, compared exactly', () => {
  const s = newSecret();
  assert.match(s, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(newSecret(), s);
  const h = hashSecret(s);
  assert.equal(secretMatches(s, h), true);
  assert.equal(secretMatches(s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A'), h), false);
  assert.equal(secretMatches('', h), false);
  assert.equal(secretMatches('../../etc/passwd', h), false);
  assert.equal(secretMatches(s, null), false);
});

test('payloads: Slack-style "text", or "body", with an optional bold "title"', () => {
  assert.equal(parsePayload({ text: 'Disk full' }).value, 'Disk full');
  assert.equal(parsePayload({ body: ' Build 42 passed ' }).value, 'Build 42 passed');
  assert.equal(parsePayload({ text: 'on PRD-WEB01', title: ' Alert:\n disk ' }).value, '**Alert: disk**\non PRD-WEB01');
  assert.equal(parsePayload({ title: 'Heads up' }).value, '**Heads up**');
  assert.match(parsePayload({}).error, /text/);
  assert.match(parsePayload(null).error, /text/);
  assert.match(parsePayload({ text: 5 }).error, /text/);
  assert.match(parsePayload({ text: 'x'.repeat(4001) }).error, /4000/);
  assert.match(parsePayload({ text: 'x', title: 't'.repeat(201) }).error, /200/);
});

test('names are required and short', () => {
  assert.equal(parseName('  Zabbix   alerts ').value, 'Zabbix alerts');
  assert.match(parseName('').error, /name/);
  assert.match(parseName('n'.repeat(81)).error, /80/);
});
