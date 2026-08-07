const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json({ limit: '2mb' }));

// Static frontend files (brand-only pages are protected below)
const PUBLIC_DIR = __dirname;
const DB_PATH = path.join(__dirname, 'db.json');
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 200;
const rateLimitState = new Map();

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

function isLocalhost(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first === '127.0.0.1' || first === '::1') return true;
  }
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function rateLimit(req, res, next) {
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitState.get(key);

  if (!entry || now - entry.resetAt > RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(key, { count: 1, resetAt: now });
    return next();
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

function requireBrandSession(req, res, next) {
  if (isLocalhost(req)) return next();

  const cookieHeader = req.headers.cookie || '';
  const brandCookie = cookieHeader
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('mm_brand_session='));

  if (brandCookie && decodeURIComponent(brandCookie.split('=')[1]).startsWith('brand:')) {
    return next();
  }

  return res.status(403).type('text/plain').send('Forbidden: brand authentication required');
}

app.use(rateLimit);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2 https://cdn.jsdelivr.net/npm/; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com data:; img-src 'self' data: https:; connect-src 'self' https://omyzcnizwxumvookotsy.supabase.co https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; object-src 'none'; base-uri 'self';");

  const isSensitivePage = ['brandflow.html', 'add-item.html', 'view-order.html', 'profile.html', 'orders.html', 'wishlist.html', 'cart.html', 'login.html', 'signup.html', 'verify.html'].some(page => req.path.endsWith(page));
  if (isSensitivePage) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
});

app.get('/api/db', (req, res) => {
  res.status(404).json({ error: 'Database API disabled' });
});

app.post('/api/db', (req, res) => {
  res.status(404).json({ error: 'Database API disabled' });
});

app.patch('/api/db/merge', (req, res) => {
  res.status(404).json({ error: 'Database API disabled' });
});

// -------- Brand access --------
// Brand-only pages require an authenticated brand session cookie.
// Localhost requests are allowed for development calls.

// Auth pages
app.get('/login',        (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/login.html',   (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/signup',       (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signup.html')));
app.get('/signup.html',  (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signup.html')));

// Serve frontend HTML
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/marketplace.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'marketplace.html')));
app.get('/brandflow.html', requireBrandSession, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'brandflow.html')));
app.get('/add-item.html', requireBrandSession, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'add-item.html')));
app.get('/view-order.html', requireBrandSession, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'view-order.html')));
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


