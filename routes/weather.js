const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

// Maps OpenWeatherMap's condition codes/main groups to the app's four mood themes.
function mapConditionToMood(main, tempC) {
  const m = (main || '').toLowerCase();
  if (m.includes('rain') || m.includes('drizzle') || m.includes('thunderstorm')) return 'rainy';
  if (m.includes('snow') || tempC <= 10) return 'winter';
  if (tempC >= 30) return 'summer';
  return 'clear';
}

router.get('/', async (req, res) => {
  try {
    const key = process.env.OPENWEATHER_KEY;
    if (!key || key.includes('your_openweather_key')) {
      throw new Error('OPENWEATHER_KEY not configured — add a real key to .env');
    }

    const { lat, lon } = req.query;
    const city = process.env.DEFAULT_CITY || 'Mumbai';
    const locationParam = lat && lon ? `lat=${lat}&lon=${lon}` : `q=${encodeURIComponent(city)}`;

    const cacheKey = `weather:${locationParam}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const url = `https://api.openweathermap.org/data/2.5/weather?${locationParam}&units=metric&appid=${key}`;
    const wRes = await fetch(url);
    const data = await wRes.json();

    if (data.cod && data.cod !== 200) {
      throw new Error(`OpenWeatherMap error: ${data.message}`);
    }

    const tempC = data.main?.temp;
    const conditionMain = data.weather?.[0]?.main;
    const mood = mapConditionToMood(conditionMain, tempC);

    const payload = {
      mood,
      tempC,
      condition: conditionMain,
      locationName: data.name,
    };

    cache.set(cacheKey, payload, 900); // 15 min cache
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
