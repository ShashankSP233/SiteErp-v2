function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.session) req.session.error = 'Please login first.';
  return res.redirect('/login');
}
function guestOnly(req, res, next) {
  if (req.session?.user) return res.redirect('/');
  return next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session?.user;
    if (!user) return res.redirect('/login');
    if (roles.includes(user.role)) return next();
    return res.status(403).render('errors/403', { title: 'Access denied' });
  };
}
function enforcePasswordChange(req, res, next) {
  const user = req.session?.user;
  if (!user || !user.must_change_password) return next();
  if (['/change-password', '/logout'].includes(req.path)) return next();
  return res.redirect('/change-password');
}
function attachUser(req, res, next) {
  res.locals.currentUser = req.session?.user || null;
  res.locals.error = req.session?.error || null;
  res.locals.success = req.session?.success || null;
  if (req.session) { delete req.session.error; delete req.session.success; }
  next();
}
module.exports = { requireAuth, guestOnly, requireRole, enforcePasswordChange, attachUser };
