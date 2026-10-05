require('dotenv').config();
const { validateConfig } = require('./config');
validateConfig();

const { initDb, db } = require('./db');
const { redis } = require('./redis');
const { initTelemetry, shutdownTelemetry } = require('./telemetry');
const { logger } = require('./logger');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').RedisStore;
const methodOverride = require('method-override');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

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

// Initialize telemetry first (before other instrumentations)
initTelemetry();

// Structured logging for unhandled errors
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  shutdownTelemetry().finally(() => process.exit(1));
});

const { getConfig } = require('./config');
const cfg = getConfig();

const app = express();
const PORT = cfg.PORT;
const HTTPS_PORT = cfg.HTTPS_PORT;
const HOST = cfg.HOST;
const TLS_KEY_PATH = cfg.TLS_KEY_PATH || path.join(__dirname, '..', 'certs', 'key.pem');
const TLS_CERT_PATH = cfg.TLS_CERT_PATH || path.join(__dirname, '..', 'certs', 'cert.pem');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Helmet for security headers (must be early)
// Content-Security-Policy for production (development sends none). Helmet's default policy
// (script-src 'self' only) blocked the app's CDN libraries and inline scripts — found by the
// first production-mode install (#24 step 5, 2026-10-04) — so this lists what NovaConnect really
// loads: Bootstrap and its icons (cdn.jsdelivr.net), Socket.IO's client (cdn.socket.io), a few
// inline scripts and handlers, WebAssembly + blob: workers for background blur (MediaPipe,
// served from here), any https image (GIFs, avatars), blob: media and websocket connections.
// No upgrade-insecure-requests, so an install without a certificate still works over http.
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net', 'https://cdn.socket.io'],
  scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
  fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  mediaSrc: ["'self'", 'blob:', 'data:'],
  connectSrc: ["'self'", 'ws:', 'wss:'],
  workerSrc: ["'self'", 'blob:'],
  frameSrc: ["'self'"],
  frameAncestors: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  upgradeInsecureRequests: null,
};
app.use(helmet({
  contentSecurityPolicy: cfg.NODE_ENV === 'production' ? { useDefaults: false, directives: CSP_DIRECTIVES } : false,
  crossOriginEmbedderPolicy: false,
  // Six months, this host only: no includeSubDomains/preload, which would bind every subdomain of
  // a deployment's domain to https (and preload can't be undone quickly).
  hsts: cfg.NODE_ENV === 'production' ? { maxAge: 15552000, includeSubDomains: false } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// General rate limiter: 1000 requests per 15 minutes, per signed-in user (per IP otherwise).
// Registered further down, after static files and the session: it used to run first and count
// every JS/CSS/image file too, so ordinary reloads — or several people behind one office IP —
// hit 1000 and got locked out with 429s (found 2026-09-28).
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: (req) => (req.session?.user?.id ? 'user:' + req.session.user.id : 'ip:' + req.ip),
  skip: (req) => req.path === '/health', // Don't rate limit health checks
});

// Stricter rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
  keyGenerator: (req) => req.ip,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/mobile/login', authLimiter);
app.use('/api/auth/register', authLimiter);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.get('/health', async (req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (err) {
    logger.error({ err }, 'Health check failed: database disconnected');
    res.status(503).json({ status: 'unhealthy', database: 'disconnected', error: err.message });
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'img', 'logo-mark.png')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const requestLogger = require('./logger').createRequestLogger(req, res);
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    requestLogger[level]({
      status_code: res.statusCode,
      duration_ms: duration,
      content_length: res.getHeader('content-length'),
    }, `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Registered before session/attachUser and before every other router below, on purpose: nearly
// every router mounted at '/' further down has its own blanket router.use(requireAuth) with no
// path restriction, which — because Express middleware runs in registration order regardless of
// whether a later route actually matches — would otherwise intercept this Bearer-secured,
// session-less service-to-service route first and reject it with "Not signed in." before it
// ever reached here. Confirmed live 2026-09-21: that's exactly what was happening. Registering
// this first, ahead of all of them, is simpler and safer than auditing/fixing every other
// router's mount path individually.
app.use('/api/integrations', globalLimiter, integrationsInRoutes);

const sessionMiddleware = session({
  store: new RedisStore({ client: redis, prefix: 'nc:sess:' }),
  secret: cfg.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
});
app.use(sessionMiddleware);
app.use(globalLimiter); // after static files and the session — see its definition above

app.use(attachUser);
app.use((req, res, next) => {
  res.locals.h = helpers;
  res.locals.path = req.path;
  next();
});

app.use('/api/mobile', require('./mobileSession').createMobileSessionRouter({ db: require('./db').db }));
app.use('/', authRoutes);
app.use('/app', appRoutes);
app.use('/', require('./routes/membership'));
app.use('/', teamRoutes);
app.use('/', messageRoutes);
app.use('/', dmRoutes);
app.use('/', userRoutes);
app.use('/', require('./routes/search'));
app.use('/', aiRoutes);
app.use('/', calendarRoutes);
app.use('/', require('./routes/meetings'));
app.use('/', require('./routes/meet'));
app.use('/api/decom', require('./routes/decom'));
app.use('/profile', profileRoutes);
app.use('/api/profile-photo', require('./routes/profilePhoto').createProfilePhotoRouter({ db: require('./db').db, requireAuth: require('./middleware/auth').requireAuth }));
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

require('./migrate').runMigrations(logger)
  .then(() => initDb())
  .then(async ({ seeded } = {}) => {
    await realtime.resetCallPresence();
    require('./scheduler').start();
    const servers = [];

    servers.push(server.listen(PORT, HOST, () => {
      logger.info(`NovaConnect running at http://${HOST}:${PORT}`);
      if (seeded === 'demo') logger.warn('Demo workspace created (SEED_DEMO=true): admin/admin123 (admin), jdoe/member123, bsmith/member123, mchen/member123, rpatel/member123. Not for real use.');
    }));

    if (fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH)) {
      const tlsOptions = { key: fs.readFileSync(TLS_KEY_PATH), cert: fs.readFileSync(TLS_CERT_PATH) };
      const httpsServer = https.createServer(tlsOptions, app);
      realtime.attach(httpsServer, sessionMiddleware);
      servers.push(httpsServer.listen(HTTPS_PORT, HOST, () => {
        logger.info(`NovaConnect also running securely at https://${HOST}:${HTTPS_PORT}`);
      }));
    } else {
      logger.warn(`No TLS certificate found at ${TLS_CERT_PATH} — HTTPS not started.`);
    }

    // Running as PID 1 in a container: an unhandled SIGTERM is silently ignored rather
    // than terminating the process (the kernel's default signal disposition doesn't apply
    // to PID 1 without an explicit handler), which otherwise forces every container stop
    // to wait out the full timeout and fall back to SIGKILL.
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutting down...');
      // Armed first: previously this sat after the awaits below, which could wait forever.
      setTimeout(() => process.exit(1), 8000).unref();
      try {
        // End running calls cleanly (their chats get "Call ended" posts) and drop the sockets,
        // which otherwise hold server.close() open.
        await realtime.shutdownRealtime('The server is restarting');
        await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
        await shutdownTelemetry();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        await shutdownTelemetry();
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((err) => {
    logger.fatal({ err }, 'Failed to initialize database');
    process.exit(1);
  });
