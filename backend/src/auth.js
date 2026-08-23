// Auth & roles.
// Cookie/JWT login. Token embeds role (admin | team | client) and permissions
// (JSON, team-only). requireRole(...) and requirePermission(name) middleware:
// admin always passes any permission check; team passes only if permissions[name]
// is truthy; client never passes a permission check (client accounts use the
// dedicated portal routes instead).
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE_NAME = 'mmpl_session';
const TOKEN_TTL = '12h';

const PERMISSION_NAMES = ['tracking', 'billing', 'downloading', 'drafting'];

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function signToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: user.role === 'team' ? safeParsePermissions(user.permissions) : undefined,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function safeParsePermissions(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.FORCE_SECURE_COOKIE !== '0',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function getTokenFromReq(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return null;
}

function authenticate(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden for this role' });
    }
    next();
  };
}

function requirePermission(name) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { role, permissions } = req.user;
    if (role === 'admin') return next();
    if (role === 'team' && permissions && permissions[name]) return next();
    return res.status(403).json({ error: `Missing permission: ${name}` });
  };
}

function logAudit(user, action, detail) {
  try {
    db.prepare(
      'INSERT INTO audit_log (user_id, username, action, detail) VALUES (?, ?, ?, ?)'
    ).run(user ? user.id : null, user ? user.username : null, action, detail ? String(detail) : null);
  } catch (e) {
    // Audit logging must never break the request.
    console.error('audit log failed', e);
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  setSessionCookie,
  clearSessionCookie,
  authenticate,
  requireRole,
  requirePermission,
  logAudit,
  PERMISSION_NAMES,
  COOKIE_NAME,
};
