// Starts a decommission request from a chat message. This is destructive work, so the match is
// deliberately narrow:
//  - "decommission" must be a standalone word (a hyphen, including Unicode dashes, never separates a
//    prefix from the keyword: "pre-decommission X" is not a request), followed by whitespace or a colon;
//  - it must be where a command would be: at the start of the message, after a lead-in such as
//    "please", "can you", "go ahead and", "I need you to" or an @mention (discussion such as "we should"
//    or "let's" does not count), OR the name that
//    follows must look like a host name (it has a digit, dot, hyphen or underscore), so
//    "I think we should decommission web-01" still works but "the decommission today" does not;
//  - the name must contain a letter, may follow "the", "server", "vm", "host" or "machine", must not be
//    an ordinary English word ("today", "status", "process", ...) and loses a trailing sentence dot.
const LEAD_IN = "(?:@\\S+\\s+)?(?:(?:hey|hi|hello|ok|okay|so|please|pls|kindly|just|now|can you|could you|would you|will you|go ahead and|i(?:'d| would)? (?:like|want|need)(?: you)? to)[\\s,]+)*";
const NOUN = '(?:(?:the|a|an|this|that)\\s+)?(?:(?:server|vm|host|machine|box|node)\\s+)?';
const NAME = '([A-Za-z0-9][A-Za-z0-9._-]*)';
const KEYWORD = 'decommission(?:\\s*:\\s*|\\s+)';
const AT_START = new RegExp(`^\\s*${LEAD_IN}${KEYWORD}${NOUN}${NAME}`, 'iu');
const ANYWHERE = new RegExp(`(?<![\\p{L}\\p{N}_\\p{Pd}])${KEYWORD}${NOUN}${NAME}`, 'iu');
const NOT_A_HOST = new Set(('a an the this that these those it its them they all any some every everything everyone one ones none ' +
  'today tomorrow tonight yesterday now later soon asap again here there next last first once ' +
  'status request requests requested process workflow procedure plan ticket change changes task tasks card cards ' +
  'server servers vm vms host hosts machine machines box node nodes system systems ' +
  'please thanks thank ok okay yes no not of for on in at to by from with and or but if is are was be been as so ' +
  'will would should could can must may might do does did done have has had').split(' '));

function cleanName(raw) {
  const name = raw.replace(/[._-]+$/, '');
  if (!/[A-Za-z]/.test(name) || NOT_A_HOST.has(name.toLowerCase())) return null;
  return name;
}
const looksLikeHost = (name) => /[0-9._-]/.test(name);

function extractDecomIntent(text) {
  if (typeof text !== 'string') return null;
  let m = text.match(AT_START);
  if (m) {
    const name = cleanName(m[1]);
    if (name) return { hostname: name };
  }
  m = text.match(ANYWHERE);
  if (m) {
    const name = cleanName(m[1]);
    if (name && looksLikeHost(name)) return { hostname: name };
  }
  return null;
}

// True when the message uses the word "decommission" on its own but did not parse as a request, so
// the bot DM can say how to ask (never used in a channel, where it would be noise).
const mentionsDecommission = (text) => typeof text === 'string' && /(?<![\p{L}\p{N}_\p{Pd}])decommission(?![\p{L}\p{N}_])/iu.test(text);

// "status <server name | CHG number>" typed in a decommission DM or #server-decom. Anchored to the
// whole message so ordinary conversation that happens to contain the word "status" is left alone;
// "decommission status X", "status of X", "status: X" and a leading @mention are accepted. A bare
// "status" yields { help: true } (answered in the bot DM only, see decomFlow).
const STATUS_PATTERN = /^\s*(?:@\S+\s+)?(?:decommission\s+)?status(?:\s+(?:of|for))?\s*[:\p{Pd}]?\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*[?.!]?\s*$/iu;
const BARE_STATUS = /^\s*(?:@\S+\s+)?(?:decommission\s+)?status\s*[?.!]?\s*$/iu;

function extractStatusIntent(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(STATUS_PATTERN);
  if (match) return { query: match[1] };
  if (BARE_STATUS.test(text)) return { help: true };
  return null;
}

module.exports = { extractDecomIntent, extractStatusIntent, mentionsDecommission };
