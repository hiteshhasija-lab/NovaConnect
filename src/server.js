const { initDb, db } = require('./db');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const methodOverride = require('method-override');

const { attachUser } = require('./middleware/auth');
const realtime = require('./realtime');
const helpers = require('./helpers');

const authRoutes = require('./routes/auth');
const appRoutes = require('./routes/app');
const teamRoutes = require('./routes/teams');
const messageRoutes = require('./routes/messages');
const dmRoutes = require('./routes/dm');
const userRoutes = require('./routes/users');
const profileRoutes = require('./routes/profile');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const calendarRoutes = require('./routes/calendar');
const integrationsInRoutes = require('./routes/integrationsIn');

// A single unexpected rejection (e.g. a transient DB outage hit from outside an Express
// request/asyncRouter, such as a socket listener) must not take the whole process — and every
// connected user — down. Log it and keep serving; the specific call site should still be fixed.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const HOST = process.env.HOST || '0.0.0.0';
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || path.join(__dirname, '..', 'certs', 'key.pem');
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || path.join(__dirname, '..', 'certs', 'cert.pem');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.get('/health', async (req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected', error: err.message });
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Registered before session/attachUser and before every other router below, on purpose: nearly
// every router mounted at '/' further down has its own blanket router.use(requireAuth) with no
// path restriction, which — because Express middleware runs in registration order regardless of
// whether a later route actually matches — would otherwise intercept this Bearer-secured,
// session-less service-to-service route first and reject it with "Not signed in." before it
// ever reached here. Confirmed live 2026-09-21: that's exactly what was happening. Registering
// this first, ahead of all of them, is simpler and safer than auditing/fixing every other
// router's mount path individually.
app.use('/api/integrations', integrationsInRoutes);

const sessionMiddleware = session({
  store: new FileStore({ path: path.join(__dirname, '..', 'data', 'sessions'), logFn: () => {} }),
  secret: process.env.SESSION_SECRET || 'novaconnect-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
});
app.use(sessionMiddleware);

app.use(attachUser);
app.use((req, res, next) => {
  res.locals.h = helpers;
  res.locals.path = req.path;
  next();
});

app.use('/', authRoutes);
app.use('/app', appRoutes);
app.use('/', require('./routes/membership'));
app.use('/', teamRoutes);
app.use('/', messageRoutes);
app.use('/', dmRoutes);
app.use('/', userRoutes);
app.use('/', aiRoutes);
app.use('/', calendarRoutes);
app.use('/', require('./routes/meetings'));
app.use('/', require('./routes/meet'));
app.use('/api/decom', require('./routes/decom'));
app.use('/profile', profileRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: err.message || 'Something went wrong.' });
  res.status(500).render('error', { title: 'Server Error', message: 'Something went wrong.' });
});

const server = http.createServer(app);
realtime.attach(server, sessionMiddleware);

initDb()
  .then(() => {
    const servers = [];

    servers.push(server.listen(PORT, HOST, () => {
      console.log(`NovaConnect running at http://${HOST}:${PORT}`);
      console.log('Seed logins: admin/admin123 (admin), jdoe/member123, bsmith/member123, mchen/member123, rpatel/member123');
    }));

    if (fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH)) {
      const tlsOptions = { key: fs.readFileSync(TLS_KEY_PATH), cert: fs.readFileSync(TLS_CERT_PATH) };
      const httpsServer = https.createServer(tlsOptions, app);
      realtime.attach(httpsServer, sessionMiddleware);
      servers.push(httpsServer.listen(HTTPS_PORT, HOST, () => {
        console.log(`NovaConnect also running securely at https://${HOST}:${HTTPS_PORT}`);
      }));
    } else {
      console.log(`No TLS certificate found at ${TLS_CERT_PATH} — HTTPS not started.`);
    }

    // Running as PID 1 in a container: an unhandled SIGTERM is silently ignored rather
    // than terminating the process (the kernel's default signal disposition doesn't apply
    // to PID 1 without an explicit handler), which otherwise forces every container stop
    // to wait out the full timeout and fall back to SIGKILL.
    const shutdown = () => {
      console.log('Shutting down...');
      Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))))
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
