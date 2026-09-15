const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

const CACHE_TTL_SECONDS = 300;
const PAGE_SIZE = 50;
const RETURN_COUNT = 10;
const SUPPORTED_LANGUAGES = ['en', 'hi'];

const CATEGORY_QUERIES = {
  en: {
    trending: 'India OR Indian OR world news OR government OR business OR technology',
    startup: 'startup OR startups OR entrepreneur OR entrepreneurship AND India',
    funding: '"funding round" OR "raised funding" OR investment OR investors AND startup',
    ai: '"artificial intelligence" OR "AI model" OR "generative AI" OR "machine learning"',
    politics: 'parliament OR government OR election OR minister OR policy AND India',
    gtk: 'explainer OR "what you need to know" OR explained AND India',
  },
  hi: {
    trending: 'भारत OR भारतीय OR दुनिया OR समाचार OR खबर OR राजनीति OR व्यापार OR तकनीक',
    startup: 'स्टार्टअप OR उद्यमिता OR उद्यमी AND भारत',
    funding: 'फंडिंग OR निवेश OR निवेशक OR पूंजी AND स्टार्टअप',
    ai: '"कृत्रिम बुद्धिमत्ता" OR एआई OR "आर्टिफिशियल इंटेलिजेंस" OR "मशीन लर्निंग"',
    politics: 'संसद OR सरकार OR चुनाव OR मंत्री OR नीति AND भारत',
    gtk: 'समझिए OR समझाया OR "क्या है" OR "कैसे काम करता है" AND भारत',
  },
};

// Strongly relevant publishers are not hard-required, but get a small quality boost.
// This keeps source diversity while preferring established news/reporting outlets.
const TRUSTED_SOURCES = new Set([
  'Reuters', 'BBC News', 'Associated Press', 'The Hindu', 'The Indian Express',
  'Hindustan Times', 'The Times of India', 'NDTV', 'News18', 'India Today',
  'Aajtak.in', 'Moneycontrol', 'CNBC-TV18', 'Economic Times', 'Mint',
  'The Economic Times', 'The Telegraph', 'Business Standard', 'ANI', 'PTI',
  'Yale.edu', 'MIT News', 'NASA', 'WHO', 'United Nations',
]);

const HARD_EXCLUDE_PATTERNS = [
  /\/short-videos?\//i,
  /\/video\//i,
  /\/videos?\//i,
  /\/podcast/i,
  /\/sounds\//i,
  /\/comics?\//i,
];

const CATEGORY_TERMS = {
  trending: {
    positive: ['india', 'indian', 'government', 'parliament', 'economy', 'business', 'technology', 'world', 'global', 'policy', 'trade', 'oil', 'market', 'brics'],
    negative: ['football', 'soccer', 'nba', 'cricket', 'ballon', 'movie', 'movies', 'celebrity', 'comics', 'comic', 'podcast', 'playlist', 'horoscope', 'fashion'],
  },
  startup: {
    positive: ['startup', 'startups', 'founder', 'funding', 'venture', 'venture capital', 'entrepreneur', 'entrepreneurship', 'company', 'innovation'],
    negative: ['football', 'cricket', 'movie', 'celebrity', 'comics', 'podcast'],
  },
  funding: {
    positive: ['funding', 'raised', 'investment', 'investor', 'investors', 'valuation', 'venture capital', 'series a', 'series b', 'capital'],
    negative: ['football', 'cricket', 'movie', 'celebrity', 'comics', 'podcast'],
  },
  ai: {
    positive: ['artificial intelligence', ' ai ', 'ai model', 'generative ai', 'machine learning', 'llm', 'openai', 'anthropic', 'google deepmind', 'nvidia', 'robotics', 'chip', 'semiconductor'],
    negative: ['cricket', 'football', 'nba', 'movie', 'celebrity', 'comics', 'podcast'],
  },
  politics: {
    positive: ['government', 'parliament', 'minister', 'election', 'policy', 'bill', 'supreme court', 'president', 'prime minister', 'congress', 'bjp', 'india'],
    negative: ['football', 'cricket', 'movie', 'celebrity', 'comics', 'podcast'],
  },
  gtk: {
    positive: ['explainer', 'explained', 'what you need to know', 'how it works', 'why it matters', 'guide'],
    negative: ['football', 'cricket', 'movie', 'celebrity', 'comics', 'podcast'],
  },
};

function getLanguage(req) {
  const lang = String(req.query.lang || 'en').toLowerCase().trim();
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&nbsp;/g, ' ')
    .replace(/[^a-z0-9\u0900-\u097f]+/gi, ' ')
    .trim();
}

function articleText(article) {
  return ` ${cleanText(article.title)} ${cleanText(article.description)} `.toLowerCase();
}

function isValidArticle(article) {
  if (!article || !article.title || !article.url) return false;
  const title = cleanText(article.title);
  if (!title || /^\[removed\]$/i.test(title)) return false;
  if (HARD_EXCLUDE_PATTERNS.some(re => re.test(article.url))) return false;
  return true;
}

function hoursOld(publishedAt) {
  const ts = Date.parse(publishedAt || '');
  if (!Number.isFinite(ts)) return 72;
  return Math.max(0, (Date.now() - ts) / 36e5);
}

function sourceName(article) {
  return cleanText(article.source?.name) || 'Unknown';
}

function relevanceScore(article, category) {
  const text = articleText(article);
  const terms = CATEGORY_TERMS[category] || CATEGORY_TERMS.trending;
  let score = 0;

  for (const term of terms.positive) {
    if (text.includes(term.toLowerCase())) score += 6;
  }
  for (const term of terms.negative) {
    if (text.includes(term.toLowerCase())) score -= 14;
  }

  // India relevance is valuable for BURBREEK's home feed.
  if (/\bindia\b|\bindian\b|भारत|भारतीय/i.test(text)) score += 10;

  const source = sourceName(article);
  if (TRUSTED_SOURCES.has(source)) score += 4;

  // Penalize obvious thin/low-information cards.
  const description = cleanText(article.description);
  if (description.length >= 80) score += 3;
  if (description.length < 25) score -= 2;

  // Freshness: strong benefit in first 24h, then gradually decays.
  const age = hoursOld(article.publishedAt);
  if (age <= 6) score += 8;
  else if (age <= 24) score += 5;
  else if (age <= 48) score += 1;
  else if (age > 96) score -= 8;

  return score;
}

function dedupeByUrlAndTitle(articles) {
  const urls = new Set();
  const titles = new Set();
  const result = [];

  for (const article of articles) {
    if (!isValidArticle(article)) continue;
    const url = cleanText(article.url);
    const title = normalizeTitle(article.title);
    if (urls.has(url) || (title && titles.has(title))) continue;
    urls.add(url);
    if (title) titles.add(title);
    result.push(article);
  }
  return result;
}

// Simple near-duplicate clustering: compare normalized title token overlap.
// This catches stories with slightly different headlines about the same event.
function removeNearDuplicates(articles) {
  const kept = [];
  const tokenSet = title => new Set(normalizeTitle(title).split(' ').filter(t => t.length > 2));
  const overlap = (a, b) => {
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const token of a) if (b.has(token)) common++;
    return common / Math.min(a.size, b.size);
  };

  for (const article of articles) {
    const current = tokenSet(article.title);
    const duplicate = kept.some(existing => overlap(current, tokenSet(existing.title)) >= 0.78);
    if (!duplicate) kept.push(article);
  }
  return kept;
}

function rankArticles(articles, category) {
  const scored = articles.map((article, index) => ({
    article,
    score: relevanceScore(article, category),
    index,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const bt = Date.parse(b.article.publishedAt || '') || 0;
    const at = Date.parse(a.article.publishedAt || '') || 0;
    if (bt !== at) return bt - at;
    return a.index - b.index;
  });

  // Source diversity: don't allow one publisher to dominate the final ten.
  const result = [];
  const sourceCounts = new Map();
  const deferred = [];

  for (const item of scored) {
    const source = sourceName(item.article);
    const count = sourceCounts.get(source) || 0;
    if (count >= 2) {
      deferred.push(item);
      continue;
    }
    result.push(item.article);
    sourceCounts.set(source, count + 1);
    if (result.length >= RETURN_COUNT) return result;
  }

  for (const item of deferred) {
    const source = sourceName(item.article);
    const count = sourceCounts.get(source) || 0;
    if (count >= 3) continue;
    result.push(item.article);
    sourceCounts.set(source, count + 1);
    if (result.length >= RETURN_COUNT) break;
  }

  return result;
}

async function fetchNews(category, lang) {
  const key = process.env.NEWSAPI_KEY;
  if (!key || key.includes('your_newsapi_key')) {
    throw new Error('NEWSAPI_KEY not configured — add a real key to the environment.');
  }

  const cacheKey = `news:v2:${category}:${lang}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const query = CATEGORY_QUERIES[lang]?.[category] || CATEGORY_QUERIES[lang]?.trending;
  const params = new URLSearchParams({
    q: query,
    language: lang,
    sortBy: 'publishedAt',
    pageSize: String(PAGE_SIZE),
    apiKey: key,
  });

  const res = await fetch(`https://newsapi.org/v2/everything?${params.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'BURBREEK/1.0' },
    timeout: 10000,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NewsAPI error ${res.status}: ${body}`);
  }

  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'NewsAPI returned an unsuccessful response.');

  const cleaned = dedupeByUrlAndTitle(data.articles || []);
  const clustered = removeNearDuplicates(cleaned);
  const ranked = rankArticles(clustered, category);

  const mapped = ranked.map(article => ({
    tag: category.toUpperCase(),
    headline: cleanText(article.title),
    dek: cleanText(article.description),
    source: sourceName(article),
    url: article.url,
    time: article.publishedAt || null,
    imageUrl: article.urlToImage || null,
  }));

  cache.set(cacheKey, mapped, CACHE_TTL_SECONDS);
  return mapped;
}

router.get('/:category', async (req, res) => {
  try {
    const category = String(req.params.category || 'trending').toLowerCase().trim();
    const lang = getLanguage(req);
    const articles = await fetchNews(category, lang);

    res.json({
      category,
      language: lang,
      articles,
      count: articles.length,
      source: 'NewsAPI + BURBREEK Quality v2',
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[news] ${req.params.category}`, err.message);
    res.status(502).json({ error: 'Unable to fetch news', details: err.message });
  }
});

module.exports = router;
