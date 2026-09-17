require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const newsRoutes = require('./routes/news');
const marketsRoutes = require('./routes/markets');
const weatherRoutes = require('./routes/weather');
const manualDataRoutes = require('./routes/manualData');
const compareRoutes = require('./routes/compare');
const db = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (isProduction && !allowedOrigins.length) console.warn('[security] CORS_ORIGINS is empty; configure it for production.');

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use(cors({ origin: (origin, cb) => {
  if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
  return cb(new Error('CORS origin not allowed'));
}, credentials: false }));
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  req.requestId = requestId;
  const started = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms ${requestId}`));
  next();
});

app.get('/health', (req, res) => {
  const configured = {
    newsapi: Boolean(process.env.NEWSAPI_KEY) && !process.env.NEWSAPI_KEY.includes('your_'),
    database: db.isConfigured(),
    openweather: Boolean(process.env.OPENWEATHER_KEY) && !process.env.OPENWEATHER_KEY.includes('your_'),
  };
  const ready = db.isConfigured() ? db.isReady() : true;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', version: '1.0.0', environment: process.env.NODE_ENV || 'development', ready, configured, databaseError: db.getError() });
});

app.get('/api/config', (req, res) => res.json({ version: '1.0.0', analyticsEnabled: Boolean(process.env.GA_MEASUREMENT_ID), gaMeasurementId: process.env.GA_MEASUREMENT_ID || null, comparisonDataPolicy: 'manual-data-is-labelled' }));

app.use('/api/news', newsRoutes);
app.use('/api/markets', marketsRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/prices', manualDataRoutes);
app.use('/api/compare', compareRoutes);

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProduction ? '1h' : 0 }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health') return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(`[${req.requestId || 'unknown'}]`, err.stack || err.message || err);
  if (res.headersSent) return next(err);
  res.status(err.message === 'CORS origin not allowed' ? 403 : 500).json({ error: 'Request failed', requestId: req.requestId });
});

(async () => {
  try { await db.initDb(); }
  catch (err) {
    if (isProduction && process.env.REQUIRE_DATABASE === 'true') {
      console.error('[startup] Database required in production; exiting.');
      process.exit(1);
    }
  }
  app.listen(PORT, () => console.log(`BURBREEK v1 listening on port ${PORT}`));
})();
