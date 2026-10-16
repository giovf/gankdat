// Account dashboard client. External file (not inline) so the page can run
// under a strict script-src 'self' CSP.

// Cloudflare Turnstile: set this to your Turnstile SITE key to enable the
// login CAPTCHA. Left empty ships dark (no widget, no external script) — the
// server also skips verification until TURNSTILE_SECRET_KEY is set, so the
// two must both be configured to turn it on.
const TURNSTILE_SITE_KEY = '0x4AAAAAADxa3orlVPksuZ8i';
// Filled by the Turnstile widget callback per sign-in; must start empty.
let turnstileToken = '';

const $ = (id) => document.getElementById(id);
const banner = $('banner');
function showBanner(text, kind) {
  banner.textContent = text;
  banner.className = 'banner ' + (kind || '');
  banner.classList.remove('hidden');
}

// URL flags from magic-link verify / Stripe redirect, then clean the URL.
(function () {
  const p = new URLSearchParams(location.search);
  if (p.get('error') === 'link_expired')
    showBanner(
      '[ERR] that sign-in link was invalid or already used. Request a new one below.',
      'err',
    );
  else if (p.get('checkout') === 'success')
    showBanner(
      '[OK] payment successful — your plan is active. It may take a few seconds to reflect below.',
      'ok',
    );
  else if (p.get('checkout') === 'cancelled')
    showBanner('[--] checkout cancelled — no charge was made.', '');
  else if (p.get('paypal') === 'success')
    showBanner('[OK] credits added — your top-up balance is updated below.', 'ok');
  else if (p.get('paypal') === 'cancelled')
    showBanner('[--] PayPal checkout cancelled — no charge was made.', '');
  else if (p.get('paypal') === 'error')
    showBanner(
      '[ERR] PayPal could not complete the order — nothing was charged; try again.',
      'err',
    );
  if (p.toString()) history.replaceState(null, '', location.pathname);
})();

// Explicit-render Turnstile only when a site key is configured, so the default
// (unconfigured) build loads no third-party script.
function initTurnstile() {
  if (!TURNSTILE_SITE_KEY) return;
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.defer = true;
  s.onload = () => {
    window.turnstile.render('#turnstile-slot', {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (t) => {
        turnstileToken = t;
      },
      'error-callback': () => {
        turnstileToken = '';
      },
      'expired-callback': () => {
        turnstileToken = '';
      },
    });
  };
  document.head.appendChild(s);
}
initTurnstile();

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { accept: 'application/json' } }, opts));
  let body = {};
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

function fmtDate(s) {
  return s ? String(s).slice(0, 10) : '';
}

// Display names for stored plan slugs (slugs are the API/billing contract).
const PLAN_NAMES = { saver: 'grep', starter: 'cron', growth: 'daemon', scale: 'kernel' };

function render(d) {
  $('signin').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  $('nav-signout').classList.remove('hidden');
  $('acct-email').textContent = d.email;
  $('acct-plan').textContent = PLAN_NAMES[d.plan] ?? d.plan;

  const pct = d.granted ? Math.min(100, Math.round((d.used / d.granted) * 100)) : 0;
  $('usage-bar').style.width = pct + '%';
  $('usage-nums').textContent =
    `${d.used.toLocaleString()} / ${d.granted.toLocaleString()} credits` +
    (d.topup ? ` + ${d.topup.toLocaleString()} top-up` : '');
  $('credit-packs').classList.remove('hidden');

  const paid = d.plan && d.plan !== 'free';
  $('upgrade').classList.toggle('hidden', paid);
  $('billing-actions').innerHTML = paid
    ? '<button id="manage" class="ghost">manage billing</button>'
    : '';
  if (paid) $('manage').addEventListener('click', () => redirectTo('/v1/account/portal', {}));

  const body = $('keys-body');
  const active = (d.keys || []).filter((k) => !k.revoked_at);
  if (!active.length) {
    body.innerHTML = '<tr><td colspan="4" class="muted">no keys yet — create one.</td></tr>';
    return;
  }
  body.innerHTML = '';
  for (const k of active) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${k.name ? escapeHtml(k.name) : '<span class="muted">—</span>'}</td><td class="muted">${fmtDate(k.created_at)}</td><td><span class="pill">active</span></td><td style="text-align:right"></td>`;
    const btn = document.createElement('button');
    btn.className = 'danger';
    btn.textContent = 'revoke';
    btn.addEventListener('click', () => revokeKey(k.id, btn));
    tr.lastElementChild.appendChild(btn);
    body.appendChild(tr);
  }
}
function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

async function load() {
  const { status, body } = await api('/v1/account');
  if (status === 200 && body.ok) render(body.data);
  else {
    $('dashboard').classList.add('hidden');
    $('signin').classList.remove('hidden');
    $('nav-signout').classList.add('hidden');
  }
}

// --- Sign in ---
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn'),
    msg = $('login-msg');
  btn.disabled = true;
  btn.textContent = 'sending…';
  const { status, body } = await api('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      email: $('login-email').value.trim(),
      'cf-turnstile-response': turnstileToken,
    }),
  });
  msg.classList.remove('hidden');
  msg.textContent =
    status === 200
      ? '[OK] check your email for a sign-in link (expires in 15 minutes).'
      : status === 503
        ? '[ERR] email sign-in is not configured yet — please try again later.'
        : (body.error && body.error.message) || '[ERR] something went wrong — please try again.';
  btn.disabled = false;
  btn.textContent = 'send magic link';
  if (window.turnstile && TURNSTILE_SITE_KEY) window.turnstile.reset('#turnstile-slot');
});

$('nav-signout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/v1/auth/logout', { method: 'POST' });
  location.reload();
});

// --- Billing redirects ---
async function redirectTo(path, payload) {
  const { status, body } = await api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (status === 200 && body.ok && body.data.url) {
    window.location.href = body.data.url;
    return;
  }
  showBanner(
    (body.error && body.error.message) || '[ERR] could not open billing — please try again.',
    'err',
  );
}
document.querySelectorAll('button.buy').forEach((b) =>
  b.addEventListener('click', () => {
    b.disabled = true;
    redirectTo('/v1/account/checkout', { plan: b.dataset.plan });
  }),
);
document.querySelectorAll('button.buy-pack').forEach((b) =>
  b.addEventListener('click', () => {
    b.disabled = true;
    redirectTo('/v1/account/paypal/orders', { pack: b.dataset.pack });
  }),
);

// --- Create key + reveal modal (two states: name form → one-time reveal) ---
const km = $('key-modal'),
  kmValue = $('km-value'),
  kmCopied = $('km-copied');
let kmFocus = null,
  kmRevealed = false;
function openKeyModal() {
  $('km-create').classList.remove('hidden');
  $('km-reveal').classList.add('hidden');
  $('km-name').value = '';
  kmCopied.textContent = '';
  kmRevealed = false;
  kmFocus = document.activeElement;
  km.classList.add('open');
  km.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  $('km-name').focus();
}
function closeKeyModal() {
  km.classList.remove('open');
  km.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  kmValue.textContent = '';
  if (kmFocus && kmFocus.focus) kmFocus.focus();
  if (kmRevealed) load(); // refresh the key table only when a key was actually created
}
$('km-close').addEventListener('click', closeKeyModal);
km.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeKeyModal();
});
$('km-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('km-submit');
  btn.disabled = true;
  btn.textContent = 'creating…';
  const { status, body } = await api('/v1/account/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ name: $('km-name').value.trim() }),
  });
  btn.disabled = false;
  btn.textContent = 'create key';
  if (status === 201 && body.ok) {
    kmRevealed = true;
    kmValue.textContent = body.data.key;
    $('km-create').classList.add('hidden');
    $('km-reveal').classList.remove('hidden');
    $('km-copy').focus();
  } else {
    closeKeyModal();
    showBanner((body.error && body.error.message) || '[ERR] could not create key.', 'err');
  }
});
$('km-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(kmValue.textContent);
    kmCopied.textContent = '[COPIED]';
  } catch {
    const r = document.createRange();
    r.selectNodeContents(kmValue);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    kmCopied.textContent = '[CTRL/CMD+C]';
  }
});
$('new-key').addEventListener('click', openKeyModal);

async function revokeKey(id, btn) {
  if (!confirm('Revoke this key? Any app using it will stop working immediately.')) return;
  btn.disabled = true;
  btn.textContent = 'revoking…';
  const { status } = await api('/v1/account/keys/' + encodeURIComponent(id), { method: 'DELETE' });
  if (status === 200) load();
  else {
    btn.disabled = false;
    btn.textContent = 'revoke';
    showBanner('[ERR] could not revoke that key.', 'err');
  }
}

load();
