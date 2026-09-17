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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function fetchResponse(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'User-Agent': USER_AGENT,
        ...headers
      }
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, headers = {}) {
  const res = await fetchResponse(url, headers);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
  return res.text();
}

async function reverseGeocodeNominatim(lat, lon) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('zoom', '10');
  url.searchParams.set('addressdetails', '1');

  const res = await fetchResponse(url.toString(), {
    Accept: 'application/json',
    'User-Agent': USER_AGENT
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Nominatim HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }

  const data = await res.json();
  const address = data?.address || {};

  // Prefer actual city/town/municipality fields. Do not use suburb or
  // city_district as the fuel city, because Jaipur locations can resolve to
  // neighbourhoods such as Jagatpura while the fuel source is city-level.
  const city =
    address.city ||
    address.town ||
    address.municipality ||
    address.village ||
    '';

  const state = address.state || '';
  const country = address.country || '';

  return {
    city: city ? String(city).trim() : null,
    state: state ? String(state).trim() : null,
    country: country ? String(country).trim() : null,
    provider: 'Nominatim'
  };
}

async function reverseGeocodePhoton(lat, lon) {
  const url = new URL('https://photon.komoot.io/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('lang', 'en');
  url.searchParams.set('limit', '1');

  const res = await fetchResponse(url.toString(), {
    Accept: 'application/json',
    'User-Agent': USER_AGENT
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Photon HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }

  const data = await res.json();
  const props = data?.features?.[0]?.properties || {};
  const city = props.city || props.town || props.municipality || props.county || '';
  const state = props.state || '';
  const country = props.country || '';

  return {
    city: city ? String(city).trim() : null,
    state: state ? String(state).trim() : null,
    country: country ? String(country).trim() : null,
    provider: 'Photon'
  };
}

async function reverseGeocode(lat, lon) {
  try {
    const primary = await reverseGeocodeNominatim(lat, lon);
    if (primary.city) return primary;
    console.warn('[fuel] Nominatim returned no city, trying Photon');
  } catch (err) {
    console.warn('[fuel] Nominatim reverse geocode failed:', err.message);
  }

  try {
    const fallback = await reverseGeocodePhoton(lat, lon);
    if (fallback.city) return fallback;
    throw new Error('Photon returned no city');
  } catch (err) {
    console.warn('[fuel] Photon reverse geocode failed:', err.message);
    throw new Error('Unable to determine city from coordinates');
  }
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

function firstCurrencyInSegment(text, startIndex, maxChars = 120) {
  if (startIndex < 0) return null;
  const segment = text.slice(startIndex, startIndex + maxChars);
  const match = segment.match(/₹\s*([0-9]{2,3}(?:\.[0-9]{1,2})?)/);
  return match ? number(match[1]) : null;
}

function parseHeroPrices(text) {
  const petrolLabel = text.search(/Petrol Price/i);
  const dieselLabel = text.search(/Diesel Price/i);

  const petrol = firstCurrencyInSegment(text, petrolLabel, 90);
  const diesel = firstCurrencyInSegment(text, dieselLabel, 90);

  if (petrol !== null || diesel !== null) return { petrol, diesel };

  // Last-resort fallback: the city page's hero block normally contains
  // current petrol, previous petrol, current diesel, previous diesel.
  const hero = text.split(/Frequently Asked Questions|Understanding Fuel Prices/i)[0];
  const values = [...hero.matchAll(/₹\s*([0-9]{2,3}(?:\.[0-9]{1,2})?)/g)]
    .map(m => number(m[1]))
    .filter(v => v !== null);

  return {
    petrol: values[0] ?? null,
    diesel: values[2] ?? null
  };
}

function buildResult(city, petrol, diesel, source, updatedAt, sourceUrl, geoProvider = null) {
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
    sourceUrl,
    ...(geoProvider ? { locationResolver: geoProvider } : {})
  };
}

async function fetchFromTodayPetrolPrice(city, state) {
  if (!city) throw new Error('City is required');
  if (!state) throw new Error('State is required for TodayPetrolPrice lookup');

  const stateSlug = slugify(state);
  const citySlug = slugify(city);
  const cityUrl = `https://todaypetrolprice.in/petrol-price-in-${citySlug}-${stateSlug}/`;

  try {
    const html = await fetchText(cityUrl);
    const text = htmlToText(html);
    const prices = parseHeroPrices(text);

    if (prices.petrol !== null || prices.diesel !== null) {
      return buildResult(
        city,
        prices.petrol,
        prices.diesel,
        'TodayPetrolPrice.in',
        parseUpdatedAt(text),
        cityUrl
      );
    }

    throw new Error('Petrol/diesel hero prices not found on city page');
  } catch (cityErr) {
    console.warn('[fuel] city page failed:', cityUrl, cityErr.message);

    // State page fallback. This expects a row like:
    // Jaipur | ₹113.50 | ₹98.50
    const stateUrl = `https://todaypetrolprice.in/petrol-price-in-${stateSlug}/`;
    const html = await fetchText(stateUrl);
    const text = htmlToText(html);
    const cityRe = escapeRegex(city).replace(/\\ /g, '\\s+');
    const rowRe = new RegExp(
      `${cityRe}\\s*\\|\\s*₹\\s*([0-9]{2,3}(?:\\.[0-9]{1,2})?)\\s*\\|\\s*₹\\s*([0-9]{2,3}(?:\\.[0-9]{1,2})?)`,
      'i'
    );
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
}

async function fetchFromFuelPriceToday(city) {
  if (!city) throw new Error('City is required');

  const url = `https://www.fuelpricetoday.in/${slugify(city)}/`;
  const html = await fetchText(url);
  const text = htmlToText(html);

  const petrol = firstCurrencyInSegment(text, text.search(/Petrol/i), 140);
  const diesel = firstCurrencyInSegment(text, text.search(/Diesel/i), 140);

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
    let locationResolver = null;

    if ((!city || !state) && lat !== null && lon !== null) {
      const geo = await reverseGeocode(lat, lon);
      city = city || geo.city;
      state = state || geo.state;
      locationResolver = geo.provider;
    }

    if (!city) {
      return res.status(422).json({
        error: 'City could not be determined',
        details: 'Pass ?city=Jaipur&state=Rajasthan when reverse geocoding is unavailable.'
      });
    }

    if (!state) {
      return res.status(422).json({
        error: 'State could not be determined',
        details: 'Pass ?city=Jaipur&state=Rajasthan when reverse geocoding returns no state.'
      });
    }

    const cacheKey = `fuel:v3:${normalizeName(city)}:${normalizeName(state)}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await fetchLiveFuel(city, state);
    if (locationResolver) result.locationResolver = locationResolver;

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
