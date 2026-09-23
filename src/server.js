const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const helmet = require('helmet');
const morgan = require('morgan');
const expressLayouts = require('express-ejs-layouts');
const env = require('./config/env');
const db = require('./config/db');
const { runMigrations, ensureAdmin } = require('./db/setup');
const { attachUser, enforcePasswordChange } = require('./middleware/auth');
const { csrf } = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
if (env.isProduction) app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// Static template global (available in every render, including the layout).
app.locals.appName = env.appName;

// express-ejs-layouts passes render *options* (not res.locals) to the layout,
// so merge res.locals into the options for every render. This makes currentUser,
// error, success, csrfToken, appName, etc. available inside the layout/partials.
app.use((req, res, next) => {
  const inner = res.render.bind(res);
  res.render = (view, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    return inner(view, Object.assign({}, res.locals, options || {}), callback);
  };
  next();
});

app.use((req, res, next) => { res.locals.cspNonce = crypto.randomBytes(16).toString('base64'); next(); });
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
try {
  const bootstrapDist = path.join(path.dirname(require.resolve('bootstrap/package.json')), 'dist');
  app.use('/vendor/bootstrap', express.static(bootstrapDist));
} catch (_) { console.warn('[warn] bootstrap not found — run "npm install".'); }

// Sessions: Postgres-backed in pg mode (multi-instance safe); in-memory for the
// local PGlite test mode (fine for a single local process).
const sessionOptions = {
  secret: env.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 60 * 60 * 1000 }
};
if (db.backend === 'pg') {
  const pool = db.pool; // getter initializes the pool on access
  if (pool) {
    const pgSession = require('connect-pg-simple')(session);
    sessionOptions.store = new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true });
  } else {
    console.warn('[warn] Postgres pool unavailable — falling back to in-memory sessions for this run.');
  }
}
app.use(session(sessionOptions));
app.use(attachUser);
app.use(csrf);
app.use(enforcePasswordChange);
app.use((req, res, next) => { res.locals.appName = env.appName; next(); });

app.use(require('./routes/authRoutes'));
app.use(require('./routes/inventoryRoutes'));
app.use(require('./routes/billRoutes'));
app.use(require('./routes/poRoutes'));
app.use(require('./routes/vendorRoutes'));
app.use(require('./routes/labelRoutes'));
app.use('/inventory-audit', require('./routes/auditRoutes'));

app.use(notFound);
app.use(errorHandler);

async function start() {
  if (db.backend === 'sqlite') {
    console.log('[local] No DATABASE_URL set — using the built-in SQLite engine for local testing.');
    console.log('[local] Data is stored in ./data/local.db (delete it to reset).');
  } else {
    console.log('[db] DATABASE_URL set — using PostgreSQL. Applying migrations…');
  }
  await runMigrations();
  const created = await ensureAdmin();
  if (created) console.log(`Admin ready: ${env.defaultAdminUsername} / ${env.defaultAdminPassword} (you'll set a new password on first login).`);
  app.listen(env.port, () => console.log(`${env.appName} running on http://localhost:${env.port}  (database: ${db.backend})`));
}
start().catch((err) => {
  console.error('Failed to start:', err.message);
  if (/SSL/i.test(err.message)) {
    console.error('Hint: your PostgreSQL server does not support SSL (common for a LOCAL Postgres).');
    console.error('      Set  PGSSL="false"  in your .env and restart.');
    console.error('      (For Supabase, use the Connect-dialog string and PGSSL="true" or "auto".)');
  }
  process.exit(1);
});
