// Announcement posts (Phase 3, "Channels"): a channel post with a headline banner, as in Teams'
// "Announcement" post type. Kept in messages.metadata as { announcement: { headline, subhead, theme } },
// built here from the form's own fields, never from client-supplied JSON. Only top-level channel
// posts can be announcements (routes/messages.js); the text under the banner is the usual body,
// which may be empty. Pure, so it is unit-tested on its own (test/announcement.test.js).

const HEADLINE_MAX = 120;
const SUBHEAD_MAX = 200;
// Banner colours; the client has a class per name (public/css/style.css .msg-announcement-*).
const THEMES = ['blue', 'purple', 'green', 'orange', 'red', 'slate'];

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

// fields: { headline, subhead, theme } as the client sent them. Returns null when there is no
// headline at all (an ordinary post), { error } or { value }.
function parseAnnouncement(fields) {
  const f = fields || {};
  const headline = clean(f.headline);
  const subhead = clean(f.subhead);
  if (!headline) return subhead ? { error: 'An announcement needs a headline.' } : null;
  if (headline.length > HEADLINE_MAX) return { error: `Keep the headline to ${HEADLINE_MAX} characters.` };
  if (subhead.length > SUBHEAD_MAX) return { error: `Keep the subheading to ${SUBHEAD_MAX} characters.` };
  const theme = THEMES.includes(f.theme) ? f.theme : THEMES[0];
  return { value: { headline, subhead, theme } };
}

function metadataOf(row) {
  if (!row || !row.metadata) return null;
  try { return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata; } catch { return null; }
}

function announcementOf(row) {
  const a = metadataOf(row)?.announcement;
  return a && typeof a.headline === 'string' ? a : null;
}

// What search indexes for a message: the headline and subheading are part of an announcement's text.
function searchText(row) {
  const a = announcementOf(row);
  return [a?.headline, a?.subhead, row?.body].filter(Boolean).join('\n');
}

module.exports = { parseAnnouncement, announcementOf, metadataOf, searchText, THEMES, HEADLINE_MAX, SUBHEAD_MAX };
