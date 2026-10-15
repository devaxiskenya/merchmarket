// MerchMarket private admin app.
//
// Runs as its own Vercel project (root directory: admin/), behind Vercel Authentication,
// with no public domain. On top of that, every request needs an admin session issued here:
// a Supabase password login for an email listed in ADMIN_EMAILS. Anything else gets a 404,
// and the dashboard's own code is only sent once signed in.
//
// Env: SUPABASE_URL, SUPABASE_KEY (publishable), SUPABASE_SERVICE_ROLE_KEY,
//      ADMIN_EMAILS (comma-separated), ADMIN_SESSION_SECRET (long random string),
//      COMMISSION_RATE (optional, default 0.12)

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://omyzcnizwxumvookotsy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_2Dvox3zHhG4WG7An-sn0tQ_eZ9z6xh8';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
const COMMISSION_RATE = Math.min(Math.max(parseFloat(process.env.COMMISSION_RATE || '0.12') || 0.12, 0), 1);
const SESSION_HOURS = 8;
const KYC_EDIT_WINDOW_HOURS = 42;
const COOKIE = 'mm_admin';
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PROD = !!process.env.VERCEL || process.env.NODE_ENV === 'production';

const adminEmails = () => (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function db() {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ── Security headers ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

// ── Session cookie (HMAC-signed, HttpOnly) ───────────────────────
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function readSession(req) {
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) return null;
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [body, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!s.email || !s.exp || Date.now() > s.exp) return null;
    if (!adminEmails().includes(String(s.email).toLowerCase())) return null; // removed from the list = signed out
    return s;
  } catch (e) { return null; }
}
function setSession(res, email) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  res.setHeader('Set-Cookie',
    `${COOKIE}=${sign({ email, exp })}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${IS_PROD ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${IS_PROD ? '; Secure' : ''}`);
}

const notFound = (res) => res.status(404).type('text').send('Not found');

// ── Login (the only things reachable without a session) ──────────
const loginFails = new Map();
function throttled(ip) {
  const f = loginFails.get(ip);
  return !!(f && f.count >= 5 && Date.now() - f.first < 15 * 60 * 1000);
}
function failed(ip) {
  const now = Date.now();
  const f = loginFails.get(ip);
  if (!f || now - f.first > 15 * 60 * 1000) loginFails.set(ip, { count: 1, first: now });
  else f.count += 1;
}

app.get('/login', (req, res) => {
  if (readSession(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/login.js', (req, res) => res.sendFile(path.join(__dirname, 'login.js')));

app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (throttled(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    return res.status(500).json({ error: 'ADMIN_SESSION_SECRET is not set on this deployment.' });
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  // Same message for every failure, so the form doesn't reveal which emails are admins.
  const deny = () => { failed(ip); res.status(401).json({ error: 'Email or password is incorrect.' }); };
  if (!email || !password || !adminEmails().includes(email)) return deny();
  try {
    const auth = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await auth.auth.signInWithPassword({ email, password });
    if (error || !data?.user || !data.user.email_confirmed_at) return deny();
    await auth.auth.signOut().catch(() => {});
    setSession(res, email);
    await logAction(email, 'login', null, null, { ip });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

// ── Everything below requires an admin session ───────────────────
app.use((req, res, next) => {
  const s = readSession(req);
  if (!s) {
    if (req.method === 'GET' && req.path === '/') return res.redirect('/login');
    return notFound(res);
  }
  // Writes must be JSON from this app's own pages (SameSite=Strict cookie + this header).
  if (req.method !== 'GET' && !req.is('application/json')) return notFound(res);
  req.admin = s.email;
  next();
});

async function logAction(email, action, targetType, targetId, details) {
  try {
    await db().from('admin_actions').insert({
      admin_email: email, action, target_type: targetType, target_id: targetId ? String(targetId) : null,
      details: details || null
    });
  } catch (e) { console.error('admin_actions insert failed:', e.message); }
}

// Fetch every row of a query, 1000 at a time.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
    if (from > 50000) break;
  }
  return out;
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clean = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const asyncRoute = (fn) => (req, res) => fn(req, res).catch(e => {
  console.error(req.method, req.path, e.message);
  res.status(500).json({ error: e.message || 'Something went wrong' });
});

app.get('/api/me', (req, res) => res.json({ email: req.admin, commission_rate: COMMISSION_RATE }));

// ── Overview ─────────────────────────────────────────────────────
app.get('/api/overview', asyncRoute(async (req, res) => {
  const s = db();
  const [orders, profiles, products, couriers, waitlist] = await Promise.all([
    fetchAll(() => s.from('orders').select('id, status, payment_status, total_amount, created_at, brand_id')),
    fetchAll(() => s.from('profiles').select('id, type, created_at, deleted_at')),
    fetchAll(() => s.from('products').select('id, archived_at, admin_hidden_at')),
    fetchAll(() => s.from('couriers').select('id, active')),
    s.from('waitlist').select('id', { count: 'exact', head: true })
  ]);

  const paid = orders.filter(o => o.payment_status === 'paid' && o.status !== 'cancelled');
  const delivered = paid.filter(o => o.status === 'completed');
  const gmv = paid.reduce((t, o) => t + (Number(o.total_amount) || 0), 0);
  const deliveredValue = delivered.reduce((t, o) => t + (Number(o.total_amount) || 0), 0);

  const byStatus = {};
  orders.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });

  // Last 30 days, Nairobi dates.
  const dayKey = (d) => new Date(new Date(d).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(dayKey(Date.now() - i * 86400000));
  const sales = Object.fromEntries(days.map(d => [d, 0]));
  const signups = Object.fromEntries(days.map(d => [d, 0]));
  paid.forEach(o => { const k = dayKey(o.created_at); if (k in sales) sales[k] += Number(o.total_amount) || 0; });
  profiles.forEach(p => { const k = p.created_at && dayKey(p.created_at); if (k && k in signups) signups[k] += 1; });

  const live = profiles.filter(p => !p.deleted_at);
  const since30 = Date.now() - 30 * 86400000;
  res.json({
    commission_rate: COMMISSION_RATE,
    gmv: money(gmv),
    commission: money(gmv * COMMISSION_RATE),
    delivered_value: money(deliveredValue),
    owed_to_brands: money(deliveredValue * (1 - COMMISSION_RATE)),
    orders_total: orders.length,
    orders_paid: paid.length,
    orders_awaiting_payment: orders.filter(o => o.payment_status !== 'paid' && o.status !== 'cancelled').length,
    orders_to_ship: paid.filter(o => ['pending', 'confirmed', 'active'].includes(o.status)).length,
    orders_in_transit: paid.filter(o => o.status === 'shipped').length,
    by_status: byStatus,
    members: live.filter(p => p.type === 'member').length,
    brands: live.filter(p => p.type === 'brand').length,
    signups_30d: live.filter(p => p.created_at && new Date(p.created_at).getTime() >= since30).length,
    products_live: products.filter(p => !p.archived_at && !p.admin_hidden_at).length,
    products_hidden: products.filter(p => p.admin_hidden_at).length,
    couriers_active: couriers.filter(c => c.active).length,
    waitlist: waitlist.count || 0,
    days,
    sales: days.map(d => money(sales[d])),
    signups: days.map(d => signups[d])
  });
}));

// ── Orders ───────────────────────────────────────────────────────
async function nameMap(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = [];
  for (let i = 0; i < uniq.length; i += 200) {
    const { data, error } = await db().from('profiles').select('id, name, email, type').in('id', uniq.slice(i, i + 200));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return new Map(rows.map(r => [r.id, r]));
}

app.get('/api/orders', asyncRoute(async (req, res) => {
  const s = db();
  const rows = await fetchAll(() => {
    let q = s.from('orders')
      .select('id, user_id, brand_id, status, payment_status, total_amount, created_at, carrier, tracking_number, location, order_items(quantity)')
      .order('created_at', { ascending: false });
    if (req.query.status) q = q.eq('status', String(req.query.status));
    if (req.query.payment) q = q.eq('payment_status', String(req.query.payment));
    if (req.query.brand) q = q.eq('brand_id', String(req.query.brand));
    if (req.query.user) q = q.eq('user_id', String(req.query.user));
    return q;
  });
  const names = await nameMap(rows.flatMap(o => [o.user_id, o.brand_id]));
  const term = clean(req.query.q, 80).toLowerCase();
  const out = rows.map(o => ({
    id: o.id, status: o.status, payment_status: o.payment_status, total_amount: money(o.total_amount),
    created_at: o.created_at, carrier: o.carrier, tracking_number: o.tracking_number, location: o.location,
    items: (o.order_items || []).reduce((t, i) => t + (i.quantity || 0), 0),
    buyer: names.get(o.user_id) ? { id: o.user_id, name: names.get(o.user_id).name, email: names.get(o.user_id).email } : { id: o.user_id },
    brand: names.get(o.brand_id) ? { id: o.brand_id, name: names.get(o.brand_id).name } : { id: o.brand_id }
  })).filter(o => !term || [o.id, o.buyer.name, o.buyer.email, o.brand.name, o.tracking_number]
    .some(v => String(v || '').toLowerCase().includes(term)));
  res.json({ orders: out });
}));

app.get('/api/orders/:id', asyncRoute(async (req, res) => {
  const s = db();
  const { data: o, error } = await s.from('orders')
    .select('*, order_items(quantity, unit_price, size, sku, products(id, name)), order_status_history(from_status, to_status, note, actor_role, created_at)')
    .eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const names = await nameMap([o.user_id, o.brand_id]);
  const { data: code } = await s.from('delivery_codes')
    .select('issued_at, redeemed_at, attempts, courier_id, couriers(name)').eq('order_id', o.id).maybeSingle();
  (o.order_status_history || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  delete o.pesapal_tracking_id;
  res.json({
    order: o,
    buyer: names.get(o.user_id) || null,
    brand: names.get(o.brand_id) || null,
    // Never the code itself, only whether it exists and was used.
    delivery: code ? { issued_at: code.issued_at, redeemed_at: code.redeemed_at, attempts: code.attempts,
      courier: code.couriers?.name || null } : null,
    commission: money((Number(o.total_amount) || 0) * COMMISSION_RATE)
  });
}));

app.post('/api/orders/:id/cancel', asyncRoute(async (req, res) => {
  const reason = clean(req.body?.reason, 300);
  if (!reason) return res.status(400).json({ error: 'Give a reason. The buyer sees it.' });
  const s = db();
  const { data: o, error } = await s.from('orders').select('id, status, payment_status, user_id').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'completed' || o.status === 'cancelled') {
    return res.status(409).json({ error: `This order is already ${o.status === 'completed' ? 'delivered' : 'cancelled'}.` });
  }
  const note = 'Cancelled by MerchMarket: ' + reason;
  const { error: uErr } = await s.from('orders').update({ status: 'cancelled', last_status_note: note }).eq('id', o.id);
  if (uErr) throw uErr;
  // The database writes "<brand> cancelled this order"; correct it to say MerchMarket did.
  const { data: n } = await s.from('notifications').select('id').eq('order_id', o.id).eq('type', 'order_cancelled')
    .order('created_at', { ascending: false }).limit(1);
  if (n && n[0]) {
    await s.from('notifications').update({
      body: 'MerchMarket cancelled this order. ' + reason +
        (o.payment_status === 'paid' ? ' Your refund will be arranged by MerchMarket.' : '')
    }).eq('id', n[0].id);
  }
  await logAction(req.admin, 'order.cancel', 'order', o.id, { reason, was: o.status, payment_status: o.payment_status });
  res.json({ ok: true, refund_needed: o.payment_status === 'paid' });
}));

app.post('/api/orders/:id/note', asyncRoute(async (req, res) => {
  const note = clean(req.body?.note, 300);
  if (!note) return res.status(400).json({ error: 'Write the update first.' });
  const s = db();
  const { data: o, error } = await s.from('orders').select('id, status, user_id').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const { error: hErr } = await s.from('order_status_history').insert({
    order_id: o.id, from_status: o.status, to_status: o.status, note: 'MerchMarket: ' + note, actor_role: 'admin'
  });
  if (hErr) throw hErr;
  if (req.body?.notify) {
    await s.from('notifications').insert({ user_id: o.user_id, order_id: o.id, type: 'order_update',
      title: 'Update on your order', body: note });
  }
  await logAction(req.admin, 'order.note', 'order', o.id, { note, notified: !!req.body?.notify });
  res.json({ ok: true });
}));

// ── Brands & payouts ─────────────────────────────────────────────
app.get('/api/brands', asyncRoute(async (req, res) => {
  const s = db();
  const [brands, kyc, orders, products] = await Promise.all([
    fetchAll(() => s.from('profiles').select('id, name, email, phone, created_at, deleted_at').eq('type', 'brand')),
    fetchAll(() => s.from('vendor_kyc').select('*')),
    fetchAll(() => s.from('orders').select('brand_id, status, payment_status, total_amount')),
    fetchAll(() => s.from('products').select('brand_id, archived_at, admin_hidden_at'))
  ]);
  const kycBy = new Map(kyc.map(k => [k.brand_id, k]));
  const now = Date.now();
  res.json({
    commission_rate: COMMISSION_RATE,
    brands: brands.map(b => {
      const mine = orders.filter(o => o.brand_id === b.id);
      const paid = mine.filter(o => o.payment_status === 'paid' && o.status !== 'cancelled');
      const delivered = paid.filter(o => o.status === 'completed');
      const inProgress = paid.filter(o => o.status !== 'completed');
      const sum = (arr) => arr.reduce((t, o) => t + (Number(o.total_amount) || 0), 0);
      const k = kycBy.get(b.id) || null;
      let kycOut = null;
      if (k) {
        const lockAt = new Date(k.created_at).getTime() + KYC_EDIT_WINDOW_HOURS * 3600 * 1000;
        const reopened = !!(k.reopened_until && new Date(k.reopened_until).getTime() > now);
        kycOut = { ...k, lock_at: new Date(lockAt).toISOString(), reopened,
          editable: now < lockAt || reopened || k.status === 'rejected' };
      }
      const myProducts = products.filter(p => p.brand_id === b.id && !p.archived_at);
      return {
        ...b, kyc: kycOut,
        products: myProducts.length,
        products_hidden: myProducts.filter(p => p.admin_hidden_at).length,
        orders: mine.length,
        sales: money(sum(paid)),
        delivered_value: money(sum(delivered)),
        owed: money(sum(delivered) * (1 - COMMISSION_RATE)),
        pending_value: money(sum(inProgress) * (1 - COMMISSION_RATE)),
        commission: money(sum(paid) * COMMISSION_RATE)
      };
    }).sort((a, b) => b.sales - a.sales)
  });
}));

app.post('/api/brands/:id/reopen', asyncRoute(async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.body?.hours, 10) || 24, 1), 72);
  const reason = clean(req.body?.reason, 300);
  if (!reason) return res.status(400).json({ error: 'Give a reason for reopening (kept for the audit trail).' });
  const now = new Date();
  const { data, error } = await db().from('vendor_kyc').update({
    reopened_until: new Date(now.getTime() + hours * 3600 * 1000).toISOString(),
    reopened_by: req.admin, reopen_reason: reason, reopened_at: now.toISOString(), updated_at: now.toISOString()
  }).eq('brand_id', req.params.id).select('brand_id, reopened_until').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'This brand has no vendor details yet.' });
  await logAction(req.admin, 'brand.kyc_reopen', 'brand', req.params.id, { hours, reason });
  res.json({ ok: true, reopened_until: data.reopened_until });
}));

app.post('/api/brands/:id/lock', asyncRoute(async (req, res) => {
  const { data, error } = await db().from('vendor_kyc')
    .update({ reopened_until: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('brand_id', req.params.id).select('brand_id').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'This brand has no vendor details yet.' });
  await logAction(req.admin, 'brand.kyc_lock', 'brand', req.params.id, null);
  res.json({ ok: true });
}));

// ── Users ────────────────────────────────────────────────────────
app.get('/api/users', asyncRoute(async (req, res) => {
  const s = db();
  const [users, orders] = await Promise.all([
    fetchAll(() => s.from('profiles').select('id, name, email, phone, created_at, deleted_at, points, completed_purchases')
      .eq('type', 'member').order('created_at', { ascending: false })),
    fetchAll(() => s.from('orders').select('user_id, payment_status, status, total_amount'))
  ]);
  const term = clean(req.query.q, 80).toLowerCase();
  res.json({
    users: users.map(u => {
      const mine = orders.filter(o => o.user_id === u.id);
      return { ...u, orders: mine.length,
        spent: money(mine.filter(o => o.payment_status === 'paid' && o.status !== 'cancelled')
          .reduce((t, o) => t + (Number(o.total_amount) || 0), 0)) };
    }).filter(u => !term || [u.name, u.email, u.phone].some(v => String(v || '').toLowerCase().includes(term)))
  });
}));

// ── Products ─────────────────────────────────────────────────────
app.get('/api/products', asyncRoute(async (req, res) => {
  const s = db();
  const rows = await fetchAll(() => {
    let q = s.from('products')
      .select('id, name, price, stock, brand_id, seller, category, images, created_at, archived_at, admin_hidden_at, admin_hidden_reason')
      .is('archived_at', null).order('created_at', { ascending: false });
    if (req.query.brand) q = q.eq('brand_id', String(req.query.brand));
    if (req.query.hidden === '1') q = q.not('admin_hidden_at', 'is', null);
    return q;
  });
  const names = await nameMap(rows.map(p => p.brand_id));
  const term = clean(req.query.q, 80).toLowerCase();
  res.json({
    products: rows.map(p => {
      let img = null;
      const imgs = Array.isArray(p.images) ? p.images : [];
      const first = imgs[0];
      if (typeof first === 'string') img = first;
      else if (first && typeof first === 'object') img = first.url || first.src || null;
      return { id: p.id, name: p.name, price: money(p.price), stock: p.stock, category: p.category,
        brand: { id: p.brand_id, name: names.get(p.brand_id)?.name || p.seller || null },
        image: img && /^https:\/\//.test(img) ? img : null,
        created_at: p.created_at, hidden_at: p.admin_hidden_at, hidden_reason: p.admin_hidden_reason };
    }).filter(p => !term || [p.name, p.brand.name, p.category].some(v => String(v || '').toLowerCase().includes(term)))
  });
}));

app.post('/api/products/:id/hide', asyncRoute(async (req, res) => {
  const reason = clean(req.body?.reason, 300);
  if (!reason) return res.status(400).json({ error: 'Give a reason (kept for the audit trail).' });
  const { data, error } = await db().from('products')
    .update({ admin_hidden_at: new Date().toISOString(), admin_hidden_reason: reason })
    .eq('id', req.params.id).select('id').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Product not found' });
  await logAction(req.admin, 'product.hide', 'product', req.params.id, { reason });
  res.json({ ok: true });
}));

app.post('/api/products/:id/unhide', asyncRoute(async (req, res) => {
  const { data, error } = await db().from('products')
    .update({ admin_hidden_at: null, admin_hidden_reason: null })
    .eq('id', req.params.id).select('id').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Product not found' });
  await logAction(req.admin, 'product.unhide', 'product', req.params.id, null);
  res.json({ ok: true });
}));

// ── Couriers ─────────────────────────────────────────────────────
function newCourierCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8);
}
const hashCode = (c) => crypto.createHash('sha256').update(c, 'utf8').digest('hex');

app.get('/api/couriers', asyncRoute(async (req, res) => {
  const s = db();
  const [couriers, done] = await Promise.all([
    fetchAll(() => s.from('couriers').select('id, name, active, created_at, brand_id').order('created_at', { ascending: false })),
    fetchAll(() => s.from('delivery_codes').select('courier_id').not('courier_id', 'is', null))
  ]);
  const counts = {};
  done.forEach(r => { counts[r.courier_id] = (counts[r.courier_id] || 0) + 1; });
  const names = await nameMap(couriers.map(c => c.brand_id));
  res.json({ couriers: couriers.map(c => ({ ...c, deliveries: counts[c.id] || 0,
    brand_name: c.brand_id ? (names.get(c.brand_id)?.name || 'Brand') : null })) });
}));

app.post('/api/couriers', asyncRoute(async (req, res) => {
  const name = clean(req.body?.name, 80);
  if (!name) return res.status(400).json({ error: 'Enter the courier\'s name.' });
  const code = newCourierCode();
  const { data, error } = await db().from('couriers').insert({ name, access_code_hash: hashCode(code) })
    .select('id, name, active, created_at').single();
  if (error) throw error;
  await logAction(req.admin, 'courier.add', 'courier', data.id, { name });
  res.json({ courier: data, access_code: code });
}));

app.post('/api/couriers/:id/reset-code', asyncRoute(async (req, res) => {
  const code = newCourierCode();
  const { data, error } = await db().from('couriers').update({ access_code_hash: hashCode(code) })
    .eq('id', req.params.id).select('id').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Courier not found.' });
  await logAction(req.admin, 'courier.reset_code', 'courier', req.params.id, null);
  res.json({ ok: true, access_code: code });
}));

app.post('/api/couriers/:id/active', asyncRoute(async (req, res) => {
  const active = req.body?.active === true;
  const { data, error } = await db().from('couriers').update({ active })
    .eq('id', req.params.id).select('id, active').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Courier not found.' });
  await logAction(req.admin, active ? 'courier.activate' : 'courier.deactivate', 'courier', req.params.id, null);
  res.json({ ok: true, active: data.active });
}));

// ── Activity log ─────────────────────────────────────────────────
app.get('/api/actions', asyncRoute(async (req, res) => {
  const { data, error } = await db().from('admin_actions').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  res.json({ actions: data || [] });
}));

// ── Dashboard files (only after sign-in) ─────────────────────────
app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'deny' }));
app.use((req, res) => notFound(res));

if (require.main === module) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`MerchMarket admin on http://localhost:${port}`));
}
module.exports = app;
