'use strict';
// The client-server contract check must flag the mismatches it exists for, stay quiet on a
// consistent tree, and pass on this repository.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'contract-check.js');
const run = (root) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json'], { encoding: 'utf8' });
  return { status: r.status, report: JSON.parse(r.stdout) };
};
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return root;
}
const SERVER = `
const express = require('express');
const app = express();
app.use('/', require('./routes/search'));
app.use('/api/mobile', require('./routes/mobile'));
`;
const SEARCH_ROUTE = (answer) => `
const router = require('express').Router();
async function lookup(q) { ${answer} }
router.get('/api/search', async (req, res) => { const result = await lookup(req.query.q); res.json(result); });
router.put('/api/things/:id', async (req, res) => res.json({ ok: true }));
module.exports = router;
`;
const MOBILE_ROUTE = `
const router = require('express').Router();
router.get('/session', async (req, res) => res.json({ user: { id: 1 } }));
router.get('/list', async (req, res) => res.json({ items: [] }));
module.exports = router;
`;
const MODELS = `
struct Person: Codable { let id: Int; var username: String; var title: String? }
struct SessionResponse: Decodable { let user: Person }
struct Wanted: Decodable { let id: Int; let name: String }
`;
const base = (over = {}) => ({
  'src/server.js': SERVER,
  'src/routes/search.js': SEARCH_ROUTE('return { messages: [], files: [], people: [] };'),
  'src/routes/mobile.js': MOBILE_ROUTE,
  'public/js/app.js': `async function go(q){ const data = await api('/api/search?q=' + encodeURIComponent(q)); return data.messages.length + data.files.length + data.people.length; }`,
  'ios-app/Native/Client.swift': `
func load() async throws {
  let s: SessionResponse = try await api.get("/api/mobile/session")
}`,
  'ios-app/Native/Models.swift': MODELS,
  ...over,
});

test('a consistent tree passes', () => {
  const { status, report } = run(tree(base()));
  assert.deepStrictEqual(report.errors, []);
  assert.strictEqual(status, 0);
  assert.ok(report.checked.serverRoutes >= 4 && report.checked.webCalls >= 1 && report.checked.iosCalls >= 1);
});

test('flags a handler that answers with a variable whose keys the client does not read (the 1.0.188 search bug)', () => {
  const { status, report } = run(tree(base({
    'src/routes/search.js': SEARCH_ROUTE('return { hits: [], estimatedTotalHits: 0, query: q };'),
  })));
  assert.strictEqual(status, 1);
  const e = report.errors.find((x) => x.kind === 'response-keys');
  assert.ok(e, JSON.stringify(report.errors));
  assert.match(e.detail, /messages/);
});

test('flags a wrong method and a missing route', () => {
  const { report } = run(tree(base({
    'public/js/app.js': `api('/api/things/5', { method: 'POST', body: { a: 1 } }); api('/api/nope');`,
  })));
  const kinds = report.errors.map((e) => e.kind).sort();
  assert.deepStrictEqual(kinds, ['no-route', 'wrong-method']);
});

test('a computed path segment still has to reach a route', () => {
  const ok = run(tree(base({ 'public/js/app.js': `const a = 'x'; api('/api/things/' + a);\napi(base + '/session');` })));
  assert.ok(!ok.report.errors.some((e) => e.kind === 'no-route'), JSON.stringify(ok.report.errors));
});

test('flags an iOS model that requires a key the server does not send', () => {
  const { report } = run(tree(base({
    'ios-app/Native/Client.swift': `let w: Wanted = try await api.get("/api/mobile/session")`,
  })));
  const e = report.errors.find((x) => x.kind === 'ios-model-keys');
  assert.ok(e, JSON.stringify(report.errors));
  assert.match(e.detail, /id, name|name/);
});

test('flags an iOS array decode against an object answer', () => {
  const { report } = run(tree(base({
    'ios-app/Native/Client.swift': `let rows: [Person] = try await api.get("/api/mobile/list")`,
  })));
  assert.ok(report.errors.some((x) => x.kind === 'ios-shape'), JSON.stringify(report.errors));
});

test('flags an iOS call to a method the route does not serve', () => {
  const { report } = run(tree(base({
    'ios-app/Native/Client.swift': `try await api.send("/api/things/3", method: "DELETE")`,
  })));
  assert.ok(report.errors.some((x) => x.kind === 'wrong-method'), JSON.stringify(report.errors));
});

test('this repository has no client-server contract errors', () => {
  const { status, report } = run(path.join(__dirname, '..'));
  assert.deepStrictEqual(report.errors, []);
  assert.strictEqual(status, 0);
});
