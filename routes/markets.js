const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

// Yahoo Finance chart symbols. The chart endpoint is free and does not
// require an API key. It is an unofficial/undocumented endpoint, so keep
// this provider isolated behind /api/markets and retain a short cache.
const SYMBOLS = {
  nifty: '^NSEI',
  sensex: '^BSESN',
  banknifty: '^NSEBANK',
  nasdaq: '^IXIC',
  reliance: 'RELIANCE.NS',
  dmart: 'DMART.NS',
};

const NAMES = {
  nifty: 'NIFTY 50',
  sensex: 'SENSEX',
  banknifty: 'BANK NIFTY',
  nasdaq: 'NASDAQ',
  reliance: 'RELIANCE',
  dmart: 'DMART',
};

const CACHE_TTL_SECONDS = 60;

async function fetchQuote(symbolKey) {
  const symbol = SYMBOLS[symbolKey];
  if (!symbol) throw new Error(`Unknown symbol key: ${symbolKey}`);

  const cacheKey = `yahoo:quote:${symbolKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(symbol)}?interval=1m&range=1d&events=history`;

  const res = await fetch(url, {
    headers: {
      // Yahoo may reject generic Node clients. Use a normal browser UA.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
    },
    timeout: 10000,
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance HTTP ${res.status}`);
  }

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const error = data?.chart?.error;

  if (!result) {
    throw new Error(error?.description || `No market data returned for ${symbol}`);
  }

  const meta = result.meta || {};
  const price = Number(meta.regularMarketPrice ?? meta.previousClose);
  const previousClose = Number(meta.previousClose);

  if (!Number.isFinite(price)) {
    throw new Error(`Invalid price returned for ${symbol}`);
  }

  // Yahoo's chart metadata normally includes regularMarketChangePercent,
  // but calculate it from previousClose when that field is unavailable.
  let changePercent = Number(meta.regularMarketChangePercent);
  if (!Number.isFinite(changePercent) && Number.isFinite(previousClose) && previousClose !== 0) {
    changePercent = ((price - previousClose) / previousClose) * 100;
  }
  if (!Number.isFinite(changePercent)) changePercent = 0;

  const mapped = {
    symbol: symbolKey,
    ticker: symbol,
    name: NAMES[symbolKey] || meta.longName || meta.shortName || symbolKey,
    price,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    changePercent,
    currency: meta.currency || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    marketState: meta.marketState || null,
    asOf: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : null,
    source: 'Yahoo Finance',
  };

  cache.set(cacheKey, mapped, CACHE_TTL_SECONDS);
  return mapped;
}

router.get('/', async (req, res) => {
  const keys = Object.keys(SYMBOLS);

  const quotes = await Promise.all(
    keys.map((key) =>
      fetchQuote(key).catch((err) => ({
        symbol: key,
        error: err.message,
      }))
    )
  );

  const successful = quotes.filter((q) => !q.error).length;

  // Keep the endpoint usable if one provider symbol is temporarily
  // unavailable. Return 200 with per-symbol errors so the frontend can
  // update whichever quotes succeeded.
  res.json({
    quotes,
    source: 'Yahoo Finance',
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    updatedAt: new Date().toISOString(),
    partial: successful !== quotes.length,
  });
});

module.exports = router;
