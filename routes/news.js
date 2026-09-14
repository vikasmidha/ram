const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

// Maps the app's internal category keys to NewsAPI query terms.
const CATEGORY_QUERIES = {
  trending: 'India OR world news',
  startup: 'startup funding India',
  funding: 'startup funding round raised',
  ai: 'artificial intelligence OR AI model',
  politics: 'parliament OR government policy India',
  gtk: 'explainer OR "what you need to know"',
};

// Supported languages.
// NewsAPI expects ISO 639-1 language codes.
const SUPPORTED_LANGUAGES = ['en', 'hi'];

function getLanguage(req) {
  const lang = String(req.query.lang || 'en').toLowerCase().trim();

  return SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en';
}

async function fetchNews(category, lang) {
  const key = process.env.NEWSAPI_KEY;

  if (!key || key.includes('your_newsapi_key')) {
    throw new Error(
      'NEWSAPI_KEY not configured — add a real key to .env'
    );
  }

  /*
   * IMPORTANT:
   * Language is part of the cache key.
   *
   * Without this:
   * news:trending
   *
   * Hindi and English requests could receive the same cached response.
   */
  const cacheKey = `news:${category}:${lang}`;

  const cached = cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const q =
    CATEGORY_QUERIES[category] ||
    CATEGORY_QUERIES.trending;

  const url =
    `https://newsapi.org/v2/everything` +
    `?q=${encodeURIComponent(q)}` +
    `&language=${lang}` +
    `&sortBy=publishedAt` +
    `&pageSize=10` +
    `&apiKey=${key}`;

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();

    throw new Error(
      `NewsAPI error ${res.status}: ${body}`
    );
  }

  const data = await res.json();

  const mapped = (data.articles || [])
    .filter((article) => article.title)
    .map((article) => ({
      tag: category.toUpperCase(),

      headline: article.title,

      dek: article.description || '',

      source:
        article.source?.name ||
        'Unknown',

      url: article.url,

      time: article.publishedAt,

      imageUrl:
        article.urlToImage ||
        null,
    }));

  /*
   * Cache separately for each language.
   * 5 minutes keeps API usage under control.
   */
  cache.set(
    cacheKey,
    mapped,
    300
  );

  return mapped;
}

router.get('/:category', async (req, res) => {
  try {
    const category =
      String(req.params.category || 'trending')
        .toLowerCase()
        .trim();

    const lang = getLanguage(req);

    const articles =
      await fetchNews(category, lang);

    res.json({
      category,
      language: lang,
      articles,
    });
  } catch (err) {
    console.error(
      '[news]',
      err.message
    );

    res.status(502).json({
      error: 'Unable to fetch news',
      details: err.message,
    });
  }
});

module.exports = router;
