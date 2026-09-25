// AUTH ROUTES  ->  mounted at /auth
// ------------------------------------------------------------------
//   POST /auth/signup               { email, password }  -> sends verify link
//   GET  /auth/verify?token=...     -> verifies an email, returns a session
//   POST /auth/resend-verification  { email }            -> new verify link
//   POST /auth/login                { email, password }  -> session token
//   GET  /auth/google               -> redirect to Google sign-in
//   GET  /auth/google/callback      -> completes Google sign-in
//   POST /auth/logout               (Bearer)             -> revoke session
//   GET  /auth/me                   (Bearer)             -> current account
//
// Verified email is required: password signups must click the emailed link
// before they can log in; Google accounts are verified by Google.
//
// NOTE: passwords travel in the request body — serve over HTTPS in production.
// Login has brute-force throttling (see loginLimiter.js); password reset is still deferred.

import express from 'express';
import { hashPassword, verifyPassword } from './passwords.js';
import { newToken, hashToken, sessionExpiry } from './tokens.js';
import { sendVerificationEmail, mailerMode } from './mailer.js';
import {
  googleConfigured,
  makeState,
  verifyState,
  buildAuthUrl,
  exchangeCodeForClaims,
} from './google.js';
import {
  authAvailable,
  initAuth,
  createUser,
  findUserByEmail,
  findUserById,
  findLiveSession,
  upsertGoogleUser,
  markEmailVerified,
  createVerification,
  consumeVerification,
  createSession,
  deleteSession,
} from './store.js';
import { loginBlockedFor, recordLoginFailure, recordLoginSuccess } from './loginLimiter.js';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Short-circuit if there's no database; otherwise ensure tables exist first.
router.use(async (req, res, next) => {
  if (!authAvailable()) {
    return res.status(503).json({ error: 'Auth is unavailable: DATABASE_URL is not configured.' });
  }
  try {
    await initAuth();
    next();
  } catch (err) {
    next(err);
  }
});

function normalizeCredentials(body) {
  return {
    email: String(body?.email ?? '').trim().toLowerCase(),
    password: String(body?.password ?? ''),
  };
}

function publicUser(u) {
  return {
    id: u.id, // UUID string
    email: u.email,
    name: u.name ?? null,
    email_verified: u.email_verified ?? false,
    auth_provider: u.auth_provider ?? 'password',
    plan: u.plan ?? 'free',
    created_at: u.created_at,
  };
}

async function issueSession(userId) {
  const { raw, hash } = newToken();
  await createSession(userId, hash, sessionExpiry());
  return raw;
}

// Create a verification token, store its hash, email the link. Returns the link
// (handy to surface in dev mode).
async function sendVerification(userId, email) {
  const { raw, hash } = newToken();
  await createVerification(userId, hash, new Date(Date.now() + VERIFY_TTL_MS));
  const link = `${APP_URL}/auth/verify?token=${raw}`;
  await sendVerificationEmail(email, link);
  return link;
}

// POST /auth/signup  -> creates an UNVERIFIED account and emails a verify link
router.post('/auth/signup', async (req, res, next) => {
  try {
    const { email, password } = normalizeCredentials(req.body);
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    }

    const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 80) || null : null;
    const user = await createUser(email, await hashPassword(password), name);
    const link = await sendVerification(user.id, user.email);

    const payload = {
      message: 'Account created. Check your email to verify before logging in.',
      user: publicUser(user),
    };
    // In dev mode (no email provider) expose the link so testing is easy.
    if (mailerMode() === 'dev-console') payload.dev_verify_url = link;
    res.status(201).json(payload);
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    next(err);
  }
});

// GET /auth/verify?token=...  -> marks email verified, returns a session token
router.get('/auth/verify', async (req, res, next) => {
  try {
    const raw = String(req.query.token || '');
    if (!raw) return res.status(400).json({ error: 'Missing verification token.' });

    const userId = await consumeVerification(hashToken(raw));
    if (!userId) {
      return res.status(400).json({ error: 'Invalid or expired verification link.' });
    }
    await markEmailVerified(userId);

    const user = await findUserById(userId);
    const token = await issueSession(userId);
    res.json({ message: 'Email verified.', token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// POST /auth/resend-verification  { email }
router.post('/auth/resend-verification', async (req, res, next) => {
  try {
    const { email } = normalizeCredentials(req.body);
    const user = email ? await findUserByEmail(email) : null;
    // Only act for an unverified password account, but always reply the same way
    // so we don't reveal which emails exist.
    if (user && !user.email_verified && user.auth_provider === 'password') {
      const link = await sendVerification(user.id, user.email);
      const payload = { message: 'If that account needs verification, a link has been sent.' };
      if (mailerMode() === 'dev-console') payload.dev_verify_url = link;
      return res.json(payload);
    }
    res.json({ message: 'If that account needs verification, a link has been sent.' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login  -> session token (requires a verified email)
router.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password } = normalizeCredentials(req.body);
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Throttle brute-force: block after too many recent failures (by email + IP).
    const limitKeys = [`email:${email}`, `ip:${req.ip}`];
    const wait = loginBlockedFor(limitKeys);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
      });
    }

    const user = await findUserByEmail(email);
    const ok = user && user.password_hash && (await verifyPassword(password, user.password_hash));
    if (!ok) {
      recordLoginFailure(limitKeys);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    recordLoginSuccess(limitKeys); // correct password -> reset the counters
    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Email not verified. Check your inbox or use /auth/resend-verification.',
      });
    }

    const token = await issueSession(user.id);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// GET /auth/google  -> redirect the browser to Google's consent screen
router.get('/auth/google', (req, res) => {
  if (!googleConfigured()) {
    return res.status(503).json({ error: 'Google sign-in is not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' });
  }
  res.redirect(buildAuthUrl(makeState()));
});

// GET /auth/google/callback  -> exchange code, verify email, issue session
router.get('/auth/google/callback', async (req, res, next) => {
  try {
    if (!googleConfigured()) {
      return res.status(503).json({ error: 'Google sign-in is not configured.' });
    }
    if (req.query.error) {
      return res.status(400).json({ error: `Google sign-in cancelled: ${req.query.error}` });
    }
    const { code, state } = req.query;
    if (!code || !verifyState(state)) {
      return res.status(400).json({ error: 'Invalid or expired sign-in state. Start again at /auth/google.' });
    }

    const claims = await exchangeCodeForClaims(String(code));
    if (!claims.email) {
      return res.status(400).json({ error: 'Google account has no email.' });
    }
    if (!claims.emailVerified) {
      return res.status(403).json({ error: 'Your Google email is not verified.' });
    }

    const user = await upsertGoogleUser({ sub: claims.sub, email: claims.email });
    const token = await issueSession(user.id);
    res.json({ message: 'Signed in with Google.', token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout  (revokes the presented token)
router.post('/auth/logout', requireBearer, async (req, res, next) => {
  try {
    await deleteSession(req.tokenHash);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /auth/me
router.get('/auth/me', requireBearer, async (req, res, next) => {
  try {
    const session = await findLiveSession(req.tokenHash);
    if (!session) return res.status(401).json({ error: 'Invalid or expired token.' });
    const user = await findUserById(session.userId);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

function requireBearer(req, res, next) {
  const h = req.headers.authorization || '';
  const [scheme, value] = h.split(' ');
  if (scheme !== 'Bearer' || !value) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  req.tokenHash = hashToken(value.trim());
  next();
}

export default router;
