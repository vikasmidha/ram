const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const DATA_PATH = path.join(__dirname, '..', 'data', 'manual-prices.json');

function readData() {
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}

// GET /api/prices/grocery, GET /api/prices/fuel
router.get('/:kind', (req, res) => {
  const data = readData();
  const kind = req.params.kind;
  if (!data[kind]) return res.status(404).json({ error: 'Unknown price category' });
  res.json({ items: data[kind], lastUpdated: data.lastUpdated, source: data.source });
});

// PUT /api/prices/grocery — update prices, protected by a simple shared-secret token.
// This is intentionally minimal. For anything beyond a single-operator prototype,
// replace this with real authentication (e.g. a proper admin login) and a real
// database instead of a flat JSON file.
router.put('/:kind', (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Missing or invalid X-Admin-Token header' });
  }
  const data = readData();
  const kind = req.params.kind;
  if (!data[kind]) return res.status(404).json({ error: 'Unknown price category' });

  data[kind] = req.body.items;
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  res.json({ ok: true, lastUpdated: data.lastUpdated });
});

module.exports = router;
