const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

const CACHE_TTL_SECONDS = 900; // 15 minutes
const REQUEST_TIMEOUT_MS = 12000;
const USER_AGENT = 'BURBREEK/1.0 (https://burbreek.com)';

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeName(value).replace(/\s+/g, '-');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent': USER_AGENT
      }
    });

    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function parseGoodreturnsPrice(text, fuel, city) {
  const fuelWord = fuel === 'petrol' ? 'petrol' : 'diesel';
  const cityWord = String(city || '').trim();

  // Goodreturns currently exposes a sentence like:
  // "Today's petrol price in Jaipur is at ₹113.50 per litre"
  const direct = new RegExp(
    `Today's\\s+${fuelWord}\\s+price\\s+in[\\s\\S]{0,160}?\\bis\\
\\s+at\\s+₹\\s*([0-9]{2,3}(?:\\.[0-9]{1,2})?)`,
    'i'
  );
  const directMatch = text.match(direct);
  if (directMatch) return number(directMatch[1]);

  // Fallback: locate the H1 and first rupee value nearby.
  const heading = new RegExp(`${fuelWord}\\s+price\\s+in\\s+${cityWord.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`, 'i');
  const headingMatch = text.match(heading);
  if (headingMatch && headingMatch.index != null) {
    const segment = text.slice(headingMatch.index, headingMatch.index + 900);
    const values = [...segment.matchAll(/₹\s*([0-9]{2,3}(?:\.[0-9]{1,2})?)/g)];
    if (values.length) return number(values[0][1]);
  }

  return null;
}

function parseDateLabel(text) {
  const patterns = [
    /([0-9]{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+,?\s+202[0-9])/i,
    /([A-Za-z]+\s+[0-9]{1,2},\s+202[0-9])/i
  ];
  for (const re of patterns) {
    const m = String(text || '').match(re);
    if (!m) continue;
    const cleaned = m[1].replace(/(\d+)(st|nd|rd|th)/i, '$1');
    const d = new Date(cleaned + 'T06:00:00+05:30');
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function buildFuelItem(city, fuel, price, sourceUrl, checkedAt, sourceUpdatedAt) {
  if (price === null) return { status: 'unavailable' };
  return {
    status: 'ok',
    city,
    price,
    unit: 'per_litre',
    unitLabel: 'Per litre',
    provider: 'Goodreturns',
    source: 'Goodreturns',
    updatedAt: sourceUpdatedAt || checkedAt,
    checkedAt,
    sourceUrl
  };
}

async function fetchGoodreturns(city) {
  if (!city) throw new Error('City is required');

  const citySlug = slugify(city);
  const petrolUrl = `https://www.goodreturns.in/petrol-price-in-${citySlug}.html`;
  const dieselUrl = `https://www.goodreturns.in/diesel-price-in-${citySlug}.html`;
  const checkedAt = new Date().toISOString();

  const [petrolResult, dieselResult] = await Promise.allSettled([
    fetchText(petrolUrl),
    fetchText(dieselUrl)
  ]);

  let petrol = null;
  let diesel = null;
  let petrolUpdatedAt = null;
  let dieselUpdatedAt = null;
  let petrolError = null;
  let dieselError = null;

  if (petrolResult.status === 'fulfilled') {
    const text = htmlToText(petrolResult.value);
    petrol = parseGoodreturnsPrice(text, 'petrol', city);
    petrolUpdatedAt = parseDateLabel(text);
    if (petrol === null) petrolError = 'Petrol price not found on Goodreturns page';
  } else {
    petrolError = petrolResult.reason?.message || 'Petrol page request failed';
  }

  if (dieselResult.status === 'fulfilled') {
    const text = htmlToText(dieselResult.value);
    diesel = parseGoodreturnsPrice(text, 'diesel', city);
    dieselUpdatedAt = parseDateLabel(text);
    if (diesel === null) dieselError = 'Diesel price not found on Goodreturns page';
  } else {
    dieselError = dieselResult.reason?.message || 'Diesel page request failed';
  }

  if (petrol === null && diesel === null) {
    throw new Error(`Goodreturns failed. Petrol: ${petrolError || 'unknown'}; Diesel: ${dieselError || 'unknown'}`);
  }

  // Use one source-level timestamp only when both pages agree; otherwise use
  // the individual source timestamp on each item and checkedAt at top level.
  const sourceUpdatedAt = petrolUpdatedAt && petrolUpdatedAt === dieselUpdatedAt
    ? petrolUpdatedAt
    : (petrolUpdatedAt || dieselUpdatedAt || checkedAt);

  return {
    city,
    petrol: buildFuelItem(city, 'petrol', petrol, petrolUrl, checkedAt, petrolUpdatedAt || sourceUpdatedAt),
    diesel: buildFuelItem(city, 'diesel', diesel, dieselUrl, checkedAt, dieselUpdatedAt || sourceUpdatedAt),
    source: 'Goodreturns',
    updatedAt: sourceUpdatedAt,
    checkedAt,
    sourceUrls: {
      petrol: petrolUrl,
      diesel: dieselUrl
    }
  };
}

async function reverseGeocodeNominatim(lat, lon) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('zoom', '10');
  url.searchParams.set('addressdetails', '1');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const data = JSON.parse(body);
    const a = data?.address || {};
    const city = a.city || a.town || a.municipality || a.county || '';
    const state = a.state || '';
    return { city: String(city || '').trim(), state: String(state || '').trim(), provider: 'Nominatim' };
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocodePhoton(lat, lon) {
  const url = new URL('https://photon.komoot.io/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('lang', 'en');
  url.searchParams.set('limit', '1');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
    const data = JSON.parse(body);
    const p = data?.features?.[0]?.properties || {};
    const city = p.city || p.town || p.municipality || p.county || '';
    const state = p.state || '';
    return { city: String(city || '').trim(), state: String(state || '').trim(), provider: 'Photon' };
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocode(lat, lon) {
  try {
    const result = await reverseGeocodeNominatim(lat, lon);
    if (result.city) return result;
  } catch (err) {
    console.warn('[fuel] Nominatim failed:', err.message);
  }

  const result = await reverseGeocodePhoton(lat, lon);
  if (!result.city) throw new Error('Unable to determine city from coordinates');
  return result;
}

router.get('/', async (req, res) => {
  const lat = number(req.query.lat);
  const lon = number(req.query.lon);
  let city = String(req.query.city || '').trim();
  let state = String(req.query.state || '').trim();

  if (lat === null && lon === null && !city) {
    return res.status(400).json({
      error: 'Location required',
      details: 'Pass ?city=Jaipur or confirmed latitude/longitude.'
    });
  }

  if ((lat !== null || lon !== null) &&
      (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  try {
    let locationResolver = null;

    if (!city && lat !== null && lon !== null) {
      const geo = await reverseGeocode(lat, lon);
      city = geo.city;
      state = state || geo.state;
      locationResolver = geo.provider;
    }

    if (!city) {
      return res.status(422).json({ error: 'City could not be determined' });
    }

    // Goodreturns uses the city only; state is retained only for diagnostics.
    const cacheKey = `fuel:v6:${normalizeName(city)}:${normalizeName(state)}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await fetchGoodreturns(city);
    if (locationResolver) result.locationResolver = locationResolver;
    if (state) result.state = state;

    cache.set(cacheKey, result, CACHE_TTL_SECONDS);
    return res.json(result);
  } catch (err) {
    console.error('[fuel]', err.stack || err.message || err);
    return res.status(502).json({
      error: 'Unable to fetch live fuel prices',
      details: err.message || 'Fuel provider is temporarily unavailable.'
    });
  }
});

module.exports = router;
