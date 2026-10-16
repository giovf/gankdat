document.getElementById('fb').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('status');
  const message = document.getElementById('message').value.trim();
  const email = document.getElementById('email').value.trim();
  status.className = '';
  status.textContent = 'sending…';
  try {
    const res = await fetch('/v1/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        ...(email ? { email } : {}),
        page: document.referrer || undefined,
      }),
    });
    const body = await res.json();
    if (body.ok) {
      status.className = 'ok';
      status.textContent = 'received — thank you.';
      document.getElementById('fb').reset();
    } else {
      status.className = 'err';
      status.textContent = body.error?.message || 'something went wrong; try again.';
    }
  } catch {
    status.className = 'err';
    status.textContent = 'network error; try again or email info@gankdat.com.';
  }
});
