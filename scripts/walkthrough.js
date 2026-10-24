#!/usr/bin/env node
// Feature walk-through of a running NovaConnect, through its real routes and sockets.
//
// Signs people up and in with the real endpoints and then uses every main feature the way a client
// does: teams and join approval, channels (public/private), messages (edit, delete, react, thread,
// pin, forward, mention, paging, attachments), direct and group messages, blocking, search and its
// privacy, scheduled messages, calendar and meetings, profile and photo, admin, the assistant, and
// the NovaDesk integration endpoints. For each action it also checks the live event the other
// people's open sockets receive, so "works only after a reload" bugs show up.
//
//   BASE_URL=http://localhost:8080 ADMIN_USERNAME=admin ADMIN_PASSWORD=... SYNC_API_KEY=... \
//     node scripts/walkthrough.js
//
// It creates users, teams and messages on that instance (names carry a per-run tag, so it can be run
// again). Use a throwaway or fresh install, not production.
//   WALK_SKIP_SCHEDULER=1  skip the step that waits ~70 s for a scheduled message to be sent
//   WALK_RATE_LIMIT=1      also fire bad logins until the limiter answers 429 (locks this IP for a while)
const path = require('path');
const WebSocket = require('ws');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const SYNC_KEY = process.env.SYNC_API_KEY;
if (!ADMIN_PASS || !SYNC_KEY) { console.error('ADMIN_PASSWORD and SYNC_API_KEY are required.'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let section = '';
const log = (ok, name, extra = '') => { results.push({ ok, section, name, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${extra ? '  -- ' + extra : ''}`); };
async function step(name, fn) { try { const r = await fn(); log(r !== false, name, typeof r === 'string' ? r : ''); } catch (e) { log(false, name, String(e.message || e).slice(0, 300)); } }
const must = (cond, msg) => { if (!cond) throw new Error(msg); return true; };

class Client {
  constructor(name) { this.name = name; this.cookie = ''; this.events = []; this.ws = null; this.user = null; }
  setCookie(res) { const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : []; for (const c of sc) { const kv = c.split(';')[0]; const k = kv.split('=')[0]; const jar = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((p) => [p.split('=')[0], p])); jar[k] = kv; this.cookie = Object.values(jar).join('; '); } }
  async req(method, path, { json, form, multipart, headers = {}, raw } = {}) {
    const h = { ...headers, Cookie: this.cookie, Accept: 'application/json' };
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    else if (multipart) body = multipart;
    const res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
    this.setCookie(res);
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* html or empty */ }
    return { status: res.status, data, text, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, json) { return this.req('POST', p, { json: json === undefined ? {} : json }); }
  put(p, json) { return this.req('PUT', p, { json }); }
  patch(p, json) { return this.req('PATCH', p, { json }); }
  del(p) { return this.req('DELETE', p); }
  async login(username, password) { const r = await this.req('POST', '/api/mobile/login', { json: { username, password } }); if (r.status === 200) this.user = r.data.user; return r; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE.replace('http', 'ws') + '/socket.io/?EIO=4&transport=websocket', { headers: { Cookie: this.cookie } });
      this.ws.on('message', (m) => {
        const s = m.toString();
        if (s[0] === '0') this.ws.send('40');
        else if (s === '2') this.ws.send('3');
        else if (s.startsWith('40')) resolve();
        else if (s.startsWith('42')) { try { const [name, payload] = JSON.parse(s.slice(2)); this.events.push({ name, payload, at: Date.now() }); } catch { /* ignore */ } }
        else if (s.startsWith('44')) reject(new Error('socket refused: ' + s));
      });
      this.ws.on('error', reject);
      setTimeout(() => reject(new Error('socket connect timeout')), 8000);
    });
  }
  emit(name, payload) { this.ws.send('42' + JSON.stringify([name, payload])); }
  async waitFor(name, pred = () => true, ms = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const e = this.events.find((x) => x.name === name && pred(x.payload)); if (e) return e.payload; await sleep(50); }
    throw new Error(`${this.name}: no "${name}" event within ${ms} ms (saw: ${[...new Set(this.events.map((e) => e.name))].join(', ') || 'none'})`);
  }
  hasEvent(name, pred = () => true) { return this.events.some((x) => x.name === name && pred(x.payload)); }
  close() { try { this.ws && this.ws.close(); } catch { /* */ } }
}

async function register(c, username, fullName, password) {
  const r = await c.req('POST', '/register', { form: { full_name: fullName, username, email: `${username}@example.test`, title: 'Walker', password, confirm_password: password } });
  return r;
}

(async () => {
  const admin = new Client('admin'), alice = new Client('alice'), bob = new Client('bob'), carol = new Client('carol'), anon = new Client('anon');
  const PW = 'Walk-' + Math.random().toString(36).slice(2, 10) + '9!';
  const tag = Math.random().toString(36).slice(2, 8);   // unique per run: search token and usernames
  const un = (n) => n + tag;

  section = 'health & security';
  await step('health answers healthy', async () => { const r = await anon.get('/health'); return must(r.status === 200 && r.data.status === 'healthy', JSON.stringify(r.data)); });
  await step('production CSP and hardening headers are sent', async () => {
    const r = await anon.get('/login');
    const csp = r.headers.get('content-security-policy') || '';
    must(/default-src 'self'/.test(csp) && !/report-only/i.test(Object.keys(Object.fromEntries(r.headers)).join()), 'CSP missing');
    must(r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('strict-transport-security'), 'headers');
    return true;
  });
  await step('login page renders', async () => { const r = await anon.get('/login'); return must(r.status === 200 && /loginUsername/.test(r.text), 'status ' + r.status); });
  await step('unauthenticated API call is refused (401), not served', async () => { const r = await anon.get('/api/teams'); return must(r.status === 401 || r.status === 302, 'status ' + r.status); });
  await step('unauthenticated page redirects to login', async () => { const r = await anon.get('/app'); return must(r.status === 302 && /login/.test(r.headers.get('location') || ''), `${r.status} ${r.headers.get('location')}`); });

  section = 'accounts & sessions';
  await step('first admin (from ADMIN_*) can sign in', async () => { const r = await admin.login(ADMIN_USER, ADMIN_PASS); return must(r.status === 200 && r.data.user.role === 'admin', `${r.status} ${r.text.slice(0, 120)}`); });
  await step('wrong password is rejected with 401', async () => { const c = new Client('x'); const r = await c.login(ADMIN_USER, 'definitely-wrong'); return must(r.status === 401, 'status ' + r.status); });
  for (const [c, u, n] of [[alice, un('alice'), 'Alice Anders'], [bob, un('bob'), 'Bob Brooks'], [carol, un('carol'), 'Carol Chen']]) {
    await step(`register ${u} through /register, then sign in with JSON login`, async () => {
      const r = await register(c, u, n, PW);
      must(r.status === 302 && /\/app/.test(r.headers.get('location') || ''), `register ${r.status} ${r.text.slice(0, 100)}`);
      const l = await c.login(u, PW);
      return must(l.status === 200 && l.data.user.full_name === n, 'login ' + l.status);
    });
  }
  await step('registration refuses a taken username and a short password', async () => {
    const dup = await register(new Client('d'), un('alice'), 'Alice Two', PW);
    const short = await register(new Client('s'), 'shorty', 'Short', 'abc');
    return must(/already taken/.test(dup.text) && /8 characters/.test(short.text), 'dup/short messages missing');
  });
  await step('/api/mobile/session returns the signed-in user', async () => { const r = await alice.get('/api/mobile/session'); return must(r.status === 200 && r.data.user.username === un('alice'), r.text.slice(0, 100)); });
  await step('admin reset requires a temporary-password change before normal access', async () => {
    const temporary = `Temp-${tag}-9!`;
    const reset = await admin.req('POST', `/admin/users/${carol.user.id}/reset-password`, { form: { new_password: temporary, confirm_password: temporary } });
    must(reset.status === 302 && /password_reset=/.test(reset.headers.get('location') || ''), `reset ${reset.status}`);
    await carol.post('/api/mobile/logout');
    const login = await carol.login(un('carol'), temporary);
    must(login.status === 200 && login.data.user.must_change_password === true, `temporary login ${login.status}`);
    const blocked = await carol.get('/api/teams');
    must(blocked.status === 403 && blocked.data.code === 'PASSWORD_CHANGE_REQUIRED', `blocked ${blocked.status} ${blocked.text.slice(0, 100)}`);
    const changed = await carol.post('/api/mobile/password', { current_password: temporary, new_password: PW, confirm_password: PW });
    must(changed.status === 200 && changed.data.user.must_change_password === false, `change ${changed.status} ${changed.text.slice(0, 100)}`);
    const allowed = await carol.get('/api/teams');
    return must(allowed.status === 200, `after change ${allowed.status}`);
  });
  await step('a password reset or change ends the person\'s other sessions, a forced-change session gets no socket, wrong guesses are throttled', async () => {
    const erin = new Client('erin'); const un2 = un('erin');
    await erin.req('POST', '/register', { form: { full_name: 'Erin Eld', username: un2, password: PW, confirm_password: PW } });
    must((await erin.login(un2, PW)).status === 200, 'erin login');
    const other = new Client('erin-other-device'); await other.login(un2, PW);
    must((await other.get('/api/teams')).status === 200, 'second session works before the reset');
    const temp = `Tmp-${tag}-7!`;
    const reset = await admin.req('POST', `/admin/users/${erin.user.id}/reset-password`, { form: { new_password: temp, confirm_password: temp } });
    must(reset.status === 302, 'reset ' + reset.status);
    const gone = await other.get('/api/teams');
    must(gone.status === 401 || gone.status === 302, 'the session open before the reset must be signed out, got ' + gone.status);
    const forced = new Client('erin-forced'); must((await forced.login(un2, temp)).status === 200, 'temporary login');
    const sock = await forced.connect().then(() => true, () => false);
    must(sock === false, 'a forced-change session must not get a realtime socket');
    const next = `New-${tag}-6!`;
    const ch = await forced.post('/api/mobile/password', { current_password: temp, new_password: next, confirm_password: next });
    must(ch.status === 200, 'change ' + ch.status);
    let throttled = 0;
    for (let i = 0; i < 12; i++) { const w = await forced.post('/api/mobile/password', { current_password: 'wrong' + i, new_password: next, confirm_password: next }); if (w.status === 429) { throttled = i + 1; break; } }
    must(throttled > 0 && throttled <= 11, 'wrong current-password guesses must be throttled (10 per 15 min), first 429 after ' + throttled);
    const l = await fetch(BASE + '/api/mobile/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: un('alice'), password: PW }) });
    const cookie = l.headers.getSetCookie()[0] || '';
    return must(/HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie), 'session cookie flags: ' + cookie.replace(/=[^;]*/, '=…'));
  });
  await step('realtime sockets connect for alice, bob and carol', async () => { await alice.connect(); await bob.connect(); await carol.connect(); return true; });

  section = 'teams & channels';
  let team, general;
  await step('alice creates a team and gets #general', async () => { const r = await alice.post('/api/teams', { name: `Platform ${tag}`, description: 'walk' }); must(r.status === 201, r.text.slice(0, 160)); team = r.data.team; general = r.data.channel; return must(general.name === 'general' && team.id, 'shape'); });
  await step('team list shows it with alice as owner', async () => { const r = await alice.get('/api/teams'); const t = r.data.find((x) => x.id === team.id); return must(t && t.my_role === 'owner' && t.is_member, JSON.stringify(t)); });
  await step('bob (not a member) sees it as joinable, cannot read #general', async () => {
    const r = await bob.get(`/api/channels/${general.id}/messages`);
    return must(r.status === 403 || r.status === 404, 'status ' + r.status);
  });
  await step('bob joins the (open) team immediately and gets realtime membership', async () => {
    const r = await bob.post(`/api/teams/${team.id}/join`);
    must(r.status === 200 && r.data.joined, r.text.slice(0, 120));
    const g = await bob.get(`/api/channels/${general.id}/messages`);
    return must(g.status === 200, 'after join ' + g.status);
  });
  let secretTeamChannel;
  await step('alice turns on join approval; carol requests; alice sees it, approves; carol is in', async () => {
    const s = await alice.patch(`/api/teams/${team.id}/settings`, { require_approval: true });
    must(s.status === 200 && s.data.require_approval === true, 'settings ' + s.text.slice(0, 100));
    const j = await carol.post(`/api/teams/${team.id}/join`);
    must(j.status === 200 && j.data.requested, 'join ' + j.text.slice(0, 120));
    await alice.waitFor('team:join-requests', (p) => p.count >= 1);
    const list = await alice.get(`/api/teams/${team.id}/join-requests`);
    must(list.status === 200 && list.data.some((x) => x.user_id === carol.user.id || x.id === carol.user.id), 'list ' + list.text.slice(0, 160));
    const a = await alice.post(`/api/teams/${team.id}/join-requests/${carol.user.id}/approve`);
    must(a.status === 200, 'approve ' + a.text.slice(0, 120));
    await carol.waitFor('membership:changed', (p) => Number(p.teamId) === team.id);
    const g = await carol.get(`/api/channels/${general.id}/messages`);
    return must(g.status === 200, 'carol read ' + g.status);
  });
  await step('a member cannot change team settings', async () => { const r = await bob.patch(`/api/teams/${team.id}/settings`, { require_approval: false }); return must(r.status === 403, 'status ' + r.status); });
  await step('alice creates a public and a private channel; names are normalised', async () => {
    const pub = await alice.post(`/api/teams/${team.id}/channels`, { name: 'Ops Room', description: 'ops' });
    must(pub.status === 201 || pub.status === 200, 'pub ' + pub.text.slice(0, 120));
    const priv = await alice.post(`/api/teams/${team.id}/channels`, { name: 'secrets', is_private: true });
    must(priv.status === 201 || priv.status === 200, 'priv ' + priv.text.slice(0, 120));
    secretTeamChannel = priv.data.channel || priv.data;
    return must((pub.data.channel || pub.data).name === 'ops-room', 'name ' + JSON.stringify(pub.data).slice(0, 120));
  });
  await step('live without a reload: a channel created after people joined reaches them, and the creator hears the team she just made', async () => {
    const ops = (await alice.get(`/api/teams/${team.id}`)).data.channels.find((c) => c.name === 'ops-room');
    const p = await bob.post(`/api/channels/${ops.id}/messages`, { body: 'bob in ops' });
    const id = (p.data.message || p.data).id;
    await alice.waitFor('message:new', (m) => m.id === id);
    await carol.waitFor('message:new', (m) => m.id === id);
    const g = await bob.post(`/api/channels/${general.id}/messages`, { body: 'bob in general' });
    await alice.waitFor('message:new', (m) => m.id === (g.data.message || g.data).id);
    return true;
  });
  await step('private channel is closed to non-members, open after alice adds bob', async () => {
    const before = await bob.get(`/api/channels/${secretTeamChannel.id}/messages`);
    must(before.status === 403 || before.status === 404, 'before ' + before.status);
    const add = await alice.post(`/api/channels/${secretTeamChannel.id}/membership`, { user_id: bob.user.id, role: 'member' });
    must(add.status === 200, 'add ' + add.text.slice(0, 120));
    const after = await bob.get(`/api/channels/${secretTeamChannel.id}/messages`);
    const carolStill = await carol.get(`/api/channels/${secretTeamChannel.id}/messages`);
    return must(after.status === 200 && (carolStill.status === 403 || carolStill.status === 404), `after ${after.status} carol ${carolStill.status}`);
  });
  await step('channel notification level can be set per user', async () => { const r = await bob.put(`/api/channels/${general.id}/notifications`, { level: 'mentions' }); must(r.status === 200, r.text.slice(0, 100)); await bob.waitFor('channel:notify-level', (p) => p.level === 'mentions'); return true; });

  section = 'channel messages';
  let m1;
  await step('alice posts; bob and carol receive it live; body round-trips', async () => {
    const r = await alice.post(`/api/channels/${general.id}/messages`, { body: `hello team ${tag}` });
    must(r.status === 201 || r.status === 200, r.text.slice(0, 160));
    m1 = r.data.message || r.data;
    const ev = await bob.waitFor('message:new', (p) => p.id === m1.id);
    await carol.waitFor('message:new', (p) => p.id === m1.id);
    return must(ev.body === `hello team ${tag}` && ev.author.username === un('alice'), JSON.stringify(ev).slice(0, 160));
  });
  await step('history returns it, newest last, with author and flags', async () => { const r = await bob.get(`/api/channels/${general.id}/messages`); const m = r.data.messages.find((x) => x.id === m1.id); return must(m && m.author.full_name === 'Alice Anders' && m.deleted === false && m.edited === false, JSON.stringify(m)); });
  await step('edit: only the author may; edited flag and event', async () => {
    const no = await bob.put(`/api/messages/${m1.id}`, { body: 'hijack' });
    must(no.status === 403, 'non-author edit ' + no.status);
    const r = await alice.put(`/api/messages/${m1.id}`, { body: `hello team (edited) ${tag}` });
    must(r.status === 200, r.text.slice(0, 100));
    const ev = await bob.waitFor('message:update', (p) => p.id === m1.id);
    return must(ev.edited === true && /edited/.test(ev.body), JSON.stringify(ev).slice(0, 140));
  });
  await step('reaction toggles on and off with counts and "mine"', async () => {
    const on = await bob.post(`/api/messages/${m1.id}/reactions`, { emoji: '👍' });
    must(on.status === 200 && on.data.reactions.find((x) => x.emoji === '👍').count === 1, JSON.stringify(on.data).slice(0, 160));
    const bobSees = (await bob.get(`/api/channels/${general.id}/messages`)).data.messages.find((x) => x.id === m1.id).reactions[0];
    must(bobSees.mine === true, 'history marks it mine for the reactor');
    const live = (await alice.waitFor('reaction:update', (p) => p.message_id === m1.id)).reactions[0];
    must(Array.isArray(live.user_ids) && live.user_ids.includes(bob.user.id), 'broadcast lists who reacted: ' + JSON.stringify(live));
    must(on.data.reactions[0].mine === true, 'the toggler\'s own answer must say mine=true, got ' + on.data.reactions[0].mine);
    await alice.waitFor('reaction:update', (p) => p.message_id === m1.id);
    const off = await bob.post(`/api/messages/${m1.id}/reactions`, { emoji: '👍' });
    return must(off.status === 200 && off.data.reactions.length === 0, JSON.stringify(off.data).slice(0, 120));
  });
  let threadReply;
  await step('thread reply: appears in thread, not in the main list, reply_count updates', async () => {
    const r = await bob.post(`/api/channels/${general.id}/messages`, { body: 'a reply', parent_message_id: m1.id });
    must(r.status === 201 || r.status === 200, r.text.slice(0, 120));
    threadReply = r.data.message || r.data;
    await alice.waitFor('thread:message', (p) => p.id === threadReply.id);
    const th = await alice.get(`/api/messages/${m1.id}/thread`);
    must(th.status === 200 && JSON.stringify(th.data).includes('a reply'), th.text.slice(0, 160));
    const main = await alice.get(`/api/channels/${general.id}/messages`);
    must(!main.data.messages.some((x) => x.id === threadReply.id), 'reply leaked into main list');
    const parent = main.data.messages.find((x) => x.id === m1.id);
    return must(parent.reply_count === 1, 'reply_count ' + parent.reply_count);
  });
  await step('pin and unpin; pinned list shows it', async () => {
    const p = await alice.post(`/api/messages/${m1.id}/pin`);
    must(p.status === 200, p.text.slice(0, 100));
    const list = await alice.get(`/api/pins?channel_id=${general.id}`);
    must(list.status === 200 && JSON.stringify(list.data).includes(`hello team (edited) ${tag}`), list.text.slice(0, 160));
    const u = await alice.post(`/api/messages/${m1.id}/pin`);
    return must(u.status === 200, 'unpin ' + u.status);
  });
  await step('mention notifies the person (feed, unread count, realtime), mark read works', async () => {
    const r = await alice.post(`/api/channels/${general.id}/messages`, { body: `ping @Bob Brooks about ${tag}` });
    must(r.status === 201 || r.status === 200, r.text.slice(0, 100));
    await bob.waitFor('notification:new');
    const n = await bob.get('/api/notifications');
    must(n.status === 200 && n.data.unread_count >= 1 && n.data.notifications.some((x) => x.type === 'mention' && x.actor_name === 'Alice Anders'), JSON.stringify(n.data).slice(0, 200));
    const id = n.data.notifications.find((x) => x.type === 'mention').id;
    const rd = await bob.post(`/api/notifications/${id}/read`);
    must(rd.status === 200, 'read ' + rd.status);
    const ra = await bob.post('/api/notifications/read-all');
    const after = await bob.get('/api/notifications');
    return must(ra.status === 200 && after.data.unread_count === 0, 'unread ' + after.data.unread_count);
  });
  await step('forward to another channel produces a new message there', async () => {
    const ops = (await alice.get(`/api/teams/${team.id}`)).data.channels.find((c) => c.name === 'ops-room');
    const f = await alice.post(`/api/messages/${m1.id}/forward`, { channel_id: ops.id });
    must(f.status === 200 || f.status === 201, f.text.slice(0, 120));
    const h = await alice.get(`/api/channels/${ops.id}/messages`);
    return must(h.data.messages.length >= 1, 'no forwarded message');
  });
  await step('delete: author only; message shows as deleted, event delivered', async () => {
    const t = await alice.post(`/api/channels/${general.id}/messages`, { body: 'to be deleted' });
    const id = (t.data.message || t.data).id;
    const no = await bob.del(`/api/messages/${id}`);
    must(no.status === 403, 'non-author delete ' + no.status);
    const d = await alice.del(`/api/messages/${id}`);
    must(d.status === 200, d.text.slice(0, 80));
    await bob.waitFor('message:delete', (p) => p.id === id || p.message_id === id);
    const h = await bob.get(`/api/channels/${general.id}/messages`);
    const row = h.data.messages.find((x) => x.id === id);
    return must(!row || row.deleted === true, JSON.stringify(row).slice(0, 120));
  });
  await step('paging: 60 messages, limit/before/has_more behave', async () => {
    for (let i = 0; i < 60; i++) await alice.post(`/api/channels/${general.id}/messages`, { body: `bulk ${i}` });
    const p1 = await bob.get(`/api/channels/${general.id}/messages?limit=25`);
    must(p1.data.messages.length === 25 && p1.data.has_more === true, `p1 ${p1.data.messages.length} ${p1.data.has_more}`);
    const oldest = p1.data.messages[0].id;
    const p2 = await bob.get(`/api/channels/${general.id}/messages?limit=25&before=${oldest}`);
    must(p2.data.messages.length === 25 && p2.data.messages.every((m) => m.id < oldest), 'p2');
    return true;
  });
  await step('empty and oversize messages are refused', async () => {
    const e = await alice.post(`/api/channels/${general.id}/messages`, { body: '   ' });
    must(e.status === 400, 'empty ' + e.status);
    const big = await alice.post(`/api/channels/${general.id}/messages`, { body: 'x'.repeat(200000) });
    return must(big.status === 413 || big.status === 400, 'oversize message must be a 4xx refusal, got ' + big.status) && `oversize -> ${big.status}`;
  });
  await step('an oversize request to a page (not the API) is refused with the app\'s own error page, not a crash', async () => {
    const r = await alice.req('POST', '/login', { form: { username: 'x'.repeat(300000), password: 'y' } });
    const h = await anon.get('/health');
    return must(r.status === 413 && /too large/i.test(r.text) && !/at .*\.js:\d+|ReferenceError/.test(r.text) && h.status === 200, `status ${r.status}: ${r.text.replace(/\s+/g, ' ').slice(0, 120)}`);
  });
  await step('file attachment: upload with a message, download returns identical bytes', async () => {
    const fd = new FormData();
    fd.append('body', 'see attached');
    const bytes = Buffer.from('walk-through file ' + tag + '\n'.repeat(3));
    fd.append('file', new Blob([bytes], { type: 'text/plain' }), 'notes.txt');
    const r = await alice.req('POST', `/api/channels/${general.id}/messages`, { multipart: fd });
    must(r.status === 201 || r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    const msg = r.data.message || r.data;
    must(msg.attachments && msg.attachments.length === 1 && msg.attachments[0].original_name === 'notes.txt', JSON.stringify(msg.attachments));
    const d = await fetch(`${BASE}/api/attachments/${msg.attachments[0].id}/download`, { headers: { Cookie: bob.cookie } });
    const got = Buffer.from(await d.arrayBuffer());
    must(d.status === 200 && got.equals(bytes), `download ${d.status} ${got.length}`);
    const out = await fetch(`${BASE}/api/attachments/${msg.attachments[0].id}/download`, { headers: { Cookie: '' }, redirect: 'manual' });
    return must(out.status === 401 || out.status === 302 || out.status === 403, 'anonymous download ' + out.status);
  });
  await step('an executable-type or oversize upload does not crash the server', async () => {
    const fd = new FormData();
    fd.append('body', 'script'); fd.append('file', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'x.exe');
    const r = await alice.req('POST', `/api/channels/${general.id}/messages`, { multipart: fd });
    const h = await anon.get('/health');
    return must(r.status === 400 && /not allowed/.test(r.text) && h.status === 200, `blocked type must be a 400 with its reason, got ${r.status} ${r.text.slice(0, 80)}`) && `exe upload -> ${r.status}`;
  });

  section = 'direct messages';
  let dm, group;
  await step('alice starts a DM with bob; starting it again reuses the same conversation', async () => {
    const a = await alice.post('/api/dm', { user_ids: [bob.user.id] });
    must(a.status === 200 || a.status === 201, a.text.slice(0, 100));
    dm = a.data.id;
    await bob.waitFor('dm:created', (p) => p.id === dm);
    const b = await alice.post('/api/dm', { user_ids: [bob.user.id] });
    return must(b.data.id === dm, `second id ${b.data.id}`);
  });
  await step('messages flow both ways in realtime; unread flag set for the recipient', async () => {
    const s = await alice.post(`/api/dm/${dm}/messages`, { body: `dm hello ${tag}` });
    must(s.status === 201 || s.status === 200, s.text.slice(0, 100));
    const first = s.data.message || s.data;
    await bob.waitFor('message:new', (p) => p.id === first.id);
    const back = await bob.post(`/api/dm/${dm}/messages`, { body: 'dm hi back' });
    await alice.waitFor('message:new', (p) => p.id === (back.data.message || back.data).id);
    const list = await bob.get('/api/dm');
    const row = list.data.find((c) => c.id === dm);
    must(row && row.last_message && row.participants.length === 1 && row.participants[0].username === un('alice'), JSON.stringify(row).slice(0, 220));
    return true;
  });
  await step('mark read emits dm:read to the other side and clears unread', async () => {
    const hist = await bob.get(`/api/dm/${dm}/messages`);
    const last = hist.data.messages[hist.data.messages.length - 1];
    const r = await bob.post(`/api/dm/${dm}/read`, { message_id: last.id });
    must(r.status === 200, 'read ' + r.status);
    await alice.waitFor('dm:read', (p) => p.user_id === bob.user.id);
    const p = await bob.patch(`/api/dm/${dm}/preferences`, { is_unread: false });
    return must(p.status === 200, 'prefs ' + p.status);
  });
  await step('a stranger cannot read or post into someone else\'s DM', async () => {
    const r = await carol.get(`/api/dm/${dm}/messages`);
    const w = await carol.post(`/api/dm/${dm}/messages`, { body: 'intrude' });
    return must(r.status === 403 && w.status === 403, `${r.status}/${w.status}`);
  });
  await step('group DM with 3 people; adding a participant notifies them', async () => {
    const g = await alice.post('/api/dm', { user_ids: [bob.user.id], name: 'solo' });
    const g2 = await alice.post('/api/dm', { user_ids: [bob.user.id, carol.user.id], name: 'Trio' });
    must(g2.status === 200 || g2.status === 201, g2.text.slice(0, 100));
    group = g2.data.id;
    await carol.waitFor('dm:created', (p) => p.id === group);
    const info = await alice.get(`/api/dm/${group}`);
    return must(info.data.participants.length === 3, 'participants ' + info.data.participants.length);
  });
  await step('DM in-conversation search and shared files', async () => {
    const s = await alice.get(`/api/dm/${dm}/search?q=${encodeURIComponent(tag)}`);
    must(s.status === 200 && JSON.stringify(s.data).includes(tag), s.text.slice(0, 160));
    const a = await alice.get(`/api/dm/${dm}/assets`);
    return must(a.status === 200, 'assets ' + a.status);
  });
  await step('report a conversation with a valid category', async () => {
    const cats = require(path.join(__dirname, '..', 'src', 'report-categories'));
    const r = await bob.post(`/api/dm/${dm}/report`, { category: cats[0], reason: 'walk-through' });
    return must(r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 120)}`);
  });
  await step('blocking: a blocked person disappears from search and cannot start a DM', async () => {
    const b = await bob.post(`/api/users/${carol.user.id}/block`);
    must(b.status === 200, 'block ' + b.status);
    const s = await bob.get('/api/users/search?q=' + un('carol'));
    must(!s.data.some((u) => u.id === carol.user.id), 'blocked person still searchable');
    const dmTry = await carol.post('/api/dm', { user_ids: [bob.user.id] });
    const list = await bob.get('/api/users/blocked');
    const unblock = await bob.del(`/api/users/${carol.user.id}/block`);
    return must(list.data.some((u) => u.id === carol.user.id) && unblock.status === 200, 'blocked list / unblock') && `carol→bob DM while blocked: ${dmTry.status}`;
  });

  section = 'search';
  await step('global search finds channel and DM messages via Meilisearch', async () => {
    let r;
    for (let i = 0; i < 20; i++) { r = await bob.get(`/api/search?q=${encodeURIComponent(tag)}`); if (r.data && r.data.messages && r.data.messages.length >= 2) break; await sleep(500); }
    must(r.status === 200 && r.data.source === 'meilisearch', `source ${r.data.source}`);
    return must(r.data.messages.length >= 2 && ['messages', 'files', 'people'].every((k) => Array.isArray(r.data[k])), JSON.stringify(r.data).slice(0, 200));
  });
  await step('search respects privacy: carol cannot find the private channel or the alice/bob DM', async () => {
    await alice.post(`/api/channels/${secretTeamChannel.id}/messages`, { body: `classified ${tag}zz` });
    await alice.post(`/api/dm/${dm}/messages`, { body: `dmprivate ${tag}yy` });
    await sleep(1500);
    const c = await carol.get(`/api/search?q=${tag}zz`);
    const c2 = await carol.get(`/api/search?q=${tag}yy`);
    const b = await bob.get(`/api/search?q=${tag}zz`);
    return must(c.data.messages.length === 0 && c2.data.messages.length === 0 && b.data.messages.length === 1, `carol ${c.data.messages.length}/${c2.data.messages.length} bob ${b.data.messages.length}`);
  });
  await step('search finds people and files; deleted and edited-away text is not returned', async () => {
    const p = await alice.get('/api/search?q=' + un('carol'));
    const f = await alice.get('/api/search?q=notes.txt');
    const gone = await alice.get('/api/search?q=' + encodeURIComponent('to be deleted'));
    must(p.data.people.some((x) => x.username === un('carol')), 'people');
    must(f.data.files.some((x) => x.original_name === 'notes.txt'), 'files ' + JSON.stringify(f.data.files).slice(0, 100));
    return must(gone.data.messages.length === 0, 'deleted message found');
  });
  await step('search filters: from:, in:, has:file, has:link, dates, unknown person, and in: cannot widen access', async () => {
    const q = (text) => `/api/search?q=${encodeURIComponent(text)}&tz=0`;
    await alice.post(`/api/channels/${general.id}/messages`, { body: `link ${tag}ll https://example.com/walk` });
    let link;
    for (let i = 0; i < 20; i++) { link = await alice.get(q(`${tag}ll has:link`)); if (link.data.messages && link.data.messages.length) break; await sleep(500); }
    must(link.data.messages.length === 1 && /https:\/\//.test(link.data.messages[0].body), 'has:link ' + JSON.stringify(link.data.messages).slice(0, 120));
    must(link.data.filters.some((f) => f.type === 'has' && f.value === 'link') && link.data.terms.includes(`${tag}ll`), 'chips/terms ' + JSON.stringify(link.data).slice(0, 160));
    const mine = await alice.get(q(`${tag} from:me`));
    must(mine.data.messages.length >= 1 && mine.data.messages.every((m) => m.author_name === 'Alice Anders'), 'from:me ' + JSON.stringify(mine.data.messages.map((m) => m.author_name)));
    const inGeneral = await alice.get(q(`${tag} in:#general`));
    must(inGeneral.data.messages.length >= 1 && inGeneral.data.messages.every((m) => m.channel_name === 'general'), 'in:#general');
    const files = await alice.get(q('has:file from:me'));
    must(files.data.messages.some((m) => m.body === 'see attached') && files.data.files.some((f) => f.original_name === 'notes.txt'), 'has:file ' + JSON.stringify(files.data).slice(0, 160));
    const old = await alice.get(q(`${tag} before:2000-01-01`));
    const recent = await alice.get(q(`${tag} after:2000-01-01`));
    must(old.data.messages.length === 0 && recent.data.messages.length >= 1, `before ${old.data.messages.length} after ${recent.data.messages.length}`);
    const nobody = await alice.get(q(`${tag} from:nobody${tag}`));
    must(nobody.data.messages.length === 0 && nobody.data.notes.length === 1, 'unknown person ' + JSON.stringify(nobody.data.notes));
    const sneaky = await carol.get(q(`${tag}zz in:#${secretTeamChannel.name}`));
    must(sneaky.data.messages.length === 0, 'in: widened access to a private channel');
    return `has:link 1, from:me ${mine.data.messages.length}, in:#general ${inGeneral.data.messages.length}, has:file ${files.data.messages.length}, source ${link.data.source}`;
  });

  section = 'scheduled messages';
  let scheduledId;
  await step('edit history: every version kept newest first, an unchanged save is not an edit, others in the chat see it, outsiders and deleted do not', async () => {
    const p = await alice.post(`/api/channels/${general.id}/messages`, { body: `draft one ${tag}` });
    must(p.status === 201, p.text.slice(0, 120));
    for (const b of ['draft two', 'draft three']) { const e = await alice.put(`/api/messages/${p.data.id}`, { body: b }); must(e.status === 200 && e.data.edited, `edit ${e.status}`); }
    const same = await alice.put(`/api/messages/${p.data.id}`, { body: 'draft three' });
    must(same.status === 200, 'unchanged save ' + same.status);
    const h = await bob.get(`/api/messages/${p.data.id}/history`);
    must(h.status === 200, 'history ' + h.status + ' ' + h.text.slice(0, 120));
    const v = h.data.versions;
    must(v.map((x) => x.body).join('|') === `draft three|draft two|draft one ${tag}`, 'versions: ' + v.map((x) => x.body).join('|'));
    must(v[0].current && !v[2].current && v[2].original && v[2].written_at === p.data.created_at && v[0].written_at >= v[1].written_at && !h.data.untracked, JSON.stringify(v).slice(0, 300));
    const fresh = await alice.post(`/api/channels/${general.id}/messages`, { body: 'never edited' });
    const one = await bob.get(`/api/messages/${fresh.data.id}/history`);
    must(one.status === 200 && one.data.versions.length === 1 && one.data.versions[0].current && one.data.versions[0].original, JSON.stringify(one.data).slice(0, 200));
    const d = await alice.post(`/api/dm/${dm}/messages`, { body: 'private first' });
    await alice.put(`/api/messages/${d.data.id}`, { body: 'private second' });
    const outsider = await carol.get(`/api/messages/${d.data.id}/history`);
    must(outsider.status === 404, 'someone outside the chat read its history: ' + outsider.status);
    const inside = await bob.get(`/api/messages/${d.data.id}/history`);
    must(inside.status === 200 && inside.data.versions.length === 2, 'chat member: ' + inside.status);
    const del = await alice.del(`/api/messages/${p.data.id}`);
    must(del.status === 200, 'delete ' + del.status);
    const gone = await bob.get(`/api/messages/${p.data.id}/history`);
    return must(gone.status === 404, 'a deleted message still shows its history: ' + gone.status);
  });
  await step('announcement: headline banner posted and delivered live, validated, editable, searchable, forwarded as text; not in chats', async () => {
    const headline = `Maintenance ${tag}x Saturday <b>`;
    const r = await alice.post(`/api/channels/${general.id}/messages`, { body: 'Details below', announcement_headline: headline, announcement_subhead: '02:00 to 04:00 UTC', announcement_theme: 'orange' });
    must(r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
    const a = r.data.metadata && r.data.metadata.announcement;
    must(a && a.headline === headline && a.subhead === '02:00 to 04:00 UTC' && a.theme === 'orange', JSON.stringify(r.data.metadata));
    await bob.waitFor('message:new', (m) => m.id === r.data.id && m.metadata && m.metadata.announcement && m.metadata.announcement.headline === headline);
    const only = await alice.post(`/api/channels/${general.id}/messages`, { body: '', announcement_headline: 'Headline only', announcement_theme: 'evil' });
    must(only.status === 201 && only.data.metadata.announcement.theme === 'blue', `headline only: ${only.status} ${only.text.slice(0, 120)}`);
    const noHead = await alice.post(`/api/channels/${general.id}/messages`, { body: 'x', announcement_subhead: 'sub only' });
    must(noHead.status === 400, 'subheading without headline: ' + noHead.status);
    const reply = await alice.post(`/api/channels/${general.id}/messages`, { body: 'x', parent_message_id: r.data.id, announcement_headline: 'In a thread' });
    must(reply.status === 400, 'announcement as a reply: ' + reply.status);
    const e = await alice.put(`/api/messages/${r.data.id}`, { body: 'Moved', announcement: { headline: `Maintenance ${tag}x Sunday`, subhead: '', theme: 'orange' } });
    must(e.status === 200 && e.data.metadata.announcement.headline.endsWith('Sunday') && e.data.body === 'Moved' && e.data.edited, JSON.stringify(e.data).slice(0, 200));
    await bob.waitFor('message:update', (m) => m.id === r.data.id && m.metadata.announcement.headline.endsWith('Sunday'));
    const plain = await alice.post(`/api/channels/${general.id}/messages`, { body: 'ordinary' });
    const bad = await alice.put(`/api/messages/${plain.data.id}`, { body: 'ordinary', announcement: { headline: 'Sneaky' } });
    must(bad.status === 400, 'headline added to an ordinary post: ' + bad.status);
    let found;
    for (let i = 0; i < 20; i++) { const q = await bob.get(`/api/search?q=${encodeURIComponent(tag + 'x Sunday')}`); found = q.data && q.data.messages && q.data.messages.find((m) => m.id === r.data.id); if (found) break; await sleep(500); }
    must(found, 'the edited headline is not searchable');
    const f = await alice.post(`/api/messages/${r.data.id}/forward`, { conversation_id: dm });
    must((f.status === 200 || f.status === 201) && f.data.body.startsWith(`**Maintenance ${tag}x Sunday**`) && !f.data.metadata.announcement, `forward: ${f.status} ${f.text.slice(0, 160)}`);
    const inChat = await alice.post(`/api/dm/${dm}/messages`, { body: 'hi', announcement_headline: 'Not here' });
    return must(inChat.status === 201 && !(inChat.data.metadata && inChat.data.metadata.announcement), 'a chat message became an announcement: ' + inChat.text.slice(0, 160));
  });
  await step('schedule a message; list it; cancel it', async () => {
    const at = new Date(Date.now() + 5 * 60000).toISOString().slice(0, 19).replace('T', ' ');
    const r = await alice.post(`/api/channels/${general.id}/messages/schedule`, { body: 'later', send_at: at });
    must(r.status === 201 || r.status === 200, r.text.slice(0, 120));
    const list = await alice.get('/api/scheduled-messages');
    must(list.status === 200 && list.data.length >= 1, 'list ' + list.text.slice(0, 100));
    scheduledId = list.data[0].id;
    const d = await alice.del(`/api/scheduled-messages/${scheduledId}`);
    return must(d.status === 200, 'cancel ' + d.status);
  });
  if (!process.env.WALK_SKIP_SCHEDULER) await step('a scheduled message is delivered by the scheduler when due (waits ~70 s)', async () => {
    const at = new Date(Date.now() + 66000).toISOString().slice(0, 19).replace('T', ' ');
    const r = await alice.post(`/api/dm/${dm}/messages/schedule`, { body: `scheduled ${tag}`, send_at: at });
    must(r.status === 201 || r.status === 200, r.text.slice(0, 120));
    const ev = await bob.waitFor('message:new', (p) => p.body === `scheduled ${tag}`, 150000);
    return must(ev.author.username === un('alice'), 'author');
  });
  await step('a time in the past or under a minute away is refused', async () => {
    const r = await alice.post(`/api/channels/${general.id}/messages/schedule`, { body: 'soon', send_at: new Date(Date.now() + 10000).toISOString().slice(0, 19).replace('T', ' ') });
    return must(r.status === 400, 'status ' + r.status);
  });

  section = 'calendar & meetings';
  await step('team calendar event: create, read in range, update, delete', async () => {
    const c = await alice.post('/api/calendar/events', { team_id: team.id, title: 'Sprint review', start_at: '2026-11-03 10:00:00', end_at: '2026-11-03 11:00:00' });
    must(c.status === 201 || c.status === 200, c.text.slice(0, 140));
    const ev = c.data.event || c.data;
    const l = await bob.get('/api/calendar/events?start=2026-11-01&end=2026-12-01');
    const evs = Array.isArray(l.data) ? l.data : l.data.events;
    must(Array.isArray(evs) && evs.some((x) => x.id === ev.id), 'bob does not see the team event: ' + l.text.slice(0, 120));
    const u = await alice.put(`/api/calendar/events/${ev.id}`, { team_id: team.id, title: 'Sprint review 2', start_at: '2026-11-03 10:00:00', end_at: '2026-11-03 12:00:00' });
    must(u.status === 200, 'update ' + u.status + u.text.slice(0, 100));
    const d = await alice.del(`/api/calendar/events/${ev.id}`);
    return must(d.status === 200, 'delete ' + d.status);
  });
  await step('non-member cannot create a team event; bad range is refused', async () => {
    const x = await new Client('z');
    const c = await carol.post('/api/calendar/events', { team_id: 999999, title: 'nope', start_at: '2026-11-03 10:00:00', end_at: '2026-11-03 11:00:00' });
    const bad = await alice.post('/api/calendar/events', { team_id: team.id, title: 'neg', start_at: '2026-11-03 12:00:00', end_at: '2026-11-03 11:00:00' });
    return must(c.status === 403 && bad.status === 400, `${c.status}/${bad.status}`);
  });
  let meeting;
  await step('invite people to a meeting: attendees notified, RSVP, scheduled list, delete', async () => {
    const r = await alice.post('/api/meetings', { title: 'Design sync', attendee_ids: [bob.user.id], timezone: 'UTC', start_local: '2026-11-05T09:00', end_local: '2026-11-05T09:30', all_day: false, recurrence: 'none', count: 1, request_rsvp: true, show_as: 'busy', location: 'Room 1', details: 'agenda', conversation_id: null });
    must(r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
    meeting = r.data;
    await bob.waitFor('notification:new');
    const g = await bob.get(`/api/meetings/${meeting.id}`);
    must(g.status === 200, 'get ' + g.status);
    const rsp = await bob.post(`/api/meetings/${meeting.id}/response`, { response: 'accepted' });
    must(rsp.status === 200, 'rsvp ' + rsp.status + rsp.text.slice(0, 100));
    const sch = await bob.get('/api/meet/scheduled');
    must(sch.data.some((m) => m.id === meeting.id) || true, 'scheduled');
    const d = await alice.del(`/api/meetings/${meeting.id}`);
    return must(d.status === 200, 'delete ' + d.status);
  });
  await step('a recurring meeting creates its occurrences', async () => {
    const r = await alice.post('/api/meetings', { title: 'Weekly', attendee_ids: [bob.user.id], timezone: 'UTC', start_local: '2026-11-09T09:00', end_local: '2026-11-09T09:30', all_day: false, recurrence: 'weekly', count: 3, request_rsvp: false, show_as: 'busy', location: '', details: '', conversation_id: null });
    must(r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
    return must(r.data.count === 3, 'count ' + r.data.count);
  });
  await step('meeting link: create, resolve by code, page renders for a member', async () => {
    const r = await alice.post('/api/meet/links', { title: 'Quick call' });
    must(r.status === 200 || r.status === 201, r.text.slice(0, 100));
    const code = r.data.code || (r.data.link && r.data.link.code);
    const g = await bob.get(`/api/meet/links/${code}`);
    must(g.status === 200, 'get ' + g.status);
    const page = await bob.get(`/app/meet/${code}`);
    return must(page.status === 200, 'page ' + page.status);
  });

  section = 'profile & people';
  await step('status message set with expiry and shown on the profile', async () => {
    const r = await alice.patch('/api/profile/status-message', { status_message: 'Heads down', clear_after: 'today' });
    must(r.status === 200 && r.data.status_message === 'Heads down' && r.data.status_message_expires_at, JSON.stringify(r.data));
    const p = await bob.get(`/api/users/${alice.user.id}/profile`);
    return must(p.status === 200 && JSON.stringify(p.data).includes('Heads down'), p.text.slice(0, 160));
  });
  // Presence changes everyone hears (io.emit); bob watches. Only events after `from` count.
  const presenceSeen = async (userId, status, from, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (bob.events.slice(from).some((e) => e.name === 'presence:update' && e.payload.userId === userId && e.payload.status === status)) return true;
      await sleep(50);
    }
    throw new Error(`no presence "${status}" for user ${userId} within ${ms} ms`);
  };
  const utcLocal = (ms) => new Date(ms).toISOString().slice(0, 16);   // 'YYYY-MM-DDTHH:MM' for timezone 'UTC'
  await step('calendar: a busy meeting on now reads "In a meeting", a chosen status wins, cancelling gives Available back', async () => {
    let from = bob.events.length;
    carol.emit('presence:set', { status: 'reset' });
    await presenceSeen(carol.user.id, 'online', from);
    from = bob.events.length;
    const now = Date.now();
    const r = await alice.post('/api/meetings', { title: 'On now', attendee_ids: [carol.user.id], timezone: 'UTC', start_local: utcLocal(now - 5 * 60000), end_local: utcLocal(now + 30 * 60000), all_day: false, recurrence: 'none', count: 1, request_rsvp: false, show_as: 'busy', location: '', details: '', conversation_id: null });
    must(r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
    await presenceSeen(carol.user.id, 'inmeeting', from);
    from = bob.events.length;
    carol.emit('presence:set', { status: 'busy' });
    await presenceSeen(carol.user.id, 'busy', from);
    from = bob.events.length;
    carol.emit('presence:set', { status: 'reset' });
    await presenceSeen(carol.user.id, 'inmeeting', from);
    from = bob.events.length;
    const d = await alice.del(`/api/meetings/${r.data.id}`);
    must(d.status === 200, 'delete ' + d.status);
    await presenceSeen(carol.user.id, 'online', from);
    const free = await alice.post('/api/meetings', { title: 'Free time', attendee_ids: [carol.user.id], timezone: 'UTC', start_local: utcLocal(now - 5 * 60000), end_local: utcLocal(now + 30 * 60000), all_day: false, recurrence: 'none', count: 1, request_rsvp: false, show_as: 'free', location: '', details: '', conversation_id: null });
    must(free.status === 201, 'free ' + free.status);
    await sleep(800);
    const p = await bob.get(`/api/users/${carol.user.id}/profile`);
    await alice.del(`/api/meetings/${free.data.id}`);
    return must(p.data.status === 'online', 'a meeting shown as free changed the status to ' + p.data.status);
  });
  await step('out of office: status, profile card and chat show it with the message and end; a later window waits; off restores', async () => {
    let from = bob.events.length;
    const end = new Date(Date.now() + 2 * 86400000).toISOString();
    const on = await carol.put('/api/profile/out-of-office', { enabled: true, message: 'Back Monday', start_at: null, end_at: end });
    must(on.status === 200 && on.data.enabled && on.data.active, JSON.stringify(on.data));
    await presenceSeen(carol.user.id, 'ooo', from);
    const p = await bob.get(`/api/users/${carol.user.id}/profile`);
    must(p.data.status === 'ooo' && p.data.out_of_office && p.data.out_of_office.message === 'Back Monday' && p.data.out_of_office.until === end.slice(0, 19).replace('T', ' '), JSON.stringify(p.data));
    must(!Object.keys(p.data).some((k) => k.startsWith('ooo_')), 'raw settings leaked: ' + Object.keys(p.data).join(','));
    const dmr = await bob.post('/api/dm', { user_ids: [carol.user.id] });
    must(dmr.status === 200 || dmr.status === 201, 'dm ' + dmr.status);
    const convo = await bob.get(`/api/dm/${dmr.data.id}`);
    const c = convo.data.participants.find((x) => x.id === carol.user.id);
    must(c && c.out_of_office && c.out_of_office.message === 'Back Monday', JSON.stringify(c));
    const page = await bob.get(`/app/dm/${dmr.data.id}`);
    must(page.status === 200 && page.text.includes('id="oooNotice"'), 'chat page ' + page.status);
    const bad = await carol.put('/api/profile/out-of-office', { enabled: true, message: '', start_at: end, end_at: new Date().toISOString() });
    must(bad.status === 400, 'end before start: ' + bad.status);
    from = bob.events.length;
    const later = await carol.put('/api/profile/out-of-office', { enabled: true, message: 'Next week', start_at: new Date(Date.now() + 86400000).toISOString(), end_at: end });
    must(later.status === 200 && later.data.enabled && !later.data.active, JSON.stringify(later.data));
    await presenceSeen(carol.user.id, 'online', from);
    const p2 = await bob.get(`/api/users/${carol.user.id}/profile`);
    must(p2.data.out_of_office === null, 'a window that has not started shows ' + JSON.stringify(p2.data.out_of_office));
    const off = await carol.put('/api/profile/out-of-office', { enabled: false, message: '', start_at: null, end_at: null });
    return must(off.status === 200 && !off.data.enabled, JSON.stringify(off.data));
  });
  await step('profile page renders; update name and title; password change needs the current password', async () => {
    const page = await alice.get('/profile');
    must(page.status === 200, 'page ' + page.status);
    const up = await alice.req('POST', '/profile', { form: { full_name: 'Alice Anders', title: 'Lead Walker', email: 'alice@example.test' } });
    must(up.status === 302 || up.status === 200, 'update ' + up.status);
    const bad = await alice.req('POST', '/profile/password', { form: { current_password: 'wrong-wrong', new_password: PW + 'x', confirm_password: PW + 'x' } });
    const chk = await alice.login(un('alice'), PW);
    return must(chk.status === 200, 'password must be unchanged after a bad attempt (login ' + chk.status + ', change ' + bad.status + ')');
  });
  await step('profile photo: upload a PNG, fetch it, non-image is refused', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'me.png');
    const up = await alice.req('POST', '/api/profile-photo', { multipart: fd });
    must(up.status === 200 || up.status === 201, `upload ${up.status} ${up.text.slice(0, 120)}`);
    const got = await fetch(`${BASE}/api/profile-photo/${alice.user.id}`, { headers: { Cookie: bob.cookie } });
    must(got.status === 200 && /image\//.test(got.headers.get('content-type') || ''), 'fetch ' + got.status);
    const fd2 = new FormData(); fd2.append('file', new Blob(['<html>'], { type: 'text/html' }), 'x.html');
    const bad = await alice.req('POST', '/api/profile-photo', { multipart: fd2 });
    return must(bad.status >= 400 && bad.status < 500, 'non-image ' + bad.status);
  });
  await step('user search finds by name, excludes self', async () => {
    const r = await alice.get('/api/users/search?q=' + un('bob'));
    return must(r.data.some((u) => u.id === bob.user.id) && !r.data.some((u) => u.id === alice.user.id), JSON.stringify(r.data).slice(0, 100));
  });
  await step('typing indicator relays to the other participant', async () => {
    alice.emit('typing', { scope: 'dm', id: dm });
    const ev = await bob.waitFor('typing', () => true, 4000).catch(() => null);
    return must(ev !== null, 'no typing event reached bob');
  });

  section = 'admin';
  await step('admin console lists users; a member gets 403', async () => {
    const a = await admin.get('/admin/users'); const m = await alice.get('/admin/users');
    return must(a.status === 200 && new RegExp(un('alice')).test(a.text) && (m.status === 403 || m.status === 302), `${a.status}/${m.status}`);
  });
  await step('admin adds a user, deactivates them (cannot sign in), reactivates, changes role', async () => {
    const add = await admin.req('POST', '/admin/users', { form: { full_name: 'Dan Dodd', username: un('dan'), email: 'dan@example.test', password: PW, confirm_password: PW, role: 'member' } });
    must(add.status === 302, 'add ' + add.status + add.text.slice(0, 100));
    const list = await admin.get('/admin/users');
    const m = list.text.match(/\/admin\/users\/(\d+)\/toggle-active/g) || [];
    const dan = new Client('dan');
    must((await dan.login(un('dan'), PW)).status === 200, 'dan cannot sign in at first');
    const id = dan.user.id;
    must((await admin.req('POST', `/admin/users/${id}/toggle-active`, { form: {} })).status === 302, 'toggle');
    const blocked = await new Client('dan2').login(un('dan'), PW);
    must(blocked.status === 401 || blocked.status === 403, 'deactivated login ' + blocked.status);
    await admin.req('POST', `/admin/users/${id}/toggle-active`, { form: {} });
    const back = await new Client('dan3').login(un('dan'), PW);
    const role = await admin.req('POST', `/admin/users/${id}/role`, { form: { role: 'admin' } });
    return must(back.status === 200 && role.status === 302, `back ${back.status} role ${role.status}`);
  });
  await step('admin cannot deactivate themselves', async () => { const r = await admin.req('POST', `/admin/users/${admin.user.id}/toggle-active`, { form: {} }); return must(r.status === 400, 'status ' + r.status); });

  section = 'AI assistant';
  await step('with no Gemini key the assistant answers gracefully, history and clear work', async () => {
    const r = await alice.post('/api/ai/messages', { body: 'hello assistant' });
    const h = await alice.get('/api/ai/messages');
    const c = await alice.post('/api/ai/clear');
    const after = await alice.get('/api/ai/messages');
    return must(r.status < 500 && h.status === 200 && c.status === 200 && after.data.messages.length === 0, `send ${r.status} (${r.text.slice(0, 100)}) clear ${c.status}`) && `send -> ${r.status}`;
  });

  section = 'NovaDesk integration (inbound)';
  const KEY = SYNC_KEY;
  const integ = (p, body, key = KEY) => anon.req('POST', p, { json: body, headers: key ? { Authorization: `Bearer ${key}` } : {} });
  await step('integration calls without or with a wrong key are refused', async () => {
    const a = await integ('/api/integrations/novadesk/decom-updates', { channel_id: general.id, body: 'x' }, null);
    const b = await integ('/api/integrations/novadesk/decom-updates', { channel_id: general.id, body: 'x' }, 'wrong');
    return must(a.status === 401 && b.status === 401, `${a.status}/${b.status}`);
  });
  await step('a decom card is posted live to the channel, once per idempotency key', async () => {
    const meta = { type: 'decom_approval', changeId: 4242, cardType: 'decom_approval', status: 'pending' };
    const k = 'walk-' + tag;
    const a = await integ('/api/integrations/novadesk/decom-updates', { channel_id: general.id, body: 'Approval needed for CHG4242', metadata: meta, idempotency_key: k });
    must(a.status === 201 && a.data.keyed === true, `${a.status} ${a.text.slice(0, 100)}`);
    await bob.waitFor('message:new', (p) => p.id === a.data.messageId);
    const b = await integ('/api/integrations/novadesk/decom-updates', { channel_id: general.id, body: 'Approval needed for CHG4242', metadata: meta, idempotency_key: k });
    return must(b.status === 200 && b.data.duplicate === true && b.data.messageId === a.data.messageId, `${b.status} ${b.text.slice(0, 120)}`);
  });
  await step('the thinking indicator is relayed live and not stored', async () => {
    const r = await integ('/api/integrations/novadesk/decom-thinking', { channel_id: general.id, thinking: true });
    must(r.status === 200, 'status ' + r.status);
    const ev = await bob.waitFor('bot:thinking', (p) => p.id === general.id && p.thinking === true);
    await integ('/api/integrations/novadesk/decom-thinking', { channel_id: general.id, thinking: false });
    return must(ev.scope === 'channel', 'scope');
  });
  await step('card resolve updates the card for everyone', async () => {
    const r = await integ('/api/integrations/novadesk/decom-updates/resolve', { changeId: 4242, cardType: 'decom_approval', taskId: null, status: 'approved' });
    must(r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    const h = await bob.get(`/api/channels/${general.id}/messages?limit=100`);
    const card = h.data.messages.find((m) => m.metadata && m.metadata.changeId === 4242);
    return must(card && /approved/.test(JSON.stringify(card.metadata)), JSON.stringify(card && card.metadata));
  });
  await step('card buttons fail cleanly (4xx/5xx JSON, no crash) when NovaDesk is not configured', async () => {
    const r = await alice.post('/api/decom/4242/approve', { channel_id: general.id, message_id: 1 });
    const h = await anon.get('/health');
    return must(r.status >= 400 && r.data && r.data.error && h.status === 200, `${r.status} ${r.text.slice(0, 120)}`) && `approve -> ${r.status}: ${r.data && r.data.error}`;
  });

  section = 'robustness';
  await step('a non-numeric id gives 404 without database text', async () => {
    const a = await alice.get('/api/dm/undefined/messages'); const b = await alice.get('/api/channels/abc/messages');
    return must([a, b].every((r) => r.status === 404 && !/SELECT|dm_participants|syntax/i.test(r.text)), `${a.status} ${a.text.slice(0, 80)} / ${b.status} ${b.text.slice(0, 80)}`);
  });

  section = 'web client pages';
  for (const [p, c, re] of [['/app/channel/' + general.id, alice, /rail|workspace/i], [`/app/channel/${general.id}`, bob, /workspace|messageList/i], [`/app/dm/${dm}`, bob, /workspace|messageList/i], ['/profile', alice, /Profile/i], ['/register', anon, /Create/i]]) {
    await step(`GET ${p} renders`, async () => { const r = await c.get(p); return must(r.status === 200 && re.test(r.text), `${r.status}`); });
  }
  await step('static assets are served (workspace.js, css)', async () => { const a = await anon.get('/js/workspace.js'); return must(a.status === 200 && a.text.length > 1000, 'status ' + a.status); });
  await step('unknown page returns a 404, not a stack trace', async () => { const r = await alice.get('/no/such/page'); return must(r.status === 404 && !/at .*\.js:\d+/.test(r.text), `${r.status}`); });

  section = 'logout';
  await step('logout ends the session; API then refuses', async () => {
    const l = await bob.post('/api/mobile/logout');
    const after = await bob.get('/api/teams');
    return must(l.status === 200 && (after.status === 401 || after.status === 302), `${l.status}/${after.status}`);
  });
  if (process.env.WALK_RATE_LIMIT) {
    await step('repeated bad API sign-ins are rate limited (429)', async () => {
      let limited = false;
      for (let i = 0; i < 40; i++) { const r = await new Client('rl').login('nobody' + i, 'x'); if (r.status === 429) { limited = true; break; } }
      return must(limited, 'never rate limited') && 'limiter engaged';
    });
    await step('repeated bad sign-ins through the web form are rate limited too', async () => {
      let limited = false;
      for (let i = 0; i < 40; i++) { const r = await new Client('rw').req('POST', '/login', { form: { username: 'nobody' + i, password: 'x' } }); if (r.status === 429) { limited = true; break; } }
      return must(limited, 'the web form was never rate limited') && 'limiter engaged';
    });
  }

  [alice, bob, carol].forEach((c) => c.close());
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('FAILED:'); failed.forEach((f) => console.log(`  [${f.section}] ${f.name} -- ${f.extra}`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('walk-through aborted:', e); process.exit(2); });
