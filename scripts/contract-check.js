#!/usr/bin/env node
// Client-server contract check.
//
// Cross-checks every API call the web client (public/js) and the iOS app (ios-app/Native) makes
// against the route that serves it: URL, method, and the keys the client reads from the answer.
// Pure static analysis (no server, no database), so it runs in the lint job in a second.
//
//   node scripts/contract-check.js              # check this repository
//   node scripts/contract-check.js --root DIR   # check another checkout (used by the tests)
//   node scripts/contract-check.js --json       # machine readable report
//
// Exit code 1 when an error is found. Warnings (info) never fail the build.
//
// What it can and cannot see: a handler's answer is resolved through `res.json({...})`,
// `res.json(variable)` and `res.json(await helper(...))` (the helper's `return {...}` objects, a
// few hops deep). Answers built from SQL rows alone (`res.json(rows)`) have no statically known keys
// and are only checked for "array versus object". Client reads are taken from
// `const {a, b} = await api(...)`, `const r = await api(...); r.a` and `api(...).then(r => r.a)`.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const ROOT = path.resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : path.join(__dirname, '..'));
const acorn = require('acorn');

// ------------------------------------------------------------------ AST helpers
function parse(code) {
  const base = { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true, allowHashBang: true };
  try { return acorn.parse(code, { ...base, sourceType: 'script' }); } catch (e) { return acorn.parse(code, { ...base, sourceType: 'module' }); }
}
function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parents) === false) return;
  parents.push(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, parents));
    else if (v && typeof v.type === 'string') walk(v, visit, parents);
  }
  parents.pop();
}
const isFn = (n) => n && /Function/.test(n.type);
const keyName = (k) => (k && k.type === 'Identifier' ? k.name : k && k.type === 'Literal' ? String(k.value) : null);
const listJs = (dir, skip = []) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) return skip.includes(f) ? [] : listJs(p, skip);
    return f.endsWith('.js') ? [p] : [];
  });
};

// ------------------------------------------------------------------ server: function index and answer shapes
const srcDir = path.join(ROOT, 'src');
const srcFiles = listJs(srcDir);
const asts = new Map(srcFiles.map((f) => [f, parse(fs.readFileSync(f, 'utf8'))]));
const fnIndex = new Map();
const addFn = (name, fn) => { if (!fnIndex.has(name)) fnIndex.set(name, []); fnIndex.get(name).push(fn); };
for (const ast of asts.values()) {
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) addFn(n.id.name, n);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isFn(n.init)) addFn(n.id.name, n.init);
    if (n.type === 'Property' && keyName(n.key) && isFn(n.value)) addFn(keyName(n.key), n.value);
  });
}
const newShape = () => ({ keys: new Set(), array: false, dynamic: false });
const mergeShape = (into, from) => { from.keys.forEach((k) => into.keys.add(k)); into.array = into.array || from.array; into.dynamic = into.dynamic || from.dynamic; };
function shapeOf(expr, scope, depth, seen) {
  const out = newShape();
  if (!expr || depth > 4) { out.dynamic = true; return out; }
  switch (expr.type) {
    case 'AwaitExpression': return shapeOf(expr.argument, scope, depth, seen);
    case 'ObjectExpression':
      for (const pr of expr.properties) { if (pr.type === 'SpreadElement') out.dynamic = true; else { const k = keyName(pr.key); if (k) out.keys.add(k); } }
      return out;
    case 'ArrayExpression': out.array = true; return out;
    case 'ConditionalExpression': mergeShape(out, shapeOf(expr.consequent, scope, depth, seen)); mergeShape(out, shapeOf(expr.alternate, scope, depth, seen)); return out;
    case 'LogicalExpression': mergeShape(out, shapeOf(expr.left, scope, depth, seen)); mergeShape(out, shapeOf(expr.right, scope, depth, seen)); return out;
    case 'Identifier': {
      let decl = null;
      const assigned = [];
      walk(scope, (m) => {
        if (m.type === 'VariableDeclarator' && m.id.type === 'Identifier' && m.id.name === expr.name && m.init) decl = m.init;
        if (m.type === 'AssignmentExpression' && m.left.type === 'MemberExpression' && m.left.object.type === 'Identifier' && m.left.object.name === expr.name && !m.left.computed) assigned.push(m.left.property.name);
      });
      if (!decl) { out.dynamic = true; return out; }
      const s = shapeOf(decl, scope, depth + 1, seen);
      assigned.forEach((k) => s.keys.add(k));
      return s;
    }
    case 'CallExpression': {
      const c = expr.callee;
      const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null);
      if (name && /^(map|filter|slice|sort|concat|reverse|all)$/.test(name)) { out.array = true; return out; }
      const fns = name ? fnIndex.get(name) : null;
      if (!fns || !fns.length || seen.has(name)) { out.dynamic = true; return out; }
      seen.add(name);
      for (const fn of fns) mergeShape(out, returnShape(fn, depth + 1, seen));
      seen.delete(name);
      return out;
    }
    default: out.dynamic = true; return out;
  }
}
function returnShape(fn, depth, seen) {
  if (fn.body.type !== 'BlockStatement') return shapeOf(fn.body, fn, depth, seen);
  const out = newShape();
  let any = false;
  walk(fn.body, (n) => {
    if (n !== fn.body && isFn(n)) return false;
    if (n.type === 'ReturnStatement') { any = true; mergeShape(out, n.argument ? shapeOf(n.argument, fn, depth, seen) : newShape()); }
    return true;
  });
  if (!any) out.dynamic = true;
  return out;
}
function summariseHandler(h) {
  const res = { keys: new Set(), array: false, dynamic: false, bodyKeys: new Set(), json: false };
  if (!h) { res.dynamic = true; return res; }
  const body = h.body;
  walk(body, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'json') {
      res.json = true;
      mergeShape(res, shapeOf(n.arguments[0], h, 0, new Set()));
    }
    if (n.type === 'MemberExpression' && n.object.type === 'MemberExpression' && n.object.object.name === 'req' && n.object.property.name === 'body' && !n.computed) res.bodyKeys.add(n.property.name);
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && n.init && n.init.type === 'MemberExpression' && n.init.object.name === 'req' && n.init.property.name === 'body') {
      for (const pr of n.id.properties) { const k = pr.key && keyName(pr.key); if (k) res.bodyKeys.add(k); }
    }
    return true;
  });
  return res;
}

// ------------------------------------------------------------------ server: mounts and route table
// Mount prefixes are read from server.js: app.use('/prefix', ..., <router>) where <router> is an
// identifier bound with require('./routes/x'), or an inline require('./x').createY(...) call.
function mountsFromServer() {
  const serverFile = path.join(srcDir, 'server.js');
  const ast = asts.get(serverFile);
  const requires = new Map();       // identifier -> module path relative to src
  const modOf = (n) => {            // require('./x') possibly followed by member calls
    let cur = n;
    while (cur && (cur.type === 'CallExpression' || cur.type === 'MemberExpression')) {
      if (cur.type === 'CallExpression' && cur.callee.type === 'Identifier' && cur.callee.name === 'require' && cur.arguments[0] && cur.arguments[0].type === 'Literal') return String(cur.arguments[0].value);
      cur = cur.type === 'CallExpression' ? cur.callee : cur.object;
    }
    return null;
  };
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) { const m = modOf(n.init); if (m && m.startsWith('.')) requires.set(n.id.name, m); }
  });
  const mounts = new Map();         // module (no extension, relative to src) -> [prefix]
  walk(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.object.name !== 'app' || n.callee.property.name !== 'use') return;
    const a = n.arguments;
    const prefix = a[0] && a[0].type === 'Literal' && typeof a[0].value === 'string' ? a[0].value : '/';
    const last = a[a.length - 1];
    const mod = last.type === 'Identifier' ? requires.get(last.name) : modOf(last);
    if (!mod || !mod.startsWith('.')) return;
    const key = path.normalize(mod).replace(/\.js$/, '');
    if (!mounts.has(key)) mounts.set(key, []);
    mounts.get(key).push(prefix);
  });
  return mounts;
}
const mounts = mountsFromServer();
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const table = [];
const unmountedFiles = new Set();
for (const [file, ast] of asts) {
  const rel = path.relative(srcDir, file).replace(/\.js$/, '');
  const prefixes = mounts.get(rel) || (rel === 'server' ? ['/'] : null);
  walk(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression') return;
    const obj = n.callee.object, prop = n.callee.property;
    if (!obj || obj.type !== 'Identifier' || !['router', 'app'].includes(obj.name) || !METHODS.has(prop.name)) return;
    const a0 = n.arguments[0];
    let routePath = null;
    if (a0 && a0.type === 'Literal' && typeof a0.value === 'string') routePath = a0.value;
    else if (a0 && a0.type === 'TemplateLiteral') routePath = a0.quasis.map((q) => q.value.cooked).join(':~');
    if (routePath === null) return;
    if (!prefixes) { unmountedFiles.add(path.relative(ROOT, file)); return; }
    const handler = [...n.arguments].reverse().find(isFn) || null;
    const summary = summariseHandler(handler);
    for (const pre of prefixes) {
      const full = (pre === '/' ? '' : pre) + (routePath.startsWith('/') ? routePath : '/' + routePath);
      table.push({ method: prop.name.toUpperCase(), path: full || '/', where: `${path.relative(ROOT, file)}:${n.loc.start.line}`, ...summary });
    }
  });
}
const segs = (p) => p.split('?')[0].replace(/\/+$/, '').split('/');
// A client segment may be ':~' (computed at run time), 'assets:~' (a literal with something
// appended, usually a query string), or ':p' (an interpolated id). A leading ':~' means the base URL
// is built at run time, so only the tail of the route is compared.
const segMatches = (route, client) => {
  if (route.startsWith(':') || client.startsWith(':')) return true;
  const i = client.indexOf(':~');
  return i > 0 ? route === client.slice(0, i) : route === client;
};
function matchRoutes(clientPath) {
  let c = segs(clientPath);
  const tailOnly = c[0] === ':~';
  if (tailOnly) c = c.slice(1);
  return table.filter((r) => {
    const s = segs(r.path);
    if (tailOnly ? s.length <= c.length : s.length !== c.length) return false;
    const tail = tailOnly ? s.slice(s.length - c.length) : s;
    return tail.every((seg, i) => segMatches(seg, c[i]));
  });
}

// ------------------------------------------------------------------ web client call sites
function exprToPath(n) {
  if (!n) return ':~';
  if (n.type === 'Literal') return String(n.value);
  if (n.type === 'TemplateLiteral') { let s = ''; n.quasis.forEach((q, i) => { s += q.value.cooked; if (i < n.expressions.length) s += ':p'; }); return s; }
  if (n.type === 'BinaryExpression' && n.operator === '+') return exprToPath(n.left) + exprToPath(n.right);
  if (n.type === 'ConditionalExpression') return exprToPath(n.consequent);
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && /encodeURIComponent|Number|String/.test(n.callee.name)) return ':p';
  return ':~';
}
const webCalls = [];
for (const file of listJs(path.join(ROOT, 'public', 'js'), ['vendor'])) {
  const ast = parse(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(ROOT, file);
  walk(ast, (n, parents) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null);
    if (!['api', 'fetch'].includes(name)) return;
    if (c.type === 'MemberExpression' && !(c.object.type === 'Identifier' && ['window', 'self', 'globalThis'].includes(c.object.name))) return;
    if (!n.arguments[0]) return;
    const p = exprToPath(n.arguments[0]);
    if (!/(\/|:~)/.test(p)) return;
    let method = 'GET';
    let bodyKeys = null;
    const opts = n.arguments[1];
    if (opts && opts.type === 'ObjectExpression') {
      const props = opts.properties.filter((pr) => pr.type === 'Property');
      const m = props.find((pr) => keyName(pr.key) === 'method');
      const b = props.find((pr) => keyName(pr.key) === 'body');
      if (m && m.value.type === 'Literal') method = String(m.value.value).toUpperCase();
      else if (!m && b) method = 'POST';
      if (b && b.value.type === 'ObjectExpression') bodyKeys = b.value.properties.filter((x) => x.type === 'Property').map((x) => keyName(x.key)).filter(Boolean);
    }
    const reads = new Set();
    const parent = parents[parents.length - 1], grand = parents[parents.length - 2];
    const scopeOf = () => { for (let i = parents.length - 1; i >= 0; i--) if (isFn(parents[i])) return parents[i]; return ast; };
    const fromFn = (fn) => {
      if (!fn || !isFn(fn) || !fn.params[0]) return;
      const p0 = fn.params[0];
      if (p0.type === 'ObjectPattern') p0.properties.forEach((pr) => { const k = pr.key && keyName(pr.key); if (k) reads.add(k); });
      else if (p0.type === 'Identifier') walk(fn.body, (m) => { if (m.type === 'MemberExpression' && m.object.type === 'Identifier' && m.object.name === p0.name && !m.computed) reads.add(m.property.name); });
    };
    if (parent && parent.type === 'AwaitExpression' && grand && grand.type === 'VariableDeclarator') {
      if (grand.id.type === 'ObjectPattern') grand.id.properties.forEach((pr) => { const k = pr.key && keyName(pr.key); if (k) reads.add(k); });
      else if (grand.id.type === 'Identifier') walk(scopeOf(), (m) => { if (m.type === 'MemberExpression' && m.object.type === 'Identifier' && m.object.name === grand.id.name && !m.computed) reads.add(m.property.name); });
    } else if (parent && parent.type === 'MemberExpression' && parent.property && parent.property.name === 'then' && grand && grand.type === 'CallExpression') {
      fromFn(grand.arguments[0]);
    } else if (parent && parent.type === 'AwaitExpression' && grand && grand.type === 'MemberExpression' && !grand.computed) {
      reads.add(grand.property.name);
    }
    webCalls.push({ client: 'web', where: `${rel}:${n.loc.start.line}`, method, path: p, bodyKeys, reads: [...reads] });
  });
}

// ------------------------------------------------------------------ iOS client
const iosDir = path.join(ROOT, 'ios-app', 'Native');
const iosFiles = fs.existsSync(iosDir) ? fs.readdirSync(iosDir).filter((f) => f.endsWith('.swift')).map((f) => path.join(iosDir, f)) : [];
// Required keys of every Decodable model: stored properties that are neither optional nor defaulted.
const models = new Map();
for (const file of iosFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const re = /(?:struct|class)\s+(\w+)\s*:[^{]*\b(?:Decodable|Codable)\b[^{]*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1, i = re.lastIndex;
    while (i < text.length && depth) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
    const body = text.slice(re.lastIndex, i - 1);
    const required = [];
    // top-level members only: drop nested braces (computed properties, functions) first
    let flat = '', d = 0;
    for (const ch of body) { if (ch === '{') d++; else if (ch === '}') d--; else if (d === 0) flat += ch; }
    for (const part of flat.split(/[\n;]/)) {
      const pm = part.match(/^\s*(?:let|var)\s+(\w+)\s*:\s*([^=]+?)\s*$/);
      if (pm && !pm[2].endsWith('?') && !/^\s*static/.test(part)) required.push(pm[1]);
    }
    models.set(m[1], required);
  }
}
const stateTypes = new Map();      // file -> {var -> type}
for (const file of iosFiles) {
  const map = {};
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/@State(?:Object)?\s+(?:private\s+)?var\s+(\w+)\s*:\s*([\w\[\]?]+)/g)) map[m[1]] = m[2];
  stateTypes.set(file, map);
}
const iosCalls = [];
for (const file of iosFiles) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(/\.(get|send|request)(?:<[^>]+>)?\(\s*"(\/[^"]*)"([^)]*)\)?/g)) {
      const verb = m[1];
      const p = m[2].replace(/\\\([^)]*\)/g, ':p');
      const mm = m[3].match(/method:\s*"(\w+)"/);
      const method = mm ? mm[1].toUpperCase() : (verb === 'send' ? 'POST' : 'GET');
      // decoded type: `let x: T = try await ... .get(`, or `name = try await ... .get(` with a @State type
      let type = null;
      const before = line.slice(0, m.index);
      const lt = before.match(/let\s+\w+\s*:\s*([\w\[\]]+)\s*=/);
      const asg = before.match(/(\w+)\s*=\s*try await/);
      if (verb === 'get') type = lt ? lt[1] : (asg && stateTypes.get(file)[asg[1]]) || null;
      const unwrap = type && /^\[(\w+)\]$/.test(type) ? { array: true, model: type.slice(1, -1) } : type ? { array: false, model: type } : null;
      iosCalls.push({ client: 'ios', where: `${path.relative(ROOT, file)}:${idx + 1}`, method, path: p, decode: unwrap });
    }
  });
}

// ------------------------------------------------------------------ cross-check
const errors = [];
const warnings = [];
const used = new Set();
const SKIP_READS = new Set(['length', 'map', 'forEach', 'filter', 'then', 'catch', 'find', 'some', 'every', 'sort', 'slice', 'reduce', 'concat', 'includes', 'push', 'join', 'keys', 'values', 'entries']);
let dynamicBase = 0;
for (const c of [...webCalls, ...iosCalls]) {
  const p = c.path.split('?')[0];
  if (p.startsWith(':~') && p.replace(/^(:~)+/, '').length === 0) { dynamicBase++; continue; }   // the client builds the whole URL at run time
  const hits = matchRoutes(p);
  if (!hits.length) { errors.push({ kind: 'no-route', ...c, detail: `no server route matches ${c.method} ${p}` }); continue; }
  const exact = hits.filter((r) => r.method === c.method);
  hits.forEach((r) => used.add(r));
  if (!exact.length) { errors.push({ kind: 'wrong-method', ...c, detail: `${p} exists only as ${[...new Set(hits.map((r) => r.method))].join('/')}, client uses ${c.method}` }); continue; }
  exact.forEach((r) => used.add(r));
  if (exact.length > 1 && p.includes(':~')) continue;           // runtime-chosen action: reachability is all we can say
  const r = exact[0];
  const where = `${r.method} ${r.path} (${r.where})`;
  if (c.client === 'web') {
    if (c.reads.length && r.json && !r.dynamic && !r.array && r.keys.size) {
      const missing = c.reads.filter((k) => !r.keys.has(k) && !SKIP_READS.has(k));
      if (missing.length) errors.push({ kind: 'response-keys', ...c, detail: `client reads ${missing.join(', ')}; ${where} answers with ${[...r.keys].join(', ')}` });
    }
    if (c.bodyKeys && r.bodyKeys.size) {
      const unread = c.bodyKeys.filter((k) => !r.bodyKeys.has(k));
      if (unread.length) warnings.push({ kind: 'request-unread', ...c, detail: `client sends ${unread.join(', ')}; ${where} reads ${[...r.bodyKeys].join(', ')}` });
    }
  } else if (c.decode) {
    const model = models.get(c.decode.model);
    if (!model) { warnings.push({ kind: 'ios-model-unknown', ...c, detail: `decodes into ${c.decode.model}, which is not a Decodable struct in the app` }); continue; }
    if (c.decode.array && r.json && !r.dynamic && !r.array) errors.push({ kind: 'ios-shape', ...c, detail: `app decodes [${c.decode.model}] but ${where} answers with an object (${[...r.keys].join(', ')})` });
    if (!c.decode.array && r.json && r.array && !r.keys.size) errors.push({ kind: 'ios-shape', ...c, detail: `app decodes ${c.decode.model} but ${where} answers with an array` });
    if (!c.decode.array && r.json && !r.dynamic && r.keys.size) {
      const missing = model.filter((k) => !r.keys.has(k));
      if (missing.length) errors.push({ kind: 'ios-model-keys', ...c, detail: `${c.decode.model} requires ${missing.join(', ')}; ${where} answers with ${[...r.keys].join(', ')}` });
    }
  }
}
const unused = table.filter((r) => !used.has(r) && /^\/api\//.test(r.path) && !/^\/api\/(integrations|mobile|decom|auth)/.test(r.path));
for (const f of unmountedFiles) warnings.push({ kind: 'unmounted', where: f, detail: 'defines routes but is not mounted in server.js' });

const report = {
  checked: { webCalls: webCalls.length, iosCalls: iosCalls.length, iosModels: models.size, serverRoutes: table.length, runtimeBuiltUrls: dynamicBase },
  errors, warnings, unusedRoutes: unused.map((r) => `${r.method} ${r.path} (${r.where})`),
};
if (flag('--json')) console.log(JSON.stringify(report, null, 2));
else {
  const c = report.checked;
  console.log(`contract-check: ${c.webCalls} web calls, ${c.iosCalls} iOS calls, ${c.iosModels} iOS models, ${c.serverRoutes} server routes (${c.runtimeBuiltUrls} URLs built at run time are not checked)`);
  for (const e of errors) console.log(`ERROR  ${e.where}  [${e.kind}]  ${e.detail}`);
  for (const w of warnings) console.log(`warn   ${w.where}  [${w.kind}]  ${w.detail}`);
  if (flag('--unused')) report.unusedRoutes.forEach((u) => console.log(`unused ${u}`));
  console.log(errors.length ? `FAILED: ${errors.length} contract error(s)` : `OK: no contract errors (${warnings.length} warning(s), ${unused.length} API routes not called by a client)`);
}
process.exit(errors.length ? 1 : 0);
