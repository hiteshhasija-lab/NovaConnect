#!/usr/bin/env node
// Data survives an upgrade. Used by the "Upgrade" job in CI, which starts an OLDER release, runs
//   node scripts/upgrade-check.js seed      (creates a person, a team, messages, two files, a photo)
// upgrades the same install in place to this version, then runs
//   node scripts/upgrade-check.js verify    (the same person signs in with the same password and finds it all)
// Only endpoints that exist in old releases are used, so the script runs against both versions.
//   BASE_URL (default http://localhost:8080), STATE_FILE (default ./upgrade-state.json)
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const BASE = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const STATE = process.env.STATE_FILE || './upgrade-state.json';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function req(method, path, { json, form, multipart } = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json' };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  else if (multipart) body = multipart;
  const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
  for (const c of res.headers.getSetCookie()) cookie = c.split(';')[0];
  const buffer = Buffer.from(await res.arrayBuffer());
  let data = null; try { data = JSON.parse(buffer.toString()); } catch { /* not json */ }
  return { status: res.status, data, buffer, headers: res.headers };
}
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`); };
async function upload(channel, name, bytes) {
  const fd = new FormData();
  fd.append('body', 'file ' + name);
  fd.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
  const r = await req('POST', `/api/channels/${channel}/messages`, { multipart: fd });
  return r.data && r.data.attachments && r.data.attachments[0] && r.data.attachments[0].id;
}

async function seed() {
  const tag = crypto.randomBytes(3).toString('hex');
  const username = 'upg' + tag;
  const password = 'Up-' + crypto.randomBytes(6).toString('hex') + '9!';
  const reg = await req('POST', '/register', { form: { full_name: 'Upgrade Check', username, email: `${username}@example.test`, password, confirm_password: password } });
  check('register', reg.status === 302, reg.status);
  const login = await req('POST', '/api/mobile/login', { json: { username, password } });
  check('sign in', login.status === 200, login.status);
  const team = await req('POST', '/api/teams', { json: { name: 'Upgrade ' + tag } });
  const channel = team.data.channel.id;
  const token = 'upgradetoken' + tag;
  const bodies = [`first message ${token}`, `second message ${token}`];
  for (const body of bodies) check('post a message', (await req('POST', `/api/channels/${channel}/messages`, { json: { body } })).status === 201);
  const small = Buffer.from('small file ' + tag);
  const big = crypto.randomBytes(1024 * 1024);
  const smallId = await upload(channel, 'small.txt', small);
  const bigId = await upload(channel, 'big.bin', big);
  check('two attachments saved', Boolean(smallId && bigId), `${smallId}/${bigId}`);
  const fd = new FormData(); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'me.png');
  check('profile photo saved', (await req('POST', '/api/profile-photo', { multipart: fd })).status === 200);
  fs.writeFileSync(STATE, JSON.stringify({ username, password, userId: login.data.user.id, team: team.data.team.id, channel, token, bodies, smallId, bigId, smallHash: sha(small), bigHash: sha(big) }));
}

async function verify() {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const login = await req('POST', '/api/mobile/login', { json: { username: st.username, password: st.password } });
  check('the same person signs in with the same password', login.status === 200 && login.data.user.id === st.userId, login.status);
  const teams = await req('GET', '/api/teams');
  check('their team is there', teams.status === 200 && teams.data.some((t) => t.id === st.team));
  const msgs = await req('GET', `/api/channels/${st.channel}/messages?limit=100`);
  const have = (msgs.data.messages || []).map((m) => m.body);
  check('their messages are all there', st.bodies.every((b) => have.includes(b)), `${have.length} messages in the channel`);
  const small = await req('GET', `/api/attachments/${st.smallId}/download`);
  check('the small file downloads identically', small.status === 200 && sha(small.buffer) === st.smallHash, small.status);
  const big = await req('GET', `/api/attachments/${st.bigId}/download`);
  check('the 1 MB file downloads byte-identical', big.status === 200 && sha(big.buffer) === st.bigHash, big.status);
  const photo = await req('GET', `/api/profile-photo/${st.userId}`);
  check('their profile photo is still the photo (not initials)', photo.status === 200 && /png/.test(photo.headers.get('content-type') || ''), photo.headers.get('content-type'));
  // The search index is rebuilt from the database at start-up; give it a moment.
  let found = 0;
  for (let i = 0; i < 24 && found < 2; i++) {
    const s = await req('GET', `/api/search?q=${st.token}`);
    found = s.status === 200 && s.data.messages ? s.data.messages.length : 0;
    if (found < 2) await sleep(1500);
  }
  check('search finds their old messages again', found >= 2, `${found} found`);
  const posted = await req('POST', `/api/channels/${st.channel}/messages`, { json: { body: 'after the upgrade ' + st.token } });
  check('they can post to the old channel on the new version', posted.status === 201, posted.status);
}

const mode = process.argv[2];
(async () => {
  if (mode === 'seed') await seed(); else if (mode === 'verify') await verify(); else { console.error('usage: upgrade-check.js seed|verify'); process.exit(2); }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
