const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

const CACHE_TTL_SECONDS = 900;
const REQUEST_TIMEOUT_MS = 12000;
const NOMINATIM_USER_AGENT = 'BURBREEK/1.0 (burbreek.com)';

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCity(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...headers
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }

    return await res.json();
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

  const data = await fetchJson(url.toString(), {
    'User-Agent': NOMINATIM_USER_AGENT
  });

  const address = data?.address || {};
  const city =
    address.city ||
    address.town ||
    address.municipality ||
    address.city_district ||
    address.county ||
    '';

  return city ? String(city).trim() : null;
}

async function fetchFuelFromApiMitra(city) {
  const apiUrl = new URL('https://api.apimitra.in/fuel');
  apiUrl.searchParams.set('city', city);

  const data = await fetchJson(apiUrl.toString(), {
    'User-Agent': 'BURBREEK/1.0 fuel service'
  });

  if (data?.status !== 'ok' || !data?.price) {
    throw new Error('Fuel provider returned no city price');
  }

  const petrol = number(data.price?.petrol?.price);
  const diesel = number(data.price?.diesel?.price);

  return {
    city: data.price.location || city,
    petrol: petrol !== null ? {
      status: 'ok',
      city: data.price.location || city,
      price: petrol,
      unit: data.price.petrol.unit || 'per_litre',
      unitLabel: 'Per litre',
      provider: 'APIMitra',
      source: 'APIMitra',
      updatedAt: data.fetched_at || new Date().toISOString()
    } : { status: 'unavailable' },
    diesel: diesel !== null ? {
      status: 'ok',
      city: data.price.location || city,
      price: diesel,
      unit: data.price.diesel.unit || 'per_litre',
      unitLabel: 'Per litre',
      provider: 'APIMitra',
      source: 'APIMitra',
      updatedAt: data.fetched_at || new Date().toISOString()
    } : { status: 'unavailable' },
    source: 'APIMitra',
    updatedAt: data.fetched_at || new Date().toISOString()
  };
}

router.get('/', async (req, res) => {
  const lat = number(req.query.lat);
  const lon = number(req.query.lon);
  const suppliedCity = String(req.query.city || '').trim();

  if (
    lat === null && lon === null && !suppliedCity
  ) {
    return res.status(400).json({
      error: 'Location required',
      details: 'Pass confirmed latitude/longitude or a city.'
    });
  }

  if (
    (lat !== null || lon !== null) &&
    (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180)
  ) {
    return res.status(400).json({
      error: 'Invalid coordinates'
    });
  }

  try {
    let city = suppliedCity;

    if (!city && lat !== null && lon !== null) {
      city = await reverseGeocode(lat, lon);
    }

    if (!city) {
      return res.status(422).json({
        error: 'City could not be determined',
        details: 'Pass ?city=Jaipur when reverse geocoding is unavailable.'
      });
    }

    const cacheKey = `fuel:v1:${normalizeCity(city)}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await fetchFuelFromApiMitra(city);
    cache.set(cacheKey, result, CACHE_TTL_SECONDS);

    res.json(result);
  } catch (err) {
    console.error('[fuel]', err.message);
    res.status(502).json({
      error: 'Unable to fetch live fuel prices',
      details: err.message
    });
  }
});

module.exports = router;
