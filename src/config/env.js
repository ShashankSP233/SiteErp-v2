try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }
const path = require('path');

const rootDir = path.resolve(__dirname, '../..');
const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const sessionSecret = process.env.SESSION_SECRET || 'dev-secret-change-me';

if (isProduction) {
  if (!process.env.SESSION_SECRET || sessionSecret === 'dev-secret-change-me') {
    throw new Error('SESSION_SECRET must be set to a strong unique value in production.');
  }
  if ((process.env.DEFAULT_ADMIN_PASSWORD || 'admin123') === 'admin123') {
    throw new Error('DEFAULT_ADMIN_PASSWORD must be changed from the default in production.');
  }
}

if (!process.env.ERP_DATABASE_URL && isProduction) {
  throw new Error('DATABASE_URL must be set in production (Supabase/Postgres connection string).');
}

module.exports = {
  nodeEnv,
  isProduction,
  appName: process.env.APP_NAME || 'Site ERP',
  port: Number(process.env.PORT || 3000),
  sessionSecret,
  databaseUrl: process.env.ERP_DATABASE_URL || '',
  pgSsl: (() => {
    const raw = String(process.env.PGSSL || 'auto').trim().toLowerCase();
    if (['true', '1', 'require', 'on', 'yes'].includes(raw)) return true;
    if (['false', '0', 'disable', 'off', 'no'].includes(raw)) return false;
    // auto: local Postgres usually has no SSL; hosted (Supabase, etc.) needs it.
    const url = process.env.ERP_DATABASE_URL || '';
    const isLocal = /@\[?(localhost|127\.0\.0\.1|::1)\]?[:\/]/i.test(url) || /(^|[?&;\s])host=\s*(localhost|127\.0\.0\.1)/i.test(url);
    return !isLocal;
  })(),
  rootDir,
  defaultAdminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 5)
};
