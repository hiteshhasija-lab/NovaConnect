// Edit history (Phase 3, "Messages"): turns a message and its stored earlier versions
// (message_edits, oldest first) into what "(edited)" shows, newest first. Each version says when it
// was written: the message's creation for the first, the edit that replaced the one before for the
// rest. Pure, so it is unit-tested on its own (test/editHistory.test.js).
const { announcementOf } = require('./announcement');

function editVersions(message, edits) {
  const all = [...edits.map(e => ({ body: e.body || '', metadata: e.metadata })), { body: message.body || '', metadata: message.metadata }];
  const writtenAt = [message.created_at, ...edits.map(e => e.replaced_at)];
  const untracked = !!Number(message.edits_untracked);
  return all.map((v, i) => ({
    body: v.body,
    announcement: announcementOf(v),
    // (When an untracked message's oldest known version was written isn't known.)
    written_at: i === 0 && untracked ? null : writtenAt[i],
    current: i === all.length - 1,
    // The first version is the original, unless the message was edited before history was kept.
    original: i === 0 && !untracked,
  })).reverse();
}

module.exports = { editVersions };
