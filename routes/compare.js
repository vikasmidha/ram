const express = require('express');
const db = require('../db');
const manual = require('../data/manual-prices.json');

const router = express.Router();

const DEFAULT_ITEMS = (manual.grocery || []).slice(0, 6).map((item, index) => ({
  id: null,
  name: item.item,
  unit: item.unit,
  category: 'grocery',
  defaultRank: index + 1,
  prices: item.prices,
  source: 'manual',
}));

function bestPrice(prices) {
  const entries = Object.entries(prices || {}).map(([store, price]) => [store, Number(price)]).filter(([, price]) => Number.isFinite(price));
  if (!entries.length) return null;
  const [store, price] = entries.reduce((a, b) => b[1] < a[1] ? b : a);
  const highest = Math.max(...entries.map(([, p]) => p));
  return { store, price, saving: Number((highest - price).toFixed(2)) };
}

router.get('/defaults', async (req, res) => {
  try {
    const products = [];
    for (const item of DEFAULT_ITEMS) {
      const matches = await db.searchProducts(item.name);
      const product = matches[0];
      products.push({ ...item, id: product ? product.id : null, best: bestPrice(item.prices) });
    }
    res.json({ items: products });
  } catch (e) {
    res.json({ items: DEFAULT_ITEMS.map(i => ({ ...i, best: bestPrice(i.prices) })), fallback: true });
  }
});

router.get('/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const userId = String(req.query.userId || '').trim();
  const latitude = req.query.lat !== undefined ? Number(req.query.lat) : null;
  const longitude = req.query.lng !== undefined ? Number(req.query.lng) : null;
  if (!query) return res.json({ items: [] });
  try {
    const items = await db.searchProducts(query);
    const enriched = [];
    for (const item of items) {
      const rows = await db.getComparisons(item.id, latitude, longitude);
      const prices = {};
      rows.forEach(r => { prices[r.store] = Number(r.price); });
      enriched.push({ ...item, prices, best: bestPrice(prices), updatedAt: rows[0]?.updated_at || null });
    }
    const productId = items[0]?.id || null;
    await db.recordSearch({ userId, query, productId, latitude, longitude });
    res.json({ items: enriched, query, personalized: Boolean(userId) });
  } catch (e) {
    // Keep the new frontend usable before the database is configured.
    const q = query.toLowerCase();
    const items = DEFAULT_ITEMS.filter(i => i.name.toLowerCase().includes(q)).map(i => ({ ...i, best: bestPrice(i.prices) }));
    res.json({ items, query, fallback: true, message: 'Database not configured; showing catalog fallback.' });
  }
});

router.get('/recommendations', async (req, res) => {
  const userId = String(req.query.userId || '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 8), 1), 20);
  try {
    const personal = await db.getRecommendations(userId, limit);
    if (personal.length) return res.json({ items: personal, type: 'personal' });
    const popular = await db.getPopular(limit);
    res.json({ items: popular, type: 'popular' });
  } catch (e) {
    res.json({ items: DEFAULT_ITEMS.map(i => ({ id: i.id, name: i.name, unit: i.unit })), type: 'default' });
  }
});

router.post('/location', async (req, res) => {
  const { userId, latitude, longitude, geohash, city } = req.body || {};
  if (!userId || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
    return res.status(400).json({ error: 'userId, latitude and longitude are required' });
  }
  try {
    await db.saveLocation(userId, Number(latitude), Number(longitude), geohash, city);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, fallback: true });
  }
});

router.post('/activity', async (req, res) => {
  const { userId, productId, type } = req.body || {};
  if (!userId || !productId) return res.status(400).json({ error: 'userId and productId are required' });
  try {
    await db.recordActivity({ userId, productId, type });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, fallback: true });
  }
});

module.exports = router;
