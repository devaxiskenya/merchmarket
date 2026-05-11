/* ─── BRANDFLOW ADMIN FUNCTIONS ────────────────────────────────────── */

function tabSwitch(tabName) {
  // Update nav tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  
  // Update modules
  document.querySelectorAll('.module').forEach(mod => {
    mod.classList.toggle('active', mod.id === tabName);
  });
  
  // Load tab data if function exists
  if (window[`load${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Tab`]) {
    window[`load${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Tab`]();
  }
  
  // Specific handling for inventory tab
  if (tabName === 'inventory') {
    setTimeout(loadInventoryTab, 100);
  }
}

// AUTO-init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('Brandflow admin ready');
  
  // Wire up nav tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      const tabName = tab.dataset.tab;
      tabSwitch(tabName);
    });
  });
  
  // Add Item button
  document.getElementById('add-inventory')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Open modal for creating a new item (not editing)
    if (typeof showInventoryModal === 'function') {
      showInventoryModal(null);
    } else {
      console.error('showInventoryModal is not defined');
    }
  });

  
  // Load initial orders
  tabSwitch('orders');
  
  // Buttons
  document.getElementById('refresh-orders')?.addEventListener('click', () => {
    loadOrdersTab(document.getElementById('orders-search')?.value || '');
    showToast('Orders refreshed!', 'success');
  });
  
  document.getElementById('reset-db')?.addEventListener('click', resetDatabase);
  
  // Search
  document.getElementById('orders-search')?.addEventListener('input', debounce(loadOrdersTab, 300));
});

function loadOrdersTab(filter = '') {
  const user = getCurrentUser();
  if (!user || user.type !== 'brand') {
    showToast('Brand login required', 'error');
    return;
  }
  
  const ordersKey = getUserDataKey('merchOrders');
  // Demo orders disabled.
  let orders = loadLocal(ordersKey, []);

  
  if (filter) {
    orders = orders.filter(o => 
      o.customer.name.toLowerCase().includes(filter.toLowerCase()) ||
      o.id.toLowerCase().includes(filter.toLowerCase())
    );
  }
  
  // Update stats
  const stats = calculateOrderStats(orders);
  updateStats(stats);
  
  // Render table
  renderOrdersTable(orders);
}




function calculateOrderStats(orders) {
  const total = orders.length;
  const pending = orders.filter(o => o.status === 'pending').length;
  const confirmed = orders.filter(o => o.status === 'confirmed').length;
  const active = orders.filter(o => o.status === 'active').length;
  const completed = orders.filter(o => o.status === 'completed').length;
  const cancelled = orders.filter(o => o.status === 'cancelled').length;
  const revenue = orders.reduce((sum, o) => sum + parseInt(o.total.replace(/,/g, '') || 0), 0);
  
  return { total, pending, confirmed, active, completed, cancelled, revenue };
}

function updateStats(stats) {
  const fields = {
    'total-orders': stats.total,
    'pending-orders': stats.pending,
    'confirmed-orders': stats.confirmed,
    'active-orders': stats.active,
    'completed-orders': stats.completed,
    'cancelled-orders': stats.cancelled,
    'total-revenue': `KES ${stats.revenue.toLocaleString()}`
  };
  
  Object.entries(fields).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });
}

function renderOrdersTable(orders) {
  const tbody = document.getElementById('orders-table-body');
  if (!tbody) return;
  
  if (orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:3rem;color:var(--text-secondary);">No orders found</td></tr>';
    return;
  }
  
  tbody.innerHTML = orders.map(order => `
    <tr>
      <td><strong>#${order.id}</strong></td>
      <td>${order.customer.name}<br><small>${order.customer.email}</small></td>
      <td>${order.item}</td>
      <td>${order.dateOrdered}<br><small>Updated: ${order.dateUpdated}</small></td>
      <td>${order.location}</td>
      <td>KES ${order.total}</td>
      <td><span class="status ${order.status}">${order.status.toUpperCase()}</span></td>
      <td>
        <button class="action-btn" onclick="viewOrder('${order.id}')">View</button>
        <button class="action-btn" style="background:#4caf50;color:white;" onclick="confirmOrder('${order.id}')">Confirm</button>
      </td>
    </tr>
  `).join('');
}

function loadInventoryTab() {
  const user = getCurrentUser();
  if (!user || user.type !== 'brand') return;
  
  const invKey = getUserDataKey('merchInventory');
  const inventory = loadLocal(invKey, []);
  
  const tbody = document.getElementById('inventory-table-body');
  if (tbody) {
    tbody.innerHTML = inventory.map(item => `
      <tr>
        <td>${item.name}</td>
        <td>${item.sku}</td>
        <td>${item.stock}</td>
        <td>KES ${item.price?.toLocaleString()}</td>
        <td>${item.images?.length || 0} images</td>
        <td>
          <button class="action-btn" onclick="showInventoryModal('${item.id}')">Edit</button>
          <button class="action-btn" style="background:#f44336;color:white;" onclick="deleteInventoryItem('${item.id}')">Delete</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="6" style="text-align:center;padding:3rem;color:var(--text-secondary);">No inventory items</td></tr>';
  }
}

function loadCustomersTab() {
  const ordersKey = getUserDataKey('merchOrders');
  const orders = loadLocal(ordersKey, []);
  
  const customers = {};
  orders.forEach(order => {
    const email = order.customer.email;
    if (!customers[email]) {
      customers[email] = { name: order.customer.name, orders: 0, total: 0 };
    }
    customers[email].orders++;
    customers[email].total += parseInt(order.total.replace(/,/g, '') || 0);
  });
  
  const customerList = Object.entries(customers).map(([email, data]) => ({
    name: data.name,
    email,
    orders: data.orders,
    total: data.total.toLocaleString()
  }));
  
  const tbody = document.getElementById('customers-table-body');
  if (tbody) {
    tbody.innerHTML = customerList.map(cust => `
      <tr>
        <td>${cust.name}</td>
        <td>${cust.email}</td>
        <td>${cust.orders}</td>
        <td>KES ${cust.total}</td>
        <td><button class="action-btn">View</button></td>
      </tr>
    `).join('') || '<tr><td colspan="5" style="text-align:center;padding:3rem;color:var(--text-secondary);">No customers yet</td></tr>';
  }
}

function resetDatabase() {
  if (!confirm('⚠️ RESET ALL DATA? This deletes orders, inventory, customers PERMANENTLY.')) return;
  
  const user = getCurrentUser();
  if (!user) {
    showToast('Login required', 'error');
    return;
  }
  
  const keys = ['merchOrders', 'merchInventory'];
  keys.forEach(key => saveLocal(getUserDataKey(key), []));
  
  showToast('Database reset complete!', 'success');
  setTimeout(() => tabSwitch('orders'), 1500);
}

function viewOrder(id) {
  const user = getCurrentUser();
  if (!user || user.type !== 'brand') {
    showToast('Brand login required', 'error');
    return;
  }

  const ordersKey = getUserDataKey('merchOrders');
  const orders = loadLocal(ordersKey, []);
  const order = orders.find(o => o.id === id);
  if (!order) {
    showToast('Order not found', 'error');
    return;
  }

  const modal = document.getElementById('inventory-modal');
  if (!modal) {
    showToast('Modal container not found', 'error');
    return;
  }

  const itemsHtml = order.items && order.items.length > 0
    ? order.items.map(i => `<li>${i.tracking || i.sku || i.name} (Qty: ${i.quantity}) — KES ${i.price.toFixed(0)}</li>`).join('')
    : `<li>${order.item}</li>`;

  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()" style="
        max-width:560px;max-height:90vh;overflow-y:auto;
        background:white;border-radius:20px;padding:2.5rem;box-shadow:0 25px 60px rgba(0,0,0,.3);
        position:relative;animation:modalSlideIn .3s cubic-bezier(.4,0,.2,1);
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
          <h2 style="margin:0;font-size:1.6rem;font-weight:700;color:#1a1a1a;">Order #${order.id}</h2>
          <button onclick="closeModal()" style="
            background:none;border:none;font-size:1.6rem;cursor:pointer;color:#999;
            padding:.3rem;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;
            transition:background .2s;
          " onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='none'">×</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:1.2rem;color:#333;font-size:.95rem;">
          <div style="background:#f8f9fa;border-radius:12px;padding:1.2rem;">
            <h4 style="margin:0 0 .6rem 0;color:#667eea;font-size:1rem;">👤 Customer</h4>
            <p style="margin:.2rem 0;"><strong>Name:</strong> ${order.customer.name}</p>
            <p style="margin:.2rem 0;"><strong>Email:</strong> ${order.customer.email}</p>
          </div>

          <div style="background:#f8f9fa;border-radius:12px;padding:1.2rem;">
            <h4 style="margin:0 0 .6rem 0;color:#667eea;font-size:1rem;">📦 Items</h4>
            <ul style="margin:0;padding-left:1.2rem;">${itemsHtml}</ul>
          </div>

          <div style="background:#f8f9fa;border-radius:12px;padding:1.2rem;">
            <h4 style="margin:0 0 .6rem 0;color:#667eea;font-size:1rem;">📍 Shipping</h4>
            <p style="margin:.2rem 0;"><strong>Location:</strong> ${order.location || 'Nairobi, Kenya'}</p>
            <p style="margin:.2rem 0;"><strong>Date Ordered:</strong> ${order.dateOrdered}</p>
            <p style="margin:.2rem 0;"><strong>Last Updated:</strong> ${order.dateUpdated}</p>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;background:#f8f9fa;border-radius:12px;padding:1.2rem;">
            <div>
              <p style="margin:.2rem 0;"><strong>Status:</strong> <span class="status ${order.status}">${order.status.toUpperCase()}</span></p>
            </div>
            <div style="font-size:1.3rem;font-weight:700;color:#1a1a1a;">
              KES ${order.total}
            </div>
          </div>
        </div>

        <div style="display:flex;gap:1rem;justify-content:flex-end;margin-top:1.5rem;">
          ${order.status === 'pending' ? `
            <button type="button" onclick="confirmOrder('${order.id}');closeModal();" style="
              padding:1rem 2rem;border:none;border-radius:12px;background:#4caf50;color:white;font-weight:600;font-size:1rem;cursor:pointer;transition:background .2s;
            ">Confirm Order</button>
          ` : ''}
          <button type="button" onclick="closeModal()" style="
            padding:1rem 2rem;border:none;border-radius:12px;background:#f5f5f5;color:#666;font-weight:600;font-size:1rem;cursor:pointer;transition:background .2s;
          ">Close</button>
        </div>

        <style>
          @keyframes modalSlideIn {
            from { opacity:0; transform: translateY(-30px) scale(.95); }
            to   { opacity:1; transform: translateY(0) scale(1); }
          }
          .modal-overlay { position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center;padding:2rem; }
        </style>
      </div>
    </div>
  `;
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function confirmOrder(id) {
  const user = getCurrentUser();
  if (!user || user.type !== 'brand') {
    showToast('Brand login required', 'error');
    return;
  }

  const ordersKey = getUserDataKey('merchOrders');
  let orders = loadLocal(ordersKey, []);
  const order = orders.find(o => o.id === id);
  if (!order) {
    showToast('Order not found', 'error');
    return;
  }

  order.status = 'confirmed';
  order.dateUpdated = new Date().toLocaleDateString();
  saveLocal(ordersKey, orders);

  showToast(`Order ${id} confirmed`, 'success');
  loadOrdersTab(document.getElementById('orders-search')?.value || '');
}
function deleteInventoryItem(id) { 
  if (confirm('Delete this item?')) {
    const user = getCurrentUser();
    if (!user) return;
    
    const invKey = getUserDataKey('merchInventory');
    let inventory = loadLocal(invKey, []);
    inventory = inventory.filter(item => item.id !== id);
    saveLocal(invKey, inventory);
    if (typeof syncBrandToCatalog === 'function') syncBrandToCatalog(user.id);
    localStorage.setItem('merchCatalogDirty', Date.now().toString());
    
    showToast('Item deleted', 'success');
    loadInventoryTab(); // Refresh table
  }
}

function closeModal() {
  const modal = document.getElementById('inventory-modal');
  if (modal) {
    modal.innerHTML = '';
    modal.classList.remove('active');
  }
  document.body.style.overflow = ''; // Re-enable scroll
}

function showInventoryModal(itemId = null) {
  const user = getCurrentUser();
  if (!user || user.type !== 'brand') {
    showToast('Brand login required', 'error');
    return;
  }
  
  const modal = document.getElementById('inventory-modal');
  if (!modal) {
    showToast('Modal container not found', 'error');
    return;
  }
  
  // Load current inventory
  const invKey = getUserDataKey('merchInventory');
  let inventory = loadLocal(invKey, []);
  
  // Find item if editing
  const item = itemId ? inventory.find(item => item.id === itemId) : null;
  const isEdit = !!item;
  
  // Modal overlay + form
  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()" style="
        max-width:580px;max-height:90vh;overflow-y:auto;
        background:white;border-radius:20px;padding:2.5rem;box-shadow:0 25px 60px rgba(0,0,0,.3);
        position:relative;animation:modalSlideIn .3s cubic-bezier(.4,0,.2,1);
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem;">
          <h2 style="margin:0;font-size:1.8rem;font-weight:700;color:#1a1a1a;">
            ${isEdit ? 'Edit Item' : 'Add New Inventory Item'}
          </h2>
          <button onclick="closeModal()" style="
            background:none;border:none;font-size:1.6rem;cursor:pointer;color:#999;
            padding:.3rem;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;
            transition:background .2s;
          " onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='none'">×</button>
        </div>
        
        <form id="inventory-form" style="display:flex;flex-direction:column;gap:1.5rem;">
          <div>
            <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;font-size:.95rem;">Item Name</label>
            <input type="text" id="item-name" required value="${item?.name || ''}" style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;transition:border-color .2s;box-sizing:border-box;"
                   placeholder="e.g. Custom Logo Hoodie">
          </div>
          
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;">
            <div>
              <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;font-size:.95rem;">SKU</label>
              <input type="text" id="item-sku" required value="${item?.sku || ''}" style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;transition:border-color .2s;box-sizing:border-box;"
                     placeholder="e.g. HOD-001">
            </div>
            <div>
              <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;font-size:.95rem;">Stock</label>
              <input type="number" id="item-stock" min="0" required value="${item?.stock || 0}" style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;transition:border-color .2s;box-sizing:border-box;">
            </div>
          </div>
          
          <div>
            <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;font-size:.95rem;">Price (KES)</label>
            <input type="number" id="item-price" min="0" step="0.01" required value="${item?.price || ''}" style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;transition:border-color .2s;box-sizing:border-box;"
                   placeholder="e.g. 2500">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;">
            <div>
              <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;font-size:.95rem;">Category</label>
              <select id="item-category" required style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;transition:border-color .2s;box-sizing:border-box;">
                <option value="tshirts">T-Shirts</option>
                <option value="hoodies">Hoodies</option>
                <option value="caps">Caps</option>
                <option value="mugs">Mugs</option>
                <option value="bags">Bags</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;font-size:.95rem;">Tags</label>
              <input type="text" id="item-tags" value="${item?.tags?.join(', ') || ''}" style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;transition:border-color .2s;box-sizing:border-box;"
                     placeholder="e.g. trendy, limited">
            </div>
          </div>
          
          <div>
            <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;font-size:.95rem;">Images</label>
            <input type="file" id="item-image-files" accept="image/*" multiple style="display:none">
            <button type="button" id="btn-select-images" style="
              padding:.8rem 1.2rem;border:2px dashed #c0c0c0;border-radius:12px;background:#fafafa;
              color:#555;font-weight:600;font-size:.95rem;cursor:pointer;width:100%;transition:border-color .2s;
            " onmouseover="this.style.borderColor='#667eea'" onmouseout="this.style.borderColor='#c0c0c0'">
              📁 Click to choose images from device
            </button>
            <div id="image-preview-list" style="display:flex;flex-wrap:wrap;gap:.6rem;margin-top:.8rem;"></div>
            <small style="color:#666;font-size:.85rem;">You can select multiple images. Existing images are kept unless removed.</small>
          </div>
          
          <div style="display:flex;gap:1rem;justify-content:flex-end;margin-top:1rem;">
            <button type="button" onclick="closeModal()" style="
              padding:1rem 2rem;border:none;border-radius:12px;background:#f5f5f5;color:#666;font-weight:600;font-size:1rem;cursor:pointer;transition:background .2s;
            ">Cancel</button>
            ${isEdit ? `
              <button type="button" onclick="deleteInventoryItem('${itemId}');closeModal();" style="
                padding:1rem 2rem;border:none;border-radius:12px;background:#f44336;color:white;font-weight:600;font-size:1rem;cursor:pointer;transition:background .2s;
              ">Delete Item</button>
            ` : ''}
            <button type="submit" style="
              padding:1rem 2.2rem;border:none;border-radius:12px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;font-weight:700;font-size:1rem;cursor:pointer;transition:transform .2s,box-shadow .2s;
            " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 25px rgba(102,126,234,.4)'"
               onmouseout="this.style.transform='';this.style.boxShadow=''">
              ${isEdit ? 'Update Item' : 'Add Item'}
            </button>
          </div>
        </form>
        
        <style>
          @keyframes modalSlideIn {
            from { opacity:0; transform: translateY(-30px) scale(.95); }
            to { opacity:1; transform: translateY(0) scale(1); }
          }
          .modal-overlay { position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center;padding:2rem; }
          input:focus, textarea:focus { outline:none !important; border-color:#667eea !important; box-shadow:0 0 0 3px rgba(102,126,234,.1) !important; }
        </style>
      </div>
    </div>
  `;
  
  // Show modal
  modal.classList.add('active');

  // Pre-select category when editing
  if (isEdit && item?.category) {
    document.getElementById('item-category').value = item.category;
  }

  // Prevent body scroll
  document.body.style.overflow = 'hidden';

  // ─── Image upload handling ───
  const fileInput   = document.getElementById('item-image-files');
  const selectBtn   = document.getElementById('btn-select-images');
  const previewList = document.getElementById('image-preview-list');

  // Collect images as plain strings (URLs or base64 data URLs)
  let currentImages = (item?.images || []).map(img => {
    // Support both legacy string URLs and {url:...} objects from marketplace
    return typeof img === 'string' ? img : (img?.url || '');
  }).filter(Boolean);

  function renderPreviews() {
    if (!previewList) return;
    previewList.innerHTML = currentImages.map((src, idx) => `
      <div style="position:relative;width:70px;height:70px;border-radius:8px;overflow:hidden;border:1px solid #ddd;flex-shrink:0;">
        <img src="${src}" style="width:100%;height:100%;object-fit:cover;">
        <button type="button" data-idx="${idx}" class="btn-rm-img" style="
          position:absolute;top:2px;right:2px;width:20px;height:20px;border:none;border-radius:50%;
          background:#f44336;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;
        ">×</button>
      </div>
    `).join('');

    previewList.querySelectorAll('.btn-rm-img').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.idx);
        currentImages.splice(idx, 1);
        renderPreviews();
      };
    });
  }

  if (selectBtn && fileInput) {
    selectBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      if (files.length === 0) return;
      let processed = 0;
      files.forEach(file => {
        const reader = new FileReader();
        reader.onload = ev => {
          currentImages.push(ev.target.result);
          processed++;
          if (processed === files.length) {
            renderPreviews();
            fileInput.value = ''; // reset so same files can be re-selected
          }
        };
        reader.readAsDataURL(file);
      });
    });
  }

  renderPreviews();

  // Handle form submit
  const form = document.getElementById('inventory-form');
  if (form) {
    form.onsubmit = function(e) {
      e.preventDefault();

      const formData = {
        id: itemId || `ITEM-${Date.now()}`,
        name: document.getElementById('item-name').value.trim(),
        sku: document.getElementById('item-sku').value.trim(),
        stock: parseInt(document.getElementById('item-stock').value) || 999,
        price: parseFloat(document.getElementById('item-price').value) || 0,
        category: document.getElementById('item-category').value,
        condition: 'new',
        tags: document.getElementById('item-tags').value.split(',').map(t => t.trim()).filter(Boolean),
        images: currentImages,
        createdAt: item?.createdAt || new Date().toISOString()
      };

      if (!formData.name || !formData.sku) {
        showToast('Name and SKU are required', 'error');
        return;
      }

      // Save to inventory
      if (isEdit) {
        const idx = inventory.findIndex(i => i.id === itemId);
        if (idx !== -1) inventory[idx] = formData;
      } else {
        inventory.push(formData);
      }

      saveLocal(invKey, inventory);
      if (typeof syncBrandToCatalog === 'function') syncBrandToCatalog(user.id);
      
      // Notify marketplace to refresh if it's open
      localStorage.setItem('merchCatalogDirty', Date.now().toString());
      
      loadInventoryTab(); // Refresh table
      closeModal();

      const action = isEdit ? 'updated' : 'added';
      showToast(`Item ${action} successfully!`, 'success');
    };
  }
}

