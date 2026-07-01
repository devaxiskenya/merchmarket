const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json({ limit: '2mb' }));

// Static frontend files (we will serve brandflow only through guards below)
const PUBLIC_DIR = __dirname;

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

// -------- Brand access --------
// Brand page access is guarded client-side by Supabase JWT in brandflow.html.
// The client reads the session, checks profile.type === 'brand', and redirects
// to login.html?type=brand if not authenticated. No server cookie needed.

// Auth pages
app.get('/login',        (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/login.html',   (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/signup',       (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signup.html')));
app.get('/signup.html',  (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signup.html')));

// Serve frontend HTML
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/marketplace.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'marketplace.html')));
app.get('/brandflow.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'brandflow.html')));
app.get('/wishlist.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'wishlist.html')));
app.get('/cart.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cart.html')));
app.get('/orders.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'orders.html')));

// Static assets
app.use(express.static(PUBLIC_DIR));

// Fallback 404
app.use((req, res) => res.status(404).send('Not found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MerchMarket server running on http://localhost:${PORT}`);
});


