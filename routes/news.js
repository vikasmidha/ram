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
    trending: '(India OR Indian OR world OR government OR economy OR business OR technology OR geopolitics)',
    startup: '(startup OR startups OR founder OR entrepreneurship) AND India',
    funding: '("funding round" OR "raised funding" OR investment OR investors OR valuation) AND (startup OR company)',
    ai: '("artificial intelligence" OR "AI model" OR "generative AI" OR "machine learning" OR LLM)',
    politics: '(parliament OR government OR election OR minister OR policy OR court) AND India',
    gtk: '(explainer OR "what you need to know" OR explained OR "how it works") AND India',
  },
  hi: {
    trending: '(भारत OR भारतीय OR दुनिया OR समाचार OR खबर OR सरकार OR अर्थव्यवस्था OR व्यापार OR तकनीक OR भू-राजनीति)',
    startup: '(स्टार्टअप OR उद्यमिता OR उद्यमी) AND भारत',
    funding: '(फंडिंग OR निवेश OR निवेशक OR पूंजी OR वैल्यूएशन) AND (स्टार्टअप OR कंपनी)',
    ai: '("कृत्रिम बुद्धिमत्ता" OR एआई OR "आर्टिफिशियल इंटेलिजेंस" OR "मशीन लर्निंग")',
    politics: '(संसद OR सरकार OR चुनाव OR मंत्री OR नीति OR अदालत) AND भारत',
    gtk: '(समझिए OR समझाया OR "क्या है" OR "कैसे काम करता है") AND भारत',
  },
};

const SOURCE_TIERS = {
  3: new Set([
    'Reuters', 'BBC News', 'Associated Press', 'The Hindu', 'The Indian Express',
    'Hindustan Times', 'The Times of India', 'NDTV', 'News18', 'India Today',
    'Aajtak.in', 'Moneycontrol', 'CNBC-TV18', 'Economic Times', 'The Economic Times',
    'Mint', 'Business Standard', 'ANI', 'PTI', 'The Telegraph', 'Financial Times',
    'Bloomberg', 'The Guardian', 'CNN', 'NPR', 'Al Jazeera', 'Yale.edu', 'MIT News',
    'NASA', 'WHO', 'United Nations',
  ]),
  2: new Set([
    'TechCrunch', 'Wired', 'The Verge', 'Forbes', 'Fortune', 'CNBC', 'MarketWatch',
    'VentureBeat', 'Ars Technica', 'The Register', 'The Information', 'Axios',
    'Foreign Policy', 'Politico', 'Euronews', 'DW', 'Nikkei Asia',
  ]),
};

const HARD_EXCLUDE_PATTERNS = [
  /\/short-videos?\//i, /\/video\//i, /\/videos?\//i, /\/podcast/i,
  /\/sounds\//i, /\/comics?\//i, /\/live-blog/i, /\/liveblog/i,
];

const HARD_EXCLUDE_TEXT = [
  /guest contribution/i, /sponsored/i, /advertorial/i, /press release/i,
  /promoted content/i, /coupon/i, /horoscope/i,
];

const CATEGORY_TERMS = {
  trending: {
    positive: ['india', 'indian', 'government', 'parliament', 'economy', 'business', 'technology', 'world', 'global', 'policy', 'trade', 'oil', 'market', 'brics', 'geopolitic'],
    negative: ['football', 'soccer', 'nba', 'cricket', 'ballon', 'movie', 'movies', 'celebrity', 'comics', 'comic', 'podcast', 'playlist', 'fashion', 'gaming', 'gaming news'],
  },
  startup: {
    positive: ['startup', 'startups', 'founder', 'funding', 'venture', 'venture capital', 'entrepreneur', 'entrepreneurship', 'innovation', 'company'],
    negative: ['football', 'cricket', 'movie', 'celebrity', 'comics', 'podcast'],
  },
  funding: {
    positive: ['funding', 'raised', 'investment', 'investor', 'investors', 'valuation', 'venture capital', 'series a', 'series b', 'capital'],
    negative: ['football', 'cricket', 'movie', 'celebrity', 'comics', 'podcast'],
  },
  ai: {
    positive: ['artificial intelligence', ' ai ', 'ai model', 'generative ai', 'machine learning', 'llm', 'openai', 'anthropic', 'deepmind', 'nvidia', 'robotics', 'semiconductor', 'chip'],
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

const TOPIC_GROUPS = [
  { name: 'brics', terms: ['brics', 'global south', 'xi jinping', 'putin'] },
  { name: 'ai', terms: ['artificial intelligence', 'generative ai', 'ai model', 'machine learning', 'anthropic', 'openai', 'llm'] },
  { name: 'markets', terms: ['stock market', 'shares', 'nifty', 'sensex', 'federal reserve', 'interest rate', 'bond', 'wall street'] },
  { name: 'energy', terms: ['crude oil', 'oil price', 'brent', 'natural gas', 'energy supply'] },
  { name: 'politics', terms: ['parliament', 'election', 'government', 'minister', 'policy', 'president', 'prime minister'] },
  { name: 'business', terms: ['company', 'business', 'trade', 'exports', 'imports', 'investment'] },
  { name: 'climate', terms: ['climate', 'global warming', 'emissions', 'weather', 'environment'] },
];

function getLanguage(req) {
  const lang = String(req.query.lang || 'en').toLowerCase().trim();
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en';
}

function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalizeTitle(value) {
  return cleanText(value).toLowerCase().replace(/&nbsp;/g, ' ').replace(/[^a-z0-9\u0900-\u097f]+/gi, ' ').trim();
}
function articleText(article) { return ` ${cleanText(article.title)} ${cleanText(article.description)} `.toLowerCase(); }
function sourceName(article) { return cleanText(article.source?.name) || 'Unknown'; }
function hoursOld(publishedAt) {
  const ts = Date.parse(publishedAt || '');
  if (!Number.isFinite(ts)) return 72;
  return Math.max(0, (Date.now() - ts) / 36e5);
}
function sourceTier(source) {
  if (SOURCE_TIERS[3].has(source)) return 3;
  if (SOURCE_TIERS[2].has(source)) return 2;
  if (/biztoc|guru.?focus|cryptobriefing|dailyhodl|globenewswire|prnewswire/i.test(source)) return 1;
  return 1;
}
function topicGroup(article) {
  const text = articleText(article);
  for (const group of TOPIC_GROUPS) {
    if (group.terms.some(term => text.includes(term))) return group.name;
  }
  return 'other';
}
function isValidArticle(article) {
  if (!article || !article.title || !article.url) return false;
  const title = cleanText(article.title);
  const description = cleanText(article.description);
  if (!title || /^\[removed\]$/i.test(title)) return false;
  if (HARD_EXCLUDE_PATTERNS.some(re => re.test(article.url))) return false;
  if (HARD_EXCLUDE_TEXT.some(re => re.test(`${title} ${description}`))) return false;
  return true;
}
function dedupeByUrlAndTitle(articles) {
  const urls = new Set(); const titles = new Set(); const result = [];
  for (const article of articles) {
    if (!isValidArticle(article)) continue;
    const url = cleanText(article.url);
    const title = normalizeTitle(article.title);
    if (urls.has(url) || (title && titles.has(title))) continue;
    urls.add(url); if (title) titles.add(title); result.push(article);
  }
  return result;
}
function removeNearDuplicates(articles) {
  const kept = [];
  const tokenSet = title => new Set(normalizeTitle(title).split(' ').filter(t => t.length > 2));
  const overlap = (a, b) => {
    if (!a.size || !b.size) return 0;
    let common = 0; for (const token of a) if (b.has(token)) common++;
    return common / Math.min(a.size, b.size);
  };
  for (const article of articles) {
    const current = tokenSet(article.title);
    if (!kept.some(existing => overlap(current, tokenSet(existing.title)) >= 0.78)) kept.push(article);
  }
  return kept;
}
function relevanceScore(article, category) {
  const text = articleText(article);
  const terms = CATEGORY_TERMS[category] || CATEGORY_TERMS.trending;
  let score = 0;
  for (const term of terms.positive) if (text.includes(term.toLowerCase())) score += 5;
  for (const term of terms.negative) if (text.includes(term.toLowerCase())) score -= 20;
  if (/\bindia\b|\bindian\b|भारत|भारतीय/i.test(text)) score += 12;
  const tier = sourceTier(sourceName(article));
  score += tier === 3 ? 7 : tier === 2 ? 3 : 0;
  const age = hoursOld(article.publishedAt);
  if (age <= 6) score += 8; else if (age <= 24) score += 5; else if (age <= 48) score += 1; else if (age > 96) score -= 8;
  const desc = cleanText(article.description);
  if (desc.length >= 80) score += 3; if (desc.length < 25) score -= 3;
  if (/opinion|commentary|editorial|analysis/i.test(`${article.title} ${desc}`)) score -= 8;
  if (/biztoc|guru.?focus|cryptobriefing|dailyhodl/i.test(sourceName(article))) score -= 10;
  return score;
}
function rankArticles(articles, category) {
  const scored = articles.map((article, index) => ({ article, score: relevanceScore(article, category), index, topic: topicGroup(article) }));
  scored.sort((a,b) => b.score - a.score || (Date.parse(b.article.publishedAt||'')||0) - (Date.parse(a.article.publishedAt||'')||0) || a.index-b.index);
  const result = []; const sourceCounts = new Map(); const topicCounts = new Map();
  // First pass: maximize useful source/topic diversity without excluding strong stories forever.
  for (const item of scored) {
    const source = sourceName(item.article); const topic = item.topic;
    const sc = sourceCounts.get(source) || 0; const tc = topicCounts.get(topic) || 0;
    if (sc >= 2 || tc >= 2) continue;
    result.push(item.article); sourceCounts.set(source, sc+1); topicCounts.set(topic, tc+1);
    if (result.length >= RETURN_COUNT) return result;
  }
  // Second pass fills remaining slots, still preventing one source from dominating.
  for (const item of scored) {
    if (result.includes(item.article)) continue;
    const source = sourceName(item.article); const sc = sourceCounts.get(source) || 0;
    if (sc >= 3) continue;
    result.push(item.article); sourceCounts.set(source, sc+1);
    if (result.length >= RETURN_COUNT) break;
  }
  return result;
}

async function fetchNews(category, lang) {
  const key = process.env.NEWSAPI_KEY;
  if (!key || key.includes('your_newsapi_key')) throw new Error('NEWSAPI_KEY not configured — add a real key to the environment.');
  const cacheKey = `news:v3:${category}:${lang}`;
  const cached = cache.get(cacheKey); if (cached) return cached;
  const query = CATEGORY_QUERIES[lang]?.[category] || CATEGORY_QUERIES[lang]?.trending;
  const params = new URLSearchParams({ q: query, language: lang, sortBy: 'publishedAt', pageSize: String(PAGE_SIZE), apiKey: key });
  const res = await fetch(`https://newsapi.org/v2/everything?${params.toString()}`, { headers: { Accept: 'application/json', 'User-Agent': 'BURBREEK/1.0' }, timeout: 10000 });
  if (!res.ok) throw new Error(`NewsAPI error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'NewsAPI returned an unsuccessful response.');
  const ranked = rankArticles(removeNearDuplicates(dedupeByUrlAndTitle(data.articles || [])), category);
  const mapped = ranked.map(article => ({ tag: category.toUpperCase(), headline: cleanText(article.title), dek: cleanText(article.description), source: sourceName(article), url: article.url, time: article.publishedAt || null, imageUrl: article.urlToImage || null }));
  cache.set(cacheKey, mapped, CACHE_TTL_SECONDS); return mapped;
}

router.get('/:category', async (req, res) => {
  try {
    const category = String(req.params.category || 'trending').toLowerCase().trim();
    const lang = getLanguage(req); const articles = await fetchNews(category, lang);
    res.json({ category, language: lang, articles, count: articles.length, source: 'NewsAPI + BURBREEK Quality v3', cacheTtlSeconds: CACHE_TTL_SECONDS, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`[news] ${req.params.category}`, err.message);
    res.status(502).json({ error: 'Unable to fetch news', details: err.message });
  }
});

module.exports = router;
