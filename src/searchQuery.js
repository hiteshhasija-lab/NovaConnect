// The global search bar's query language (Phase 3, "Search"): free text plus filters.
//
//   from:<person>    a name, a username or "me"; quote names with spaces: from:"Jane Doe"
//   in:<place>       a channel (#general or general) or a chat (@jdoe, a person's name, a group's name)
//   before:<date>    after:<date>    on:<date>     YYYY-MM-DD in the searcher's own time zone;
//                    "before" excludes that day, "after" includes it, "on" is that one day
//   has:file         has:link
//
// Several from: (or in:) values mean any of them. Anything else, including an unknown "word:" or a
// date that isn't a real day, stays in the free text, so nothing the user typed is silently dropped.
// Pure (no database), so it is unit-tested on its own (test/searchQuery.test.js); src/search.js
// turns the result into Meilisearch and Postgres conditions.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HAS = new Set(['file', 'link']);

// Split into tokens: key:"quoted value", key:value, "quoted phrase", word.
function tokenize(raw) {
  const tokens = [];
  const re = /([A-Za-z]+):"([^"]*)"|([A-Za-z]+):(\S+)|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw))) {
    if (m[1] !== undefined) tokens.push({ key: m[1].toLowerCase(), value: m[2], raw: m[0] });
    else if (m[3] !== undefined) tokens.push({ key: m[3].toLowerCase(), value: m[4], raw: m[0] });
    else if (m[5] !== undefined) tokens.push({ text: m[5], raw: m[0] });
    else tokens.push({ text: m[6], raw: m[0] });
  }
  return tokens;
}

// Midnight at the start of a local day, as a UTC instant (ms). tzOffsetMinutes is what the
// browser's Date.getTimezoneOffset() reports (minutes to ADD to local time to get UTC, so 300 for
// US Central summer time). Returns null for anything that isn't a real calendar day.
function localDayStart(value, tzOffsetMinutes) {
  const m = DATE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return utc + tzOffsetMinutes * 60000;
}

// 'YYYY-MM-DD HH:MM:SS' in UTC, the format messages.created_at is stored in (so text compares work).
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function parseSearchQuery(raw, { tzOffsetMinutes = 0 } = {}) {
  const tz = Number.isInteger(tzOffsetMinutes) && Math.abs(tzOffsetMinutes) <= 14 * 60 ? tzOffsetMinutes : 0;
  const q = { text: '', terms: [], from: [], in: [], after: null, before: null, has: { file: false, link: false }, applied: [] };
  const words = [];
  let afterMs = null;
  let beforeMs = null;

  for (const t of tokenize(String(raw || ''))) {
    if (t.text !== undefined) { words.push(t.text); continue; }
    const value = t.value.trim();
    if (t.key === 'from' && value) { q.from.push(value); q.applied.push({ type: 'from', value, label: `From: ${value}` }); continue; }
    if (t.key === 'in' && value) { q.in.push(value); q.applied.push({ type: 'in', value, label: `In: ${value}` }); continue; }
    if (t.key === 'has' && HAS.has(value.toLowerCase())) {
      const v = value.toLowerCase();
      if (!q.has[v]) { q.has[v] = true; q.applied.push({ type: 'has', value: v, label: v === 'file' ? 'Has a file' : 'Has a link' }); }
      continue;
    }
    if (t.key === 'after' || t.key === 'before' || t.key === 'on') {
      const start = localDayStart(value, tz);
      if (start !== null) {
        const nextDay = start + 24 * 3600 * 1000;
        if (t.key !== 'before') afterMs = afterMs === null ? start : Math.max(afterMs, start);
        if (t.key === 'before') beforeMs = beforeMs === null ? start : Math.min(beforeMs, start);
        if (t.key === 'on') beforeMs = beforeMs === null ? nextDay : Math.min(beforeMs, nextDay);
        q.applied.push({ type: t.key, value, label: `${t.key[0].toUpperCase()}${t.key.slice(1)}: ${value}` });
        continue;
      }
    }
    words.push(t.raw);   // unknown key, empty value or not a real date: keep it as text
  }

  q.text = words.join(' ').trim();
  // Words to highlight in results: the free text's words, without quotes, at least 2 characters.
  q.terms = [...new Set(q.text.replace(/"/g, ' ').split(/\s+/).filter((w) => w.length >= 2).map((w) => w.toLowerCase()))].slice(0, 10);
  if (afterMs !== null) q.after = { ms: afterMs, ts: Math.floor(afterMs / 1000), sql: sqlTime(afterMs) };
  if (beforeMs !== null) q.before = { ms: beforeMs, ts: Math.floor(beforeMs / 1000), sql: sqlTime(beforeMs) };
  q.hasFilters = q.applied.length > 0;
  return q;
}

module.exports = { parseSearchQuery, tokenize, localDayStart };
