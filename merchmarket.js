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
// NOTE: supabase is the global from the CDN script tag, e.g.
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
const { createClient } = supabase;
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
  toast.innerHTML = `<span>${icons[type] || icons.default}</span><span>${msg}</span>`;
  toast.style.transform = 'translateY(0)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.transform = 'translateY(120%)'; }, 4000);
}

/* ─── REAL-TIME CATALOG SYNC (replaces BroadcastChannel + polling) ─ */
// Supabase real-time subscription replaces BroadcastChannel and
// storage-event polling. When any row in `products` changes, the
// marketplace re-renders automatically — across all tabs AND devices.

function subscribeToProductChanges() {
  db
    .channel('products-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
      console.log('📡 Product change detected — refreshing marketplace...');
      if (typeof initMarketplace === 'function') initMarketplace();
    })
    .subscribe();
}

/* ─── AUTH & USER MANAGEMENT ──────────────────────────────── */

function showAuthError(msg) { showToast(msg, 'error'); }

// Fetch the public profile row that mirrors auth.users
async function fetchProfile(userId) {
  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) { console.error('fetchProfile error:', error.message); return null; }
  return data;
}

async function createAccount(type, name, email, password) {
  if (!type || !name || !email || !password) {
    showAuthError('Please fill in all fields.');
    return null;
  }

  const { data: signUpData, error: signUpError } = await db.auth.signUp({
    email,
    password,
    options: { data: { name, type } }
  });

  if (signUpError) {
    if (signUpError.message.toLowerCase().includes('already registered')) {
      showAuthError('An account with that email already exists. Please log in.');
    } else {
      showAuthError(signUpError.message);
    }
    return null;
  }

  const user = signUpData.user;

  // Upsert profile (safe fallback if DB trigger already created it)
  const { error: profileError } = await db.from('profiles').upsert({
    id: user.id,
    name,
    type,
    email,
    created_at: new Date().toISOString()
  });

  if (profileError) console.error('Profile upsert error:', profileError.message);

  showToast(`Welcome, ${name}! Account created.`, 'success');
  return { ...user, name, type };
}

async function login(email, password) {
  if (!email || !password) {
    showAuthError('Please enter your email and password.');
    return null;
  }

  const { data, error } = await db.auth.signInWithPassword({ email, password });

  if (error) { showAuthError('Invalid email or password.'); return null; }

  const profile = await fetchProfile(data.user.id);
  if (!profile) {
    showAuthError('Account found but profile is missing. Contact support.');
    return null;
  }

  // Sync auth to localStorage so brandflow.html guard (legacy) can work.
  try {
    localStorage.setItem('currentUserId', data.user.id);
    localStorage.setItem('currentUserProfile', JSON.stringify({ ...data.user, ...profile }));
  } catch (e) {
    console.warn('localStorage sync failed:', e);
  }

  window.location.href = profile.type === 'brand' ? '/brandflow.html' : '/marketplace.html';
  return { ...data.user, ...profile };
}

async function logout() {
  await db.auth.signOut();
  window.location.href = 'index.html';
}

// Returns the current session user merged with their profile row,
// or null when no session exists.
async function getCurrentUser() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return null;
  const profile = await fetchProfile(session.user.id);
  return profile ? { ...session.user, ...profile } : null;
}

// Fires on every auth state transition (sign-in, sign-out, token refresh).
// Individual pages listen for the custom `userReady` event instead of
// calling getCurrentUser() on every load.
db.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_IN' && session) {
    const profile = await fetchProfile(session.user.id);

    // Keep legacy guards in sync with Supabase auth.
    try {
      localStorage.setItem('currentUserId', session.user.id);
      if (profile) localStorage.setItem('currentUserProfile', JSON.stringify({ ...session.user, ...profile }));
    } catch (e) {
      console.warn('localStorage sync failed:', e);
    }

    window.dispatchEvent(new CustomEvent('userReady', { detail: profile }));
  }

  if (event === 'SIGNED_OUT') {
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

  const { data, error } = await db
    .from('wishlists')
    .select('*, products(*)')
    .eq('user_id', user.id);

  if (error) { console.error('getWishlist error:', error.message); return []; }
  return data;
}

async function updateCartBadge() {
  const user = await getCurrentUser();
  let count = 0;

  if (user) {
    const { data } = await db
      .from('wishlists')
      .select('quantity')
      .eq('user_id', user.id);
    count = (data || []).reduce((s, i) => s + (i.quantity || 1), 0);
  } else {
    const local = loadLocal('mm_wishlist_guest', []);
    count = local.reduce((s, i) => s + (i.quantity || 1), 0);
  }

  document.querySelectorAll('.wishlist-count, #wishlist-count').forEach(el => {
    el.textContent = count;
    el.style.display = count > 0 ? 'inline-flex' : 'none';
  });
}

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

  // Authenticated: upsert into Supabase
  const { data: existing } = await db
    .from('wishlists')
    .select('id, quantity')
    .eq('user_id', user.id)
    .eq('product_id', id)
    .maybeSingle();

  if (existing) {
    await db.from('wishlists').update({ quantity: existing.quantity + 1 }).eq('id', existing.id);
  } else {
    await db.from('wishlists').insert({ user_id: user.id, product_id: id, quantity: 1 });
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

  const { data: existing } = await db
    .from('wishlists')
    .select('id, quantity')
    .eq('user_id', user.id)
    .eq('product_id', productId)
    .maybeSingle();

  if (existing) {
    await db.from('wishlists').update({ quantity: existing.quantity + 1 }).eq('id', existing.id);
  } else {
    await db.from('wishlists').insert({ user_id: user.id, product_id: productId, quantity: 1 });
  }

  showToast(`${product.name} added to wishlist!`, 'success');
  updateCartBadge();
}

/* ─── GLOBAL PRODUCT CATALOG ───────────────────────────────── */
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
    const imageHtml   = imageSrc
      ? `<img src="${imageSrc}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover;border-radius:8px 8px 0 0;">`
      : `<div class="image-placeholder" style="width:100%;height:100%;background:linear-gradient(45deg,#ccc,#ddd);border-radius:8px 8px 0 0;display:flex;align-items:center;justify-content:center;color:#666;font-size:1.2rem;">No Image</div>`;

    return `
      <div class="product-card" data-id="${p.id}" data-stock="${p.stock}">
        <div class="product-image" style="background:${p.gradient};border-radius:12px 12px 0 0;overflow:hidden;">
          ${imageHtml}
          ${p.badge && p.badge.toLowerCase() !== 'new' ? `<div class="product-badge">${p.badge}</div>` : ''}
          ${stockBadge}
          <button class="wishlist-btn" onclick="toggleWishlist(this)">♡</button>
        </div>
        <div class="product-details">
          <div class="product-seller">
            <div class="seller-badge" style="background:${p.gradient}"></div>
            <span class="seller-name">${p.seller}</span>
          </div>
          <h3 class="product-title">${p.name}</h3>
          ${p.condition ? `<div style="font-size:.75rem;color:#a0a0a0;margin-bottom:.3rem;text-transform:capitalize;">Condition: ${p.condition}</div>` : ''}
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

  const { data: orders, error } = await db
    .from('orders')
    .select('*, order_items(*, products(name, sku))')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) { console.error('renderMemberOrders error:', error.message); return; }
  if (!orders || orders.length === 0) return;

  // Remove any static fallback rows
  document.querySelectorAll('.static-fallback').forEach(r => r.remove());

  tbody.innerHTML += orders.map(o => {
    const statusClass = o.status || 'pending';
    const items = o.order_items || [];

    const productCell = items.length
      ? items.map(i => {
          const name = i.products?.name || i.sku || '—';
          return `${name}<br><span style="opacity:.75;font-size:.85rem;">Qty: ${i.quantity || 1}</span>`;
        }).join('<div style="margin-top:.35rem;">')
      : '—';

    const qtyCell = items.length
      ? items.map(i => String(i.quantity || 1)).join(' + ')
      : '1';

    const total = parseFloat(o.total) || 0;
    const date  = o.created_at ? new Date(o.created_at).toLocaleDateString('en-KE') : '—';

    return `
      <tr>
        <td style="font-family:monospace;color:#ffd8b5;">#${o.id}</td>
        <td>${productCell}</td>
        <td>${qtyCell}</td>
        <td style="font-size:.85rem;color:#a0a0a0;">${o.location || 'Nairobi, Kenya'}</td>
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

/* ─── BOOT ─────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  updateCartBadge();

  const page = window.location.pathname.split('/').pop() || 'index.html';

  if (page.includes('marketplace.html')) {
    console.log('Marketplace page detected — initializing...');
    await initMarketplace();
  }

  if (page.includes('brandflow')) initAdmin();

  // Auth: login form
  const loginForm = document.querySelector('.login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      const email    = document.getElementById('login-email')?.value.trim()
                    || document.getElementById('username')?.value.trim();
      const password = document.getElementById('login-password')?.value
                    || document.getElementById('password')?.value;
      await login(email, password);
    });
  }

  // Auth: signup form
  const signupForm = document.querySelector('.signup-form');
  if (signupForm) {
    signupForm.addEventListener('submit', async e => {
      e.preventDefault();
      const type     = document.body.dataset.userType || 'member';
      const name     = document.getElementById('brandName')?.value.trim()
                    || document.getElementById('fullName')?.value.trim();
      const email    = document.getElementById('email')?.value.trim();
      const password = document.getElementById('password')?.value;
      const confirm  = document.getElementById('confirmPassword')?.value;

      if (password !== confirm) { showToast("Passwords don't match", 'error'); return; }

      const user = await createAccount(type, name, email, password);
      if (user) window.location.href = type === 'brand' ? 'authbrand.html' : 'marketplace.html';
    });
  }
});