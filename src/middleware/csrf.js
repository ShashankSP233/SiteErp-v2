const crypto = require('crypto');
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function csrf(req, res, next) {
  if (req.session && !req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session ? req.session.csrfToken : '';
  if (SAFE.has(req.method)) return next();
  const submitted = (req.body && req.body._csrf) || (req.query && req.query._csrf) || req.get('x-csrf-token');
  if (req.session && submitted && timingSafeEqual(submitted, req.session.csrfToken)) return next();
  res.status(403).render('errors/403', { title: 'Invalid request token' });
}
module.exports = { csrf };
