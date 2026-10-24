// VIP people (Teams' "priority access"): whether a new message alerts you (sound, desktop
// notification, blink) and marks its chat unread. Loaded by the web client before workspace.js;
// required by test/vipRules.test.js (no DOM here), so the rules are tested on their own.
//
//   - your own messages never alert;
//   - while you are Do not disturb or Presenting, only VIPs get through;
//   - otherwise the chat's or channel's level decides: all / mentions only / off,
//     except that a VIP's message always alerts.
(function (root) {
  const SILENCING = ['dnd', 'presenting'];
  function alertFor({ fromMe, fromVip, myStatus, level, mentionsMe }) {
    if (fromMe) return false;
    if (fromVip) return true;
    if (SILENCING.includes(myStatus)) return false;
    return level === 'all' || (level === 'mentions' && !!mentionsMe);
  }
  // An unread dot for a chat you are not looking at: not in "off" chats, unless a VIP wrote.
  function unreadFor({ fromVip, level }) {
    return fromVip || level !== 'off';
  }
  const api = { alertFor, unreadFor, SILENCING };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NCVipRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
