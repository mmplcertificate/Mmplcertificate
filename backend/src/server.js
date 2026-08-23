require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const db = require('./db');
const { authenticate } = require('./auth');

const authRoutes = require('./routes/auth-routes');
const certificatesRoutes = require('./routes/certificates');
const documentsRoutes = require('./routes/documents');
const engagementsRoutes = require('./routes/engagements');
const draftHelperRoutes = require('./routes/draft-helper');
const financialsRoutes = require('./routes/financials');
const draftRequestsRoutes = require('./routes/draft-requests');
const clientPortalRoutes = require('./routes/client-portal');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

// Public. Registered before every other /api mount, deliberately: the bare
// `/api` mount further down (for documents.js) applies `authenticate` to any
// /api/* request that falls through to it, so anything meant to be public has
// to be registered ahead of that mount or it gets shadowed the same way the
// engagements/draft-requests/client-portal routers once were.
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);

// Authenticated (role/permission checks happen per-router / per-route below)
app.use('/api/certificates', authenticate, certificatesRoutes);
app.use('/api/engagements', authenticate, engagementsRoutes);
app.use('/api/draft-helper', authenticate, draftHelperRoutes);
app.use('/api/financials', authenticate, financialsRoutes);
app.use('/api/draft-requests', authenticate, draftRequestsRoutes);
app.use('/api/client-portal', authenticate, clientPortalRoutes);

// documents.js intentionally mounted at bare /api: its own internal routes span
// several path shapes (/certificates/:id/documents, /files/:hash/download, ...)
// that don't share one sub-prefix. Permission checks live INSIDE documents.js,
// per-route, not here — a blanket authenticate/requirePermission at this mount
// point previously shadowed every other /api/* router registered after it.
app.use('/api', authenticate, documentsRoutes);

// Static frontend
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, '..', '..', 'frontend', 'dist');
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`MMPL dashboard backend listening on port ${PORT}`);
  console.log(`DB: ${db.DB_PATH}`);
});
