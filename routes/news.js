const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

// Maps the app's internal category keys to NewsAPI query terms.
// NewsAPI's /everything endpoint takes a free-text query; /top-headlines
// takes a category enum. We use /everything for the topical sections since
// NewsAPI's fixed categories (business, technology, etc.) don't line up
// cleanly with "startup", "ai", "politics", etc.
const CATEGORY_QUERIES = {
  trending: 'India OR world news',
  startup: 'startup funding India',
  funding: 'startup funding round raised',
  ai: 'artificial intelligence OR AI model',
  politics: 'parliament OR government policy India',
  gtk: 'explainer OR "what you need to know"',
};

async function fetchNews(category) {
  const key = process.env.NEWSAPI_KEY;
  if (!key || key.includes('your_newsapi_key')) {
    throw new Error('NEWSAPI_KEY not configured — add a real key to .env');
  }

  const cacheKey = `news:${category}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const q = CATEGORY_QUERIES[category] || CATEGORY_QUERIES.trending;
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${key}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NewsAPI error ${res.status}: ${body}`);
  }
  const data = await res.json();

  const mapped = (data.articles || []).map((a) => ({
    tag: category.toUpperCase(),
    headline: a.title,
    dek: a.description || '',
    source: a.source?.name || 'Unknown',
    url: a.url,
    time: a.publishedAt,
    imageUrl: a.urlToImage || null,
  }));

  cache.set(cacheKey, mapped, 300); // 5 min cache — respects free-tier rate limits
  return mapped;
}

router.get('/:category', async (req, res) => {
  try {
    const articles = await fetchNews(req.params.category);
    res.json({ category: req.params.category, articles });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
