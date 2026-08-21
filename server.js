const express = require('express');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json({ limit: '2mb' }));

// Static frontend files (brand-only pages are protected below)
const PUBLIC_DIR = __dirname;
const DB_PATH = path.join(__dirname, 'db.json');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://omyzcnizwxumvookotsy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_2Dvox3zHhG4WG7An-sn0tQ_eZ9z6xh8';
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

function createSupabaseClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const client = createSupabaseClient();
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) throw error || new Error('Invalid user token');

    await client.auth.setSession({ access_token: token, refresh_token: '' });
    req.supabase = client;
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized', details: e.message });
  }
}

async function requireBrand(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const { data, error } = await req.supabase
      .from('profiles')
      .select('id, name, type')
      .eq('id', req.user.id)
      .single();

    if (error || !data || data.type !== 'brand') {
      res.status(403).json({ error: 'Brand access required' });
      return;
    }

    req.brandProfile = data;
    next();
  } catch (e) {
    res.status(403).json({ error: 'Brand access required', details: e.message });
  }
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

app.get('/api/member/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .maybeSingle();

    if (error) throw error;
    res.json({ profile: data || null });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load profile', details: e.message });
  }
});

app.patch('/api/member/profile', requireAuth, async (req, res) => {
  try {
    const payload = {
      id: req.user.id,
      email: req.user.email,
      type: req.user.user_metadata?.type || 'member',
      updated_at: new Date().toISOString(),
      ...req.body
    };

    const { data, error } = await req.supabase
      .from('profiles')
      .upsert(payload, { onConflict: 'id' })
      .select('*')
      .single();

    if (error) throw error;
    res.json({ profile: data });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update profile', details: e.message });
  }
});

app.get('/api/member/orders', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('orders')
      .select('*, order_items(*, products(name, sku))')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ orders: data || [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load member orders', details: e.message });
  }
});

app.get('/api/member/wishlist', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('wishlists')
      .select(`
        id,
        quantity,
        products (
          id, name, price, seller, images, sku
        )
      `)
      .eq('user_id', req.user.id)
      .order('id', { ascending: false });

    if (error) throw error;
    res.json({ wishlist: data || [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load wishlist', details: e.message });
  }
});

app.post('/api/member/wishlist', requireAuth, async (req, res) => {
  try {
    const { product_id, quantity = 1 } = req.body || {};
    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const { data: existing, error: existingError } = await req.supabase
      .from('wishlists')
      .select('id, quantity')
      .eq('user_id', req.user.id)
      .eq('product_id', product_id)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      const { error: updateError } = await req.supabase
        .from('wishlists')
        .update({ quantity: existing.quantity + qty })
        .eq('id', existing.id);
      if (updateError) throw updateError;
      return res.json({ ok: true, updated: true });
    }

    const { error: insertError } = await req.supabase
      .from('wishlists')
      .insert({ user_id: req.user.id, product_id, quantity: qty });

    if (insertError) throw insertError;
    res.json({ ok: true, updated: false });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update wishlist', details: e.message });
  }
});

app.delete('/api/member/wishlist/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await req.supabase
      .from('wishlists')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to remove wishlist item', details: e.message });
  }
});

app.post('/api/member/wishlist/clear', requireAuth, async (req, res) => {
  try {
    const { error } = await req.supabase
      .from('wishlists')
      .delete()
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to clear wishlist', details: e.message });
  }
});

app.get('/api/member/cart', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('cart_items')
      .select(`
        id,
        quantity,
        products (
          id, name, price, seller, images, sku, stock
        )
      `)
      .eq('user_id', req.user.id)
      .order('added_at', { ascending: false });

    if (error) throw error;
    res.json({ cart: data || [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load cart', details: e.message });
  }
});

app.post('/api/member/cart', requireAuth, async (req, res) => {
  try {
    const { product_id, quantity = 1 } = req.body || {};
    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const { data: existing, error: existingError } = await req.supabase
      .from('cart_items')
      .select('id, quantity')
      .eq('user_id', req.user.id)
      .eq('product_id', product_id)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      const { error: updateError } = await req.supabase
        .from('cart_items')
        .update({ quantity: existing.quantity + qty })
        .eq('id', existing.id);
      if (updateError) throw updateError;
      return res.json({ ok: true, updated: true });
    }

    const { error: insertError } = await req.supabase
      .from('cart_items')
      .insert({ user_id: req.user.id, product_id, quantity: qty, added_at: new Date().toISOString() });

    if (insertError) throw insertError;
    res.json({ ok: true, updated: false });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update cart', details: e.message });
  }
});

// Sets an exact quantity (used by the +/- controls on cart.html), unlike the
// POST route above which only increments. Zero-row updates (wrong user,
// deleted row) are checked explicitly rather than trusted as success.
app.patch('/api/member/cart/:id', requireAuth, async (req, res) => {
  try {
    const qty = parseInt(req.body?.quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }

    const { data, error } = await req.supabase
      .from('cart_items')
      .update({ quantity: qty })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select();

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Cart item not found' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update cart item', details: e.message });
  }
});

app.delete('/api/member/cart/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await req.supabase
      .from('cart_items')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to remove cart item', details: e.message });
  }
});

app.post('/api/member/cart/clear', requireAuth, async (req, res) => {
  try {
    const { error } = await req.supabase
      .from('cart_items')
      .delete()
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to clear cart', details: e.message });
  }
});

app.post('/api/member/orders', requireAuth, async (req, res) => {
  try {
    const { orders } = req.body || {};
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'No orders supplied' });
    }

    const created = [];
    for (const order of orders) {
      const { brand_id, total_amount, location, items = [] } = order || {};
      if (!brand_id || !Array.isArray(items) || items.length === 0) {
        continue;
      }

      const { data, error } = await req.supabase
        .from('orders')
        .insert({
          user_id: req.user.id,
          brand_id,
          total_amount: String(total_amount ?? '0.00'),
          status: 'pending',
          location: location || 'Nairobi, Kenya',
          created_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (error || !data) {
        throw error || new Error('Failed to create order');
      }

      const orderItems = items.map(item => ({
        order_id: data.id,
        product_id: item.product_id,
        quantity: item.quantity,
        sku: item.sku || '',
        unit_price: item.unit_price
      }));

      const { error: itemsError } = await req.supabase.from('order_items').insert(orderItems);
      if (itemsError) throw itemsError;

      created.push(data.id);
    }

    if (created.length === 0) {
      return res.status(400).json({ error: 'No valid orders created' });
    }

    res.json({ ok: true, orderIds: created });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create member orders', details: e.message });
  }
});

app.get('/api/brand/orders', requireAuth, requireBrand, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('orders')
      .select(`
        id, total_amount, status, location, created_at,
        profiles!orders_user_id_fkey (id, name, email),
        order_items (
          id, quantity, sku, unit_price,
          products (name, sku)
        )
      `)
      .eq('brand_id', req.brandProfile.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ orders: data || [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load brand orders', details: e.message });
  }
});

app.get('/api/brand/orders/:id', requireAuth, requireBrand, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('orders')
      .select(`
        id, total_amount, status, location, created_at,
        profiles!orders_user_id_fkey (name, email),
        order_items (quantity, sku, unit_price, products (name))
      `)
      .eq('id', req.params.id)
      .eq('brand_id', req.brandProfile.id)
      .single();

    if (error) throw error;
    res.json({ order: data });
  } catch (e) {
    res.status(404).json({ error: 'Order not found', details: e.message });
  }
});

app.patch('/api/brand/orders/:id/status', requireAuth, requireBrand, async (req, res) => {
  try {
    const { status } = req.body || {};
    const { error } = await req.supabase
      .from('orders')
      .update({ status })
      .eq('id', req.params.id)
      .eq('brand_id', req.brandProfile.id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update order status', details: e.message });
  }
});

app.get('/api/brand/inventory', requireAuth, requireBrand, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('products')
      .select('*')
      .eq('brand_id', req.brandProfile.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ products: data || [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load inventory', details: e.message });
  }
});

app.post('/api/brand/products', requireAuth, requireBrand, async (req, res) => {
  try {
    const payload = {
      ...req.body,
      brand_id: req.brandProfile.id,
      seller: req.brandProfile.name,
      updated_at: new Date().toISOString()
    };
    payload.created_at = new Date().toISOString();

    const { data, error } = await req.supabase
      .from('products')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw error;
    res.json({ product: data });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add product', details: e.message });
  }
});

app.put('/api/brand/products/:id', requireAuth, requireBrand, async (req, res) => {
  try {
    const payload = {
      ...req.body,
      brand_id: req.brandProfile.id,
      seller: req.brandProfile.name,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await req.supabase
      .from('products')
      .update(payload)
      .eq('id', req.params.id)
      .eq('brand_id', req.brandProfile.id)
      .select('*')
      .single();

    if (error) throw error;
    res.json({ product: data });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update product', details: e.message });
  }
});

app.delete('/api/brand/products/:id', requireAuth, requireBrand, async (req, res) => {
  try {
    const { error } = await req.supabase
      .from('products')
      .delete()
      .eq('id', req.params.id)
      .eq('brand_id', req.brandProfile.id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete product', details: e.message });
  }
});

app.get('/api/brand/payments', requireAuth, requireBrand, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('vendor_payments')
      .select('*')
      .eq('brand_id', req.brandProfile.id)
      .maybeSingle();

    if (error) throw error;
    res.json({ payments: data });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load payment details', details: e.message });
  }
});

app.post('/api/brand/payments', requireAuth, requireBrand, async (req, res) => {
  try {
    const { method, label, details } = req.body || {};
    const { error } = await req.supabase
      .from('vendor_payments')
      .upsert({
        brand_id: req.brandProfile.id,
        method,
        label,
        details,
        updated_at: new Date().toISOString()
      }, { onConflict: 'brand_id' });

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save payment details', details: e.message });
  }
});

app.post('/api/brand/reset', requireAuth, requireBrand, async (req, res) => {
  try {
    const productIds = await req.supabase
      .from('products')
      .select('id')
      .eq('brand_id', req.brandProfile.id)
      .then(r => (r.data || []).map(p => p.id));

    if (productIds.length) {
      await req.supabase.from('order_items').delete().in('product_id', productIds);
      await req.supabase.from('wishlists').delete().in('product_id', productIds);
      await req.supabase.from('products').delete().eq('brand_id', req.brandProfile.id);
    }

    await req.supabase.from('orders').delete().eq('brand_id', req.brandProfile.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reset brand data', details: e.message });
  }
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


