/* ========================================
   MERCHMARKET — FIXED v2.1 - No top-level await
   Brand products now merge into marketplace!
   ======================================== */

/* ─── SHARED UTILITIES ─────────────────────────────────────── */

function saveLocal(key, data) {
  // Source of truth: localStorage (sync)
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('saveLocal failed', key, e);
  }
}

function loadLocal(key, fallback = []) {
  // Source of truth: localStorage (sync)
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
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

/* ─── CROSS-TAB / SAME-TAB COMMUNICATION ──────────────────── */

let catalogChannel = null;
try {
  catalogChannel = new BroadcastChannel('merchmarket_catalog');
} catch (e) {
  console.log('BroadcastChannel not supported, using storage events only');
}

// Setup catalog update listeners once (prevents duplicate listeners on re-init)
if (!window._mmCatalogListeners) {
  window._mmCatalogListeners = true;

  // BroadcastChannel listener (same-tab + cross-tab)
  if (catalogChannel) {
    catalogChannel.onmessage = (e) => {
      if (e.data?.type === 'catalogUpdated') {
        console.log('📡 Catalog update via BroadcastChannel - refreshing marketplace...');
        if (typeof initMarketplace === 'function') initMarketplace();
      }
    };
  }

  // Storage event fallback (cross-tab only)
  window.addEventListener('storage', (e) => {
    if (e.key === 'merchCatalogDirty') {
      console.log('💾 Catalog dirty via storage event - refreshing marketplace...');
      if (typeof initMarketplace === 'function') initMarketplace();
    }
  });
}

// Polling fallback for browsers without BroadcastChannel
if (!catalogChannel) {
  let lastDirtyTimestamp = 0;
  setInterval(() => {
    const dirty = localStorage.getItem('merchCatalogDirty');
    if (dirty) {
      const ts = parseInt(dirty);
      if (ts > lastDirtyTimestamp) {
        lastDirtyTimestamp = ts;
        console.log('⏰ Catalog dirty via polling - refreshing marketplace...');
        if (typeof initMarketplace === 'function') initMarketplace();
      }
    }
  }, 2000);
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

/* ─── AUTH & USER MANAGEMENT ──────────────────────────────── */

let users = (typeof loadLocal === 'function') ? loadLocal('merchUsers', []) : (localStorage.getItem('merchUsers') ? JSON.parse(localStorage.getItem('merchUsers')) : []);


function createAccount(type, name, email, password) {
  if (!type || !name || !email || !password) {
    showToast('Please fill in all fields.', 'error'); 
    return null;
  }
  if (users.find(u => u.email === email)) {
    showToast('An account with that email already exists.', 'error'); 
    return null;
  }
  const user = {
    id: Date.now(),
    type, 
    name,
    email,
    password, 
    createdAt: new Date().toISOString(),
    orders: [],
    profile: { avatar: '' }
  };
  users.push(user);
  saveLocal('merchUsers', users);
  if (user.type === 'brand') {
    saveLocal(`merchInventory_${user.id}`, []);
    saveLocal(`merchOrders_${user.id}`, []);
  }
  showToast(`Welcome, ${name}! Account created.`, 'success');
  return user;
}

function login(email, password) {
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) { 
    showToast('Invalid email or password.', 'error'); 
    return null; 
  }
  saveLocal('currentUserId', user.id);
  setTimeout(() => {
    window.location.href = user.type === 'brand' ? 'brandflow.html' : 'marketplace.html';
  }, 800);
  return user;
}

function logout() {
  localStorage.removeItem('currentUserId');
  window.location.href = 'index.html';
}

function getCurrentUser() {
  const id = loadLocal('currentUserId', null);
  return users.find(u => u.id == id) || null;
}

function getUserDataKey(baseKey, userId = null) {
  const user = userId ? users.find(u => u.id == userId) : getCurrentUser();
  if (!user) return baseKey;
  return `${baseKey}_${user.id}`;
}

/* ─── CART SYSTEM ──────────────────────────────────────────── */

function getGlobalCart() { return []; }
function saveGlobalCart(c) { /* cart disabled */ }

function getCartCount() {
  return 0;
}

function updateCartBadge() {
  // Cart badge removed. Wishlist badge uses localStorage.merchCart.
  const wishlist = loadLocal('merchCart', []);
  const count = wishlist.reduce((s, i) => s + (i.quantity || 1), 0);
  document.querySelectorAll('.wishlist-count, #wishlist-count').forEach(el => {
    el.textContent = count;
    el.style.display = count > 0 ? 'inline-flex' : 'none';
  });
}

function addToCart(btn) {
  // Cart disabled. Route "Add" action to wishlist instead.
  if (btn.disabled) return;

  const card  = btn.closest('.product-card');
  const id    = card.dataset.id;
  const title = card.querySelector('.product-title')?.textContent.trim() || 'Item';
  const priceRaw = card.querySelector('.product-price')?.textContent.trim() || 'KES 0';
  const price = parseFloat(priceRaw.replace(/[^0-9.]/g, '')) || 0;
  const seller = card.querySelector('.seller-name')?.textContent.trim() || 'MerchMarket';
  const imageSrc = card.querySelector('img')?.src || '';
  const stock = parseInt(card.dataset.stock) || 999;

  if (stock === 0) { showToast('Out of stock!', 'error'); return; }

  const cartId = id.startsWith('inv-') ? id : 'static-' + title.toLowerCase().replace(/\s+/g, '-');

  // Use merchCart localStorage as wishlist storage (existing wishlist.js expects this).
  let wishlist = loadLocal('merchCart', []);
  const existing = wishlist.find(i => i.id === cartId);
  if (existing) {
    existing.quantity++;
  } else {
    wishlist.push({ id: cartId, name: title, price, seller, quantity: 1, image: imageSrc });
  }
  saveLocal('merchCart', wishlist);

  // Update wishlist badge if present
  const badge = document.getElementById('wishlist-count');
  if (badge) {
    const count = wishlist.reduce((s, i) => s + (i.quantity || 1), 0);
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  showToast(`${title} added to wishlist!`, 'success');
}


function addToCartById(itemId) {
  // Cart disabled. Route to wishlist instead.
  const item = currentProducts.find(p => p.id === itemId);
  if (!item) {
    showToast('Product not found', 'error');
    return;
  }

  let wishlist = loadLocal('merchCart', []);
  const existing = wishlist.find(c => c.id === 'inv-' + itemId);
  if (existing) {
    existing.quantity++;
  } else {
    wishlist.push({
      id: 'inv-' + itemId,
      name: item.name,
      price: item.price,
      seller: item.seller,
      quantity: 1,
      image: item.images && item.images.length > 0 ? item.images[0].url || item.images[0] : ''
    });
  }

  saveLocal('merchCart', wishlist);

  const badge = document.getElementById('wishlist-count');
  if (badge) {
    const count = wishlist.reduce((s, i) => s + (i.quantity || 1), 0);
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  showToast(`${item.name} added to wishlist!`, 'success');
}


/* ─── GLOBAL PRODUCT CATALOG ───────────────────────────────── */

const CATALOG_KEY = 'merchProducts';
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

function normalizeItemForCatalog(item, brand) {
  const stock = typeof item.stock === 'number' ? item.stock : 999;
  const images = Array.isArray(item.images)
    ? item.images.map(img => typeof img === 'string' ? { url: img } : (img?.url ? img : null)).filter(Boolean)
    : [];
  return {
    id: `${brand.id}-inv-${item.id}`,
    rawId: item.id,
    brandId: brand.id,
    name: item.name || 'Untitled Product',
    price: parseFloat(item.price) || 0,
    seller: brand.name || 'Unknown Brand',
    category: item.category || 'other',
    condition: item.condition || 'new',
    tags: Array.isArray(item.tags) ? item.tags : [],
    gradient: item.gradient || getGradientForId(item.id),
    images: images,
    stock: stock,
    badge: stock === 0 ? 'Out of Stock' : (item.badge || ''),
    sku: item.sku || '',
    createdAt: item.createdAt || new Date().toISOString()
  };
}

function rebuildCatalogFromAllBrands() {
  try {
    users = loadLocal('merchUsers', []);
    let catalog = [...loadStaticProducts()];
    users.filter(u => u.type === 'brand').forEach(brand => {
      try {
        const inv = loadLocal(`merchInventory_${brand.id}`, []);
        inv.forEach(item => {
          const normalized = normalizeItemForCatalog(item, brand);
          catalog.push(normalized);
        });
      } catch (e) {
        console.error(`Error loading inventory for brand ${brand.id}:`, e);
      }
    });
    saveLocal(CATALOG_KEY, catalog);
    return catalog;
  } catch (e) {
    console.error('Error rebuilding catalog:', e);
    return loadLocal(CATALOG_KEY, loadStaticProducts());
  }
}

function syncBrandToCatalog(brandId) {
  // Marketplace-side product uploading disabled.
  // Inventory updates should only come from Brand Admin (brandflow).
  // Keeping this function as a no-op prevents marketplace listing from creating/pushing new products.
  console.log(`Marketplace uploads disabled - ignoring syncBrandToCatalog(${brandId})`);
}



/* ─── MARKETPLACE ──────────────────────────────────────────── */

function loadStaticProducts() {
  // Static products removed.
  // (Keeps function to avoid runtime errors.)
  return [];
}



let STATIC_PRODUCTS = [];
let currentProducts = [];
let searchQuery = '';

function initMarketplace() {
  console.log('=== initMarketplace START ===');
  users = loadLocal('merchUsers', []);
  STATIC_PRODUCTS = loadStaticProducts();

  // Always rebuild catalog to ensure brand inventory is included
  // (not just when empty - brands may have added products since last load)
  let catalog = rebuildCatalogFromAllBrands();

  // Filter to products with stock > 0
  currentProducts = catalog.filter(item => {
    const stock = item.stock != null ? item.stock : 999;
    return stock > 0;
  });
  
  console.log('Total catalog items:', catalog.length);
  console.log('Total available products (stock > 0):', currentProducts.length);

  renderProductGrid(currentProducts);
  
  console.log('=== initMarketplace END ===');
}

function searchProducts() {
  searchQuery = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';
  
  // Filter currentProducts array instead of DOM manipulation
  const filtered = currentProducts.filter(product => {
    if (!searchQuery) return true;
    const name = (product.name || '').toLowerCase();
    const seller = (product.seller || '').toLowerCase();
    return name.includes(searchQuery) || seller.includes(searchQuery);
  });
  
  // Re-render with filtered results
  renderProductGrid(filtered);
}

function renderProductGrid(products) {
  console.log('Rendering', products.length, 'products');
  const grid = document.getElementById('productGrid');
  if (!grid) {
    console.error('Product grid not found');
    return;
  }

  if (products.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:4rem;color:#a0a0a0;">
      <div style="font-size:3rem;margin-bottom:1rem;">🔍</div>
      <p>No products found. Try a different search or filter.</p>
    </div>`;
    return;
  }

  const countEl = document.querySelector('.results-count strong');
  if (countEl) countEl.textContent = products.length;

  grid.innerHTML = products.map(p => {
    const stockBadge = p.stock < 5 ? `<div class="product-badge">${p.stock} left</div>` : '';
    const addBtnText = p.stock === 0 ? 'Out of Stock' : 'Add to Wishlist';
    const addBtnDisabled = p.stock === 0 ? 'disabled style="opacity:.6;cursor:not-allowed"' : '';
    // Route button action to wishlist (function addToCart already does this in this project)
    const addBtnFn = 'addToCart(this)';
    
    let imageSrc = '';
    if (p.images && p.images.length > 0) {
      const firstImg = p.images[0];
      imageSrc = typeof firstImg === 'string' ? firstImg : (firstImg?.url || '');
    }
    const imageHtml = imageSrc 
      ? `<img src="${imageSrc}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover;border-radius:8px 8px 0 0;">`
      : `<div class="image-placeholder" style="width:100%;height:100%;background:linear-gradient(45deg,#ccc,#ddd);border-radius:8px 8px 0 0;display:flex;align-items:center;justify-content:center;color:#666;font-size:1.2rem;">No Image</div>`;

    return `
      <div class="product-card" data-id="${p.id}" data-stock="${p.stock || 999}">
        <div class="product-image" style="background:${p.gradient || '#1e1e1e'};border-radius:12px 12px 0 0;overflow:hidden;">
          ${imageHtml}
          ${p.badge && p.badge.toLowerCase() !== 'new' ? `<div class="product-badge">${p.badge}</div>` : ''}
          ${stockBadge}
          <button class="wishlist-btn" onclick="toggleWishlist(this)">♡</button>
        </div>
      <div class="product-details">
          <div class="product-seller">
            <div class="seller-badge" style="background:${p.gradient || 'var(--gradient-1)'}"></div>
            <span class="seller-name">${p.seller}</span>
          </div>
          <h3 class="product-title">${p.name}</h3>
          ${p.condition ? `<div style="font-size:.75rem;color:#a0a0a0;margin-bottom:.3rem;text-transform:capitalize;">Condition: ${p.condition}</div>` : ''}
          <div class="product-footer">
            <div class="product-price">KES ${p.price.toFixed(0)}</div>
            <button class="add-to-cart-btn" onclick="addToCart(this)" ${addBtnDisabled}>${addBtnText}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Update results count after render
  const resultsCount = document.querySelector('.results-count');
  if (resultsCount) resultsCount.innerHTML = `Showing <strong>${products.length}</strong> results`;
}

function toggleWishlist(btn) {
  btn.classList.toggle('active');
  btn.textContent = btn.classList.contains('active') ? '♥' : '♡';
  showToast(btn.classList.contains('active') ? 'Added to wishlist!' : 'Removed from wishlist', 'info');
}

function initAdmin() {
  if (typeof tabSwitch === 'function') tabSwitch('orders');
}

/* ─── SOCIAL FEED ─────────────────────────────────────────── */

function toggleFollow(btn) {
  const isFollowing = btn.classList.toggle('following');
  btn.textContent = isFollowing ? 'Following' : 'Follow';
  btn.style.borderColor = isFollowing ? '#c47d2e' : '';
  btn.style.color = isFollowing ? '#ffd8b5' : '';
  showToast(isFollowing ? 'Now following!' : 'Unfollowed', 'info');
}

function toggleLike(el) {
  const countSpan = el.querySelector('.like-count');
  let count = parseFloat(countSpan.textContent) || 0;
  const isK = countSpan.textContent.includes('K');
  if (el.classList.toggle('liked')) {
    el.style.color = '#ff3366';
    count += 0.1;
  } else {
    el.style.color = '';
    count -= 0.1;
  }
  if (isK) {
    countSpan.textContent = count.toFixed(1) + 'K';
  } else {
    countSpan.textContent = Math.round(count);
  }
}

function loadMore() {
  showToast('Loading more posts...', 'info');
  setTimeout(() => showToast('No more posts to load.', 'info'), 800);
}

/* ─── ORDERS ──────────────────────────────────────────────── */

function renderMemberOrders() {
  const tbody = document.getElementById('orders-body');
  if (!tbody) return;

  const user = getCurrentUser();
  let orders = [];
  if (user) {
    const allKeys = Object.keys(localStorage).filter(k => k.startsWith('merchOrders_'));
    allKeys.forEach(key => {
      const brandOrders = loadLocal(key, []);
      brandOrders.forEach(o => {
        if (o.customer && o.customer.email === user.email) {
          orders.push(o);
        }
      });
    });
  }

  if (orders.length === 0) {
    // Keep static fallback rows if no real orders
    return;
  }

  document.querySelectorAll('.static-fallback').forEach(r => r.remove());

  tbody.innerHTML += orders.map(o => {
    const totalNum = parseInt(o.total?.replace(/,/g, '') || 0);
    const statusClass = o.status || 'pending';
    return `
      <tr>
        <td style="font-family:monospace;color:#ffd8b5;">#${o.id}</td>
        <td>${o.item}</td>
        <td>1</td>
        <td style="font-size:.85rem;color:#a0a0a0;">${o.location || 'Nairobi, Kenya'}</td>
        <td style="font-size:.85rem;color:#a0a0a0;">${o.dateOrdered}</td>
        <td><span class="status-badge ${statusClass}">${statusClass.charAt(0).toUpperCase() + statusClass.slice(1)}</span></td>
        <td><strong>KES ${totalNum.toLocaleString()}</strong></td>
      </tr>
    `;
  }).join('');
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

document.addEventListener('DOMContentLoaded', () => {
  updateCartBadge();
  
  const page = window.location.pathname.split('/').pop() || 'index.html';

  if (page.includes('marketplace.html')) {
    console.log('Marketplace page detected - initializing...');
    initMarketplace();
    // Marketplace-side upload/listing modal disabled.
    // (No sellModal wiring)
  }

  // Other page inits...
  if (page.includes('brandflow')) initAdmin();
  
  // Auth forms
  const loginForm = document.querySelector('.login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', e => {
      e.preventDefault();
      const email = document.getElementById('login-email')?.value.trim() || document.getElementById('username')?.value.trim();
      const password = document.getElementById('login-password')?.value || document.getElementById('password')?.value;
      login(email, password);
    });
  }

  const signupForm = document.querySelector('.signup-form');
  if (signupForm) {
    signupForm.addEventListener('submit', e => {
      e.preventDefault();
      const type = document.body.dataset.userType || 'member';
      const name = document.getElementById('brandName')?.value.trim() || document.getElementById('fullName')?.value.trim();
      const email = document.getElementById('email')?.value.trim();
      const password = document.getElementById('password')?.value;
      const confirm = document.getElementById('confirmPassword')?.value;
      if (password !== confirm) return showToast("Passwords don't match", 'error');
      const user = createAccount(type, name, email, password);
      if (user) window.location.href = type === 'brand' ? 'authbrand.html' : 'marketplace.html';
    });
  }
});
