const express = require('express');
const fetch = require('node-fetch');
const cache = new Map();

const router = express.Router();
const CACHE_TTL_MS = 10 * 60 * 1000;

function configured() {
  return Boolean(process.env.TMDB_API_KEY || process.env.TMDB_ACCESS_TOKEN);
}

function authHeaders() {
  const headers = { Accept: 'application/json' };
  if (process.env.TMDB_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.TMDB_ACCESS_TOKEN}`;
  return headers;
}

async function tmdb(pathname, params = {}) {
  if (!configured()) throw new Error('TMDB is not configured. Add TMDB_API_KEY or TMDB_ACCESS_TOKEN in Render.');
  const url = new URL(`https://api.themoviedb.org/3${pathname}`);
  if (!process.env.TMDB_ACCESS_TOKEN) url.searchParams.set('api_key', process.env.TMDB_API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { headers: authHeaders(), timeout: 10000 });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.status_message || `TMDB HTTP ${res.status}`);
  return body;
}

function mapMovie(m) {
  return {
    id: m.id,
    title: m.title || m.original_title || 'Untitled',
    originalTitle: m.original_title || '',
    releaseDate: m.release_date || null,
    rating: Number.isFinite(Number(m.vote_average)) ? Number(m.vote_average) : null,
    votes: Number.isFinite(Number(m.vote_count)) ? Number(m.vote_count) : 0,
    overview: m.overview || '',
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    backdrop: m.backdrop_path ? `https://image.tmdb.org/t/p/w780${m.backdrop_path}` : null,
  };
}

router.get('/status', (req, res) => {
  res.json({ provider: 'TMDB', configured: configured() });
});

router.get('/now-playing', async (req, res) => {
  const region = String(req.query.region || 'IN').toUpperCase().slice(0, 2);
  const language = region === 'IN' ? 'en-IN' : 'en-US';
  const key = `now:${region}:${language}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return res.json(cached.data);

  try {
    const body = await tmdb('/movie/now_playing', { language, region, page: 1 });
    const data = {
      success: true,
      provider: 'TMDB',
      region,
      items: (body.results || []).slice(0, 10).map(mapMovie),
      updatedAt: new Date().toISOString(),
    };
    cache.set(key, { at: Date.now(), data });
    res.set('Cache-Control', 'no-store').json(data);
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;
