// AUTH ROUTES  ->  mounted at /auth
// ------------------------------------------------------------------
//   POST /auth/signup               { email, password }  -> sends verify link
//   GET  /auth/verify?token=...     -> verifies an email, returns a session
//   POST /auth/resend-verification  { email }            -> new verify link
//   POST /auth/forgot-password      { email }            -> emails a reset link
//   POST /auth/reset-password       { token, password }  -> sets a new password
//   POST /auth/login                { email, password }  -> session token, or a
//                                                           2FA challenge
//   POST /auth/login/2fa            { challenge, code }  -> session token
//   GET  /auth/google               -> redirect to Google sign-in
//   GET  /auth/google/callback      -> completes Google sign-in
//   POST /auth/logout               (Bearer)             -> revoke session
//   GET  /auth/me                   (Bearer)             -> current account
//   PATCH /auth/me                  (Bearer) { name }    -> update profile
//   DELETE /auth/me                 (Bearer)             -> delete account
//   POST /auth/change-password      (Bearer) { current_password, new_password }
//   POST /auth/2fa/setup            (Bearer)             -> secret + QR code
//   POST /auth/2fa/enable           (Bearer) { code }    -> recovery codes
//   POST /auth/2fa/disable          (Bearer) { code }    -> turns 2FA off
//
// Verified email is required: password signups must click the emailed link
// before they can log in; Google accounts are verified by Google.
//
// Two-factor (authenticator app, see totp.js): every route that signs someone in
// goes through finishSignIn(), so with 2FA on, login, password reset, email
// verification, and Google all stop at a challenge until a code is entered.
//
// NOTE: passwords travel in the request body — serve over HTTPS in production.
// Login has brute-force throttling (see loginLimiter.js). Password reset issues a
// short-lived (1h), single-use emailed token and revokes existing sessions.

import express from 'express';
import { hashPassword, verifyPassword } from './passwords.js';
import { newToken, hashToken, sessionExpiry } from './tokens.js';
import { sendVerificationEmail, sendPasswordResetEmail, mailerMode } from './mailer.js';
import { requireAuth } from './middleware.js';
import {
  totpAvailable,
  generateSecret,
  verifyTotp,
  otpauthUrl,
  qrDataUrl,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
} from './totp.js';
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
  setPassword,
  createPasswordReset,
  consumePasswordReset,
  deleteSessionsForUser,
  deleteOtherSessions,
  createSession,
  deleteSession,
  deleteUser,
  setName,
  setPendingTotpSecret,
  enableTotp,
  disableTotp,
  markTotpStepUsed,
  consumeRecoveryCode,
  createLoginChallenge,
  findLoginChallenge,
  deleteLoginChallenge,
} from './store.js';
import { loginBlockedFor, recordLoginFailure, recordLoginSuccess } from './loginLimiter.js';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 60 * 60 * 1000; // 1h — password-reset links are short-lived
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // time to enter the 2FA code after the password
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
    has_password: Boolean(u.password_hash),
    two_factor_enabled: Boolean(u.totp_enabled),
    created_at: u.created_at,
  };
}

async function issueSession(userId) {
  const { raw, hash } = newToken();
  await createSession(userId, hash, sessionExpiry());
  return raw;
}

// Finish a sign-in. Without 2FA: a session. With 2FA: a short-lived challenge the
// client trades for a session (plus a code) at POST /auth/login/2fa. Every route
// that signs someone in uses this, so none of them can skip the second factor.
async function finishSignIn(user) {
  if (user.totp_enabled) {
    const { raw, hash } = newToken();
    await createLoginChallenge(user.id, hash, new Date(Date.now() + CHALLENGE_TTL_MS));
    return { two_factor_required: true, challenge: raw };
  }
  return { token: await issueSession(user.id), user: publicUser(user) };
}

// Check a second factor: a 6-digit authenticator code, or a recovery code.
// Spends whichever matched (a code's time step can't be reused; recovery codes
// are single-use). Returns true if it was valid.
async function checkSecondFactor(user, input) {
  const code = String(input ?? '').trim();
  if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
    if (!user.totp_secret) return false;
    let secret;
    try {
      secret = decryptSecret(user.totp_secret);
    } catch (err) {
      // e.g. APP_SECRET changed: authenticator codes can't be checked, but
      // recovery codes still work.
      console.error(`[2fa] ${err.message} (user ${user.id})`);
      return false;
    }
    const step = verifyTotp(secret, code, user.totp_last_step);
    return step != null && (await markTotpStepUsed(user.id, step));
  }
  return code ? consumeRecoveryCode(user.id, hashRecoveryCode(code)) : false;
}

// Rate-limit guard shared by the code/password checks below. Sends 429 and
// returns true when blocked.
function blocked(res, keys) {
  const wait = loginBlockedFor(keys);
  if (!wait) return false;
  res.set('Retry-After', String(wait));
  res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
  return true;
}

// Create a verification token, store its hash, and return the link to email
// (also handy to surface in dev mode).
async function newVerificationLink(userId) {
  const { raw, hash } = newToken();
  await createVerification(userId, hash, new Date(Date.now() + VERIFY_TTL_MS));
  return `${APP_URL}/auth/verify?token=${raw}`;
}

// For replies that must look the same whether or not the account exists: don't
// make the response wait on the email, so a slow or failed send can't change it.
// (sendEmail never rejects; the catch is a guard against a process crash.)
function sendInBackground(promise) {
  promise.catch((err) => console.error('[mailer]', err.message));
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
    const link = await newVerificationLink(user.id);
    // Wait here (unlike resend/forgot): this user just created the account, so
    // telling them the email didn't go out reveals nothing and tells them what to do.
    const sent = await sendVerificationEmail(user.email, link);

    const payload = {
      message: sent.error
        ? 'Account created, but we couldn’t send the verification email. Log in and use "Resend verification" to try again.'
        : 'Account created. Check your email to verify before logging in.',
      user: publicUser(user),
    };
    if (sent.error) payload.email_failed = true;
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
    res.json({ message: 'Email verified.', ...(await finishSignIn(user)) });
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
      const link = await newVerificationLink(user.id);
      sendInBackground(sendVerificationEmail(user.email, link));
      const payload = { message: 'If that account needs verification, a link has been sent.' };
      if (mailerMode() === 'dev-console') payload.dev_verify_url = link;
      return res.json(payload);
    }
    res.json({ message: 'If that account needs verification, a link has been sent.' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/forgot-password  { email }  -> emails a reset link
// Always replies the same way so we never reveal which emails exist.
router.post('/auth/forgot-password', async (req, res, next) => {
  const generic = { message: 'If an account exists for that email, a reset link has been sent.' };
  try {
    const { email } = normalizeCredentials(req.body);
    const user = email && EMAIL_RE.test(email) ? await findUserByEmail(email) : null;

    // Only password accounts can reset a password (Google users have none).
    if (user && user.password_hash && user.auth_provider === 'password') {
      const { raw, hash } = newToken();
      await createPasswordReset(user.id, hash, new Date(Date.now() + RESET_TTL_MS));
      const link = `${APP_URL}/app/?reset=${raw}`;
      sendInBackground(sendPasswordResetEmail(user.email, link));
      if (mailerMode() === 'dev-console') return res.json({ ...generic, dev_reset_url: link });
    }
    res.json(generic);
  } catch (err) {
    next(err);
  }
});

// POST /auth/reset-password  { token, password }  -> sets a new password
router.post('/auth/reset-password', async (req, res, next) => {
  try {
    const raw = String(req.body?.token || '');
    const password = String(req.body?.password ?? '');
    if (!raw) return res.status(400).json({ error: 'Missing reset token.' });
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    }

    const userId = await consumePasswordReset(hashToken(raw));
    if (!userId) {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }

    await setPassword(userId, await hashPassword(password));
    // A reset can also confirm ownership of the inbox, and invalidates any
    // sessions an attacker might hold — revoke all existing sessions.
    await markEmailVerified(userId);
    await deleteSessionsForUser(userId);

    // With 2FA on, a reset still needs a code: the emailed link alone isn't
    // enough to get in.
    const user = await findUserById(userId);
    res.json({ message: 'Password updated.', ...(await finishSignIn(user)) });
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

    res.json(await finishSignIn(user));
  } catch (err) {
    next(err);
  }
});

// POST /auth/login/2fa  { challenge, code }  -> session token
// The second step of a 2FA sign-in: the challenge comes from finishSignIn(), the
// code from the authenticator app (or a recovery code).
router.post('/auth/login/2fa', async (req, res, next) => {
  try {
    const raw = String(req.body?.challenge || '');
    const challengeHash = raw ? hashToken(raw) : null;
    const userId = challengeHash ? await findLoginChallenge(challengeHash) : null;
    if (!userId) return res.status(401).json({ error: 'Your sign-in expired. Log in again.' });

    const keys = [`2fa:${userId}`, `ip:${req.ip}`];
    if (blocked(res, keys)) return;

    const user = await findUserById(userId);
    if (!user?.totp_enabled) {
      // 2FA was turned off after this challenge was issued: start over.
      await deleteLoginChallenge(challengeHash);
      return res.status(401).json({ error: 'Your sign-in expired. Log in again.' });
    }
    if (!(await checkSecondFactor(user, req.body?.code))) {
      recordLoginFailure(keys);
      return res.status(401).json({ error: 'Invalid code. Try again.' });
    }
    recordLoginSuccess(keys);

    // Single use: if two requests race with valid codes, only one gets in.
    if (!(await deleteLoginChallenge(challengeHash))) {
      return res.status(401).json({ error: 'Your sign-in expired. Log in again.' });
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
    res.json({ message: 'Signed in with Google.', ...(await finishSignIn(user)) });
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

// PATCH /auth/me  { name }  -> update the display name (empty clears it)
router.patch('/auth/me', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim().slice(0, 80) || null;
    const user = await setName(req.user.id, name);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    res.json({ message: 'Profile saved.', user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// POST /auth/change-password  { current_password, new_password }
// Signs out every OTHER session; the device making the change stays signed in.
router.post('/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    const current = String(req.body?.current_password ?? '');
    const newPassword = String(req.body?.new_password ?? '');
    const user = await findUserById(req.user.id);
    if (!user?.password_hash) {
      return res.status(400).json({ error: 'This account signs in with Google, so it has no password to change.' });
    }
    if (newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters.` });
    }

    // A stolen session shouldn't be able to guess the current password.
    const keys = [`pw:${user.id}`];
    if (blocked(res, keys)) return;
    if (!(await verifyPassword(current, user.password_hash))) {
      recordLoginFailure(keys);
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    recordLoginSuccess(keys);

    await setPassword(user.id, await hashPassword(newPassword));
    await deleteOtherSessions(user.id, req.sessionTokenHash);
    res.json({ message: 'Password updated. Other devices have been signed out.' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/setup  -> a new secret + QR code. 2FA stays OFF until /enable
// confirms the app produces matching codes.
router.post('/auth/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    if (!totpAvailable()) {
      return res.status(503).json({ error: 'Two-factor authentication needs APP_SECRET set on the server.' });
    }
    const user = await findUserById(req.user.id);
    if (user.totp_enabled) return res.status(409).json({ error: 'Two-factor authentication is already on.' });

    const secret = generateSecret();
    await setPendingTotpSecret(user.id, encryptSecret(secret));
    const url = otpauthUrl(user.email, secret);
    res.json({ secret, otpauth_url: url, qr: qrDataUrl(url) });
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/enable  { code }  -> turns 2FA on; returns recovery codes ONCE
router.post('/auth/2fa/enable', requireAuth, async (req, res, next) => {
  try {
    const user = await findUserById(req.user.id);
    if (user.totp_enabled) return res.status(409).json({ error: 'Two-factor authentication is already on.' });
    if (!user.totp_secret) return res.status(400).json({ error: 'Start setup first.' });

    const keys = [`2fa:${user.id}`];
    if (blocked(res, keys)) return;
    const step = verifyTotp(decryptSecret(user.totp_secret), req.body?.code);
    if (step == null) {
      recordLoginFailure(keys);
      return res.status(400).json({ error: 'That code didn’t match. Check your app and try the current code.' });
    }
    recordLoginSuccess(keys);

    const codes = generateRecoveryCodes();
    await enableTotp(user.id, step, codes.map(hashRecoveryCode));
    res.json({ message: 'Two-factor authentication is on.', recovery_codes: codes });
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/disable  { code }  -> needs a current authenticator or recovery
// code, so a stolen session alone can't turn 2FA off.
router.post('/auth/2fa/disable', requireAuth, async (req, res, next) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is already off.' });

    const keys = [`2fa:${user.id}`];
    if (blocked(res, keys)) return;
    if (!(await checkSecondFactor(user, req.body?.code))) {
      recordLoginFailure(keys);
      return res.status(400).json({ error: 'Invalid code. Use your authenticator app or a recovery code.' });
    }
    recordLoginSuccess(keys);

    await disableTotp(user.id);
    res.json({ message: 'Two-factor authentication is off.' });
  } catch (err) {
    next(err);
  }
});

// DELETE /auth/me  -> permanently deletes the account (irreversible)
router.delete('/auth/me', requireBearer, async (req, res, next) => {
  try {
    const session = await findLiveSession(req.tokenHash);
    if (!session) return res.status(401).json({ error: 'Invalid or expired token.' });
    // Deleting the user cascades to sessions, api_keys, usage, and tokens.
    await deleteUser(session.userId);
    res.json({ ok: true, message: 'Account deleted.' });
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
