const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

const router = express.Router();
const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function configured() {
  return Boolean(process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('your_'));
}

function clean(v, max) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeKey(title, dek, tag, lang) {
  return crypto.createHash('sha256').update(`${lang}|${title}|${dek}|${tag}`).digest('hex');
}

function fallback(title, dek) {
  const base = [title, dek].filter(Boolean).join(' — ');
  if (!base) return 'BURBREEK brings fast, focused news, live updates, useful comparisons and everyday information in one place.';
  return base.length <= 155 ? base : base.slice(0, 152).replace(/\s+\S*$/, '') + '...';
}

router.get('/status', (req, res) => {
  res.json({ provider: 'Google Gemini API', configured: configured(), model: process.env.GEMINI_MODEL || 'gemini-3.8-flash' });
});

router.get('/meta-description', async (req, res) => {
  const title = clean(req.query.title, 220);
  const dek = clean(req.query.dek, 500);
  const tag = clean(req.query.tag, 60);
  const lang = String(req.query.lang || 'en').toLowerCase() === 'hi' ? 'hi' : 'en';
  if (!title && !dek) return res.status(400).json({ success: false, error: 'title or dek is required' });

  const key = makeKey(title, dek, tag, lang);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return res.json(cached.data);

  if (!configured()) {
    const payload = { success: false, configured: false, description: fallback(title, dek), source: 'deterministic-fallback' };
    cache.set(key, { at: Date.now(), data: payload });
    return res.json(payload);
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const prompt = lang === 'hi'
    ? `नीचे दिए गए समाचार के लिए 140-155 अक्षरों की एक तथ्यात्मक SEO meta description लिखें। कोई नई जानकारी या दावा न जोड़ें। क्लिकबेट, इमोजी, हैशटैग और उद्धरण चिह्न न रखें। केवल description लौटाएँ।\nश्रेणी: ${tag}\nशीर्षक: ${title}\nविवरण: ${dek}`
    : `Write one factual SEO meta description of 140-155 characters for the news item below. Do not add any new facts or claims. No clickbait, emoji, hashtags or quotation marks. Return only the description.\nCategory: ${tag}\nTitle: ${title}\nDescription: ${dek}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || `Gemini HTTP ${response.status}`);
      const text = body?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(' ').trim() || '';
      const description = clean(text.replace(/^['\"`]+|['\"`]+$/g, ''), 170);
      const payload = { success: Boolean(description), configured: true, description: description || fallback(title, dek), source: description ? 'gemini' : 'deterministic-fallback', model };
      cache.set(key, { at: Date.now(), data: payload });
      return res.json(payload);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error('[seo] Gemini meta generation failed', err.message || err);
    const payload = { success: false, configured: true, description: fallback(title, dek), source: 'deterministic-fallback', error: 'AI generation unavailable' };
    cache.set(key, { at: Date.now(), data: payload });
    return res.json(payload);
  }
});

module.exports = router;
