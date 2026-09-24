const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();
const cache = new Map();
const CACHE_TTL_MS = 20 * 60 * 1000;

function fail(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function apiKeyConfigured() {
  return Boolean(process.env.YOUTUBE_API_KEY && !process.env.YOUTUBE_API_KEY.includes('your_'));
}

async function youtube(endpoint, params) {
  if (!apiKeyConfigured()) {
    const err = new Error('YouTube live media is not configured. Add YOUTUBE_API_KEY in Render.');
    err.code = 'YOUTUBE_NOT_CONFIGURED';
    throw err;
  }
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  url.searchParams.set('key', process.env.YOUTUBE_API_KEY);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = body?.error?.message || `YouTube HTTP ${response.status}`;
      const err = new Error(msg);
      err.status = response.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function nowIso() { return new Date().toISOString(); }

router.get('/status', (req, res) => {
  res.json({ provider: 'YouTube Data API', configured: apiKeyConfigured() });
});

router.get('/trending-music', async (req, res) => {
  const key = 'music:IN';
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return res.json(cached.data);
  try {
    const data = await youtube('videos', {
      part: 'snippet,statistics',
      chart: 'mostPopular',
      regionCode: 'IN',
      videoCategoryId: '10',
      maxResults: '10',
    });
    const items = (data.items || []).map((v, i) => ({
      rank: i + 1,
      id: v.id,
      title: v.snippet?.title || 'Untitled',
      channel: v.snippet?.channelTitle || '',
      thumbnail: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || null,
      views: Number(v.statistics?.viewCount || 0),
      publishedAt: v.snippet?.publishedAt || null,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`,
    }));
    const payload = { success: true, provider: 'YouTube Data API', region: 'IN', items, updatedAt: nowIso() };
    cache.set(key, { at: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    if (err.code === 'YOUTUBE_NOT_CONFIGURED') return fail(res, 503, err.message);
    console.error('[media] trending music failed', err.message || err);
    return fail(res, 502, 'Unable to fetch trending music right now.');
  }
});

router.get('/top-shorts', async (req, res) => {
  const key = 'shorts:world';
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return res.json(cached.data);
  try {
    const after = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const search = await youtube('search', {
      part: 'snippet',
      q: '#shorts',
      type: 'video',
      videoDuration: 'short',
      order: 'viewCount',
      publishedAfter: after,
      maxResults: '10',
    });
    const ids = (search.items || []).map(v => v.id?.videoId).filter(Boolean);
    let stats = {};
    if (ids.length) {
      const statData = await youtube('videos', { part: 'statistics', id: ids.join(','), maxResults: String(ids.length) });
      (statData.items || []).forEach(v => { stats[v.id] = Number(v.statistics?.viewCount || 0); });
    }
    const items = (search.items || []).map((v, i) => ({
      rank: i + 1,
      id: v.id?.videoId,
      title: v.snippet?.title || 'Untitled',
      channel: v.snippet?.channelTitle || '',
      thumbnail: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || null,
      views: stats[v.id?.videoId] || 0,
      publishedAt: v.snippet?.publishedAt || null,
      url: v.id?.videoId ? `https://www.youtube.com/shorts/${encodeURIComponent(v.id.videoId)}` : null,
    })).sort((a,b) => b.views - a.views).map((x, i) => ({ ...x, rank: i + 1 }));
    const payload = { success: true, provider: 'YouTube Data API', region: 'Worldwide', items, updatedAt: nowIso() };
    cache.set(key, { at: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    if (err.code === 'YOUTUBE_NOT_CONFIGURED') return fail(res, 503, err.message);
    console.error('[media] top shorts failed', err.message || err);
    return fail(res, 502, 'Unable to fetch trending Shorts right now.');
  }
});

module.exports = router;
