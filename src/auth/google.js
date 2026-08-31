// GOOGLE OAUTH  (OpenID Connect authorization-code flow, no dependencies)
// ------------------------------------------------------------------
// Flow:
//   1. /auth/google           -> redirect the browser to Google with a signed
//                                 `state` (CSRF guard).
//   2. Google redirects back to /auth/google/callback?code=...&state=...
//   3. We verify state, exchange the code for tokens at Google's token
//      endpoint (server-to-server over TLS), and read the id_token's claims
//      (email, email_verified, sub).
//
// Config (from .env):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   (from Google Cloud Console)
//   GOOGLE_REDIRECT_URI  (default http://localhost:3000/auth/google/callback)
//   APP_SECRET           (signs the state param; falls back to a random secret)
//
// Note: the id_token comes straight from Google's token endpoint over our own
// TLS connection, so decoding its payload is trustworthy here. For defence in
// depth you could also verify its RS256 signature against Google's JWKS.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
export const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

// Secret for signing the OAuth `state`. A per-process random secret is fine for
// a single instance; set APP_SECRET to survive restarts / multiple instances.
const STATE_SECRET = process.env.APP_SECRET || randomBytes(32).toString('hex');
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the flow

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function googleConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// --- signed state (CSRF) ---

export function makeState() {
  const payload = `${Date.now()}.${randomBytes(12).toString('hex')}`;
  const sig = createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export function verifyState(state) {
  try {
    const decoded = Buffer.from(String(state), 'base64url').toString('utf8');
    const idx = decoded.lastIndexOf('.');
    if (idx < 0) return false;
    const payload = decoded.slice(0, idx);
    const sig = decoded.slice(idx + 1);
    const expected = createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const ts = Number(payload.split('.')[0]);
    return Number.isFinite(ts) && Date.now() - ts < STATE_TTL_MS;
  } catch {
    return false;
  }
}

// --- flow steps ---

export function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCodeForClaims(code) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed: HTTP ${res.status} ${detail}`);
  }
  const tokens = await res.json();
  if (!tokens.id_token) throw new Error('Google response missing id_token.');
  return decodeIdToken(tokens.id_token);
}

// Decode a JWT payload (base64url) without verifying signature — safe here
// because the token came directly from Google over TLS. Returns the claims.
export function decodeIdToken(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return {
    sub: payload.sub,
    email: payload.email ? String(payload.email).toLowerCase() : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: payload.name || null,
  };
}
