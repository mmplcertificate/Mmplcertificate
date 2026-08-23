const express = require('express');
const db = require('../db');
const {
  verifyPassword,
  signToken,
  setSessionCookie,
  clearSessionCookie,
  authenticate,
  logAudit,
} = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = signToken(user);
  setSessionCookie(res, token);
  logAudit(user, 'login', null);
  res.json({
    username: user.username,
    role: user.role,
    permissions: user.role === 'team' ? JSON.parse(user.permissions || '{}') : undefined,
  });
});

router.post('/logout', authenticate, (req, res) => {
  logAudit(req.user, 'logout', null);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', authenticate, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role,
    permissions: req.user.permissions,
  });
});

module.exports = router;
