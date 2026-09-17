const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

const CACHE_TTL_SECONDS = 900; // 15 minutes
const REQUEST_TIMEOUT_MS = 12000;
const NOMINATIM_USER_AGENT = 'BURBREEK/1.0 (burbreek.com)';

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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/h[1-6]>/gi, '\n')
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

async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'User-Agent': NOMINATIM_USER_AGENT,
        ...headers
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocode(lat, lon) {
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
      headers: {
        Accept: 'application/json',
        'User-Agent': NOMINATIM_USER_AGENT
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Nominatim HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }

    const data = await res.json();
    const address = data?.address || {};
    const city =
      address.city ||
      address.town ||
      address.municipality ||
      address.county ||
      address.state_district ||
      address.city_district ||
      '';
    const state = address.state || address.state_district || '';
    const country = address.country || '';

    return {
      city: city ? String(city).trim() : null,
      state: state ? String(state).trim() : null,
      country: country ? String(country).trim() : null
    };
  } finally {
    clearTimeout(timer);
  }
}

function parsePriceAfterLabel(text, label) {
  const re = new RegExp(`${escapeRegex(label)}[\\s\\S]{0,120}?₹\\s*([0-9]{2,3}(?:\\.[0-9]{1,2})?)`, 'i');
  const match = text.match(re);
  return match ? number(match[1]) : null;
}

function parseUpdatedAt(text) {
  const patterns = [
    /Prices were last updated on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i,
    /Updated\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const d = new Date(match[1] + ' GMT+0530');
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

function buildResult(city, petrol, diesel, source, updatedAt, sourceUrl) {
  const cityLabel = city || 'Local city';
  const stamp = updatedAt || new Date().toISOString();

  return {
    city: cityLabel,
    petrol: petrol !== null ? {
      status: 'ok',
      city: cityLabel,
      price: petrol,
      unit: 'per_litre',
      unitLabel: 'Per litre',
      provider: source,
      source,
      updatedAt: stamp,
      sourceUrl
    } : { status: 'unavailable' },
    diesel: diesel !== null ? {
      status: 'ok',
      city: cityLabel,
      price: diesel,
      unit: 'per_litre',
      unitLabel: 'Per litre',
      provider: source,
      source,
      updatedAt: stamp,
      sourceUrl
    } : { status: 'unavailable' },
    source,
    updatedAt: stamp,
    sourceUrl
  };
}

async function fetchFromTodayPetrolPrice(city, state) {
  if (!city) throw new Error('City is required');

  const stateSlug = state ? slugify(state) : null;
  if (stateSlug) {
    const cityUrl = `https://todaypetrolprice.in/petrol-price-in-${slugify(city)}-${stateSlug}/`;
    try {
      const html = await fetchText(cityUrl);
      const text = htmlToText(html);
      const petrol = parsePriceAfterLabel(text, 'Petrol Price');
      const diesel = parsePriceAfterLabel(text, 'Diesel Price');
      if (petrol !== null || diesel !== null) {
        return buildResult(city, petrol, diesel, 'TodayPetrolPrice.in', parseUpdatedAt(text), cityUrl);
      }
    } catch (err) {
      console.warn('[fuel] city page failed:', cityUrl, err.message);
    }

    const stateUrl = `https://todaypetrolprice.in/petrol-price-in-${stateSlug}/`;
    const html = await fetchText(stateUrl);
    const text = htmlToText(html);
    const cityRe = escapeRegex(city).replace(/\\ /g, '\\s+');
    const rowRe = new RegExp(`${cityRe}\\s*\\|\\s*₹\\s*([0-9]{2,3}(?:\\.[0-9]{1,2})?)\\s*\\|\\s*₹\\s*([0-9]{2,3}(?:\\.[0-9]{1,2})?)`, 'i');
    const row = text.match(rowRe);
    if (!row) throw new Error('City row not found on state fuel page');
    return buildResult(
      city,
      number(row[1]),
      number(row[2]),
      'TodayPetrolPrice.in',
      parseUpdatedAt(text),
      stateUrl
    );
  }

  throw new Error('State is required for TodayPetrolPrice lookup');
}

async function fetchFromFuelPriceToday(city) {
  if (!city) throw new Error('City is required');

  const url = `https://www.fuelpricetoday.in/${slugify(city)}/`;
  const html = await fetchText(url);
  const text = htmlToText(html);

  const petrol = parsePriceAfterLabel(text, 'Petrol');
  const diesel = parsePriceAfterLabel(text, 'Diesel');

  if (petrol === null && diesel === null) {
    throw new Error('No petrol/diesel values found on FuelPriceToday page');
  }

  return buildResult(city, petrol, diesel, 'FuelPriceToday.in', parseUpdatedAt(text), url);
}

async function fetchLiveFuel(city, state) {
  try {
    return await fetchFromTodayPetrolPrice(city, state);
  } catch (primaryErr) {
    console.warn('[fuel] TodayPetrolPrice failed:', primaryErr.message);
    try {
      return await fetchFromFuelPriceToday(city);
    } catch (fallbackErr) {
      throw new Error(`Primary source: ${primaryErr.message}; fallback source: ${fallbackErr.message}`);
    }
  }
}

router.get('/', async (req, res) => {
  const lat = number(req.query.lat);
  const lon = number(req.query.lon);
  const suppliedCity = String(req.query.city || '').trim();
  const suppliedState = String(req.query.state || '').trim();

  if (lat === null && lon === null && !suppliedCity) {
    return res.status(400).json({
      error: 'Location required',
      details: 'Pass confirmed latitude/longitude or a city.'
    });
  }

  if (
    (lat !== null || lon !== null) &&
    (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180)
  ) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  try {
    let city = suppliedCity;
    let state = suppliedState;

    if ((!city || !state) && lat !== null && lon !== null) {
      const geo = await reverseGeocode(lat, lon);
      city = city || geo.city;
      state = state || geo.state;
    }

    if (!city) {
      return res.status(422).json({
        error: 'City could not be determined',
        details: 'Pass ?city=Jaipur&state=Rajasthan when reverse geocoding is unavailable.'
      });
    }

    const cacheKey = `fuel:v2:${normalizeName(city)}:${normalizeName(state || '')}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await fetchLiveFuel(city, state);
    cache.set(cacheKey, result, CACHE_TTL_SECONDS);

    return res.json(result);
  } catch (err) {
    console.error('[fuel]', err.stack || err.message || err);
    return res.status(502).json({
      error: 'Unable to fetch live fuel prices',
      details: 'Fuel provider is temporarily unavailable.'
    });
  }
});

module.exports = router;
