const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

const DB_PATH = path.join(__dirname, 'db.json');

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      merchUsers: [],
      merchInventory: {}, // keyed by brandId
      merchOrders: {}, // keyed by brandId
      merchCart: []
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

app.get('/api/db', (req, res) => {
  try {
    res.json(readDb());
  } catch (e) {
    res.status(500).json({ error: 'Failed to read db', details: String(e) });
  }
});

app.post('/api/db', (req, res) => {
  try {
    const next = req.body;
    writeDb(next);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to write db', details: String(e) });
  }
});

// Convenience helpers for keyed updates
app.patch('/api/db/merge', (req, res) => {
  try {
    const patch = req.body || {};
    const db = readDb();
    const merged = { ...db, ...patch };
    writeDb(merged);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to merge db', details: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MerchMarket JSON DB server running on http://localhost:${PORT}`);
});

