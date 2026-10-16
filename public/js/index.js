// Progressive enhancement only — the static dataset cards above are the no-JS
// fallback. When JS runs, the catalog re-renders from the live registry, so a
// newly shipped dataset appears here with zero landing-page edits.
(async function () {
  try {
    const res = await fetch('/v1/data');
    const body = await res.json();
    if (!body.ok || !Array.isArray(body.data) || body.data.length === 0) return;
    const grid = document.getElementById('datasets-grid');
    grid.innerHTML = '';
    for (const s of body.data) {
      const card = document.createElement('div');
      card.className = 'card';
      const h3 = document.createElement('h3');
      h3.textContent = s.slug + ' ';
      const label = document.createElement('span');
      label.textContent = '// ' + s.title;
      h3.appendChild(label);
      const p = document.createElement('p');
      p.textContent = s.description;
      const chips = document.createElement('p');
      chips.className = 'chips';
      for (const param of s.supported_params.slice(0, 6)) {
        const code = document.createElement('code');
        code.textContent = param;
        chips.appendChild(code);
      }
      card.append(h3, p, chips);
      grid.appendChild(card);
    }
  } catch {
    /* keep the static fallback */
  }
})();

// Stripe redirects back to /?checkout=success|cancelled — show a banner, then
// clean the URL so a refresh doesn't replay it.
(function () {
  const status = new URLSearchParams(location.search).get('checkout');
  if (!status) return;
  const banner = document.getElementById('checkout-banner');
  if (status === 'success') {
    banner.textContent =
      '[OK] payment successful — your plan is now active. Your new monthly allowance applies immediately; check it any time with GET /v1/usage.';
    banner.className = 'banner ok';
  } else {
    banner.textContent =
      '[--] checkout cancelled — no charge was made. Pick a plan whenever you are ready.';
    banner.className = 'banner';
  }
  banner.style.display = 'block';
  history.replaceState(null, '', location.pathname + location.hash);
})();

// --- interactive fx (desktop flourish; all gated on prefers-reduced-motion) ---
(function () {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1. typewriter hero: the verb gets re-typed on a loop, cursor at the edit point
  if (!reduced) {
    const verbs = ['gank', 'yoink', 'liberate', 'extract', 'wrangle', 'normalize'];
    const el = document.getElementById('verb');
    let vi = 0;
    function erase(done) {
      const t = el.textContent;
      if (!t.length) return done();
      el.textContent = t.slice(0, -1);
      setTimeout(() => erase(done), 38);
    }
    function type(word, i) {
      if (i > word.length) return setTimeout(cycle, 2800);
      el.textContent = word.slice(0, i);
      setTimeout(() => type(word, i + 1), 62 + Math.random() * 55);
    }
    function cycle() {
      erase(() => {
        vi = (vi + 1) % verbs.length;
        type(verbs[vi], 1);
      });
    }
    setTimeout(cycle, 3200);
  }

  // 2. permanent click burst: a random heist verb rises from every click
  const VERBS = [
    'GANKED',
    'YOINKED',
    'LOOTED',
    'SWIPED',
    'NICKED',
    'PINCHED',
    'LIFTED',
    'SNATCHED',
    'EXTRACTED',
    'LIBERATED',
    'ACQUIRED',
    'PILFERED',
    'PURLOINED',
    'FETCHED',
    'PARSED',
    'CACHED',
  ];
  if (!reduced)
    document.addEventListener('click', (e) => {
      const b = document.createElement('div');
      b.className = 'burst';
      b.textContent = '[' + VERBS[Math.floor(Math.random() * VERBS.length)] + ']';
      b.style.left = e.clientX - 24 + 'px';
      b.style.top = e.clientY - 18 + 'px';
      document.body.appendChild(b);
      setTimeout(() => b.remove(), 780);
    });

  // 3. cursor roulette: [ do not press ] equips a random cursor effect
  const blockcur = Object.assign(document.createElement('div'), { id: 'blockcur' });
  const spotcv = Object.assign(document.createElement('canvas'), { id: 'spotcv' });
  const xhv = Object.assign(document.createElement('div'), { id: 'xhv', className: 'xh' });
  const xhh = Object.assign(document.createElement('div'), { id: 'xhh', className: 'xh' });
  const xhc = Object.assign(document.createElement('div'), { id: 'xhc' });
  const lockbox = Object.assign(document.createElement('div'), { id: 'lockbox' });
  lockbox.innerHTML = '<i></i><i></i><i></i><i></i>';
  const glitchA = Object.assign(document.createElement('div'), { id: 'glitchA' });
  const glitchB = Object.assign(document.createElement('div'), { id: 'glitchB' });
  const racc = Object.assign(document.createElement('img'), {
    id: 'racc',
    src: '/icon-raccoon.svg',
    alt: '',
  });
  document.body.append(blockcur, spotcv, xhv, xhh, xhc, lockbox, glitchA, glitchB, racc);
  const sctx = spotcv.getContext('2d');
  function fit() {
    spotcv.width = innerWidth;
    spotcv.height = innerHeight;
  }
  fit();
  addEventListener('resize', fit);

  // cursor-replacing effects hide the real pointer; the replacement never blinks
  const NOCURSOR = new Set(['block', 'glitch', 'racc']);
  let fx = '',
    lastTrail = 0,
    lastDrip = 0;
  let mx = innerWidth / 2,
    my = innerHeight / 2; // live pointer
  let lx = mx,
    ly = my,
    rx = mx,
    ry = my; // lagged followers (lock, raccoon)
  const DRIPCHARS = '01{}$;<>/#'.split('');

  function setFx(name) {
    fx = name;
    document.documentElement.classList.toggle('fx-nocursor', NOCURSOR.has(fx));
    blockcur.style.display = fx === 'block' ? 'block' : 'none';
    spotcv.style.display = fx === 'spot' ? 'block' : 'none';
    xhv.style.display = xhh.style.display = xhc.style.display = fx === 'xhair' ? 'block' : 'none';
    lockbox.style.display = fx === 'lock' ? 'block' : 'none';
    glitchA.style.display = glitchB.style.display = fx === 'glitch' ? 'block' : 'none';
    racc.style.display = fx === 'racc' ? 'block' : 'none';
    if (fx !== 'spot') sctx.clearRect(0, 0, spotcv.width, spotcv.height);
  }
  document.addEventListener('mousemove', (e) => {
    mx = e.clientX;
    my = e.clientY;
    if (fx === 'block') {
      blockcur.style.left = mx - 2 + 'px';
      blockcur.style.top = my - 4 + 'px';
    } else if (fx === 'trail' && performance.now() - lastTrail > 28) {
      lastTrail = performance.now();
      const t = document.createElement('div');
      t.className = 'tp';
      t.style.left = mx - 3 + 'px';
      t.style.top = my - 3 + 'px';
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 520);
    } else if (fx === 'spot') {
      sctx.clearRect(0, 0, spotcv.width, spotcv.height);
      const g = sctx.createRadialGradient(mx, my, 0, mx, my, 190);
      g.addColorStop(0, 'rgba(0,255,65,.09)');
      g.addColorStop(0.5, 'rgba(0,255,65,.03)');
      g.addColorStop(1, 'rgba(0,255,65,0)');
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, spotcv.width, spotcv.height);
    } else if (fx === 'xhair') {
      xhv.style.left = mx + 'px';
      xhh.style.top = my + 'px';
      xhc.style.left = mx + 12 + 'px';
      xhc.style.top = my + 12 + 'px';
      xhc.textContent = '[' + mx + ',' + my + ']';
    } else if (fx === 'drip' && performance.now() - lastDrip > 46) {
      lastDrip = performance.now();
      const d = document.createElement('div');
      d.className = 'dripc';
      d.textContent = DRIPCHARS[Math.floor(Math.random() * DRIPCHARS.length)];
      d.style.left = mx + (Math.random() * 14 - 7) + 'px';
      d.style.top = my + 6 + 'px';
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 720);
    }
  });
  // rAF loop drives the lagged/jittery effects (lock, glitch, raccoon)
  (function raf() {
    if (fx === 'lock') {
      lx += (mx - lx) * 0.22;
      ly += (my - ly) * 0.22;
      lockbox.style.left = lx - 17 + 'px';
      lockbox.style.top = ly - 17 + 'px';
    } else if (fx === 'glitch') {
      const jx = Math.random() < 0.12 ? Math.random() * 4 - 2 : 0;
      const jy = Math.random() < 0.12 ? Math.random() * 4 - 2 : 0;
      glitchA.style.left = mx - 2 + jx + 'px';
      glitchA.style.top = my - 4 + jy + 'px';
      glitchB.style.left = mx - 2 - jx + (Math.random() < 0.08 ? 4 : 2) + 'px';
      glitchB.style.top = my - 4 - jy + 'px';
    } else if (fx === 'racc') {
      rx += (mx - rx) * 0.35;
      ry += (my - ry) * 0.35;
      racc.style.left = rx - 4 + 'px';
      racc.style.top = ry - 3 + 'px';
    }
    requestAnimationFrame(raf);
  })();
  const ROULETTE = [
    ['block', 'BLOCK CURSOR'],
    ['trail', 'PIXEL TRAIL'],
    ['spot', 'SPOTLIGHT'],
    ['xhair', 'CROSSHAIR'],
    ['drip', 'CODE DRIP'],
    ['lock', 'TARGET LOCK'],
    ['glitch', 'GLITCH'],
    ['racc', 'RACCOON'],
    ['', 'BACK TO NORMAL'],
  ];
  const roll = document.getElementById('fxroll');
  if (roll && !reduced)
    roll.addEventListener('click', (e) => {
      e.stopPropagation();
      const options = ROULETTE.filter(([name]) => name !== fx);
      const [name, label] = options[Math.floor(Math.random() * options.length)];
      setFx(name);
      const b = document.createElement('div');
      b.className = 'burst';
      b.textContent = '[' + label + (name ? ' EQUIPPED' : '') + ']';
      b.style.left = Math.max(8, e.clientX - 90) + 'px';
      b.style.top = e.clientY + 16 + 'px';
      document.body.appendChild(b);
      setTimeout(() => b.remove(), 780);
    });
})();
