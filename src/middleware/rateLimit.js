function createRateLimiter({ windowMs, max, keyGenerator, message }) {
  const hits = new Map();
  const t = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); }, windowMs);
  if (t.unref) t.unref();
  return function (req, res, next) {
    const key = keyGenerator ? keyGenerator(req) : req.ip;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; hits.set(key, e); }
    e.count++;
    if (e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
      if (req.session) req.session.error = message || 'Too many attempts. Please try again later.';
      return res.redirect(req.originalUrl);
    }
    next();
  };
}
module.exports = { createRateLimiter };
