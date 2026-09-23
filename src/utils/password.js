const crypto = require('crypto');
// Zero-dependency password hashing (built-in scrypt). Portable across any host.
const N = 16384, R = 8, P = 1, KEYLEN = 64, SALT_BYTES = 16;

function hashPassword(password) {
  if (!password) throw new Error('Password is required.');
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  let derived;
  try { derived = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, { N: Number(n), r: Number(r), p: Number(p) }); }
  catch { return false; }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}
module.exports = { hashPassword, verifyPassword };
