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

const PESAPAL_ENV = process.env.PESAPAL_ENV || 'sandbox';
const PESAPAL_BASE_URL = PESAPAL_ENV === 'live'
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';
const PESAPAL_CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const PESAPAL_CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;
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
    throw new Error(`Pesapal auth failed: ${payload.message || res.statusText}`);
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

  const isSensitivePage = ['brandflow.html', 'brand-profile.html', 'add-item.html', 'view-order.html', 'profile.html', 'orders.html', 'wishlist.html', 'cart.html', 'login.html', 'signup.html', 'verify.html'].some(page => req.path.endsWith(page));
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

app.post('/api/payments/pesapal/initiate', requireAuth, async (req, res) => {
  try {
    const { orders, billing_address } = req.body || {};
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'No orders supplied' });
    }

    const checkoutGroupId = crypto.randomUUID();
    const created = [];
    let combinedTotal = 0;

    for (const order of orders) {
      const { brand_id, total_amount, location, items = [] } = order || {};
      if (!brand_id || !Array.isArray(items) || items.length === 0) continue;

      const amount = parseFloat(total_amount) || 0;
      combinedTotal += amount;

      const { data, error } = await req.supabase
        .from('orders')
        .insert({
          user_id: req.user.id,
          brand_id,
          total_amount: String(total_amount ?? '0.00'),
          status: 'pending',
          checkout_group_id: checkoutGroupId,
          location: location || 'Nairobi, Kenya',
          created_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (error || !data) throw error || new Error('Failed to create order');

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
      .select('id, payment_status, status')
      .eq('checkout_group_id', checkout_group_id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'No orders found for this checkout' });
    }

    const anyFailed = data.some(o => o.payment_status === 'failed');
    const allPaid = data.every(o => o.payment_status === 'paid');
    res.json({ orders: data, payment_status: allPaid ? 'paid' : (anyFailed ? 'failed' : 'unpaid') });
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
    const { status } = req.body || {};
    const allowed = ['pending', 'confirmed', 'active', 'completed', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const { data, error } = await req.supabase
      .from('orders')
      .update({ status })
      .eq('id', req.params.id)
      .eq('brand_id', req.brandProfile.id)
      .select('id, status, payment_status');

    if (error) {
      // The DB-level payment-gate trigger blocks unpaid orders from being
      // progressed — surface that as a clean, expected 409 rather than a
      // generic 500, since any client (this route, or a future one) hits
      // the same trigger and the message should be actionable.
      if (/payment_status is paid/i.test(error.message || '')) {
        return res.status(409).json({ error: 'This order has not been paid yet — it cannot be progressed until payment is confirmed.' });
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

function cleanVariants(rawVariants) {
  if (!Array.isArray(rawVariants)) return null;
  return rawVariants
    .map(v => ({
      size_label: String(v?.size_label ?? v?.size ?? '').trim(),
      stock: Number.parseInt(v?.stock, 10)
    }))
    .filter(v => v.size_label && Number.isFinite(v.stock) && v.stock >= 0);
}

app.post('/api/brand/products', requireAuth, requireBrand, async (req, res) => {
  try {
    const { variants: rawVariants, ...rest } = req.body;
    const variants = cleanVariants(rawVariants);

    const payload = {
      ...rest,
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

app.put('/api/brand/products/:id', requireAuth, requireBrand, async (req, res) => {
  try {
    const { variants: rawVariants, ...rest } = req.body;
    const variants = cleanVariants(rawVariants); // null = field omitted entirely, [] = cleared

    const manualStock = Number.parseInt(rest.stock, 10);

    const payload = {
      ...rest,
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
app.get('/brand-profile.html', requireBrandSession, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'brand-profile.html')));
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


