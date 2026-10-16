// Small server-rendered HTML pages (sign-in confirm, agent-key approval, OAuth
// consent). No inline scripts — the Worker's CSP is script-src 'self' — so
// every interaction is a plain form POST.

const PAGE_STYLE = `:root{--bg:#0A0A0A;--panel:#111315;--green:#00FF41;--border:#2A2E33;--fg:#E6E8EA;--muted:#8B9299;--warn:#FFB347;
--mono:"JetBrains Mono","Fira Code",ui-monospace,Menlo,Consolas,monospace;--sans:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box;border-radius:0}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:15px/1.6 var(--sans);padding:20px}
.card{border:1px solid var(--border);background:var(--panel);max-width:420px;width:100%;padding:28px;text-align:center}
img{width:44px;height:40px;image-rendering:pixelated}
h1{font:800 1.3rem var(--sans);letter-spacing:-.02em;margin:16px 0 6px}
p{color:var(--muted);font:.88rem var(--mono);margin:0 0 20px}
p.warn{color:var(--warn)}
ul{color:var(--muted);font:.88rem var(--mono);text-align:left;margin:0 0 20px;padding-left:20px}
.code{color:var(--green);font:700 1.5rem var(--mono);letter-spacing:.12em;margin:0 0 16px}
a{color:var(--green)}
input[type=email]{width:100%;padding:12px;margin:0 0 12px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font:.95rem var(--mono)}
button{width:100%;padding:13px;border:1px solid var(--green);background:var(--green);color:#0A0A0A;font:700 .9rem var(--mono);cursor:pointer;letter-spacing:.03em}
button:hover{box-shadow:0 0 22px rgba(0,255,65,.35)}
button.secondary{background:transparent;color:var(--muted);border-color:var(--border);margin-top:10px}
button.secondary:hover{box-shadow:none;color:var(--fg)}`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} — gankdat</title>
<style>${PAGE_STYLE}</style></head><body>
<div class="card">
<img src="/favicon.png" alt="">
${body}
</div></body></html>`;
}

/**
 * True only for a same-origin browser request — a cross-site auto-submitted
 * form (the login-CSRF vector) is 'cross-site'/'same-site' or carries a
 * mismatched Origin. Fails closed: modern browsers always send one of these on
 * a form POST, so a request with neither is rejected.
 */
export function isSameOrigin(reqUrl: string, secFetchSite?: string, origin?: string): boolean {
  if (secFetchSite) return secFetchSite === 'same-origin';
  if (origin) {
    try {
      return new URL(origin).origin === new URL(reqUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}
