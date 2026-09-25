require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const newsRoutes = require('./routes/news');
const marketsRoutes = require('./routes/markets');
const weatherRoutes = require('./routes/weather');
const manualDataRoutes = require('./routes/manualData');
const compareRoutes = require('./routes/compare');
const railwayRoutes = require('./routes/railway');
const mediaRoutes = require('./routes/media');
const seoRoutes = require('./routes/seo');
const moviesRoutes = require('./routes/movies');
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
    railway: Boolean(process.env.RAILRADAR_API_KEY) || Boolean(process.env.RAILKIT_API_KEY),
    youtube: Boolean(process.env.YOUTUBE_API_KEY) && !process.env.YOUTUBE_API_KEY.includes('your_'),
    gemini: Boolean(process.env.GEMINI_API_KEY) && !process.env.GEMINI_API_KEY.includes('your_'),
    tmdb: Boolean(process.env.TMDB_API_KEY || process.env.TMDB_ACCESS_TOKEN),
  };
  const ready = db.isConfigured() ? db.isReady() : true;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', version: '1.1.0', environment: process.env.NODE_ENV || 'development', ready, configured, databaseError: db.getError() });
});

app.get('/api/config', (req, res) => res.json({
  version: '1.1.0',
  analyticsEnabled: Boolean(process.env.GA_MEASUREMENT_ID),
  gaMeasurementId: process.env.GA_MEASUREMENT_ID || null,
  comparisonDataPolicy: 'manual-data-is-labelled',
  youtubeEnabled: Boolean(process.env.YOUTUBE_API_KEY),
  geminiEnabled: Boolean(process.env.GEMINI_API_KEY),
  moviesEnabled: Boolean(process.env.TMDB_API_KEY || process.env.TMDB_ACCESS_TOKEN),
  railwayEnabled: Boolean(process.env.RAILRADAR_API_KEY || process.env.RAILKIT_API_KEY),
}));

app.use('/api/news', newsRoutes);
app.use('/api/markets', marketsRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/prices', manualDataRoutes);
app.use('/api/compare', compareRoutes);
app.use('/api/railway', railwayRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/seo', seoRoutes);
app.use('/api/movies', moviesRoutes);

// Crawlable story URL: the browser still opens BURBREEK's in-app story view via JS,
// while crawlers receive real server-rendered <title>, meta description, OG tags and Article JSON-LD.
app.get('/story', async (req, res, next) => {
  try {
    const title = String(req.query.title || '').trim().slice(0, 220);
    const dek = String(req.query.dek || '').trim().slice(0, 500);
    const tag = String(req.query.tag || '').trim().slice(0, 60);
    const source = String(req.query.source || 'BURBREEK').trim().slice(0, 120);
    const sourceUrl = String(req.query.url || '').trim();
    const publishedAt = String(req.query.publishedAt || '').trim();
    const imageUrl = String(req.query.image || '').trim();
    if (!title && !dek) return res.redirect('/');

    const seo = await seoRoutes.generateMetaDescription({ title, dek, tag, lang: req.query.lang || 'en' });
    const file = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const safeTitle = title || 'BURBREEK';
    const safeDescription = seo.description || dek || 'BURBREEK — live news, markets, weather and everyday comparisons.';
    const canonical = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const articleJson = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: safeTitle,
      description: safeDescription,
      datePublished: /^\d{4}-/.test(publishedAt) ? publishedAt : new Date().toISOString(),
      publisher: { '@type': 'Organization', name: 'BURBREEK', url: `${req.protocol}://${req.get('host')}/` },
      mainEntityOfPage: canonical,
      isPartOf: { '@type': 'WebSite', name: 'BURBREEK', url: `${req.protocol}://${req.get('host')}/` },
      articleSection: tag || undefined,
      url: sourceUrl || canonical,
      sourceOrganization: source,
      ...(imageUrl && /^https?:\/\//i.test(imageUrl) ? { image: imageUrl } : {}),
    });
    const jsonLd = articleJson.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const headPatch = `\n<title>${escapeHtml(safeTitle)} | BURBREEK</title>\n<meta name="description" content="${escapeHtml(safeDescription)}">\n<link rel="canonical" href="${escapeHtml(canonical)}">\n<meta property="og:title" content="${escapeHtml(safeTitle)} | BURBREEK">\n<meta property="og:description" content="${escapeHtml(safeDescription)}">\n<meta property="og:type" content="article">\n<meta property="og:url" content="${escapeHtml(canonical)}">\n<meta name="twitter:card" content="summary_large_image">${imageUrl && /^https?:\/\//i.test(imageUrl) ? `\n<meta property="og:image" content="${escapeHtml(imageUrl)}">` : ''}\n<script type="application/ld+json">${jsonLd}</script>`;
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(file.replace('</head>', `${headPatch}\n</head>`));
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProduction ? '5m' : 0 }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/story') return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(`[${req.requestId || 'unknown'}]`, err.stack || err.message || err);
  if (res.headersSent) return next(err);
  res.status(err.message === 'CORS origin not allowed' ? 403 : 500).json({ error: 'Request failed', requestId: req.requestId });
});

function escapeHtml(v) {
  return String(v).replace(/[&<>\"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;' }[c]));
}

(async () => {
  try { await db.initDb(); }
  catch (err) {
    if (isProduction && process.env.REQUIRE_DATABASE === 'true') {
      console.error('[startup] Database required in production; exiting.');
      process.exit(1);
    }
  }
  app.listen(PORT, () => console.log(`BURBREEK v1.1 listening on port ${PORT}`));
})();
