const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));
function localTime(value, zone) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new Error('Enter a valid date and time.');
  const d = dayjs.tz(value, zone);
  if (!d.isValid() || d.format('YYYY-MM-DDTHH:mm') !== value) throw new Error('This date/time does not exist in the selected time zone.');
  return d;
}
function occurrences(input) {
  const zone = input.timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); } catch { throw new Error('Choose a valid time zone.'); }
  if (typeof zone !== 'string' || zone.length > 100) throw new Error('Choose a valid time zone.');
  const start = localTime(input.start_local, zone), end = localTime(input.end_local, zone);
  if (end.valueOf() <= start.valueOf()) throw new Error('The end must be after the start.');
  if (end.diff(start,'day',true) > 31) throw new Error('A meeting cannot span more than 31 days.');
  const recurrence = input.recurrence || 'none';
  if (!['none','daily','weekly','monthly'].includes(recurrence)) throw new Error('Invalid repeat option.');
  const count = recurrence === 'none' ? 1 : Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 52) throw new Error('Choose 1–52 occurrences.');
  const unit = { daily:'day', weekly:'week', monthly:'month' }[recurrence];
  const result = [];
  for (let i=0;i<count;i++) {
    // Add on a UTC wall-clock calendar, then interpret each date in the selected zone.
    // Repeating 9am meetings stay at 9am across DST changes.
    const wallStart = dayjs.utc(input.start_local).add(i, unit || 'day').format('YYYY-MM-DDTHH:mm');
    const wallEnd = dayjs.utc(input.end_local).add(i, unit || 'day').format('YYYY-MM-DDTHH:mm');
    const a = localTime(wallStart,zone), b = localTime(wallEnd,zone);
    if (b.valueOf() <= a.valueOf()) throw new Error('A repeated meeting ends before it starts.');
    result.push({ start_at:a.utc().format('YYYY-MM-DD HH:mm:ss'), end_at:b.utc().format('YYYY-MM-DD HH:mm:ss'), local_start:wallStart, local_end:wallEnd });
  }
  return result;
}
module.exports = { occurrences };
