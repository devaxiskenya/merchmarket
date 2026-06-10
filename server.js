const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

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

// -------- Admin auth (server-side) --------
// Brand Admin pages should not be accessible by copying/pasting the URL.
// This uses a minimal server session stored in-memory.

const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const sessions = new Map(); // token -> { userId, type, exp }

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: user.id, type: user.type, exp: Date.now() + SESSION_TTL_MS });
  return token;
}

function authBrand(req, res, next) {
  const token = req.cookies?.mm_session || req.query?.mm_session || req.headers['x-mm-session'];
  if (!token) return res.redirect('/marketplace.html');

  const sess = sessions.get(token);
  if (!sess) return res.redirect('/marketplace.html');
  if (Date.now() > sess.exp) {
    sessions.delete(token);
    return res.redirect('/marketplace.html');
  }
  if (sess.type !== 'brand') return res.redirect('/marketplace.html');

  req.brandUserId = sess.userId;
  next();
}

// Parse cookies (needed for session token)
app.use(require('cookie-parser')());

// Login endpoint to create server session for Brand Admin
// Frontend can call this after login. For backward compatibility, we also accept
// currentUserId + users payload.
app.post('/api/login', (req, res) => {
  try {
    const { email, password, user } = req.body || {};
    // Guest-mode app keeps users in localStorage; server doesn't know them.
    // So we rely on the client passing a `user` object.
    const u = user || null;
    if (!u || !u.id || u.type !== 'brand') {
      return res.status(401).json({ error: 'Brand session requires brand user' });
    }

    const token = createSession(u);
    res.cookie('mm_session', token, { httpOnly: true, sameSite: 'lax' });
    return res.json({ ok: true, redirect: '/brandflow.html' });
  } catch (e) {
    return res.status(500).json({ error: 'Login failed', details: String(e) });
  }
});

// Convenience: allow member login to simply redirect to marketplace.
// This prevents client-side code from navigating to a non-existent file.
app.get('/login', (req, res) => res.redirect('/marketplace.html'));

// Serve frontend HTML
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/marketplace.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'marketplace.html')));
app.get('/brandflow.html', authBrand, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'brandflow.html')));
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


