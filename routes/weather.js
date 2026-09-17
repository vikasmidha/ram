const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();
const CACHE_TTL_SECONDS = 120;
const FETCH_TIMEOUT_MS = 9000;

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function weatherInfoFromOpenMeteo(code) {
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

function infoFromWttr(conditionText, weatherCode) {
  const text = String(conditionText || '').trim();
  const lower = text.toLowerCase();
  const code = Number(weatherCode);

  if (/thunder|storm|lightning/i.test(lower)) {
    return { condition: 'Thunderstorm', icon: '⛈️', mood: 'rainy' };
  }
  if (/drizzle/i.test(lower)) {
    return { condition: 'Drizzle', icon: '🌦️', mood: 'rainy' };
  }
  if (/rain|shower/i.test(lower) || [176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359, 362, 365, 374, 377].includes(code)) {
    return { condition: 'Rain', icon: '🌧️', mood: 'rainy' };
  }
  if (/fog|mist/i.test(lower)) {
    return { condition: 'Foggy', icon: '🌫️', mood: 'winter' };
  }
  if (/overcast/i.test(lower)) {
    return { condition: 'Overcast', icon: '☁️', mood: 'winter' };
  }
  if (/cloud/i.test(lower)) {
    return { condition: 'Partly cloudy', icon: '🌤️', mood: 'clear' };
  }
  if (/sun|clear/i.test(lower)) {
    return { condition: 'Clear sky', icon: '☀️', mood: 'clear' };
  }
  return null;
}

function dayLabel(dateString, index) {
  if (index === 0) return 'Today';
  return new Date(`${dateString}T12:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'BURBREEK/1.0 (burbreek.com)' },
    });
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWttr(lat, lon) {
  const url = `https://wttr.is/${encodeURIComponent(`${lat},${lon}`)}?format=j1&lang=en`;
  const data = await fetchJson(url, 'wttr.is');
  const current = data?.current_condition?.[0];
  if (!current) throw new Error('wttr.is returned no current condition');

  const conditionText = current.weatherDesc?.[0]?.value || '';
  const info = infoFromWttr(conditionText, current.weatherCode);
  const precipitationMm = number(current.precipMM) || 0;
  const result = {
    locationLabel: data?.nearest_area?.[0]?.areaName?.[0]?.value || null,
    current: {
      temperatureC: number(current.temp_C),
      apparentTemperatureC: number(current.FeelsLikeC),
      humidity: number(current.humidity),
      windKmh: number(current.windspeedKmph),
      precipitationMm,
      rainMm: precipitationMm,
      weatherCode: number(current.weatherCode),
      conditionText,
      observationTime: current.observation_time || null,
    },
    conditionInfo: info,
  };
  return result;
}

async function fetchOpenMeteo(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,showers,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,rain_sum,precipitation_probability_max');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '5');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('precipitation_unit', 'mm');

  const data = await fetchJson(url.toString(), 'Open-Meteo');
  if (!data.current || !data.daily) throw new Error('Open-Meteo returned incomplete weather data');

  return {
    timezone: data.timezone || null,
    current: {
      temperatureC: number(data.current.temperature_2m),
      apparentTemperatureC: number(data.current.apparent_temperature),
      humidity: number(data.current.relative_humidity_2m),
      windKmh: number(data.current.wind_speed_10m),
      precipitationMm: number(data.current.precipitation),
      rainMm: number(data.current.rain),
      showersMm: number(data.current.showers),
      weatherCode: number(data.current.weather_code),
    },
    daily: (data.daily.time || []).map((date, i) => ({
      date,
      day: dayLabel(date, i),
      icon: weatherInfoFromOpenMeteo(data.daily.weather_code?.[i]).icon,
      maxC: number(data.daily.temperature_2m_max?.[i]),
      minC: number(data.daily.temperature_2m_min?.[i]),
      precipitationMm: number(data.daily.precipitation_sum?.[i]),
      rainMm: number(data.daily.rain_sum?.[i]),
      rainProbability: number(data.daily.precipitation_probability_max?.[i]),
    })),
    info: weatherInfoFromOpenMeteo(data.current.weather_code),
  };
}

async function fetchWeather(lat, lon) {
  const cacheKey = `weather:live:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const [wttrResult, openMeteoResult] = await Promise.allSettled([
    fetchWttr(lat, lon),
    fetchOpenMeteo(lat, lon),
  ]);

  const wttr = wttrResult.status === 'fulfilled' ? wttrResult.value : null;
  const meteo = openMeteoResult.status === 'fulfilled' ? openMeteoResult.value : null;

  if (!wttr && !meteo) {
    const wttrError = wttrResult.status === 'rejected' ? wttrResult.reason?.message : null;
    const meteoError = openMeteoResult.status === 'rejected' ? openMeteoResult.reason?.message : null;
    throw new Error([wttrError, meteoError].filter(Boolean).join(' | ') || 'All weather providers failed');
  }

  const wttrRain = wttr && ((wttr.current.rainMm || 0) > 0 || infoFromWttr(wttr.current.conditionText, wttr.current.weatherCode)?.mood === 'rainy');
  const meteoRain = meteo && (((meteo.current.rainMm || 0) > 0) || ((meteo.current.showersMm || 0) > 0) || ['Rain', 'Drizzle', 'Thunderstorm'].includes(meteo.info.condition));
  const isRainingNow = Boolean(wttrRain || meteoRain);

  let info = wttr?.conditionInfo || meteo?.info || { condition: 'Mixed conditions', icon: '🌥️', mood: 'clear' };
  if (isRainingNow) {
    const thunder = /thunder|storm|lightning/i.test(String(wttr?.current?.conditionText || '')) || meteo?.info?.condition === 'Thunderstorm';
    info = thunder
      ? { condition: 'Thunderstorm', icon: '⛈️', mood: 'rainy' }
      : { condition: 'Rain', icon: '🌧️', mood: 'rainy' };
  }

  const rainNowMm = Math.max(
    Number(wttr?.current?.rainMm || 0),
    Number(meteo?.current?.rainMm || 0),
    Number(meteo?.current?.showersMm || 0),
  );

  const current = {
    ...(meteo?.current || {}),
    ...(wttr?.current || {}),
    precipitationMm: rainNowMm > 0 ? rainNowMm : Number(meteo?.current?.precipitationMm ?? wttr?.current?.precipitationMm ?? 0),
    rainMm: rainNowMm,
    rainingNow: isRainingNow,
  };

  const result = {
    locationLabel: wttr?.locationLabel || null,
    timezone: meteo?.timezone || null,
    condition: info.condition,
    icon: info.icon,
    mood: info.mood,
    current,
    daily: meteo?.daily || [],
    source: wttr && meteo ? 'wttr.is + Open-Meteo' : (wttr ? 'wttr.is' : 'Open-Meteo'),
    updatedAt: new Date().toISOString(),
    providers: {
      wttr: Boolean(wttr),
      openMeteo: Boolean(meteo),
    },
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
      return res.status(400).json({
        error: 'Location required',
        details: 'Confirm a location in BURBREEK to load local weather.',
      });
    }

    const weather = await fetchWeather(lat, lon);
    res.json({ ...weather, requestedLocation: true, cacheTtlSeconds: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error('[weather]', err.message);
    res.status(502).json({ error: 'Unable to fetch weather', details: err.message });
  }
});

module.exports = router;
