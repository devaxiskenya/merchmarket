/*user*/
async function addUser(name, email, role = 'customer') {
  const { data, error } = await supabase
    .from('users')
    .insert([{ name, email, role }]);
  if (error) console.error(error);
  else console.log('User added:', data);
}
/*brand*/
async function addBrand(name, logoUrl, description) {
  const { data, error } = await supabase
    .from('brands')
    .insert([{ name, logo_url: logoUrl, description }]);
  if (error) console.error(error);
  else console.log('Brand added:', data);
}
/*product*/
async function addProduct(name, description, price, stock, imageUrl, brandId) {
  const { data, error } = await supabase
    .from('products')
    .insert([{
      name,
      description,
      price,
      stock_quantity: stock,
      image_url: imageUrl,
      brand_id: brandId
    }]);
  if (error) console.error(error);
  else console.log('Product added:', data);
}

async function getProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, price, stock_quantity, image_url');
  if (error) console.error(error);
  else console.table(data);
}

/*orders*/
async function createOrder(userId, items) {
  // Step 1: create order
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert([{ user_id: userId, status: 'pending', total_amount: 0 }])
    .select()
    .single();

  if (orderError) return console.error(orderError);

  let total = 0;

  // Step 2: add items
  for (const item of items) {
    const { data: product } = await supabase
      .from('products')
      .select('price')
      .eq('id', item.product_id)
      .single();

    const price = product.price;
    total += price * item.quantity;

    await supabase.from('order_items').insert([{
      order_id: order.id,
      product_id: item.product_id,
      quantity: item.quantity,
      price
    }]);
  }

  // Step 3: update total
  await supabase
    .from('orders')
    .update({ total_amount: total })
    .eq('id', order.id);

  console.log('Order created:', order.id, 'Total:', total);
}


document.getElementById('brandLoginForm').addEventListener('submit', async function (e) {
      e.preventDefault();
 
      const btn      = document.getElementById('login-btn');
      const email    = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
 
      // Disable button while the async login call is in flight
      btn.disabled    = true;
      btn.textContent = 'Signing in…';
 
      try {
        await login(email, password);
        // `login()` handles the redirect on success, so nothing more needed here.
      } catch (err) {
        // Unexpected error not already surfaced by showToast inside login()
        console.error('Login error:', err);
        if (typeof showToast === 'function') showToast('Something went wrong. Please try again.', 'error');
      } finally {
        btn.disabled    = false;
        btn.textContent = 'LOG IN AS BRAND';
      }
    });