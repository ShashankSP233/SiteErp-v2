const express = require('express');
const { authenticate, createUser, changePassword, listUsers } = require('../repositories/userRepo');
const { logAudit } = require('../repositories/auditRepo');
const { guestOnly, requireAuth, requireRole } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, max: 10,
  keyGenerator: req => `${req.ip}:${String(req.body?.username || '').toLowerCase()}`,
  message: 'Too many login attempts. Please wait a few minutes and try again.'
});

router.get('/login', guestOnly, (req, res) => res.render('auth/login', { title: 'Login' }));

router.post('/login', guestOnly, loginLimiter, async (req, res, next) => {
  try {
    const user = await authenticate(req.body.username || '', req.body.password || '');
    if (!user) { req.session.error = 'Invalid username or password.'; return res.redirect('/login'); }
    req.session.regenerate(async (err) => {
      if (err) return next(err);
      req.session.user = user;
      await logAudit({ userId: user.id, action: 'LOGIN', entity: 'users', entityId: user.id, ip: req.ip, userAgent: req.get('user-agent') });
      res.redirect(user.must_change_password ? '/change-password' : '/');
    });
  } catch (err) { next(err); }
});

router.post('/logout', requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  await logAudit({ userId: uid, action: 'LOGOUT', entity: 'users', entityId: uid, ip: req.ip, userAgent: req.get('user-agent') });
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/change-password', requireAuth, (req, res) => res.render('auth/change-password', { title: 'Change Password' }));
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    if (req.body.newPassword !== req.body.confirmPassword) throw new Error('Passwords do not match.');
    await changePassword(req.session.user.id, req.body.newPassword);
    req.session.user.must_change_password = false;
    await logAudit({ userId: req.session.user.id, action: 'CHANGE_PASSWORD', entity: 'users', entityId: req.session.user.id, ip: req.ip });
    req.session.success = 'Password updated successfully.';
    res.redirect('/');
  } catch (err) { req.session.error = err.message; res.redirect('/change-password'); }
});

router.get('/users', requireAuth, requireRole('admin'), async (req, res, next) => {
  try { res.render('auth/users', { title: 'Users', users: await listUsers() }); } catch (e) { next(e); }
});
router.get('/users/new', requireAuth, requireRole('admin'), (req, res) => res.render('auth/user-form', { title: 'Create User' }));
router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { username, password, fullName, role } = req.body;
    if (!username || !password) throw new Error('Username and password are required.');
    if (String(password).length < 8) throw new Error('Password must be at least 8 characters long.');
    const user = await createUser({ username, password, fullName, role });
    await logAudit({ userId: req.session.user.id, action: 'CREATE_USER', entity: 'users', entityId: user.id, details: { username, role }, ip: req.ip });
    req.session.success = 'User created. They must set a new password on first login.';
    res.redirect('/users');
  } catch (err) { req.session.error = err.message; res.redirect('/users/new'); }
});

module.exports = router;
