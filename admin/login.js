document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const err = document.getElementById('err');
  err.textContent = '';
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { err.textContent = data.error || 'Sign-in failed.'; return; }
    location.href = '/';
  } catch (x) {
    err.textContent = 'No connection. Try again.';
  } finally {
    btn.disabled = false;
  }
});
