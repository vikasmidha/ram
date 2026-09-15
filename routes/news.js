const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

const CACHE_TTL_SECONDS = 300;
const PAGE_SIZE = 20;

const SUPPORTED_LANGUAGES = ['en', 'hi'];

/*
 * English search queries.
 */
const CATEGORY_QUERIES_EN = {
  trending:
    '(India OR Indian OR world) AND (news OR politics OR business OR technology)',

  startup:
    '(startup OR startups OR entrepreneur OR entrepreneurship) AND (India OR Indian)',

  funding:
    '("funding round" OR "raised funding" OR investment OR investors) AND (startup OR company)',

  ai:
    '("artificial intelligence" OR "AI model" OR "generative AI" OR "machine learning")',

  politics:
    '(parliament OR government OR election OR minister OR policy) AND India',

  gtk:
    '("explainer" OR "what you need to know" OR "explained" OR "how it works") AND India',
};

/*
 * Hindi search queries.
 *
 * NewsAPI's language=hi is still used as the primary language filter.
 * Hindi search terms improve the chance of getting genuinely Hindi
 * reporting instead of simply receiving English stories.
 */
const CATEGORY_QUERIES_HI = {
  trending:
    '(भारत OR भारतीय OR दुनिया) AND (समाचार OR खबर OR राजनीति OR व्यापार OR तकनीक)',

  startup:
    '(स्टार्टअप OR उद्यमिता OR उद्यमी) AND (भारत OR भारतीय)',

  funding:
    '(फंडिंग OR निवेश OR निवेशक OR पूंजी) AND (स्टार्टअप OR कंपनी)',

  ai:
    '("कृत्रिम बुद्धिमत्ता" OR एआई OR "आर्टिफिशियल इंटेलिजेंस" OR "मशीन लर्निंग")',

  politics:
    '(संसद OR सरकार OR चुनाव OR मंत्री OR नीति) AND भारत',

  gtk:
    '(समझिए OR समझाया OR "क्या है" OR "कैसे काम करता है") AND भारत',
};

function getLanguage(req) {
  const lang = String(req.query.lang || 'en')
    .toLowerCase()
    .trim();

  return SUPPORTED_LANGUAGES.includes(lang)
    ? lang
    : 'en';
}

function getQuery(category, lang) {
  const queries =
    lang === 'hi'
      ? CATEGORY_QUERIES_HI
      : CATEGORY_QUERIES_EN;

  return queries[category] || queries.trending;
}

function cleanText(value) {
  if (!value) return '';

  return String(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidArticle(article) {
  if (!article) return false;

  const title = cleanText(article.title);

  if (!title) return false;

  /*
   * NewsAPI can return removed/placeholder articles.
   */
  if (title === '[Removed]') return false;

  if (
    title.toLowerCase().includes('[removed]')
  ) {
    return false;
  }

  if (!article.url) return false;

  return true;
}

function dedupeArticles(articles) {
  const seenUrls = new Set();
  const seenTitles = new Set();

  const result = [];

  for (const article of articles) {
    if (!isValidArticle(article)) continue;

    const url = cleanText(article.url);

    const title = cleanText(article.title)
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097f]+/gi, ' ')
      .trim();

    /*
     * Exact URL duplicate.
     */
    if (seenUrls.has(url)) continue;

    /*
     * Exact normalized title duplicate.
     */
    if (title && seenTitles.has(title)) continue;

    seenUrls.add(url);

    if (title) {
      seenTitles.add(title);
    }

    result.push(article);
  }

  return result;
}

function mapArticle(article, category) {
  return {
    tag: category.toUpperCase(),

    headline: cleanText(article.title),

    dek: cleanText(article.description),

    source:
      cleanText(article.source?.name) ||
      'Unknown',

    url: article.url,

    time: article.publishedAt || null,

    imageUrl:
      article.urlToImage || null,
  };
}

async function fetchNews(category, lang) {
  const key = process.env.NEWSAPI_KEY;

  if (
    !key ||
    key.includes('your_newsapi_key')
  ) {
    throw new Error(
      'NEWSAPI_KEY not configured — add a real key to the environment.'
    );
  }

  /*
   * Language MUST be part of the cache key.
   */
  const cacheKey =
    `news:${category}:${lang}`;

  const cached = cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const query = getQuery(category, lang);

  const params = new URLSearchParams({
    q: query,
    language: lang,
    sortBy: 'publishedAt',
    pageSize: String(PAGE_SIZE),
    apiKey: key,
  });

  const url =
    `https://newsapi.org/v2/everything?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'BURBREEK/1.0',
    },
    timeout: 10000,
  });

  if (!res.ok) {
    const body = await res.text();

    throw new Error(
      `NewsAPI error ${res.status}: ${body}`
    );
  }

  const data = await res.json();

  if (data.status !== 'ok') {
    throw new Error(
      data.message ||
      'NewsAPI returned an unsuccessful response.'
    );
  }

  /*
   * Clean and deduplicate before sending to frontend.
   */
  const cleaned =
    dedupeArticles(data.articles || []);

  /*
   * Map only after cleaning.
   */
  const mapped =
    cleaned
      .slice(0, 10)
      .map(article =>
        mapArticle(article, category)
      );

  /*
   * Cache independently by category + language.
   */
  cache.set(
    cacheKey,
    mapped,
    CACHE_TTL_SECONDS
  );

  return mapped;
}

router.get('/:category', async (req, res) => {
  try {
    const category =
      String(
        req.params.category || 'trending'
      )
        .toLowerCase()
        .trim();

    const lang = getLanguage(req);

    const articles =
      await fetchNews(
        category,
        lang
      );

    res.json({
      category,
      language: lang,
      articles,
      count: articles.length,
      source: 'NewsAPI',
      cacheTtlSeconds:
        CACHE_TTL_SECONDS,
      updatedAt:
        new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `[news] ${req.params.category}`,
      err.message
    );

    res.status(502).json({
      error: 'Unable to fetch news',
      details: err.message,
    });
  }
});

module.exports = router;
