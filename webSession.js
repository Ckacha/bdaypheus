const crypto = require('crypto');

const COOKIE = 'bdaypheus_session';
const MAX_AGE_S = 30 * 86400;

const secret = process.env.SESSION_SECRET || process.env.SLACK_SIGNING_SECRET || '';
const key = secret ? crypto.createHmac('sha256', secret).update('bdaypheus-session').digest() : null;
const secure = (process.env.PUBLIC_BASE_URL || '').startsWith('https://');
const flags = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

function sign(value) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

function sessionCookie(userId) {
  if (!key) return null;
  const value = `${userId}.${Math.floor(Date.now() / 1000) + MAX_AGE_S}`;
  return `${COOKIE}=${value}.${sign(value)}; Max-Age=${MAX_AGE_S}; ${flags}`;
}

const clearSessionCookie = `${COOKIE}=; Max-Age=0; ${flags}`;

function readSession(req) {
  if (!key) return null;
  const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9._-]+)`).exec(req.headers.cookie || '');
  const [userId, exp, mac] = raw ? raw[1].split('.') : [];
  if (!userId || !exp || !mac) return null;

  const expected = Buffer.from(sign(`${userId}.${exp}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;

  return { userId, csrf: sign(`csrf.${raw[1]}`) };
}

module.exports = { sessionCookie, clearSessionCookie, readSession };
