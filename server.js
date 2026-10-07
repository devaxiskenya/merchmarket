const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json({ limit: '2mb' }));

// Static frontend files (brand-only pages are protected below)
const PUBLIC_DIR = __dirname;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://omyzcnizwxumvookotsy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_2Dvox3zHhG4WG7An-sn0tQ_eZ9z6xh8';
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 200;
const rateLimitState = new Map();

/* ─── PESAPAL ────────────────────────────────────────────────
   Server-side only — consumer key/secret never reach the browser.
   Env vars required: PESAPAL_CONSUMER_KEY, PESAPAL_CONSUMER_SECRET,
   PESAPAL_ENV ('sandbox' default, or 'live'), SUPABASE_SERVICE_ROLE_KEY
   (needed because the IPN webhook has no user session, so it must
   bypass RLS via the service-role key to update payment_status —
   this key is NOT the same as SUPABASE_KEY above, which is the
   publishable/anon key used for user-scoped requests). */

const PESAPAL_ENV = (process.env.PESAPAL_ENV || 'sandbox').trim().toLowerCase();
const PESAPAL_BASE_URL = PESAPAL_ENV === 'live'
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';
const PESAPAL_CONSUMER_KEY = (process.env.PESAPAL_CONSUMER_KEY || '').trim().replace(/^['"]|['"]$/g, '');
const PESAPAL_CONSUMER_SECRET = (process.env.PESAPAL_CONSUMER_SECRET || '').trim().replace(/^['"]|['"]$/g, '');
const APP_DOMAIN = process.env.APP_DOMAIN || 'https://merchmarket.co.ke';

function createSupabaseServiceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }
  return createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

let _pesapalTokenCache = null; // { token, expiresAt }

async function getPesapalToken() {
  if (_pesapalTokenCache && _pesapalTokenCache.expiresAt > Date.now()) {
    return _pesapalTokenCache.token;
  }
  if (!PESAPAL_CONSUMER_KEY || !PESAPAL_CONSUMER_SECRET) {
    throw new Error('Pesapal credentials are not configured (PESAPAL_CONSUMER_KEY/SECRET missing)');
  }

  const res = await fetch(`${PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ consumer_key: PESAPAL_CONSUMER_KEY, consumer_secret: PESAPAL_CONSUMER_SECRET })
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.token) {
    // Pesapal often replies HTTP 200 with { error: { code, message } } and no token.
    const detail = payload.error?.code || payload.error?.message || payload.message || res.statusText;
    console.error('pesapal auth failed:', { env: PESAPAL_ENV, baseUrl: PESAPAL_BASE_URL, http: res.status, error: payload.error || null, status: payload.status || null });
    throw new Error(`Pesapal auth failed (${PESAPAL_ENV}): ${detail}`);
  }

  // Pesapal tokens are short-lived — refresh a little early to be safe.
  _pesapalTokenCache = { token: payload.token, expiresAt: Date.now() + 4 * 60 * 1000 };
  return payload.token;
}

// The IPN URL only needs registering once with Pesapal, but Vercel functions
// have no shared memory between invocations, so the resulting ipn_id is
// cached in the app_settings table (service-role only) rather than
// re-registering on every payment.
async function getOrRegisterPesapalIpnId(supabaseAdmin) {
  const settingKey = `pesapal_ipn_id_${PESAPAL_ENV}`;
  const { data: existing } = await supabaseAdmin
    .from('app_settings')
    .select('value')
    .eq('key', settingKey)
    .maybeSingle();

  if (existing?.value) return existing.value;

  const token = await getPesapalToken();
  const res = await fetch(`${PESAPAL_BASE_URL}/api/URLSetup/RegisterIPN`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: `${APP_DOMAIN}/api/payments/pesapal/ipn`, ipn_notification_type: 'GET' })
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.ipn_id) {
    throw new Error(`Pesapal IPN registration failed: ${payload.message || res.statusText}`);
  }

  await supabaseAdmin
    .from('app_settings')
    .upsert({ key: settingKey, value: payload.ipn_id, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  return payload.ipn_id;
}

async function submitPesapalOrder({ merchantReference, amount, description, billing, supabaseAdmin }) {
  const token = await getPesapalToken();
  const ipnId = await getOrRegisterPesapalIpnId(supabaseAdmin);

  const res = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id: merchantReference,
      currency: 'KES',
      amount,
      description,
      callback_url: `${APP_DOMAIN}/payment-return.html`,
      notification_id: ipnId,
      billing_address: billing
    })
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) {
    throw new Error(`Pesapal order submission failed: ${payload.error?.message || payload.message || res.statusText}`);
  }
  return payload; // { order_tracking_id, merchant_reference, redirect_url }
}

async function getPesapalTransactionStatus(orderTrackingId) {
  const token = await getPesapalToken();
  const res = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Pesapal status check failed: ${payload.message || res.statusText}`);
  }
  return payload; // { payment_status_description, status_code, ... }
}

function pesapalStatusToPaymentStatus(statusPayload) {
  const code = statusPayload?.status_code;
  const desc = (statusPayload?.payment_status_description || '').toLowerCase();
  if (code === 1 || desc === 'completed') return 'paid';
  if (code === 2 || desc === 'failed') return 'failed';
  return 'unpaid'; // pending/invalid/reversed — leave as unpaid, IPN will fire again on change
}

function createSupabaseClient(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined
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
    const verifyClient = createSupabaseClient();
    const { data: { user }, error } = await verifyClient.auth.getUser(token);
    if (error || !user) throw error || new Error('Invalid user token');

    // req.supabase carries the user's own JWT on every request it makes,
    // so RLS policies see the real auth.uid() — not the setSession()
    // approach previously used here, which required a real refresh_token
    // to reliably attach the Authorization header and was silently
    // falling back to anon-only access when it didn't.
    req.supabase = createSupabaseClient(token);
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

  const isSensitivePage = ['brandflow.html', 'brand-profile.html', 'admin-vendors.html', 'add-item.html', 'view-order.html', 'profile.html', 'orders.html', 'wishlist.html', 'cart.html', 'login.html', 'signup.html', 'verify.html'].some(page => req.path.endsWith(page));
  if (isSensitivePage) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
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
      .select('*, order_items(*, products(name, sku, seller)), order_status_history(to_status, note, created_at)')
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
      const { data: updated, error: updateError } = await req.supabase
        .from('wishlists')
        .update({ quantity: existing.quantity + qty })
        .eq('id', existing.id)
        .select('id')
        .single();
      if (updateError) throw updateError;
      return res.json({ ok: true, updated: true, id: updated.id });
    }

    const { data: inserted, error: insertError } = await req.supabase
      .from('wishlists')
      .insert({ user_id: req.user.id, product_id, quantity: qty })
      .select('id')
      .single();

    if (insertError) throw insertError;
    res.json({ ok: true, updated: false, id: inserted.id });
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
        size,
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
    const { product_id, quantity = 1, size = null } = req.body || {};
    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    // A product with sizes needs each size treated as its own cart line —
    // otherwise picking "L" then later "M" would just bump the quantity of
    // whichever row happened to exist. size is nullable (non-variant
    // products), and Postgres NULL never equals NULL via .eq(), so the
    // "no size" case has to use .is() instead.
    let existingQuery = req.supabase
      .from('cart_items')
      .select('id, quantity')
      .eq('user_id', req.user.id)
      .eq('product_id', product_id);
    existingQuery = size ? existingQuery.eq('size', size) : existingQuery.is('size', null);
    const { data: existing, error: existingError } = await existingQuery.maybeSingle();

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
      .insert({ user_id: req.user.id, product_id, quantity: qty, size, added_at: new Date().toISOString() });

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
        price: item.unit_price,
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

app.post('/api/payments/pesapal/initiate', requireAuth, async (req, res) => {
  try {
    const { orders, billing_address } = req.body || {};
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'No orders supplied' });
    }

    // Never trust client-sent prices/totals/brands: re-derive everything from
    // the products table. The client only supplies product_id, quantity, location.
    const requested = [];
    let location = 'Nairobi, Kenya';
    for (const order of orders) {
      if (order?.location && location === 'Nairobi, Kenya') location = String(order.location).slice(0, 200);
      for (const item of (Array.isArray(order?.items) ? order.items : [])) {
        const qty = Number.parseInt(item?.quantity, 10);
        if (!item?.product_id || !Number.isInteger(qty) || qty < 1 || qty > 100) {
          return res.status(400).json({ error: 'Invalid item or quantity' });
        }
        requested.push({ product_id: item.product_id, quantity: qty });
      }
    }
    if (requested.length === 0) {
      return res.status(400).json({ error: 'No valid orders created' });
    }

    const productIds = [...new Set(requested.map(r => r.product_id))];
    const { data: products, error: productsError } = await req.supabase
      .from('products')
      .select('id, brand_id, price, stock, sku')
      .in('id', productIds);
    if (productsError) throw productsError;
    const productMap = new Map((products || []).map(p => [String(p.id), p]));

    // Group by the brand that actually owns each product.
    const byBrand = new Map();
    for (const r of requested) {
      const p = productMap.get(String(r.product_id));
      if (!p) return res.status(400).json({ error: 'A product in your cart no longer exists' });
      if (p.stock != null && p.stock < r.quantity) {
        return res.status(400).json({ error: 'Not enough stock for one of the items' });
      }
      if (!byBrand.has(p.brand_id)) byBrand.set(p.brand_id, []);
      byBrand.get(p.brand_id).push({ product: p, quantity: r.quantity });
    }

    const checkoutGroupId = crypto.randomUUID();
    const created = [];
    let combinedTotal = 0;

    for (const [brand_id, lines] of byBrand.entries()) {
      const amount = lines.reduce((sum, l) => sum + (parseFloat(l.product.price) || 0) * l.quantity, 0);
      combinedTotal += amount;

      const { data, error } = await req.supabase
        .from('orders')
        .insert({
          user_id: req.user.id,
          brand_id,
          total_amount: amount.toFixed(2),
          status: 'pending',
          checkout_group_id: checkoutGroupId,
          location,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (error || !data) throw error || new Error('Failed to create order');

      const orderItems = lines.map(l => ({
        order_id: data.id,
        product_id: l.product.id,
        quantity: l.quantity,
        sku: l.product.sku || '',
        price: l.product.price,
        unit_price: l.product.price
      }));
      const { error: itemsError } = await req.supabase.from('order_items').insert(orderItems);
      if (itemsError) throw itemsError;

      created.push(data.id);
    }

    if (created.length === 0) {
      return res.status(400).json({ error: 'No valid orders created' });
    }
    if (combinedTotal <= 0) {
      return res.status(400).json({ error: 'Order total must be greater than zero' });
    }

    const billing = {
      email_address: billing_address?.email || req.user.email || '',
      phone_number: billing_address?.phone || '',
      country_code: 'KE',
      first_name: billing_address?.first_name || req.user.user_metadata?.name || 'Customer',
      last_name: billing_address?.last_name || '',
      line_1: billing_address?.line_1 || 'Nairobi'
    };

    const supabaseAdmin = createSupabaseServiceClient();
    const pesapalRes = await submitPesapalOrder({
      merchantReference: checkoutGroupId,
      amount: combinedTotal,
      description: `MerchMarket order ${checkoutGroupId}`.slice(0, 100),
      billing,
      supabaseAdmin
    });

    await req.supabase
      .from('orders')
      .update({ pesapal_tracking_id: pesapalRes.order_tracking_id })
      .eq('checkout_group_id', checkoutGroupId);

    res.json({ ok: true, redirect_url: pesapalRes.redirect_url, checkout_group_id: checkoutGroupId });
  } catch (e) {
    console.error('pesapal initiate error:', e.message);
    res.status(500).json({ error: 'Failed to start payment', details: e.message });
  }
});


// Shared handler for both GET and POST — Pesapal was registered with
// ipn_notification_type 'GET', but some Pesapal accounts/configs deliver via
// POST, so both are supported defensively.
async function handlePesapalIpn(req, res) {
  try {
    const params = { ...req.query, ...(req.body || {}) };
    const orderTrackingId = params.OrderTrackingId || params.orderTrackingId;
    const merchantReference = params.OrderMerchantReference || params.orderMerchantReference;
    const notificationType = params.OrderNotificationType || params.orderNotificationType || 'IPNCHANGE';

    if (!orderTrackingId) {
      return res.status(400).json({ error: 'Missing OrderTrackingId' });
    }

    // Never trust the webhook payload's status alone — independently verify
    // with Pesapal via GetTransactionStatus before writing anything.
    const statusPayload = await getPesapalTransactionStatus(orderTrackingId);
    const paymentStatus = pesapalStatusToPaymentStatus(statusPayload);

    const supabaseAdmin = createSupabaseServiceClient();
    const { error } = await supabaseAdmin
      .from('orders')
      .update({ payment_status: paymentStatus, pesapal_tracking_id: orderTrackingId })
      .eq('checkout_group_id', merchantReference || '__no_match__');

    if (error) throw error;

    // Pesapal expects this exact ack shape back.
    res.json({
      orderNotificationType: notificationType,
      orderTrackingId,
      orderMerchantReference: merchantReference || '',
      status: 200
    });
  } catch (e) {
    console.error('pesapal ipn error:', e.message);
    res.status(500).json({ error: 'IPN processing failed', details: e.message });
  }
}

app.get('/api/payments/pesapal/ipn', handlePesapalIpn);
app.post('/api/payments/pesapal/ipn', handlePesapalIpn);

// Polled by payment-return.html after Pesapal redirects the browser back,
// since the IPN webhook can arrive a few seconds after the redirect.
app.get('/api/payments/pesapal/status', requireAuth, async (req, res) => {
  try {
    const { checkout_group_id } = req.query;
    if (!checkout_group_id) {
      return res.status(400).json({ error: 'checkout_group_id is required' });
    }

    const { data, error } = await req.supabase
      .from('orders')
      .select('id, payment_status, status, pesapal_tracking_id')
      .eq('checkout_group_id', checkout_group_id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'No orders found for this checkout' });
    }

    // Don't depend solely on the IPN webhook: if still unpaid, ask Pesapal
    // directly (the same verified call the IPN handler makes).
    const trackingId = data.find(o => o.pesapal_tracking_id)?.pesapal_tracking_id;
    if (trackingId && data.some(o => o.payment_status !== 'paid' && o.payment_status !== 'failed')) {
      try {
        const statusPayload = await getPesapalTransactionStatus(trackingId);
        const verified = pesapalStatusToPaymentStatus(statusPayload);
        if (verified !== 'unpaid') {
          const supabaseAdmin = createSupabaseServiceClient();
          const { error: updError } = await supabaseAdmin
            .from('orders')
            .update({ payment_status: verified })
            .eq('checkout_group_id', checkout_group_id)
            .eq('user_id', req.user.id);
          if (!updError) data.forEach(o => { o.payment_status = verified; });
        }
      } catch (verifyErr) {
        console.error('pesapal direct verify failed:', verifyErr.message);
      }
    }

    const anyFailed = data.some(o => o.payment_status === 'failed');
    const allPaid = data.every(o => o.payment_status === 'paid');
    res.json({ orders: data.map(({ pesapal_tracking_id, ...o }) => o), payment_status: allPaid ? 'paid' : (anyFailed ? 'failed' : 'unpaid') });
  } catch (e) {
    res.status(500).json({ error: 'Failed to check payment status', details: e.message });
  }
});

app.get('/api/brand/orders', requireAuth, requireBrand, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('orders')
      .select(`
        id, total_amount, status, payment_status, location, created_at,
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
        id, total_amount, status, payment_status, location, created_at,
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
    const { status, tracking_number, carrier, note } = req.body || {};
    // 'completed' (delivered) is deliberately absent: only a courier scan can set it.
    const allowed = ['confirmed', 'active', 'shipped', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Delivery is confirmed by the courier scan, not by the seller.' });
    }

    const clean = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const update = { status };
    const trk = clean(tracking_number, 80);
    const car = clean(carrier, 80);
    const nt  = clean(note, 300);
    if (trk) update.tracking_number = trk;
    if (car) update.carrier = car;
    if (nt)  update.last_status_note = nt;

    const { data, error } = await req.supabase
      .from('orders')
      .update(update)
      .eq('id', req.params.id)
      .eq('brand_id', req.brandProfile.id)
      .select('id, status, payment_status, tracking_number, carrier');

    if (error) {
      // Database rules (payment gate, allowed moves, system-only fields) surface here.
      if (/payment_status is paid/i.test(error.message || '')) {
        return res.status(409).json({ error: 'This order has not been paid yet — it cannot be progressed until payment is confirmed.' });
      }
      if (/cannot move from/i.test(error.message || '')) {
        return res.status(409).json({ error: error.message.split('\n')[0] });
      }
      if (error.code === '42501' || /only be changed by the system/i.test(error.message || '')) {
        return res.status(403).json({ error: 'That field can only be changed by the system.' });
      }
      throw error;
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Order not found or permission denied' });
    }

    res.json({ ok: true, order: data[0] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update order status', details: e.message });
  }
});

// Buyer: fetch the delivery QR token + backup code for one of their shipped orders.
// The codes live in a table brands cannot read; only the order's buyer gets them here.
app.get('/api/member/orders/:id/delivery-code', requireAuth, async (req, res) => {
  try {
    const { data: order, error } = await req.supabase
      .from('orders')
      .select('id, user_id, status')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'shipped') {
      return res.status(409).json({ error: 'A delivery code is only available while your order is shipped.' });
    }

    const admin = createSupabaseServiceClient();
    const { data: code, error: codeErr } = await admin
      .from('delivery_codes')
      .select('token, short_code, redeemed_at')
      .eq('order_id', order.id)
      .maybeSingle();
    if (codeErr) throw codeErr;
    if (!code || code.redeemed_at) return res.status(404).json({ error: 'No active delivery code for this order' });

    res.json({ order_id: order.id, token: code.token, short_code: code.short_code });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load delivery code', details: e.message });
  }
});

// Courier: confirm a delivery by QR token, or by order id + 6-digit backup code.
// Auth is a courier access code (header x-courier-code), checked against couriers.access_code_hash.
app.post('/api/courier/confirm-delivery', async (req, res) => {
  try {
    const crypto = require('crypto');
    const rawCode = String(req.headers['x-courier-code'] || '').trim();
    if (!rawCode) return res.status(401).json({ error: 'Courier access code required' });

    const admin = createSupabaseServiceClient();
    const hash = crypto.createHash('sha256').update(rawCode, 'utf8').digest('hex');
    const { data: courier, error: cErr } = await admin
      .from('couriers').select('id, name').eq('access_code_hash', hash).eq('active', true).maybeSingle();
    if (cErr) throw cErr;
    if (!courier) return res.status(401).json({ error: 'Invalid courier access code' });

    const { token, order_id, short_code } = req.body || {};
    const { data: result, error } = await admin.rpc('confirm_delivery', {
      p_courier: courier.id,
      p_token: typeof token === 'string' && token ? token.trim() : null,
      p_order_id: typeof order_id === 'string' && order_id ? order_id.trim() : null,
      p_short_code: typeof short_code === 'string' && short_code ? short_code.trim() : null
    });
    if (error) throw error;

    if (result && result.ok) return res.json({ ok: true, order_id: result.order_id });

    const reason = result && result.reason;
    const map = {
      invalid:          [400, 'That code is not valid.'],
      locked:           [429, 'Too many wrong attempts for this order. Ask the buyer to contact support.'],
      already_redeemed: [409, 'This delivery was already confirmed.'],
      not_shipped:      [409, 'This order is not marked as shipped.'],
      unpaid:           [409, 'This order has not been paid.']
    };
    const [code, msg] = map[reason] || [400, 'Could not confirm delivery.'];
    res.status(code).json({ ok: false, reason, error: msg });
  } catch (e) {
    res.status(500).json({ error: 'Failed to confirm delivery', details: e.message });
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

// Garment measurement field names the add-item.html variant editor can
// send, per item type. Kept as one flat whitelist here (rather than
// duplicating the per-category mapping) — a field being technically valid
// for a category it wasn't shown for is harmless, the UI is what enforces
// which fields make sense per type.
const GARMENT_FIELD_WHITELIST = new Set([
  'chest_cm', 'shoulder_cm', 'length_cm', 'waist_cm', 'hip_cm', 'inseam_cm'
]);

// Validates the size_specs array sent from add-item.html: array of
// { size_label, garment: { <whitelisted_key>: cm } }. Drops any entry with
// no label or no valid garment measurements. Returns null (not []) when
// the input isn't an array at all, so callers can distinguish "field not
// sent, leave existing data alone" from "sent as an empty array, clear it".
function cleanSizeSpecs(rawSizeSpecs) {
  if (!Array.isArray(rawSizeSpecs)) return null;
  return rawSizeSpecs
    .map(entry => {
      const size_label = String(entry?.size_label ?? '').trim();
      const garmentRaw = entry?.garment && typeof entry.garment === 'object' ? entry.garment : {};
      const garment = {};
      Object.entries(garmentRaw).forEach(([key, val]) => {
        if (!GARMENT_FIELD_WHITELIST.has(key)) return;
        const num = Number.parseFloat(val);
        if (Number.isFinite(num) && num > 0 && num < 300) garment[key] = num;
      });
      return size_label && Object.keys(garment).length ? { size_label, garment } : null;
    })
    .filter(Boolean);
}

function cleanVariants(rawVariants) {
  if (!Array.isArray(rawVariants)) return null;
  return rawVariants
    .map(v => ({
      size_label: String(v?.size_label ?? v?.size ?? '').trim(),
      stock: Number.parseInt(v?.stock, 10)
    }))
    .filter(v => v.size_label && Number.isFinite(v.stock) && v.stock >= 0);
}

// -------- Vendor KYC (spec section 7) --------
const KRA_PIN_RE = /^[AP][0-9]{9}[A-Z]$/;
const KYC_BUSINESS_TYPES = ['sole_trader', 'company'];
const KYC_CATEGORIES = ['goods', 'services', 'both'];
const KYC_PAYOUT_METHODS = ['mpesa_till', 'mpesa_paybill', 'bank'];

const KYC_STATUS_MESSAGES = {
  pending: 'Your brand account is pending approval. You can list products once MerchMarket has reviewed and approved it.',
  documents_submitted: 'Your documents are being checked. You can list products once your account is approved.',
  under_review: 'Your brand account is under review. You can list products once it is approved.',
  rejected: 'Your brand application was not approved. Update your details on the Profile page and resubmit.',
  suspended: 'Your brand account is suspended. Contact MerchMarket support to resolve this.'
};

// Blocks listing/editing products until the brand's vendor_kyc.status is 'approved'.
async function requireApprovedBrand(req, res, next) {
  try {
    const { data, error } = await req.supabase
      .from('vendor_kyc')
      .select('status, status_reason')
      .eq('brand_id', req.brandProfile.id)
      .maybeSingle();
    if (error) throw error;

    const status = data?.status || 'pending';
    if (status !== 'approved') {
      res.status(403).json({
        error: KYC_STATUS_MESSAGES[status] || KYC_STATUS_MESSAGES.pending,
        code: 'BRAND_NOT_APPROVED',
        status,
        reason: data?.status_reason || null
      });
      return;
    }
    next();
  } catch (e) {
    res.status(500).json({ error: 'Could not verify brand approval status', details: e.message });
  }
}

// Business, tax and payout details are fraud-sensitive: editable for 42h after
// the vendor_kyc row is created (signup), then locked. Locked fields can still be
// filled in if they are empty, and a rejected application can always be fixed.
const KYC_EDIT_WINDOW_HOURS = 42;
const KYC_FREE_FIELDS = ['contact_person', 'phone'];
const KYC_LOCKED_FIELDS = [
  'business_type', 'kra_pin', 'product_category',
  'payout_method', 'payout_account_number', 'payout_account_name', 'payout_bank_name'
];
const KYC_VALIDATORS = {
  business_type: v => KYC_BUSINESS_TYPES.includes(v) ? null : 'Choose a business type.',
  contact_person: v => v ? null : 'Contact person is required.',
  phone: v => /^(\+?254|0)[17][0-9]{8}$/.test(v) ? null : 'Enter a valid Kenyan phone number.',
  kra_pin: v => KRA_PIN_RE.test(v) ? null : 'KRA PIN must look like A123456789Z.',
  product_category: v => KYC_CATEGORIES.includes(v) ? null : 'Choose a product category.',
  payout_method: v => KYC_PAYOUT_METHODS.includes(v) ? null : 'Choose a payout method.',
  payout_account_number: v => v ? null : 'Payout number is required.',
  payout_account_name: v => v ? null : 'Payout account name is required.',
  payout_bank_name: () => null
};

function normalizeKycValue(key, raw) {
  let v = typeof raw === 'string' ? raw.trim() : '';
  if (key === 'kra_pin') return v.toUpperCase().slice(0, 11);
  if (key === 'phone') return v.replace(/[\s-]/g, '').slice(0, 20);
  return v.slice(0, 120);
}

async function getKycState(admin, brandId) {
  const { data, error } = await admin.from('vendor_kyc').select('*').eq('brand_id', brandId).maybeSingle();
  if (error) throw error;
  if (!data) return { row: null, locked: false, lockAt: null };
  const lockAt = new Date(new Date(data.created_at).getTime() + KYC_EDIT_WINDOW_HOURS * 3600 * 1000);
  const reopenedUntil = data.reopened_until ? new Date(data.reopened_until) : null;
  const reopened = !!(reopenedUntil && reopenedUntil.getTime() > Date.now());
  const locked = Date.now() >= lockAt.getTime() && data.status !== 'rejected' && !reopened;
  return {
    row: data, locked, lockAt: lockAt.toISOString(),
    reopenedUntil: reopened ? reopenedUntil.toISOString() : null
  };
}

app.get('/api/brand/kyc', requireAuth, requireBrand, async (req, res) => {
  try {
    const { row, locked, lockAt, reopenedUntil } = await getKycState(createSupabaseServiceClient(), req.brandProfile.id);
    if (row) { delete row.reopened_by; delete row.reopen_reason; }
    res.json({
      kyc: row,
      locked,
      lock_at: lockAt,
      reopened_until: reopenedUntil,
      edit_window_hours: KYC_EDIT_WINDOW_HOURS,
      locked_fields: KYC_LOCKED_FIELDS
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load verification details', details: e.message });
  }
});

app.put('/api/brand/kyc', requireAuth, requireBrand, async (req, res) => {
  try {
    const admin = createSupabaseServiceClient();
    const { row, locked } = await getKycState(admin, req.brandProfile.id);
    const body = req.body || {};
    const updates = {};

    for (const key of [...KYC_FREE_FIELDS, ...KYC_LOCKED_FIELDS]) {
      if (!(key in body)) continue;
      const value = normalizeKycValue(key, body[key]);
      const current = row?.[key] ?? null;
      if ((current ?? '') === value) continue; // unchanged

      if (KYC_LOCKED_FIELDS.includes(key) && locked && current) {
        return res.status(403).json({
          error: 'Business, tax and payout details can no longer be changed here. Contact MerchMarket support if something is wrong.',
          code: 'KYC_LOCKED',
          field: key
        });
      }
      if (value || KYC_FREE_FIELDS.includes(key) || key !== 'payout_bank_name') {
        const msg = KYC_VALIDATORS[key](value);
        if (msg) return res.status(400).json({ error: msg, field: key });
      }
      updates[key] = value || null;
    }

    const merged = { ...(row || {}), ...updates };
    if (merged.payout_method === 'bank' && !merged.payout_bank_name) {
      return res.status(400).json({ error: 'Bank name is required for bank payouts.', field: 'payout_bank_name' });
    }
    if (merged.payout_method && merged.payout_method !== 'bank' && merged.payout_bank_name) {
      updates.payout_bank_name = null;
    }
    if ('kra_pin' in updates) updates.kra_pin_verified_at = null;

    if (!Object.keys(updates).length) return res.json({ ok: true, unchanged: true });

    const resubmit = !row || row.status === 'rejected';
    const { error } = await admin.from('vendor_kyc').upsert({
      brand_id: req.brandProfile.id,
      ...updates,
      ...(resubmit ? { status: 'pending', status_reason: null } : {}),
      updated_at: new Date().toISOString()
    }, { onConflict: 'brand_id' });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That KRA PIN is already registered to another vendor.', field: 'kra_pin' });
      throw error;
    }
    res.json({ ok: true, status: resubmit ? 'pending' : row.status });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save verification details', details: e.message });
  }
});

app.post('/api/brand/products', requireAuth, requireBrand, requireApprovedBrand, async (req, res) => {
  try {
    const { variants: rawVariants, size_specs: rawSizeSpecs, ...rest } = req.body;
    const variants = cleanVariants(rawVariants);
    const sizeSpecs = cleanSizeSpecs(rawSizeSpecs); // null = not sent, don't set the column

    const payload = {
      ...rest,
      ...(sizeSpecs !== null ? { size_specs: sizeSpecs } : {}),
      brand_id: req.brandProfile.id,
      seller: req.brandProfile.name,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    };

    const { data: inserted, error } = await req.supabase
      .from('products')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw error;

    if (variants && variants.length) {
      const { error: variantError } = await req.supabase
        .from('product_variants')
        .insert(variants.map(v => ({ ...v, product_id: inserted.id })));
      if (variantError) throw variantError;
    }

    // Re-fetch: the variant rollup trigger may have just updated stock/sizes
    const { data: final, error: refetchError } = await req.supabase
      .from('products')
      .select('*')
      .eq('id', inserted.id)
      .single();
    if (refetchError) throw refetchError;

    res.json({ product: final });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add product', details: e.message });
  }
});

app.put('/api/brand/products/:id', requireAuth, requireBrand, requireApprovedBrand, async (req, res) => {
  try {
    const { variants: rawVariants, size_specs: rawSizeSpecs, ...rest } = req.body;
    const variants = cleanVariants(rawVariants); // null = field omitted entirely, [] = cleared
    const sizeSpecs = cleanSizeSpecs(rawSizeSpecs); // same null/[] distinction

    const manualStock = Number.parseInt(rest.stock, 10);

    const payload = {
      ...rest,
      ...(sizeSpecs !== null ? { size_specs: sizeSpecs } : {}),
      brand_id: req.brandProfile.id,
      seller: req.brandProfile.name,
      updated_at: new Date().toISOString()
    };

    const { error: updateError } = await req.supabase
      .from('products')
      .update(payload)
      .eq('id', req.params.id)
      .eq('brand_id', req.brandProfile.id);

    if (updateError) throw updateError;

    if (variants !== null) {
      // Replace-all: simplest correct reconciliation, the rollup trigger
      // recalculates products.stock/sizes after each variant-table write.
      const { error: deleteError } = await req.supabase
        .from('product_variants')
        .delete()
        .eq('product_id', req.params.id);
      if (deleteError) throw deleteError;

      if (variants.length) {
        const { error: insertError } = await req.supabase
          .from('product_variants')
          .insert(variants.map(v => ({ ...v, product_id: req.params.id })));
        if (insertError) throw insertError;
      } else if (Number.isFinite(manualStock) && manualStock >= 0) {
        // No sizes submitted — brand wants plain stock again.
        // The trigger just zeroed products.stock (no variants left), restore it.
        const { error: fallbackError } = await req.supabase
          .from('products')
          .update({ stock: manualStock })
          .eq('id', req.params.id)
          .eq('brand_id', req.brandProfile.id);
        if (fallbackError) throw fallbackError;
      }
    }

    const { data: final, error: refetchError } = await req.supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (refetchError) throw refetchError;

    res.json({ product: final });
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

// -------- Admin (vendor review) --------
// Admins are identified server-side only: an allow-list of verified emails in the
// ADMIN_EMAILS env var, or app_metadata.role === 'admin' (only settable with the
// service key). profiles.role is NOT used — users can edit their own profile row.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function requireAdmin(req, res, next) {
  const u = req.user || {};
  const email = (u.email || '').toLowerCase();
  const isAdmin = (u.app_metadata?.role === 'admin') ||
    (u.email_confirmed_at && ADMIN_EMAILS.includes(email));
  if (!isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

app.get('/api/admin/vendors', requireAuth, requireAdmin, async (req, res) => {
  try {
    const admin = createSupabaseServiceClient();
    const { data: rows, error } = await admin.from('vendor_kyc').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const ids = (rows || []).map(r => r.brand_id);
    const { data: profs, error: pErr } = ids.length
      ? await admin.from('profiles').select('id, name, email').in('id', ids)
      : { data: [], error: null };
    if (pErr) throw pErr;
    const byId = new Map((profs || []).map(p => [p.id, p]));

    const now = Date.now();
    res.json({
      vendors: (rows || []).map(r => {
        const lockAtMs = new Date(r.created_at).getTime() + KYC_EDIT_WINDOW_HOURS * 3600 * 1000;
        const reopened = !!(r.reopened_until && new Date(r.reopened_until).getTime() > now);
        return {
          ...r,
          name: byId.get(r.brand_id)?.name || null,
          email: byId.get(r.brand_id)?.email || null,
          lock_at: new Date(lockAtMs).toISOString(),
          editable: now < lockAtMs || reopened || r.status === 'rejected',
          reopened
        };
      })
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load vendors', details: e.message });
  }
});

app.post('/api/admin/vendors/:brandId/reopen', requireAuth, requireAdmin, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.body?.hours, 10) || 24, 1), 72);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
    if (!reason) return res.status(400).json({ error: 'Give a reason for reopening (kept for the audit trail).' });

    const now = new Date();
    const { data, error } = await createSupabaseServiceClient()
      .from('vendor_kyc')
      .update({
        reopened_until: new Date(now.getTime() + hours * 3600 * 1000).toISOString(),
        reopened_by: req.user.email,
        reopen_reason: reason,
        reopened_at: now.toISOString(),
        updated_at: now.toISOString()
      })
      .eq('brand_id', req.params.brandId)
      .select('brand_id, reopened_until')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Vendor not found.' });
    console.log(`[admin] ${req.user.email} reopened vendor ${req.params.brandId} for ${hours}h: ${reason}`);
    res.json({ ok: true, reopened_until: data.reopened_until });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reopen vendor details', details: e.message });
  }
});

app.post('/api/admin/vendors/:brandId/lock', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await createSupabaseServiceClient()
      .from('vendor_kyc')
      .update({ reopened_until: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('brand_id', req.params.brandId)
      .select('brand_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Vendor not found.' });
    console.log(`[admin] ${req.user.email} re-locked vendor ${req.params.brandId}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to lock vendor details', details: e.message });
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
    const { locked, lockAt } = await getKycState(createSupabaseServiceClient(), req.brandProfile.id);
    res.json({ payments: data, locked: !!(locked && data), lock_at: lockAt });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load payment details', details: e.message });
  }
});

// Payout details follow the same 42h window as the KYC payout fields; otherwise
// they would be a way around the lock. Writes go through the service client
// (the browser write policies are removed at deploy time).
app.post('/api/brand/payments', requireAuth, requireBrand, async (req, res) => {
  try {
    const admin = createSupabaseServiceClient();
    const { locked } = await getKycState(admin, req.brandProfile.id);
    if (locked) {
      const { data: existing, error: exErr } = await admin
        .from('vendor_payments').select('id').eq('brand_id', req.brandProfile.id).maybeSingle();
      if (exErr) throw exErr;
      if (existing) {
        return res.status(403).json({
          error: 'Payout details can no longer be changed here. Contact MerchMarket support if something is wrong.',
          code: 'PAYOUT_LOCKED'
        });
      }
    }

    const { method, label, details } = req.body || {};
    const { error } = await admin
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
    res.status(500).json({ error: 'Failed to save payout details', details: e.message });
  }
});

// -------- Brand account deletion --------
function storagePathFromUrl(url) {
  if (typeof url !== 'string') return null;
  const part = url.split('/product-images/')[1];
  return part ? decodeURIComponent(part.split('?')[0]) : null;
}

// Removes the brand's uploaded images except those still used by archived
// products (kept because paid orders reference them).
async function purgeBrandImages(admin, brandId) {
  const { data: kept, error } = await admin
    .from('products').select('images').eq('brand_id', brandId).not('archived_at', 'is', null);
  if (error) throw error;

  const keep = new Set();
  for (const p of kept || []) {
    for (const img of Array.isArray(p.images) ? p.images : []) {
      if (typeof img === 'string') { const sp = storagePathFromUrl(img); if (sp) keep.add(sp); continue; }
      if (img && typeof img === 'object') {
        if (img.path) keep.add(img.path);
        const sp = storagePathFromUrl(img.url || img.image);
        if (sp) keep.add(sp);
      }
    }
  }

  const bucket = admin.storage.from('product-images');
  const toRemove = [];
  for (let offset = 0; ; offset += 100) {
    const { data: files, error: listErr } = await bucket.list(brandId, { limit: 100, offset });
    if (listErr) throw listErr;
    if (!files || !files.length) break;
    for (const f of files) {
      const path = `${brandId}/${f.name}`;
      if (!keep.has(path)) toRemove.push(path);
    }
    if (files.length < 100) break;
  }
  for (let i = 0; i < toRemove.length; i += 100) {
    const { error: rmErr } = await bucket.remove(toRemove.slice(i, i + 100));
    if (rmErr) throw rmErr;
  }
  return toRemove.length;
}

app.get('/api/brand/account/deletion-check', requireAuth, requireBrand, async (req, res) => {
  try {
    const { data, error } = await createSupabaseServiceClient()
      .rpc('brand_deletion_blockers', { p_brand: req.brandProfile.id });
    if (error) throw error;
    res.json({
      canDelete: data.open_orders === 0 && data.unsettled_funds === 0,
      open_orders: data.open_orders,
      unsettled_funds: data.unsettled_funds,
      unpaid_orders: data.unpaid_orders
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to check account status', details: e.message });
  }
});

app.post('/api/brand/account/delete', requireAuth, requireBrand, async (req, res) => {
  try {
    const { password, confirm } = req.body || {};
    if (confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
    if (!password || !req.user?.email) return res.status(400).json({ error: 'Enter your password to confirm.' });

    // Re-authenticate: a stolen session alone must not be able to wipe an account.
    const { error: pwError } = await createSupabaseClient().auth.signInWithPassword({
      email: req.user.email,
      password
    });
    if (pwError) return res.status(401).json({ error: 'Incorrect password.' });

    const admin = createSupabaseServiceClient();
    const brandId = req.brandProfile.id;

    const { data: summary, error } = await admin.rpc('delete_brand_account_data', { p_brand: brandId });
    if (error) {
      if (/BRAND_DELETION_BLOCKED/.test(error.message)) {
        return res.status(409).json({
          error: 'You still have confirmed orders in progress or funds awaiting release. Complete or settle them first.',
          code: 'BRAND_DELETION_BLOCKED'
        });
      }
      throw error;
    }

    let imagesRemoved = null;
    try { imagesRemoved = await purgeBrandImages(admin, brandId); }
    catch (e) { console.error('brand image cleanup failed for', brandId, e.message); }

    const { error: authError } = await admin.auth.admin.deleteUser(brandId);
    if (authError) {
      console.error('brand auth deletion failed for', brandId, authError.message);
      return res.status(500).json({
        error: 'Your data was removed but we could not close your login. Please contact MerchMarket support.',
        summary
      });
    }

    res.json({ ok: true, summary: { ...summary, images_removed: imagesRemoved } });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete account', details: e.message });
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
app.get('/brand-profile.html', requireBrandSession, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'brand-profile.html')));
app.get('/add-item.html', requireBrandSession, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'add-item.html')));
app.get('/view-order.html', requireBrandSession, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'view-order.html')));
app.get('/wishlist.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'wishlist.html')));
app.get('/product.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'product.html')));
app.get('/cart.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cart.html')));
app.get('/orders.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'orders.html')));

// Never serve source, migrations or project metadata from the static root.
app.use((req, res, next) => {
  if (/^\/(server\.js|package(-lock)?\.json|vercel\.json|TODO\.md|README\.md|CNAME|migrations(\/|$))/i.test(req.path) ||
      /\/\.|\.sql$/i.test(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

// Static assets
app.use(express.static(PUBLIC_DIR));

// Fallback 404
app.use((req, res) => res.status(404).send('Not found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MerchMarket server running on http://localhost:${PORT}`);
});


