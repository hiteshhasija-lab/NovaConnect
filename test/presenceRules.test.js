const test = require('node:test');
const assert = require('node:assert/strict');
const { shownStatus, isOutOfOffice, outOfOfficeSummary, participantPresence, parseOutOfOffice } = require('../src/presenceRules');

const NOW = '2026-10-23 12:00:00';
const ooo = (extra = {}) => ({ ooo_enabled: 1, ooo_message: 'Back Monday', ooo_start_at: null, ooo_end_at: null, ...extra });

test('out of office is on only inside its window', () => {
  assert.equal(isOutOfOffice(ooo(), NOW), true);
  assert.equal(isOutOfOffice(ooo({ ooo_enabled: 0 }), NOW), false);
  assert.equal(isOutOfOffice(ooo({ ooo_start_at: '2026-10-23 12:00:01' }), NOW), false);
  assert.equal(isOutOfOffice(ooo({ ooo_start_at: NOW }), NOW), true);
  assert.equal(isOutOfOffice(ooo({ ooo_end_at: NOW }), NOW), false);   // the end itself is no longer out of office
  assert.equal(isOutOfOffice(ooo({ ooo_end_at: '2026-10-30 17:00:00' }), NOW), true);
  assert.equal(isOutOfOffice(null, NOW), false);
});

test('offline, or Appear offline, reads Out of office while it is on', () => {
  assert.equal(shownStatus({ connected: false }), 'offline');
  assert.equal(shownStatus({ connected: false, outOfOffice: true }), 'ooo');
  assert.equal(shownStatus({ connected: true, chosen: 'offline', outOfOffice: true }), 'ooo');
  assert.equal(shownStatus({ connected: true, chosen: 'offline', call: 'incall' }), 'offline');
});

test('Do not disturb beats calls, out of office and the calendar', () => {
  assert.equal(shownStatus({ connected: true, chosen: 'dnd', call: 'presenting', outOfOffice: true, calendarMeeting: true }), 'dnd');
});

test('a live call beats out of office and the calendar', () => {
  assert.equal(shownStatus({ connected: true, chosen: 'online', call: 'incall', outOfOffice: true, calendarMeeting: true }), 'incall');
  assert.equal(shownStatus({ connected: true, chosen: 'busy', call: 'presenting' }), 'presenting');
});

test('out of office beats the calendar and Available / Away / Be right back, not Busy', () => {
  for (const chosen of [null, 'online', 'away', 'brb']) assert.equal(shownStatus({ connected: true, chosen, outOfOffice: true, calendarMeeting: true }), 'ooo');
  assert.equal(shownStatus({ connected: true, chosen: 'busy', outOfOffice: true }), 'busy');
});

test('a calendar meeting reads In a meeting only instead of Available', () => {
  assert.equal(shownStatus({ connected: true, chosen: null, calendarMeeting: true }), 'inmeeting');
  assert.equal(shownStatus({ connected: true, chosen: 'online', calendarMeeting: true }), 'inmeeting');
  for (const chosen of ['busy', 'away', 'brb']) assert.equal(shownStatus({ connected: true, chosen, calendarMeeting: true }), chosen);
  assert.equal(shownStatus({ connected: true, chosen: null }), 'online');
});

test('others see the message and the end, never the raw settings', () => {
  assert.deepEqual(outOfOfficeSummary(ooo({ ooo_end_at: '2026-10-30 17:00:00' }), NOW), { message: 'Back Monday', until: '2026-10-30 17:00:00' });
  assert.equal(outOfOfficeSummary(ooo({ ooo_enabled: 0 }), NOW), null);
  const p = participantPresence({ id: 2, status_message: 'old', status_message_expires_at: '2026-10-23 11:00:00', ...ooo() }, NOW);
  assert.equal(p.status_message, null);
  assert.deepEqual(p.out_of_office, { message: 'Back Monday', until: null });
  for (const k of ['status_message_expires_at', 'ooo_enabled', 'ooo_message', 'ooo_start_at', 'ooo_end_at']) assert.ok(!(k in p), k);
});

test('the out-of-office form: times become UTC text, bad input is refused', () => {
  const now = Date.UTC(2026, 9, 23, 12);
  const ok = parseOutOfOffice({ enabled: true, message: '  Away  ', start_at: '2026-10-24T09:00:00.000Z', end_at: '2026-10-30T17:30:00.000Z' }, now);
  assert.deepEqual(ok.value, { ooo_enabled: 1, ooo_message: 'Away', ooo_start_at: '2026-10-24 09:00:00', ooo_end_at: '2026-10-30 17:30:00' });
  assert.deepEqual(parseOutOfOffice({ enabled: false }, now).value, { ooo_enabled: 0, ooo_message: null, ooo_start_at: null, ooo_end_at: null });
  assert.match(parseOutOfOffice({ enabled: 'yes' }, now).error, /Choose/);
  assert.match(parseOutOfOffice({ enabled: true, message: 'x'.repeat(501) }, now).error, /500/);
  assert.match(parseOutOfOffice({ enabled: true, start_at: 'soon' }, now).error, /valid/);
  assert.match(parseOutOfOffice({ enabled: true, start_at: 5 }, now).error, /valid/);
  assert.match(parseOutOfOffice({ enabled: true, start_at: '2026-10-25T00:00:00Z', end_at: '2026-10-24T00:00:00Z' }, now).error, /after the start/);
  assert.match(parseOutOfOffice({ enabled: true, end_at: '2026-10-22T00:00:00Z' }, now).error, /past/);
  assert.ok(parseOutOfOffice({ enabled: false, end_at: '2026-10-22T00:00:00Z' }, now).value);   // turning it off with an old end is fine
});

test('every device idle reads Away, but only instead of Available; calls, out of office and the calendar win', () => {
  const { shownStatus } = require('../src/presenceRules');
  assert.equal(shownStatus({ connected: true, chosen: null, idle: true }), 'away');
  assert.equal(shownStatus({ connected: true, chosen: 'online', idle: true }), 'away');
  for (const chosen of ['busy', 'dnd', 'brb']) assert.equal(shownStatus({ connected: true, chosen, idle: true }), chosen);
  assert.equal(shownStatus({ connected: true, chosen: null, idle: true, call: 'incall' }), 'incall');
  assert.equal(shownStatus({ connected: true, chosen: null, idle: true, outOfOffice: true }), 'ooo');
  assert.equal(shownStatus({ connected: true, chosen: null, idle: true, calendarMeeting: true }), 'inmeeting');
  assert.equal(shownStatus({ connected: false, idle: true }), 'offline');
});

test('the kind of device, from the user agent', () => {
  const { deviceOf } = require('../src/presenceRules');
  assert.equal(deviceOf('NovaConnectNative/39 CFNetwork/3826.400.120 Darwin/25.0.0'), 'iphone');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 NovaConnect/1.0.0 Chrome/130 Electron/33.0.0 Safari/537.36'), 'desktop');
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'), 'mobile');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile Safari/537.36'), 'mobile');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'), 'web');
  assert.equal(deviceOf(undefined), 'web');
});
