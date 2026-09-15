const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

const CACHE_TTL_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 10000;

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function weatherInfo(code) {
  const c = Number(code);
  if (c === 0) return { condition: 'Clear sky', icon: '☀️', mood: 'clear' };
  if ([1, 2].includes(c)) return { condition: 'Partly cloudy', icon: '🌤️', mood: 'clear' };
  if (c === 3) return { condition: 'Overcast', icon: '☁️', mood: 'winter' };
  if ([45, 48].includes(c)) return { condition: 'Foggy', icon: '🌫️', mood: 'winter' };
  if ([51, 53, 55, 56, 57].includes(c)) return { condition: 'Drizzle', icon: '🌦️', mood: 'rainy' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return { condition: 'Rain', icon: '🌧️', mood: 'rainy' };
  if ([71, 73, 75, 77, 85, 86].includes(c)) return { condition: 'Snow', icon: '❄️', mood: 'winter' };
  if ([95, 96, 99].includes(c)) return { condition: 'Thunderstorm', icon: '⛈️', mood: 'rainy' };
  return { condition: 'Mixed conditions', icon: '🌥️', mood: 'clear' };
}

function dayLabel(dateString, index) {
  if (index === 0) return 'Today';
  return new Date(`${dateString}T12:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    timeZone: 'UTC'
  });
}

async function fetchJson(url, provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'BURBREEK/1.0 weather service'
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${provider} HTTP ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function openMeteoUrl(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');

  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m'
  );
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max'
  );
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '5');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('precipitation_unit', 'mm');

  return url.toString();
}

function mapOpenMeteo(data, lat, lon, label) {
  if (!data?.current || !data?.daily) {
    throw new Error('Open-Meteo returned incomplete weather data');
  }

  const info = weatherInfo(data.current.weather_code);

  return {
    locationLabel: label || `Lat ${lat.toFixed(2)}, Lon ${lon.toFixed(2)}`,
    timezone: data.timezone || null,
    condition: info.condition,
    icon: info.icon,
    mood: info.mood,
    current: {
      temperatureC: number(data.current.temperature_2m),
      apparentTemperatureC: number(data.current.apparent_temperature),
      humidity: number(data.current.relative_humidity_2m),
      windKmh: number(data.current.wind_speed_10m),
      precipitationMm: number(data.current.precipitation),
      weatherCode: number(data.current.weather_code)
    },
    daily: (data.daily.time || []).map((date, i) => ({
      date,
      day: dayLabel(date, i),
      icon: weatherInfo(data.daily.weather_code?.[i]).icon,
      maxC: number(data.daily.temperature_2m_max?.[i]),
      minC: number(data.daily.temperature_2m_min?.[i]),
      precipitationMm: number(data.daily.precipitation_sum?.[i]),
      rainProbability: number(data.daily.precipitation_probability_max?.[i])
    })),
    source: 'Open-Meteo',
    updatedAt: new Date().toISOString()
  };
}

/*
 * Fallback provider.
 * This keeps BURBREEK weather alive if Open-Meteo has a transient
 * network/provider failure on the hosting platform.
 */
async function fetchWttr(lat, lon, label) {
  const url = `https://wttr.in/${encodeURIComponent(`${lat},${lon}`)}?format=j1`;
  const data = await fetchJson(url, 'wttr.in');

  const current = data?.current_condition?.[0];
  const days = data?.weather || [];

  if (!current) throw new Error('wttr.in returned incomplete weather data');

  const code = number(current.weatherCode);
  const info = weatherInfo(
    code === 113 ? 0 :
    code === 116 ? 2 :
    code === 119 ? 3 :
    code === 122 ? 3 :
    code === 176 || code === 263 || code === 266 || code === 293 || code === 296 ||
    code === 299 || code === 302 || code === 305 || code === 308 ? 63 :
    code === 200 ? 95 :
    3
  );

  return {
    locationLabel: label || `Lat ${lat.toFixed(2)}, Lon ${lon.toFixed(2)}`,
    timezone: null,
    condition: current.weatherDesc?.[0]?.value || info.condition,
    icon: info.icon,
    mood: info.mood,
    current: {
      temperatureC: number(current.temp_C),
      apparentTemperatureC: number(current.FeelsLikeC),
      humidity: number(current.humidity),
      windKmh: number(current.windspeedKmph),
      precipitationMm: number(current.precipMM),
      weatherCode: code
    },
    daily: days.slice(0, 5).map((day, i) => ({
      date: day.date,
      day: dayLabel(day.date, i),
      icon: weatherInfo(
        number(day.hourly?.[4]?.weatherCode)
      ).icon,
      maxC: number(day.maxtempC),
      minC: number(day.mintempC),
      precipitationMm: number(day.totalprecip_mm),
      rainProbability: null
    })),
    source: 'wttr.in fallback',
    updatedAt: new Date().toISOString()
  };
}

async function fetchWeather(lat, lon, label) {
  const cacheKey = `weather:real:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let primaryError = null;

  try {
    const data = await fetchJson(openMeteoUrl(lat, lon), 'Open-Meteo');
    const result = mapOpenMeteo(data, lat, lon, label);
    cache.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  } catch (err) {
    primaryError = err;
    console.error('[weather] Open-Meteo failed:', err.message);
  }

  try {
    const result = await fetchWttr(lat, lon, label);
    cache.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  } catch (fallbackError) {
    console.error('[weather] fallback failed:', fallbackError.message);

    const combined = `Open-Meteo: ${primaryError?.message || 'failed'}; wttr.in: ${fallbackError.message}`;
    throw new Error(combined);
  }
}

router.get('/', async (req, res) => {
  const lat = number(req.query.lat);
  const lon = number(req.query.lon);

  const valid =
    lat !== null &&
    lon !== null &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180;

  if (!valid) {
    return res.status(400).json({
      error: 'Location required',
      details: 'Confirm a location in BURBREEK to load local weather.'
    });
  }

  try {
    const weather = await fetchWeather(
      lat,
      lon,
      String(req.query.label || 'Your confirmed location')
    );

    res.json({
      ...weather,
      requestedLocation: true,
      cacheTtlSeconds: CACHE_TTL_SECONDS
    });
  } catch (err) {
    console.error('[weather] all providers failed:', err.message);

    res.status(502).json({
      error: 'Unable to fetch weather',
      details: err.message
    });
  }
});

module.exports = router;
