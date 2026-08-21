/* ========================================
   MERCHMARKET — v3.0 (Supabase)
   All persistence moved from localStorage
   to Supabase. localStorage is only kept
   for ephemeral UI state (badge counts,
   etc.) that doesn't need server sync.
   ======================================== */

/* ─── SUPABASE CLIENT ──────────────────────────────────────── */

const SUPABASE_URL = 'https://omyzcnizwxumvookotsy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_2Dvox3zHhG4WG7An-sn0tQ_eZ9z6xh8';
// We expect the Supabase SDK to be loaded on the page.
// If you're using the CDN, it must define `window.supabase` before this file runs.
const { createClient } = (typeof supabase !== 'undefined') ? supabase : {};
if (!createClient) {
  console.error('Supabase SDK not loaded. Include the @supabase/supabase-js script tag before merchmarket.js');
  throw new Error('Supabase SDK not loaded');
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ─── SHARED UTILITIES ─────────────────────────────────────── */

// Kept only for small ephemeral UI values (badge counts, dirty flags).
// Do NOT use for any business data — use Supabase instead.
function saveLocal(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); }
  catch (e) { console.error('saveLocal failed', key, e); }
}

function loadLocal(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (e) {
    console.error(`loadLocal failed for ${key}:`, e);
    return fallback;
  }
}

// Escapes user-controlled strings before they're interpolated into
// innerHTML template literals. Product names, seller names, customer
// names/emails, locations, etc. are all attacker-controllable (any
// member or brand can set them), so every render path that builds HTML
// via template strings must pass them through this first.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function escapeAttribute(str) {
  return escapeHtml(str);
}

function sanitizeImageUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^(https?:)?\/\//i.test(trimmed) || /^data:image\//i.test(trimmed) || trimmed.startsWith('blob:')) return trimmed;
  return '';
}

function setCookie(name, value, maxAgeSeconds = 86400) {
  const secureFlag = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax${secureFlag}`;
}

function clearCookie(name) {
  const secureFlag = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax${secureFlag}`;
}

function syncBrandSessionCookie(user) {
  if (user?.type === 'brand') {
    setCookie('mm_brand_session', `brand:${user.id}`, 60 * 60 * 24);
  } else {
    clearCookie('mm_brand_session');
  }
}

window.escapeHtml = escapeHtml;
window.escapeAttribute = escapeAttribute;
window.sanitizeImageUrl = sanitizeImageUrl;

/* ─── SHARED NAV COMPONENT ───────────────────────────────────
   Single source of truth for the member-facing nav (index, marketplace,
   wishlist, orders, profile). Each of those pages has an empty
   <div id="nav-root"></div> instead of hand-written <nav> markup — this
   is what index.html was silently missing an Account link for. Adding
   a link now means updating ONE place instead of five. Admin pages
   (brandflow/add-item/view-order) keep their own tab-based nav since
   it's structurally different and not part of this drift pattern. */

function renderNav(currentPage) {
  const root = document.getElementById('nav-root');
  if (!root) return;

  const cls = (page) => page === currentPage ? 'active' : '';

  root.innerHTML = `
    <nav class="nav">
      <div class="logo" onclick="location.href='index.html'">MerchMarket</div>
      <div class="nav-links">
        <a href="index.html" class="${cls('index.html')}">Home</a>
        <a href="marketplace.html" class="${cls('marketplace.html')}">Marketplace</a>
        <a href="wishlist.html" class="${cls('wishlist.html')}" style="position:relative;">
          ♡ Wishlist
          <span class="wishlist-count" id="wishlist-count" style="display:none;position:absolute;top:-8px;right:-10px;background:#c47d2e;color:#000;border-radius:50%;min-width:18px;height:18px;font-size:.7rem;font-weight:700;padding:0 4px;align-items:center;justify-content:center;">0</span>
        </a>
        <a href="cart.html" class="${cls('cart.html')}" style="position:relative;">
          🛒 Cart
          <span class="cart-count" id="cart-count" style="display:none;position:absolute;top:-8px;right:-10px;background:#c47d2e;color:#000;border-radius:50%;min-width:18px;height:18px;font-size:.7rem;font-weight:700;padding:0 4px;align-items:center;justify-content:center;">0</span>
        </a>
        <a href="orders.html" class="${cls('orders.html')}">My Orders</a>
        <a href="profile.html" class="${cls('profile.html')}" data-auth-link="member" style="display:none;">👤 Account</a>
        <a href="login.html" class="btn btn-primary" style="font-size:.85rem;padding:.55rem 1.1rem;" data-auth-link="login">Log In</a>
        <a href="#" class="btn btn-primary" style="font-size:.85rem;padding:.55rem 1.1rem;display:none;" data-auth-link="logout">Sign Out</a>
      </div>
    </nav>`;
}
window.renderNav = renderNav;

function debounce(fn, delay) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), delay);
  };
}

function showToast(msg, type = 'default') {
  let toast = document.getElementById('mm-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'mm-toast';
    toast.style.cssText = `
      position:fixed;bottom:2rem;right:2rem;z-index:9999;
      padding:.9rem 1.6rem;border-radius:12px;font-weight:600;
      font-family:'DM Sans',sans-serif;font-size:.95rem;
      background:#1e1e1e;border:1px solid rgba(170,111,2,.5);
      color:#ffd8b5;transform:translateY(120%);
      transition:transform .35s cubic-bezier(.4,0,.2,1);
      display:flex;align-items:center;gap:.6rem;max-width:360px;
    `;
    document.body.appendChild(toast);
  }
  const icons = { success: '✅', error: '⚠️', info: 'ℹ️', default: '📢' };
  const safeMsg = escapeHtml(msg);
  toast.innerHTML = `<span>${icons[type] || icons.default}</span><span>${safeMsg}</span>`;
  toast.style.transform = 'translateY(0)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.transform = 'translateY(120%)'; }, 4000);
}

/* ─── REAL-TIME CATALOG SYNC (replaces BroadcastChannel + polling) ─ */
// Supabase real-time subscription replaces BroadcastChannel and
// storage-event polling. When any row in `products` changes, the
// marketplace re-renders automatically — across all tabs AND devices.

function subscribeToProductChanges() {
  // NOTE: keep existing behavior (eventually refresh UI), but avoid
  // re-fetching on every single change burst.
  // On large catalogs this prevents DB overload and heavy DOM churn.
  let refreshScheduled = false;
  const scheduleRefresh = debounce(() => {
    refreshScheduled = false;
    console.log('📡 Product change burst — refreshing marketplace...');
    if (typeof initMarketplace === 'function') initMarketplace();
  }, 500);

  db
    .channel('products-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
      // If already scheduled, we just wait for the same debounced refresh.
      if (refreshScheduled) return;
      refreshScheduled = true;
      scheduleRefresh();
    })
    .subscribe();
}

/* ─── AUTH & USER MANAGEMENT ──────────────────────────────── */

function showAuthError(msg) { showToast(msg, 'error'); }

// ── Profile cache ────────────────────────────────────────────────────────────
// Stores the merged {session.user + profile row} for the lifetime of the page.
// Eliminates repeated round-trips: profile is fetched at most once per page load.
let _profileCache = null;
let _profileFetchPromise = null; // deduplicate concurrent fetches
let _currentAccessToken = null;

async function getCurrentAccessToken() {
  if (_currentAccessToken) return _currentAccessToken;

  const { data: { session } } = await db.auth.getSession();
  const accessToken = session?.access_token || null;
  if (accessToken) {
    _currentAccessToken = accessToken;
  }
  return accessToken;
}

async function fetchProfile(userId) {
  // Return cache hit immediately
  if (_profileCache && _profileCache.id === userId) return _profileCache;

  // Deduplicate: if a fetch is already in-flight, wait for it instead of launching another
  if (_profileFetchPromise) return _profileFetchPromise;

  _profileFetchPromise = (async () => {
    const accessToken = await getCurrentAccessToken();
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    const res = await fetch('/api/member/profile', { headers });
    const payload = await res.json().catch(() => ({}));

    if (res.ok) {
      const data = payload.profile || null;
      _profileCache = data;
      return data;
    }

    console.warn('fetchProfile server fallback:', payload.error || res.statusText);

    const { data, error } = await db
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('fetchProfile error:', error.message);
      return null;
    }

    _profileCache = data;
    return data;
  })().finally(() => {
    _profileFetchPromise = null;
  });

  return _profileFetchPromise;
}

function clearProfileCache() {
  _profileCache = null;
  _profileFetchPromise = null;
}

async function createAccount(type, name, email, password) {
  if (!type || !name || !email || !password) {
    const msg = 'Please fill in all fields.';
    showAuthError(msg);
    throw new Error(msg);
  }

  const { data: signUpData, error: signUpError } = await db.auth.signUp({
    email,
    password,
    options: {
      data: { name, type },
      emailRedirectTo: 'https://merchmarket.co.ke/verify.html'
    }
  });

  if (signUpError) {
    const msg = signUpError.message.toLowerCase().includes('already registered')
      ? 'An account with that email already exists. Please log in.'
      : signUpError.message;
    showAuthError(msg);
    throw new Error(msg);
  }

  const user = signUpData.user;
  if (!user) {
    // Supabase returns no user when email confirmation is required —
    // the account was created but is pending confirmation.
    showToast(`Account created! Check your inbox to confirm your email.`, 'success');
    return { pending: true, name, type, email };
  }

  // Persist the profile through the server so we do not depend on direct browser writes.
  const accessToken = await getCurrentAccessToken();
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : await getAuthHeader();
  const res = await fetch('/api/member/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      name,
      email,
      type,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    console.error('Profile upsert error:', payload.error || res.statusText);
  }

  showToast(`Welcome, ${name}! Account created.`, 'success');
  return { ...user, name, type };
}

function getPreferredProfileType(defaultType = 'member') {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const paramType = (params.get('type') || '').toLowerCase();
    if (paramType === 'brand' || paramType === 'member') return paramType;
  } catch (e) {
    console.warn('Could not read login type from URL:', e);
  }

  const path = (window.location.pathname || '').toLowerCase();
  if (path.includes('brand')) return 'brand';
  return defaultType;
}

function buildRecoveryProfilePayload(user, session) {
  const meta = user?.user_metadata || {};
  const name = meta.name || meta.full_name || user?.email?.split('@')[0] || 'User';
  const type = (meta.type || getPreferredProfileType('member')).toLowerCase();

  return {
    name,
    type,
    email: user?.email || session?.user?.email || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

async function login(email, password) {
  if (!email || !password) {
    const msg = 'Please enter your email and password.';
    showAuthError(msg);
    throw new Error(msg);
  }

  const { data, error } = await db.auth.signInWithPassword({ email, password });

  if (error) {
    const raw = (error.message || '').toLowerCase();
    const msg = raw.includes('email not confirmed')
      ? 'Please confirm your email first. Check your inbox for the confirmation link.'
      : (raw.includes('invalid login') || raw.includes('invalid credentials'))
        ? 'Incorrect email or password.'
        : error.message;
    showAuthError(msg);
    throw new Error(msg);
  }

  _currentAccessToken = data.session?.access_token || null;

  const profile = await fetchProfile(data.user.id);
  if (!profile) {
    // Profile row missing — recover it using auth metadata or the current login context.
    const recoveryPayload = buildRecoveryProfilePayload(data.user, data.session);
    const accessToken = data.session?.access_token || (await getCurrentAccessToken());
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : await getAuthHeader();

    if (recoveryPayload.name && recoveryPayload.type) {
      const recoveryRes = await fetch('/api/member/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(recoveryPayload)
      });

      if (!recoveryRes.ok) {
        const payload = await recoveryRes.json().catch(() => ({}));
        console.warn('Profile recovery via server failed, falling back to direct Supabase write:', payload.error || recoveryRes.statusText);
        await db.from('profiles').upsert({
          id: data.user.id,
          ...recoveryPayload
        }, { onConflict: 'id' });
      }

      const recovered = await fetchProfile(data.user.id);
      if (recovered) {
        window.location.href = recovered.type === 'brand' ? '/brandflow.html' : '/marketplace.html';
        return { ...data.user, ...recovered };
      }
    }

    const msg = 'Account found but profile is missing. Contact support.';
    showAuthError(msg);
    throw new Error(msg);
  }

  // Sync to localStorage for any legacy guards still reading it.
  try {
    localStorage.setItem('currentUserId', data.user.id);
    localStorage.setItem('currentUserProfile', JSON.stringify({ ...data.user, ...profile }));
  } catch (e) {
    console.warn('localStorage sync failed:', e);
  }

  syncBrandSessionCookie(profile);

  // Cache is already set by fetchProfile above — redirect immediately
  window.location.href = profile.type === 'brand' ? '/brandflow.html' : '/marketplace.html';
  return { ...data.user, ...profile };
}

async function logout() {
  clearProfileCache();
  syncBrandSessionCookie(null);
  await db.auth.signOut();
  window.location.href = 'login.html';
}

// Returns the current session user merged with their profile row,
// or null when no session exists.
// Uses profile cache — safe to call many times per page without extra DB hits.
async function getCurrentUser() {
  // Fast path: cache hit skips both getSession and fetchProfile
  if (_profileCache) return _profileCache;

  const { data: { session } } = await db.auth.getSession();
  if (!session) return null;

  const profile = await fetchProfile(session.user.id);
  return profile ? { ...session.user, ...profile } : null;
}

async function getAuthHeader() {
  const accessToken = await getCurrentAccessToken();
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

// Fires on every auth state transition (sign-in, sign-out, token refresh).
// On SIGNED_IN: fetchProfile uses the cache so no extra round-trip occurs
//   when arriving here right after login() already fetched the profile.
// On SIGNED_OUT: clear cache so the next getCurrentUser() call goes to the DB.
db.auth.onAuthStateChange(async (event, session) => {
  _currentAccessToken = session?.access_token || null;

  if (event === 'SIGNED_IN' && session) {
    // fetchProfile is cache-aware — this is a no-op if login() already ran
    const profile = await fetchProfile(session.user.id);

    try {
      localStorage.setItem('currentUserId', session.user.id);
      if (profile) localStorage.setItem('currentUserProfile', JSON.stringify({ ...session.user, ...profile }));
    } catch (e) {
      console.warn('localStorage sync failed:', e);
    }

    syncBrandSessionCookie(profile);
    window.dispatchEvent(new CustomEvent('userReady', { detail: profile }));
  }

  if (event === 'SIGNED_OUT') {
    clearProfileCache();
    syncBrandSessionCookie(null);
    try {
      localStorage.removeItem('currentUserId');
      localStorage.removeItem('currentUserProfile');
    } catch (e) {}
    window.dispatchEvent(new CustomEvent('userReady', { detail: null }));
  }
});

/* ─── WISHLIST / CART ──────────────────────────────────────── */
// Wishlist rows live in Supabase `wishlists` table:
//   id, user_id, product_id, quantity, added_at
// Guest sessions use the anonymous Supabase session (or fall back to
// localStorage if the user is truly unauthenticated).

async function getWishlist() {
  const user = await getCurrentUser();

  if (!user) {
    // Unauthenticated fallback: keep in localStorage for the session
    return loadLocal('mm_wishlist_guest', []);
  }

  const headers = await getAuthHeader();
  const res = await fetch('/api/member/wishlist', { headers });
  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('getWishlist error:', payload.error || res.statusText);
    return [];
  }

  return payload.wishlist || [];
}

// Single canonical badge updater used by all pages and wishlist.js.
// Exposed on window so wishlist.js (IIFE) can call it instead of its own copy.
async function updateWishlistBadge() {
  const user = await getCurrentUser();
  let count = 0;

  if (user) {
    const headers = await getAuthHeader();
    const res = await fetch('/api/member/wishlist', { headers });
    const payload = await res.json().catch(() => ({}));
    const items = payload.wishlist || [];
    count = items.reduce((s, i) => s + (i.quantity || 1), 0);
  } else {
    const local = loadLocal('mm_wishlist_guest', []);
    count = local.reduce((s, i) => s + (i.quantity || 1), 0);
  }

  document.querySelectorAll('.wishlist-count, #wishlist-count').forEach(el => {
    el.textContent = count;
    el.style.display = count > 0 ? 'inline-flex' : 'none';
  });
}

// Alias — keeps any legacy calls working without changes
const updateCartBadge = updateWishlistBadge;
window.updateWishlistBadge = updateWishlistBadge;

// Called from product card "Add to Wishlist" button
async function addToCart(btn) {
  if (btn.disabled) return;

  const card     = btn.closest('.product-card');
  const id       = card.dataset.id;
  const title    = card.querySelector('.product-title')?.textContent.trim() || 'Item';
  const priceRaw = card.querySelector('.product-price')?.textContent.trim() || 'KES 0';
  const price    = parseFloat(priceRaw.replace(/[^0-9.]/g, '')) || 0;
  const seller   = card.querySelector('.seller-name')?.textContent.trim() || 'MerchMarket';
  const imageSrc = card.querySelector('img')?.src || '';
  const stock    = parseInt(card.dataset.stock) || 999;

  if (stock === 0) { showToast('Out of stock!', 'error'); return; }

  const user = await getCurrentUser();

  if (!user) {
    // Guest: use localStorage
    let wishlist = loadLocal('mm_wishlist_guest', []);
    const existing = wishlist.find(i => i.product_id === id);
    if (existing) existing.quantity++;
    else wishlist.push({ product_id: id, name: title, price, seller, quantity: 1, image: imageSrc });
    saveLocal('mm_wishlist_guest', wishlist);
    showToast(`${title} added to wishlist!`, 'success');
    updateCartBadge();
    return;
  }

  const headers = await getAuthHeader();
  const res = await fetch('/api/member/wishlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ product_id: id, quantity: 1 })
  });
  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('addToCart wishlist error:', payload.error || res.statusText);
    showToast('Could not save wishlist item.', 'error');
    return;
  }

  showToast(`${title} added to wishlist!`, 'success');
  updateCartBadge();
}

// Called from product detail / modal (uses product id directly)
async function addToCartById(productId) {
  const product = currentProducts.find(p => p.id === productId);
  if (!product) { showToast('Product not found', 'error'); return; }

  const user = await getCurrentUser();
  const imageSrc = product.images?.[0]?.url || product.images?.[0] || '';

  if (!user) {
    let wishlist = loadLocal('mm_wishlist_guest', []);
    const existing = wishlist.find(i => i.product_id === productId);
    if (existing) existing.quantity++;
    else wishlist.push({ product_id: productId, name: product.name, price: product.price, seller: product.seller, quantity: 1, image: imageSrc });
    saveLocal('mm_wishlist_guest', wishlist);
    showToast(`${product.name} added to wishlist!`, 'success');
    updateCartBadge();
    return;
  }

  const headers = await getAuthHeader();
  const res = await fetch('/api/member/wishlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ product_id: productId, quantity: 1 })
  });
  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('addToCartById wishlist error:', payload.error || res.statusText);
    showToast('Could not save wishlist item.', 'error');
    return;
  }

  showToast(`${product.name} added to wishlist!`, 'success');
  updateCartBadge();
}

/* ─── REAL CART ──────────────────────────────────────────────
   `cart_items` is a genuinely separate table/flow from `wishlists`.
   NOTE: addToCart()/updateCartBadge() above are legacy names that
   actually operate on the wishlist table — left as-is to avoid
   breaking existing wishlist behavior. These functions are the
   real cart, named distinctly to avoid confusion with the above. */

async function getCart() {
  const user = await getCurrentUser();

  if (!user) {
    return loadLocal('mm_cart_guest', []);
  }

  const headers = await getAuthHeader();
  const res = await fetch('/api/member/cart', { headers });
  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('getCart error:', payload.error || res.statusText);
    return [];
  }

  return payload.cart || [];
}

async function updateCartCount() {
  const user = await getCurrentUser();
  let count = 0;

  if (user) {
    const headers = await getAuthHeader();
    const res = await fetch('/api/member/cart', { headers });
    const payload = await res.json().catch(() => ({}));
    const items = payload.cart || [];
    count = items.reduce((s, i) => s + (i.quantity || 1), 0);
  } else {
    const local = loadLocal('mm_cart_guest', []);
    count = local.reduce((s, i) => s + (i.quantity || 1), 0);
  }

  document.querySelectorAll('.cart-count, #cart-count').forEach(el => {
    el.textContent = count;
    el.style.display = count > 0 ? 'inline-flex' : 'none';
  });
}
window.updateCartCount = updateCartCount;

async function addProductToCartRaw(productId, name, price, seller, imageSrc, stock) {
  if (stock === 0) { showToast('Out of stock!', 'error'); return; }

  const user = await getCurrentUser();

  if (!user) {
    let cart = loadLocal('mm_cart_guest', []);
    const existing = cart.find(i => i.product_id === productId);
    if (existing) existing.quantity++;
    else cart.push({ product_id: productId, name, price, seller, quantity: 1, image: imageSrc });
    saveLocal('mm_cart_guest', cart);
    showToast(`${name} added to cart!`, 'success');
    updateCartCount();
    return;
  }

  const headers = await getAuthHeader();
  const res = await fetch('/api/member/cart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ product_id: productId, quantity: 1 })
  });
  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('addProductToCart error:', payload.error || res.statusText);
    showToast('Could not add item to cart.', 'error');
    return;
  }

  showToast(`${name} added to cart!`, 'success');
  updateCartCount();
}

// Called from the 🛒 quick-add icon on marketplace product cards
async function addProductToCart(btn) {
  if (btn.disabled) return;
  const card     = btn.closest('.product-card');
  const id       = card.dataset.id;
  const title    = card.querySelector('.product-title')?.textContent.trim() || 'Item';
  const priceRaw = card.querySelector('.product-price')?.textContent.trim() || 'KES 0';
  const price    = parseFloat(priceRaw.replace(/[^0-9.]/g, '')) || 0;
  const seller   = card.querySelector('.seller-name')?.textContent.trim() || 'MerchMarket';
  const imageSrc = card.querySelector('img')?.src || '';
  const stock    = parseInt(card.dataset.stock) || 999;
  await addProductToCartRaw(id, title, price, seller, imageSrc, stock);
}

// Called from product detail / modal contexts (uses product id directly)
async function addProductToCartById(productId) {
  const product = currentProducts.find(p => p.id === productId);
  if (!product) { showToast('Product not found', 'error'); return; }
  const imageSrc = product.images?.[0]?.url || product.images?.[0] || '';
  await addProductToCartRaw(productId, product.name, product.price, product.seller, imageSrc, product.stock);
}


// Products are stored in Supabase `products` table. Schema expected:
//   id, brand_id, name, price, seller, category, wear_category,
//   item_type, condition, tags (jsonb), images (jsonb), stock,
//   badge, sku, gradient, created_at

const GRADIENTS = [
  'linear-gradient(135deg,#667eea,#764ba2)',
  'linear-gradient(135deg,#f093fb,#f5576c)',
  'linear-gradient(135deg,#4facfe,#00f2fe)',
  'linear-gradient(135deg,#fa709a,#fee140)',
  'linear-gradient(135deg,#a8edea,#fed6e3)',
  'linear-gradient(135deg,#ffecd2,#fcb69f)',
  'linear-gradient(135deg,#ff9a9e,#fecfef)',
  'linear-gradient(135deg,#fddb92,#d1fdff)'
];

function getGradientForId(id) {
  let hash = 0;
  for (let i = 0; i < (id || '').length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i);
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

// Normalise a raw Supabase products row into the shape the renderer expects
function normalizeProduct(row) {
  const images = Array.isArray(row.images)
    ? row.images.map(img => typeof img === 'string' ? { url: img } : (img?.url ? img : null)).filter(Boolean)
    : [];

  const stock = row.stock != null ? row.stock : 999;

  return {
    id: row.id,
    brandId: row.brand_id,
    name: row.name || 'Untitled Product',
    price: parseFloat(row.price) || 0,
    seller: row.seller || 'Unknown Brand',
    category: row.category || 'other',
    wearCategory: row.wear_category || row.category || 'other',
    itemType: row.item_type || row.type || 'other',
    condition: row.condition || 'new',
    tags: Array.isArray(row.tags) ? row.tags : [],
    gradient: row.gradient || getGradientForId(String(row.id)),
    images,
    stock,
    badge: stock === 0 ? 'Out of Stock' : (row.badge || ''),
    sku: row.sku || '',
    createdAt: row.created_at || new Date().toISOString()
  };
}

// Fetch all in-stock products from Supabase
async function fetchAllProducts() {
  const { data, error } = await db
    .from('products')
    .select('*')
    .gt('stock', 0)          // only in-stock
    .order('created_at', { ascending: false });

  if (error) {
    console.error('fetchAllProducts error:', error.message);
    return [];
  }

  return data.map(normalizeProduct);
}

/* ─── MARKETPLACE ──────────────────────────────────────────── */

let currentProducts = [];
let searchQuery = '';
let activeWearCategory = 'all';
let activeItemType     = 'all';

function updateWearTabUI() {
  const container = document.getElementById('marketplaceWearTabs');
  if (!container) return;
  container.querySelectorAll('.filter-tab').forEach(btn => {
    const label = btn.textContent.trim().toLowerCase();
    const key = label === 'official wear' ? 'official'
              : label === 'street wear'   ? 'street'
              : label === 'casual wear'   ? 'casual'
              : 'all';
    btn.classList.toggle('active', key === activeWearCategory);
  });
}

function updateItemTabUI() {
  const container = document.getElementById('marketplaceItemTabs');
  if (!container) return;
  const valid = ['torso', 'trunks', 'innies', 'shoes', 'socks'];
  container.querySelectorAll('.filter-tab').forEach(btn => {
    const label = btn.textContent.trim().toLowerCase();
    const key = valid.includes(label) ? label : 'all';
    btn.classList.toggle('active', key === activeItemType);
  });
}

function setWearFilter(category) {
  activeWearCategory = category || 'all';
  updateWearTabUI();
  renderProductGrid(applyFilters());
}

function setItemFilter(itemType) {
  activeItemType = itemType || 'all';
  updateItemTabUI();
  renderProductGrid(applyFilters());
}

function normalizeLower(s) { return (s || '').toString().trim().toLowerCase(); }

function applyFilters() {
  const q = searchQuery;
  return currentProducts.filter(product => {
    const wear = normalizeLower(product.wearCategory);
    const item = normalizeLower(product.itemType);

    if (activeWearCategory !== 'all' && wear !== activeWearCategory) return false;
    if (activeItemType !== 'all' && item !== activeItemType) return false;
    if (!q) return true;

    return normalizeLower(product.name).includes(q)
        || normalizeLower(product.seller).includes(q);
  });
}

async function initMarketplace() {
  console.log('=== initMarketplace START ===');

  currentProducts = await fetchAllProducts();

  console.log('Total available products:', currentProducts.length);

  activeWearCategory = 'all';
  activeItemType     = 'all';
  updateWearTabUI();
  updateItemTabUI();
  renderProductGrid(applyFilters());

  // Subscribe to real-time product changes
  subscribeToProductChanges();

  console.log('=== initMarketplace END ===');
}

function searchProducts() {
  searchQuery = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';
  renderProductGrid(applyFilters());
}

function renderProductGrid(products) {
  console.log('Rendering', products.length, 'products');
  const grid = document.getElementById('productGrid');
  if (!grid) { console.error('Product grid not found'); return; }

  if (products.length === 0) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:4rem;color:#a0a0a0;">
        <div style="font-size:3rem;margin-bottom:1rem;">🔍</div>
        <p>No products found. Try a different search or filter.</p>
      </div>`;
    return;
  }

  const resultsEl = document.querySelector('.results-count');
  if (resultsEl) resultsEl.innerHTML = `Showing <strong>${products.length}</strong> results`;

  grid.innerHTML = products.map(p => {
    const stockBadge  = p.stock < 5 ? `<div class="product-badge">${p.stock} left</div>` : '';
    const addBtnText  = p.stock === 0 ? 'Out of Stock' : 'Add to Wishlist';
    const addBtnDisabled = p.stock === 0 ? 'disabled style="opacity:.6;cursor:not-allowed"' : '';
    const imageSrc    = p.images?.[0]?.url || '';
    const safeName     = escapeHtml(p.name);
    const safeSeller   = escapeHtml(p.seller);
    const safeCondition = escapeHtml(p.condition);
    const safeBadge     = escapeHtml(p.badge);
    const imageHtml   = imageSrc
      ? `<img src="${imageSrc}" alt="${safeName}" style="width:100%;height:100%;object-fit:cover;border-radius:8px 8px 0 0;">`
      : `<div class="image-placeholder" style="width:100%;height:100%;background:linear-gradient(45deg,#ccc,#ddd);border-radius:8px 8px 0 0;display:flex;align-items:center;justify-content:center;color:#666;font-size:1.2rem;">No Image</div>`;

    return `
      <div class="product-card" data-id="${p.id}" data-stock="${p.stock}">
        <div class="product-image" style="background:${p.gradient};border-radius:12px 12px 0 0;overflow:hidden;">
          ${imageHtml}
          ${p.badge && p.badge.toLowerCase() !== 'new' ? `<div class="product-badge">${safeBadge}</div>` : ''}
          ${stockBadge}
          <button class="wishlist-btn" onclick="toggleWishlist(this)">♡</button>
          <button class="wishlist-btn" style="left:auto;right:0.9rem;" onclick="addProductToCart(this)" title="Add to Cart" ${addBtnDisabled}>🛒</button>
        </div>
        <div class="product-details">
          <div class="product-seller">
            <div class="seller-badge" style="background:${p.gradient}"></div>
            <span class="seller-name">${safeSeller}</span>
          </div>
          <h3 class="product-title">${safeName}</h3>
          ${p.condition ? `<div style="font-size:.75rem;color:#a0a0a0;margin-bottom:.3rem;text-transform:capitalize;">Condition: ${safeCondition}</div>` : ''}
          <div class="product-footer">
            <div class="product-price">KES ${p.price.toFixed(0)}</div>
            <button class="add-to-cart-btn" onclick="addToCart(this)" ${addBtnDisabled}>${addBtnText}</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function toggleWishlist(btn) {
  btn.classList.toggle('active');
  btn.textContent = btn.classList.contains('active') ? '♥' : '♡';
  showToast(btn.classList.contains('active') ? 'Added to wishlist!' : 'Removed from wishlist', 'info');
}

/* ─── SOCIAL FEED ─────────────────────────────────────────── */

function toggleFollow(btn) {
  const isFollowing = btn.classList.toggle('following');
  btn.textContent = isFollowing ? 'Following' : 'Follow';
  btn.style.borderColor = isFollowing ? '#c47d2e' : '';
  btn.style.color       = isFollowing ? '#ffd8b5' : '';
  showToast(isFollowing ? 'Now following!' : 'Unfollowed', 'info');
}

function toggleLike(el) {
  const countSpan = el.querySelector('.like-count');
  let count = parseFloat(countSpan.textContent) || 0;
  const isK = countSpan.textContent.includes('K');
  if (el.classList.toggle('liked')) { el.style.color = '#ff3366'; count += 0.1; }
  else                              { el.style.color = '';        count -= 0.1; }
  countSpan.textContent = isK ? count.toFixed(1) + 'K' : Math.round(count);
}

function loadMore() {
  showToast('Loading more posts...', 'info');
  setTimeout(() => showToast('No more posts to load.', 'info'), 800);
}

/* ─── ORDERS ──────────────────────────────────────────────── */
// Orders live in the Supabase `orders` table:
//   id, user_id, items (jsonb), total, status, location, created_at

async function renderMemberOrders() {
  const tbody = document.getElementById('orders-body');
  if (!tbody) return;

  const user = await getCurrentUser();
  if (!user) return;

  const headers = await getAuthHeader();
  const res = await fetch('/api/member/orders', { headers });
  const payload = await res.json().catch(() => ({}));

  if (!res.ok) { console.error('renderMemberOrders error:', payload.error || res.statusText); return; }
  const orders = payload.orders || [];
  if (!orders.length) return;

  // Remove any static fallback rows
  document.querySelectorAll('.static-fallback').forEach(r => r.remove());

  tbody.innerHTML += orders.map(o => {
    const statusClass = o.status || 'pending';
    const items = o.order_items || [];

    const productCell = items.length
      ? items.map(i => {
          const name = escapeHtml(i.products?.name || i.sku || '—');
          return `${name}<br><span style="opacity:.75;font-size:.85rem;">Qty: ${i.quantity || 1}</span>`;
        }).join('<div style="margin-top:.35rem;">')
      : '—';

    const qtyCell = items.length
      ? items.map(i => String(i.quantity || 1)).join(' + ')
      : '1';

    const total = parseFloat(o.total_amount ?? o.total) || 0;
    const date  = o.created_at ? new Date(o.created_at).toLocaleDateString('en-KE') : '—';

    return `
      <tr>
        <td style="font-family:monospace;color:#ffd8b5;">#${o.id}</td>
        <td>${productCell}</td>
        <td>${qtyCell}</td>
        <td style="font-size:.85rem;color:#a0a0a0;">${escapeHtml(o.location) || 'Nairobi, Kenya'}</td>
        <td style="font-size:.85rem;color:#a0a0a0;">${date}</td>
        <td><span class="status-badge ${statusClass}">${statusClass.charAt(0).toUpperCase() + statusClass.slice(1)}</span></td>
        <td><strong>KES ${total.toLocaleString()}</strong></td>
      </tr>`;
  }).join('');
}

function initAdmin() {
  if (typeof tabSwitch === 'function') tabSwitch('orders');
}

function showSellModal() {
  const modal = document.getElementById('sellModal');
  if (modal) modal.classList.add('active');
}

function closeSellModal() {
  const modal = document.getElementById('sellModal');
  if (modal) modal.classList.remove('active');
}

function submitListing(e) {
  // Marketplace-side uploading disabled.
  // Brands can only list via Brand Admin (brandflow.html).
  e.preventDefault();
  showToast('Marketplace uploads are disabled.', 'error');
}

/* ─── NAV AUTH ─────────────────────────────────────────────── */
// Renders the correct nav state (Login vs Logout) on every page.
// Uses getCurrentUser() which is cache-first after the first call.

async function initNavAuth() {
  const user = await getCurrentUser();

  // All login/logout anchor targets in the nav — identified by data-auth-link attribute.
  // Each HTML nav must have:
  //   <a data-auth-link="login"  href="login.html">Log In</a>
  //   <a data-auth-link="logout" href="#" style="display:none">Log Out</a>
  const loginLinks  = document.querySelectorAll('[data-auth-link="login"]');
  const logoutLinks = document.querySelectorAll('[data-auth-link="logout"]');
  const memberLinks = document.querySelectorAll('[data-auth-link="member"]');

  if (user) {
    loginLinks.forEach(el  => { el.style.display = 'none'; });
    logoutLinks.forEach(el => {
      el.style.display = '';
      el.textContent   = `Sign Out`;
      el.onclick = (e) => { e.preventDefault(); logout(); };
    });
    // Account link only makes sense for member accounts — brands use Brand Admin.
    memberLinks.forEach(el => { el.style.display = (user.type === 'member') ? '' : 'none'; });
  } else {
    loginLinks.forEach(el  => { el.style.display = ''; });
    logoutLinks.forEach(el => { el.style.display = 'none'; });
    memberLinks.forEach(el => { el.style.display = 'none'; });
  }
}

/* ─── BOOT ─────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  const isAuthPage = page.includes('login') || page.includes('signup');

  // Inject the shared nav on member-facing pages (any page with a
  // #nav-root placeholder). Must happen before initNavAuth(), since
  // that queries elements this renders.
  if (document.getElementById('nav-root')) {
    renderNav(page);
  }

  // Run nav auth + cart badge in parallel — not sequentially
  if (!isAuthPage) {
    await Promise.all([
      initNavAuth(),
      updateCartBadge(),   // legacy name — actually updates the wishlist badge
      updateCartCount()    // real cart badge
    ]);
  }

  if (page.includes('marketplace')) await initMarketplace();
  if (page.includes('brandflow'))   initAdmin();

  // Auth pages (login.html, signup.html) bind their own submit handlers
  // via the AuthLogin / AuthSignup controllers defined in those files.
});
/* ─── SHARED BRAND HELPER ──────────────────────────────────── */
// Returns the current brand's full profile, or null (with a toast) if not
// a brand. Shared by brandflow-admin.js, add-item.html, and view-order.html
// so all three pages guard the same way.
async function getBrandUser() {
  const user = await getCurrentUser();
  if (!user || user.type !== 'brand') {
    showToast('Brand account required', 'error');
    return null;
  }
  return user;
}
