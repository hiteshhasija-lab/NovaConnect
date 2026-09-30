// Hyphens (including Unicode dashes) cannot separate a prefix from the keyword.
// Require whitespace or a colon before the hostname, preserving names without digits.
const DECOM_PATTERN = /(?<![\p{L}\p{N}_\p{Pd}])decommission(?:\s*:\s*|\s+)([A-Za-z0-9][A-Za-z0-9._-]*)/iu;

function extractDecomIntent(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(DECOM_PATTERN);
  return match ? { hostname: match[1] } : null;
}

module.exports = { extractDecomIntent };
