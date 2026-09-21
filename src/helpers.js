const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

dayjs.extend(relativeTime);

const CSS_PATH = path.join(__dirname, '..', 'public', 'css', 'style.css');
const WORKSPACE_JS_PATH = path.join(__dirname, '..', 'public', 'js', 'workspace.js');
let cachedCssVersion = null;
function cssVersion() {
  if (cachedCssVersion) return cachedCssVersion;
  try {
    cachedCssVersion = Math.round(fs.statSync(CSS_PATH).mtimeMs);
  } catch (e) {
    cachedCssVersion = Date.now();
  }
  return cachedCssVersion;
}

// A separate cache-buster from cssVersion() — workspace.js and style.css are edited
// independently, so busting one must not depend on the other's mtime.
let cachedJsVersion = null;
function jsVersion() {
  if (cachedJsVersion) return cachedJsVersion;
  try {
    cachedJsVersion = Math.round(fs.statSync(WORKSPACE_JS_PATH).mtimeMs);
  } catch (e) {
    cachedJsVersion = Date.now();
  }
  return cachedJsVersion;
}

let cachedAppVersion = null;
function appVersion() {
  if (cachedAppVersion) return cachedAppVersion;
  let pkgVersion = '0.0.0';
  try {
    pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch (e) { /* fall back to default above */ }
  let sha = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) { /* not a git checkout — version number alone is fine */ }
  cachedAppVersion = sha ? `v${pkgVersion} · ${sha}` : `v${pkgVersion}`;
  return cachedAppVersion;
}

function escapeHtml(str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(fullName) {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deterministic avatar color from a user id, drawn from a small fixed palette
// so avatars stay readable in both themes instead of any random hue.
const AVATAR_PALETTE = ['#0755d9', '#009edb', '#8a651f', '#426960', '#35627c', '#5c6e42', '#725c4d'];
function avatarColor(userId) {
  const n = Number(userId) || 0;
  return AVATAR_PALETTE[n % AVATAR_PALETTE.length];
}

function fmtDateTime(d) {
  if (!d) return '';
  return dayjs(d.replace(' ', 'T')).format('MMM D, YYYY h:mm A');
}

function fmtTime(d) {
  if (!d) return '';
  return dayjs(d.replace(' ', 'T')).format('h:mm A');
}

function fmtRelative(d) {
  if (!d) return '';
  return dayjs(d.replace(' ', 'T')).fromNow();
}

function fmtDayLabel(d) {
  if (!d) return '';
  const date = dayjs(d.replace(' ', 'T'));
  const now = dayjs();
  if (date.isSame(now, 'day')) return 'Today';
  if (date.isSame(now.subtract(1, 'day'), 'day')) return 'Yesterday';
  return date.format('dddd, MMMM D');
}

// Turns @Full Name mentions (matched against a roster of members) into <span class="mention">
// tags, and escapes/linkifies everything else. Applied server-side on render so it can't be
// bypassed, and again picked up by the same regex client-side for freshly-arrived socket messages.
function renderMessageBody(body, members) {
  let html = escapeHtml(body);
  const sorted = [...members].sort((a, b) => b.full_name.length - a.full_name.length);
  for (const m of sorted) {
    const needle = escapeHtml(`@${m.full_name}`);
    if (!needle) continue;
    html = html.split(needle).join(`<span class="mention">${needle}</span>`);
  }
  return html.replace(/\n/g, '<br>');
}

const STATUS_LABELS = { online: 'Online', away: 'Away', busy: 'Busy', dnd: 'Do not disturb', offline: 'Offline' };
const STATUS_COLORS = { online: '#3cb371', away: '#e8a33d', busy: '#d1494f', dnd: '#d1494f', offline: '#8a92a6' };

module.exports = {
  cssVersion, jsVersion, appVersion, escapeHtml, initials, avatarColor,
  fmtDateTime, fmtTime, fmtRelative, fmtDayLabel, renderMessageBody,
  STATUS_LABELS, STATUS_COLORS
};
