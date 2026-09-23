const env = require('../config/env');
function notFound(req, res) { res.status(404).render('errors/404', { title: 'Not found' }); }
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('[error]', err.message);
  res.status(500).render('errors/500', { title: 'Server error', message: env.isProduction ? 'Something went wrong.' : err.message });
}
module.exports = { notFound, errorHandler };
