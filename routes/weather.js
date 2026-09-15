const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();
const CACHE_TTL_SECONDS = 300;


function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function weatherInfo(code) {
  const c = Number(code);
  if (c === 0) return { condition: 'Clear sky', icon: '☀️', mood: 'clear' };
  if ([1,2].includes(c)) return { condition: 'Partly cloudy', icon: '🌤️', mood: 'clear' };
  if (c === 3) return { condition: 'Overcast', icon: '☁️', mood: 'winter' };
  if ([45,48].includes(c)) return { condition: 'Foggy', icon: '🌫️', mood: 'winter' };
  if ([51,53,55,56,57].includes(c)) return { condition: 'Drizzle', icon: '🌦️', mood: 'rainy' };
  if ([61,63,65,66,67,80,81,82].includes(c)) return { condition: 'Rain', icon: '🌧️', mood: 'rainy' };
  if ([71,73,75,77,85,86].includes(c)) return { condition: 'Snow', icon: '❄️', mood: 'winter' };
  if ([95,96,99].includes(c)) return { condition: 'Thunderstorm', icon: '⛈️', mood: 'rainy' };
  return { condition: 'Mixed conditions', icon: '🌥️', mood: 'clear' };
}

function dayLabel(dateString, index) {
  if (index === 0) return 'Today';
  return new Date(`${dateString}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
}

async function fetchWeather(lat, lon, label) {
  const cacheKey = `weather:openmeteo:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '5');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('precipitation_unit', 'mm');

  const res = await fetch(url.toString(), { timeout: 10000, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  if (!data.current || !data.daily) throw new Error('Incomplete weather response');

  const info = weatherInfo(data.current.weather_code);
  const result = {
    locationLabel: label || `Lat ${lat.toFixed(2)}, Lon ${lon.toFixed(2)}`,
    timezone: data.timezone || null,
    condition: info.condition,
    mood: info.mood,
    current: {
      temperatureC: number(data.current.temperature_2m),
      apparentTemperatureC: number(data.current.apparent_temperature),
      humidity: number(data.current.relative_humidity_2m),
      windKmh: number(data.current.wind_speed_10m),
      precipitationMm: number(data.current.precipitation),
      weatherCode: number(data.current.weather_code),
    },
    daily: (data.daily.time || []).map((date, i) => ({
      date,
      day: dayLabel(date, i),
      icon: weatherInfo(data.daily.weather_code?.[i]).icon,
      maxC: number(data.daily.temperature_2m_max?.[i]),
      minC: number(data.daily.temperature_2m_min?.[i]),
      precipitationMm: number(data.daily.precipitation_sum?.[i]),
    })),
    source: 'Open-Meteo',
    updatedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, result, CACHE_TTL_SECONDS);
  return result;
}

router.get('/', async (req, res) => {
  try {
    const lat = number(req.query.lat);
    const lon = number(req.query.lon);
    const valid = lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    if (!valid) {
      return res.status(400).json({ error: 'Location required', details: 'Confirm a location in BURBREEK to load local weather.' });
    }
    const weather = await fetchWeather(lat, lon, 'Your confirmed location');
    res.json({ ...weather, requestedLocation: true, cacheTtlSeconds: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error('[weather]', err.message);
    res.status(502).json({ error: 'Unable to fetch weather', details: err.message });
  }
});

module.exports = router;
