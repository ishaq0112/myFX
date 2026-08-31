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
let authMode = 'login';
$('#authTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  authMode = b.dataset.mode;
  $$('#authTabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('#authSubmit').textContent = authMode === 'login' ? 'Log in' : 'Sign up';
  $('#nameField').classList.toggle('hidden', authMode !== 'signup');
  $('#authNote').classList.add('hidden');
});
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
  $('#stEmail').textContent = ME.email;
  $('#stVerified').innerHTML = ME.email_verified ? '<span class="badge active">✓ Verified</span>' : '<span class="badge suspended">Unverified</span>';
  $('#stProvider').textContent = ME.auth_provider || 'password';
  $('#stCreated').textContent = ME.created_at ? new Date(ME.created_at).toLocaleDateString() : '—';
  // docs base url
  ['#d1', '#d2', '#d3'].forEach((s) => ($(s).textContent = location.origin));
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
}
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) go(b.dataset.screen); });
$$('[data-goto]').forEach((el) => (el.onclick = () => go(el.dataset.goto)));
$$('[data-toast]').forEach((el) => (el.onclick = () => toast(el.dataset.toast)));
$('#hb').onclick = () => $('#app').classList.toggle('open');

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
async function loadKeys() {
  const list = $('#keyList');
  const { ok, data } = await api('/keys', { auth: true });
  if (!ok) { list.innerHTML = `<div class="empty">${data?.error || 'Could not load keys.'}</div>`; return; }
  const keys = data.keys || [];
  if (!keys.length) { list.innerHTML = `<div class="empty">No API keys yet — create one to start calling the API.</div>`; return; }
  const dot = { active: '🟢', expired: '⚪', revoked: '🔴', suspended: '🟡' };
  list.innerHTML = keys.map((k) => `
    <div class="keyrow">
      <div class="kn"><span class="badge ${k.status}">${dot[k.status] || ''} ${k.status}</span>
        <div><div>${k.name || 'untitled'}</div><div class="km">created ${new Date(k.created_at).toLocaleDateString()}</div></div></div>
      <div class="hide"><small>Last used</small>${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</div>
      <div class="hide"><small>Expires</small>${k.expires_at ? new Date(k.expires_at).toLocaleDateString() : 'never'}</div>
      <div style="text-align:right">${k.status === 'active' ? `<button class="btn btn-danger btn-sm" data-revoke="${k.id}" data-name="${k.name || 'untitled'}">Revoke</button>` : '<span style="color:var(--faint)">—</span>'}</div>
    </div>`).join('');
  $$('[data-revoke]').forEach((b) => (b.onclick = () => openRevoke(b.dataset.revoke, b.dataset.name)));
}

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
$('#saveKey').onclick = () => {
  const k = $('#ratesKey').value.trim();
  if (k) { sessionStorage.setItem(APIKEY_KEY, k); toast('Key saved for this tab'); }
  else { sessionStorage.removeItem(APIKEY_KEY); toast('Key cleared'); }
};
$('#loadRates').onclick = async () => {
  const base = ($('#ratesBase').value.trim() || 'USD').toUpperCase();
  const meta = $('#ratesMeta'); const grid = $('#ratesGrid');
  if (!sessionStorage.getItem(APIKEY_KEY)) { toast('Enter an API key first', 'err'); return; }
  meta.textContent = 'loading…';
  const { ok, data } = await api('/v1/latest?base=' + encodeURIComponent(base), { apiKey: true });
  if (!ok) { meta.textContent = ''; grid.innerHTML = ''; toast(data?.error || 'Request failed', 'err'); return; }
  meta.textContent = `${data.count} currencies · ${data.date} · ${data.source}`;
  const codes = Object.keys(data.rates).filter((c) => c !== base).slice(0, 24);
  grid.innerHTML = codes.map((c) => `<div class="rate"><div class="cur">${base} → ${c}</div><div class="val">${fmt(data.rates[c])}</div></div>`).join('');
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
