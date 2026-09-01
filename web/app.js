/* ============================================================
   MyFX dashboard — live API client + UI logic
   Served same-origin from /app, so all fetches are relative.
   Session token -> localStorage; the API key (for /v1) -> sessionStorage.
   ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const TOKEN_KEY = 'myfx_token';
const APIKEY_KEY = 'myfx_apikey';
let ME = null;

/* ---------- tiny API helper ---------- */
async function api(path, { method = 'GET', body, auth = false, apiKey = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) headers['Authorization'] = 'Bearer ' + t;
  }
  if (apiKey) {
    const k = sessionStorage.getItem(APIKEY_KEY);
    if (k) headers['X-API-Key'] = k;
  }
  let res, data = null;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'Network error — is the server running?' } };
  }
}

/* ---------- toasts ---------- */
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.remove(), 250); }, 2600);
}

/* ============ AUTH ============ */
let authMode = 'signup';
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('#authHeading').textContent = signup ? 'Create an account' : 'Welcome back';
  $('#authSub').textContent = signup
    ? 'Sign up to get started. Enter your details below.'
    : 'Log in to your MyFX dashboard.';
  $('#authSubmit').textContent = signup ? 'Create account' : 'Log in';
  $('#nameField').classList.toggle('hidden', !signup);
  $('#confirmField').classList.toggle('hidden', !signup);
  $('#authSwitchText').textContent = signup ? 'Already have an account?' : 'New to MyFX?';
  $('#authToggle').textContent = signup ? 'Log in' : 'Create one';
  $('#authNote').classList.add('hidden');
}
$('#authToggle').onclick = () => setAuthMode(authMode === 'signup' ? 'login' : 'signup');

// show/hide password toggles
$$('.pw-eye').forEach((b) => {
  b.onclick = () => {
    const input = document.getElementById(b.dataset.eye);
    const reveal = input.type === 'password';
    b.classList.toggle('shown', reveal);
    // Blur the field out, swap text<->dots at peak blur, then blur back in
    // so the character/mask change reads as a smooth morph instead of a snap.
    input.classList.add('pw-morph');
    setTimeout(() => {
      input.type = reveal ? 'text' : 'password';
      input.classList.remove('pw-morph');
    }, 150);
  };
});

// Google OAuth. Not configured on the server yet (no GOOGLE_CLIENT_ID/SECRET),
// so avoid navigating to /auth/google (it returns a raw 503). Once creds are set,
// restore: window.location.href = '/auth/google';
$('#googleBtn').onclick = () => toast('Google sign-in isn’t enabled yet — continue with email.', 'info');

setAuthMode('signup'); // sync initial UI state

function note(type, html) {
  const n = $('#authNote');
  n.className = 'note ' + type;
  n.innerHTML = html;
  n.classList.remove('hidden');
}
$('#authSubmit').onclick = async () => {
  const email = $('#authEmail').value.trim();
  const password = $('#authPass').value;
  if (!email || !password) return note('err', 'Email and password are required.');

  if (authMode === 'signup') {
    if (password.length < 8) return note('err', 'Password must be at least 8 characters.');
    if (password !== $('#authConfirm').value) return note('err', "Passwords don't match.");
    const { ok, data } = await api('/auth/signup', { method: 'POST', body: { email, password, name: $('#authName').value.trim() } });
    if (!ok) return note('err', data?.error || 'Signup failed.');
    // Dev mode returns a verify link — offer a one-click verify.
    if (data.dev_verify_url) {
      note('info', 'Account created. In dev mode you can verify instantly: <button class="btn btn-primary btn-sm" id="devVerify" style="margin-top:8px">Verify &amp; continue</button>');
      $('#devVerify').onclick = async () => {
        const r = await fetch(data.dev_verify_url);
        const d = await r.json();
        if (d.token) { localStorage.setItem(TOKEN_KEY, d.token); enterApp(); }
        else note('err', d.error || 'Verification failed.');
      };
    } else {
      note('ok', 'Account created. Check your email to verify, then log in.');
    }
    return;
  }

  // login
  const { ok, status, data } = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (ok && data.token) { localStorage.setItem(TOKEN_KEY, data.token); return enterApp(); }
  if (status === 403) {
    note('warn', 'Email not verified. <button class="btn btn-outline btn-sm" id="resend" style="margin-top:8px">Resend verification</button>');
    $('#resend').onclick = async () => {
      const r = await api('/auth/resend-verification', { method: 'POST', body: { email } });
      if (r.data?.dev_verify_url) {
        note('info', 'Verify link ready: <button class="btn btn-primary btn-sm" id="devVerify" style="margin-top:8px">Verify &amp; continue</button>');
        $('#devVerify').onclick = async () => {
          const v = await fetch(r.data.dev_verify_url); const d = await v.json();
          if (d.token) { localStorage.setItem(TOKEN_KEY, d.token); enterApp(); }
        };
      } else toast('Verification email sent');
    };
    return;
  }
  note('err', data?.error || 'Invalid email or password.');
};

function logoutLocal() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(APIKEY_KEY);
  ME = null;
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}
async function doLogout() {
  await api('/auth/logout', { method: 'POST', auth: true });
  logoutLocal();
  toast('Logged out');
}
$('#logoutBtn').onclick = doLogout;
$('#logoutBtn2').onclick = doLogout;

/* ============ SETTINGS ============ */
const openScrim = (id) => $(id).classList.remove('hidden');
const closeScrim = (id) => $(id).classList.add('hidden');

// Profile: reflect the typed name in the sidebar/avatar immediately (not persisted in this demo).
$('#saveProfile').onclick = () => {
  const name = $('#setName').value.trim();
  if (name) {
    $('#welcomeName').textContent = name;
    $('#setDisplayName').textContent = name;
  }
  toast('Profile updates aren’t saved in this demo yet.', 'info');
};

// Security
$('#changePwBtn').onclick = () => { $('#pwNote').classList.add('hidden'); openScrim('#changePwScrim'); };
$('#pwSubmit').onclick = () => {
  const cur = $('#pwCurrent').value, nw = $('#pwNew').value, cf = $('#pwConfirm').value;
  const note = (m) => { const n = $('#pwNote'); n.textContent = m; n.classList.remove('hidden'); };
  if (!cur || !nw) return note('Fill in all fields.');
  if (nw.length < 8) return note('New password must be at least 8 characters.');
  if (nw !== cf) return note('New passwords don’t match.');
  closeScrim('#changePwScrim');
  ['#pwCurrent', '#pwNew', '#pwConfirm'].forEach((s) => ($(s).value = ''));
  toast('Password change isn’t wired in this demo yet.', 'info');
};

$('#twofaToggle').onchange = (e) => {
  toast(e.target.checked ? 'Two-factor auth isn’t active in this demo yet.' : 'Two-factor disabled.', 'info');
};

// Danger zone
$('#deleteAcctBtn').onclick = () => { $('#delConfirmInput').value = ''; $('#deleteConfirm').disabled = true; openScrim('#deleteScrim'); };
$('#delConfirmInput').oninput = (e) => {
  $('#deleteConfirm').disabled = !ME || e.target.value.trim().toLowerCase() !== (ME.email || '').toLowerCase();
};
$('#deleteConfirm').onclick = () => {
  closeScrim('#deleteScrim');
  toast('Account deletion isn’t wired in this demo yet.', 'info');
};

/* ============ ENTER APP ============ */
async function enterApp() {
  const { ok, data } = await api('/auth/me', { auth: true });
  if (!ok) { logoutLocal(); return; }
  ME = data.user;
  const initial = (ME.email[0] || '?').toUpperCase();
  const hasName = ME.name && ME.name.trim();
  let display = hasName ? ME.name.trim() : (ME.email.split('@')[0] || 'there').replace(/[._-]+/g, ' ');
  if (!hasName) display = display.charAt(0).toUpperCase() + display.slice(1);
  $('#welcomeName').textContent = display;
  $('#sideAvatar').textContent = initial;
  $('#sideEmail').textContent = ME.email;
  // settings
  $('#setAvatar').textContent = initial;
  $('#setDisplayName').textContent = display;
  $('#setName').value = hasName ? ME.name.trim() : '';
  $('#setEmailInput').value = ME.email;
  $('#stVerified').innerHTML = ME.email_verified ? '<span class="badge active">✓ Verified</span>' : '<span class="badge suspended">Unverified</span>';
  $('#stProvider').textContent = ME.auth_provider === 'google' ? 'Google' : 'Email & password';
  $('#setJoined').textContent = 'Member since ' + (ME.created_at ? new Date(ME.created_at).toLocaleDateString() : '—');
  $('#delEmail').textContent = ME.email;
  // API keys page footer
  const fd = $('#footDate'); if (fd) fd.textContent = fmtDate(ME.created_at);
  const fa = $('#footAuth'); if (fa) fa.textContent = ME.auth_provider === 'google' ? 'Google' : 'Password';
  // prefill rates key
  $('#ratesKey').value = sessionStorage.getItem(APIKEY_KEY) || '';

  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  go('overview');
}

/* ============ NAV ============ */
const TITLES = { overview: 'Dashboard', keys: 'API Keys', rates: 'Live Rates', billing: 'Billing', docs: 'Docs', settings: 'Settings' };
function go(screen) {
  $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== screen));
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.screen === screen));
  $('#pageTitle').textContent = TITLES[screen];
  $('#app').classList.remove('open');
  if (screen === 'overview') loadOverview();
  if (screen === 'keys') loadKeys();
  if (screen === 'rates') { ensureCurrencies(); updateKeyStatus(); }
  if (screen === 'billing') moveBillInd(true);
}
function updateKeyStatus() { const d = document.getElementById('rkDot'); if (d) d.classList.toggle('on', !!sessionStorage.getItem(APIKEY_KEY)); }
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) go(b.dataset.screen); });
$$('[data-goto]').forEach((el) => (el.onclick = () => go(el.dataset.goto)));
$$('[data-toast]').forEach((el) => (el.onclick = () => toast(el.dataset.toast)));
$('#hb').onclick = () => $('#app').classList.toggle('open');

/* ============ BILLING (plan cycle toggle) ============ */
const billToggle = $('#billToggle');
const billInd = document.querySelector('.bt-ind');
// Slide the orange pill under the active option. Must run while the screen is
// visible — offsetWidth is 0 while #billing is hidden.
function moveBillInd(instant) {
  const active = $('#billToggle button.active');
  if (!billInd || !active) return;
  if (instant) billInd.style.transition = 'none'; // place without sliding when the screen first opens
  billInd.style.width = active.offsetWidth + 'px';
  billInd.style.left = active.offsetLeft + 'px';
  if (instant) { void billInd.offsetWidth; billInd.style.transition = ''; }
}
if (billToggle) {
  billToggle.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const yearly = b.dataset.cycle === 'yearly';
    $$('#billToggle button').forEach((x) => x.classList.toggle('active', x === b));
    moveBillInd();
    // Fade/slide the price out, swap the value while hidden, then ease it back in.
    $$('.planc-price .amt').forEach((a) => {
      const billed = a.closest('.planc').querySelector('.planc-billed');
      const free = a.dataset.m === '$0';
      a.classList.add('swapping');
      if (billed) billed.classList.add('swapping');
      setTimeout(() => {
        a.textContent = yearly ? a.dataset.y : a.dataset.m;
        if (billed) billed.textContent = yearly && !free ? 'billed annually' : ' ';
        a.classList.remove('swapping');
        if (billed) billed.classList.remove('swapping');
      }, 160);
    });
  });
}

/* ============ DOCS (code tabs + sub-nav) ============ */
// Language tabs + copy on each code block.
$$('[data-ct]').forEach((ct) => {
  const langs = [...ct.querySelectorAll('.ct-langs button')];
  const panels = [...ct.querySelectorAll('.ct-panel')];
  const copy = ct.querySelector('.ct-copy');
  langs.forEach((btn) => (btn.onclick = () => {
    langs.forEach((b) => b.classList.toggle('active', b === btn));
    panels.forEach((p) => p.classList.toggle('active', p.dataset.lang === btn.dataset.lang));
  }));
  if (copy) copy.onclick = async () => {
    const active = ct.querySelector('.ct-panel.active');
    try { await navigator.clipboard.writeText(active.textContent.trim()); } catch (e) {}
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1400);
  };
});

// Sub-nav: click to scroll, and scroll-spy to highlight the current section.
const docsNavLinks = $$('#docsNav a');
if (docsNavLinks.length) {
  docsNavLinks.forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        const id = '#' + en.target.id;
        docsNavLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === id));
      }
    });
  }, { rootMargin: '-8% 0px -75% 0px', threshold: 0 });
  $$('.doc-section').forEach((s) => spy.observe(s));
}

/* ============ OVERVIEW (hero) ============ */
// Sample usage series (no usage metering in this build). Account panel below is real.
const OVDATA = {
  month: [42, 50, 46, 58, 63, 55, 60, 72, 68, 61, 65, 75, 82, 74, 68, 78, 84, 80, 76, 88, 92, 86, 80, 90, 95, 88, 84, 93, 97, 90],
  '30d': [55, 60, 52, 64, 70, 66, 72, 80, 76, 70, 74, 68, 72, 84, 90, 82, 78, 86, 94, 88, 82, 90, 96, 89, 84, 92, 99, 94, 88, 95],
};
let ovRange = 'month';
function renderOvChart() {
  const data = OVDATA[ovRange], svg = $('#ovChart'), W = 1000, H = 240, pad = 8;
  const n = data.length, max = Math.max(...data) * 1.15;
  const dx = W / (n - 1), X = (i) => i * dx, Y = (v) => H - pad - (v / max) * (H - pad * 2);
  let line = ''; data.forEach((v, i) => (line += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' '));
  const area = line + `L${W} ${H} L0 ${H} Z`;
  const c = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  svg.innerHTML = `<defs><linearGradient id="og" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0" stop-color="${c}" stop-opacity=".22"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#og)"/>
    <line id="ovGuide" x1="0" y1="4" x2="0" y2="236" stroke="${c}" stroke-opacity="0.28" stroke-width="1.5" style="opacity:0"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle id="ovDot" r="4.5" fill="${c}" stroke="#fff" stroke-width="2" style="opacity:0"/>`;
  svg._meta = { data, n, X, Y };
}

// Hover tooltip: show the day + that day's requests, and move the dot.
(function () {
  const svg = $('#ovChart'), tip = $('#ovTip');
  if (!svg || !tip) return;
  svg.addEventListener('mousemove', (e) => {
    const m = svg._meta; if (!m) return;
    const r = svg.getBoundingClientRect();
    let i = Math.round(((e.clientX - r.left) / r.width) * (m.n - 1));
    i = Math.max(0, Math.min(m.n - 1, i));
    const val = m.data[i];
    const dot = document.getElementById('ovDot');
    if (dot) { dot.setAttribute('cx', m.X(i)); dot.setAttribute('cy', m.Y(val)); dot.style.opacity = 1; }
    const g = document.getElementById('ovGuide');
    if (g) { g.setAttribute('x1', m.X(i)); g.setAttribute('x2', m.X(i)); g.style.opacity = 1; }
    tip.style.left = (m.X(i) / 1000) * r.width + 'px';
    tip.style.top = (m.Y(val) / 240) * r.height + 'px';
    tip.style.opacity = 1;
    tip.innerHTML = `<b>Aug ${i + 1}</b>${Math.round(val * 24).toLocaleString()} requests`;
  });
  svg.addEventListener('mouseleave', () => {
    tip.style.opacity = 0;
    const d = document.getElementById('ovDot'); if (d) d.style.opacity = 0;
    const g = document.getElementById('ovGuide'); if (g) g.style.opacity = 0;
  });
})();
async function loadOverview() {
  const k = await api('/keys', { auth: true });
  if (k.ok) { const active = (k.data.keys || []).filter((x) => x.status === 'active').length; const el = $('#stKeys'); if (el) el.textContent = active; }
  renderOvChart();
}
const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 }));

/* ============ API KEYS ============ */
const fmtDate = (iso) => { if (!iso) return '—'; return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return fmtDate(iso);
}
let previewEmpty = false;
async function loadKeys() {
  const list = $('#keyList'), empty = $('#keyEmpty');
  const { ok, data } = await api('/keys', { auth: true });
  if (!ok) { list.innerHTML = `<div class="k-empty" style="color:var(--danger)">${data?.error || 'Could not load keys.'}</div>`; empty.classList.add('hidden'); return; }
  const keys = data.keys || [];
  $('#keyCount').textContent = keys.length;
  if (previewEmpty || keys.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  const badge = (s) => `<span class="kbadge ${s}"><span class="kdot"></span>${s}</span>`;
  list.innerHTML = keys.map((k) => {
    const canRevoke = k.status === 'active' || k.status === 'suspended';
    const label = k.status === 'revoked' ? 'Revoked' : 'Revoke';
    return `<div class="krow">
      <div class="kmain"><div class="kname">${k.name || 'untitled'} ${badge(k.status)}</div><div class="kmask">myfx_live_••••${(k.id || '').slice(-4)}</div></div>
      <div class="kcol"><div class="klabel">Created</div><div class="kval">${fmtDate(k.created_at)}</div></div>
      <div class="kcol"><div class="klabel">Last used</div><div class="kval">${k.last_used_at ? timeAgo(k.last_used_at) : 'Never'}</div></div>
      <div class="kact"><button class="btn btn-danger btn-sm" data-revoke="${k.id}" data-name="${k.name || 'untitled'}" ${canRevoke ? '' : 'disabled'}>${label}</button></div>
    </div>`;
  }).join('');
  $$('[data-revoke]').forEach((b) => (b.onclick = () => { if (!b.disabled) openRevoke(b.dataset.revoke, b.dataset.name); }));
}
$('#previewEmptyBtn').onclick = () => {
  previewEmpty = !previewEmpty;
  $('#previewEmptyBtn').textContent = previewEmpty ? 'Show keys' : 'Preview empty state';
  loadKeys();
};

/* Quick start snippet switcher */
const QS = {
  latest: { code: `curl "${location.origin}/v1/latest?base=USD" \\\n  -H "X-API-Key: myfx_live_…"`, cap: "Returns every currency's rate against your base currency." },
  convert: { code: `curl "${location.origin}/v1/convert?from=USD&to=INR&amount=100" \\\n  -H "X-API-Key: myfx_live_…"`, cap: 'Converts an amount from one currency to another.' },
  currencies: { code: `curl "${location.origin}/v1/currencies" \\\n  -H "X-API-Key: myfx_live_…"`, cap: 'Lists all supported currency codes.' },
};
let curEp = 'latest';
function renderQS() { $('#qsSnippet').textContent = QS[curEp].code; $('#qsCaption').textContent = QS[curEp].cap; }
$('#epPills').addEventListener('click', (e) => {
  const b = e.target.closest('.ep-pill'); if (!b) return;
  $$('#epPills .ep-pill').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); curEp = b.dataset.ep; renderQS();
});
$('#qsCopy').onclick = () => { copy(QS[curEp].code); toast('Copied to clipboard'); };
renderQS();

/* create key modal */
function openCreate() { $('#createScrim').classList.remove('hidden'); $('#createStep').classList.remove('hidden'); $('#revealStep').classList.add('hidden'); $('#keyName').value = ''; $('#keyName').focus(); }
$('#createKeyBtn').onclick = openCreate;
$('#heroCreate').onclick = openCreate;
$('#ovRange').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#ovRange button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); ovRange = b.dataset.r; renderOvChart();
});
$('#createConfirm').onclick = async function () {
  const name = $('#keyName').value.trim() || 'untitled-key';
  const days = $('#keyExpiry').value;
  const body = { name };
  if (days) body.expires_in_days = Number(days);
  this.innerHTML = '<span class="spin"></span> Creating…'; this.disabled = true;
  const { ok, data } = await api('/keys', { method: 'POST', auth: true, body });
  this.innerHTML = 'Create key'; this.disabled = false;
  if (!ok) { toast(data?.error || 'Could not create key', 'err'); return; }
  const secret = data.key;
  sessionStorage.setItem(APIKEY_KEY, secret); // so Rates page can use it
  $('#ratesKey').value = secret;
  updateKeyStatus();
  $('#revealKey').textContent = secret;
  $('#createStep').classList.add('hidden');
  $('#revealStep').classList.remove('hidden');
  $('#copyKey').onclick = () => { navigator.clipboard?.writeText(secret); toast('Key copied'); };
  loadKeys();
  toast('API key created');
};

/* revoke modal */
let revokeId = null;
function openRevoke(id, name) { revokeId = id; $('#revokeName').textContent = name; $('#revokeScrim').classList.remove('hidden'); }
$('#revokeConfirm').onclick = async () => {
  const { ok, data } = await api('/keys/' + revokeId, { method: 'DELETE', auth: true });
  $('#revokeScrim').classList.add('hidden');
  if (!ok) return toast(data?.error || 'Revoke failed', 'err');
  toast('Key revoked'); loadKeys();
};

/* close any modal */
$$('[data-close]').forEach((b) => (b.onclick = () => b.closest('.scrim').classList.add('hidden')));

/* ============ RATES ============ */
// Currency dropdowns, populated from /v1/currencies (needs a key).
let CURRENCIES = null, CUR_NAME = {};
async function ensureCurrencies(force) {
  if (CURRENCIES && !force) return;
  if (!sessionStorage.getItem(APIKEY_KEY)) return; // need a key to fetch the list
  const { ok, data } = await api('/v1/currencies', { apiKey: true });
  if (!ok || !data.currencies) return;
  CURRENCIES = data.currencies.map((o) => (typeof o === 'string' ? o : o.code));
  CUR_NAME = {};
  data.currencies.forEach((o) => { if (typeof o !== 'string') CUR_NAME[o.code] = o.name; });
  fillCurrencySelects();
}
function fillCurrencySelects() {
  if (!CURRENCIES) return;
  const opts = CURRENCIES.map((c) => `<option value="${c}" data-name="${CUR_NAME[c] || ''}">${c}</option>`).join('');
  const defaults = { ratesBase: 'USD', cvFrom: 'USD', cvTo: 'INR' };
  ['ratesBase', 'cvFrom', 'cvTo'].forEach((id) => {
    const el = document.getElementById(id); if (!el) return;
    const prev = el.value;
    el.innerHTML = opts;
    el.value = CURRENCIES.includes(prev) ? prev : (CURRENCIES.includes(defaults[id]) ? defaults[id] : CURRENCIES[0]);
    el.dispatchEvent(new Event('change')); // refresh the custom dropdown label
  });
}

// Replace each native <select.cur-select> with a styled dropdown.
// Handles option labels that differ from values (e.g. "30 days" -> "30"),
// and only shows the search box when the list is long (> 6 options).
function enhanceCurrencySelects() {
  $$('.cur-select').forEach((sel) => {
    if (sel.dataset.enhanced) return;
    sel.dataset.enhanced = '1';
    const wrap = document.createElement('div'); wrap.className = 'csel';
    sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(sel); sel.classList.add('csel-native');
    const label = () => (sel.selectedOptions[0] ? sel.selectedOptions[0].text : (sel.value || '—'));
    wrap.insertAdjacentHTML('beforeend',
      `<button type="button" class="csel-btn"><span class="csel-val">${label()}</span>
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
       <div class="csel-panel hidden"><input class="csel-search" placeholder="Search…" /><div class="csel-list"></div></div>`);
    const btn = wrap.querySelector('.csel-btn'), valEl = wrap.querySelector('.csel-val');
    const panel = wrap.querySelector('.csel-panel'), list = wrap.querySelector('.csel-list'), search = wrap.querySelector('.csel-search');
    const build = (f = '') => {
      const q = f.trim().toUpperCase();
      const shown = [...sel.options].map((o) => ({ v: o.value, t: o.text, n: o.dataset.name || '' }))
        .filter((o) => o.t.toUpperCase().includes(q) || o.v.toUpperCase().includes(q) || o.n.toUpperCase().includes(q));
      list.innerHTML = shown.length
        ? shown.map((o) => `<div class="csel-opt ${o.v === sel.value ? 'sel' : ''}" data-v="${o.v}"><span class="csel-code">${o.t}</span>${o.n ? `<span class="csel-name">${o.n}</span>` : ''}</div>`).join('')
        : '<div class="csel-empty">No match</div>';
    };
    const open = () => {
      // Close any other open dropdown — only one at a time.
      $$('.csel.open').forEach((w) => { w.classList.remove('open'); const p = w.querySelector('.csel-panel'); if (p) p.classList.add('hidden'); });
      wrap.classList.add('open'); panel.classList.remove('hidden'); search.value = '';
      search.style.display = sel.options.length > 6 ? '' : 'none';
      build();
      // Open upward if there isn't enough room below the button.
      wrap.classList.toggle('up', (window.innerHeight - btn.getBoundingClientRect().bottom) < 320);
      if (search.style.display !== 'none') search.focus();
    };
    const close = () => { wrap.classList.remove('open'); panel.classList.add('hidden'); };
    btn.onclick = (e) => { e.stopPropagation(); wrap.classList.contains('open') ? close() : open(); };
    search.oninput = () => build(search.value);
    list.onclick = (e) => { const o = e.target.closest('.csel-opt'); if (!o) return; sel.value = o.dataset.v; valEl.textContent = label(); sel.dispatchEvent(new Event('change')); close(); };
    sel.addEventListener('change', () => { valEl.textContent = label(); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
  });
}
enhanceCurrencySelects();

$('#saveKey').onclick = () => {
  const k = $('#ratesKey').value.trim();
  if (k) { sessionStorage.setItem(APIKEY_KEY, k); toast('Key saved for this tab'); ensureCurrencies(true); }
  else { sessionStorage.removeItem(APIKEY_KEY); toast('Key cleared'); }
  updateKeyStatus();
};
$('#loadRates').onclick = async () => {
  const base = ($('#ratesBase').value.trim() || 'USD').toUpperCase();
  const meta = $('#ratesMeta'); const grid = $('#ratesGrid');
  if (!sessionStorage.getItem(APIKEY_KEY)) { toast('Enter an API key first', 'err'); return; }
  meta.textContent = 'loading…';
  const { ok, data } = await api('/v1/latest?base=' + encodeURIComponent(base), { apiKey: true });
  if (!ok) { meta.textContent = ''; grid.innerHTML = ''; toast(data?.error || 'Request failed', 'err'); return; }
  meta.textContent = `${data.count} currencies · ${data.source} · ${data.date}`;
  const codes = Object.keys(data.rates).filter((c) => c !== base).sort();
  grid.innerHTML = codes.map((c) => `<div class="rate"><div class="cur">${base} → ${c}</div>${CUR_NAME[c] ? `<div class="rname">${CUR_NAME[c]}</div>` : ''}<div class="val">${fmt(data.rates[c])}</div></div>`).join('');
};
$('#doConvert').onclick = async () => {
  const amount = $('#cvAmt').value, from = $('#cvFrom').value.trim().toUpperCase(), to = $('#cvTo').value.trim().toUpperCase();
  if (!sessionStorage.getItem(APIKEY_KEY)) { toast('Enter an API key first', 'err'); return; }
  const { ok, data } = await api(`/v1/convert?from=${from}&to=${to}&amount=${encodeURIComponent(amount)}`, { apiKey: true });
  if (!ok) { $('#cvResult').textContent = ''; toast(data?.error || 'Convert failed', 'err'); return; }
  $('#cvResult').textContent = `${amount} ${from} = ${fmt(data.result)} ${to}`;
};

/* ============ BOOT ============ */
if (localStorage.getItem(TOKEN_KEY)) enterApp();
