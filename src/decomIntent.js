// Hyphens (including Unicode dashes) cannot separate a prefix from the keyword.
// Require whitespace or a colon before the hostname, preserving names without digits.
const DECOM_PATTERN = /(?<![\p{L}\p{N}_\p{Pd}])decommission(?:\s*:\s*|\s+)([A-Za-z0-9][A-Za-z0-9._-]*)/iu;

function extractDecomIntent(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(DECOM_PATTERN);
  return match ? { hostname: match[1] } : null;
}

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

module.exports = { extractDecomIntent, extractStatusIntent };
