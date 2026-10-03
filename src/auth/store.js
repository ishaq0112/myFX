// AUTH PERSISTENCE  (users + sessions + email verification, in Neon)
// ------------------------------------------------------------------
// Tables:
//   users               — id, email (unique), password_hash (nullable for
//                          Google accounts), email_verified, auth_provider,
//                          google_sub (unique), created_at
//   sessions            — token_hash (PK), user_id, expires_at
//   email_verifications — token_hash (PK), user_id, expires_at
//   password_resets     — token_hash (PK), user_id, expires_at
//   recovery_codes      — (user_id, code_hash) — single-use 2FA backup codes
//   login_challenges    — token_hash (PK), user_id, expires_at — the step
//                          between a correct password and the 2FA code
// Auth requires DATABASE_URL.

import { sql, hasDb } from '../db.js';

let initDone = null;

export function authAvailable() {
  return hasDb;
}

/** Create/upgrade the auth tables. Idempotent — safe to call repeatedly, and
 *  migrates an existing `users` table (from the email/password-only version). */
export function initAuth() {
  if (initDone) return initDone;
  initDone = (async () => {
    if (!hasDb) return;

    // UUID primary keys (gen_random_uuid() is built into Postgres 13+/Neon):
    // non-guessable and they don't leak how many users exist.
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        email_verified BOOLEAN NOT NULL DEFAULT false,
        auth_provider TEXT NOT NULL DEFAULT 'password',
        google_sub    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key ON users (google_sub) WHERE google_sub IS NOT NULL`;
    // Migration: add the display name for tables created before it existed.
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`;
    // Migration: billing plan (drives usage quotas/rate limits). Default Free.
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'`;
    // Migration: two-factor auth. totp_secret is the ENCRYPTED secret (pending
    // during setup, active once totp_enabled); totp_last_step blocks replaying
    // a code that was already used.
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT`;

    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )`;

    await sql`
      CREATE TABLE IF NOT EXISTS email_verifications (
        token_hash TEXT PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )`;

    await sql`
      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )`;

    await sql`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, code_hash)
      )`;

    await sql`
      CREATE TABLE IF NOT EXISTS login_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )`;
  })();
  return initDone;
}

/** Insert an email/password user (unverified). Throws 'EMAIL_TAKEN' on dup. */
export async function createUser(email, passwordHash, name = null) {
  try {
    const rows = await sql`
      INSERT INTO users (email, password_hash, name, auth_provider, email_verified)
      VALUES (${email}, ${passwordHash}, ${name}, 'password', false)
      RETURNING id, email, name, password_hash, email_verified, auth_provider, created_at`;
    return rows[0];
  } catch (e) {
    if (e.code === '23505' || /duplicate key|unique/i.test(e.message)) {
      const err = new Error('Email already registered.');
      err.code = 'EMAIL_TAKEN';
      throw err;
    }
    throw e;
  }
}

export async function findUserByEmail(email) {
  const rows = await sql`
    SELECT id, email, name, password_hash, email_verified, auth_provider, google_sub, plan,
           totp_enabled, totp_secret, totp_last_step, created_at
    FROM users WHERE email = ${email}`;
  return rows[0] || null;
}

export async function findUserById(id) {
  const rows = await sql`
    SELECT id, email, name, password_hash, email_verified, auth_provider, google_sub, plan,
           totp_enabled, totp_secret, totp_last_step, created_at
    FROM users WHERE id = ${id}`;
  return rows[0] || null;
}

/** Update the display name; returns the updated user. */
export async function setName(userId, name) {
  const rows = await sql`
    UPDATE users SET name = ${name} WHERE id = ${userId}
    RETURNING id, email, name, password_hash, email_verified, auth_provider, plan, totp_enabled, created_at`;
  return rows[0] || null;
}

/** Find or create a Google-authenticated user, linking by google_sub then email.
 *  Google emails are verified by Google, so email_verified is set true. */
export async function upsertGoogleUser({ sub, email }) {
  // 1. Already linked by Google subject id?
  let rows = await sql`
    SELECT id, email, name, password_hash, email_verified, auth_provider, google_sub, plan, totp_enabled, created_at
    FROM users WHERE google_sub = ${sub}`;
  if (rows[0]) return rows[0];

  // 2. Existing account with this email (e.g. signed up with password)? Link it.
  rows = await sql`
    SELECT id, email, name, password_hash, email_verified, auth_provider, google_sub, plan, totp_enabled, created_at
    FROM users WHERE email = ${email}`;
  if (rows[0]) {
    const updated = await sql`
      UPDATE users
      SET google_sub = ${sub}, email_verified = true
      WHERE id = ${rows[0].id}
      RETURNING id, email, name, password_hash, email_verified, auth_provider, google_sub, plan, totp_enabled, created_at`;
    return updated[0];
  }

  // 3. Brand new Google user (no password).
  const created = await sql`
    INSERT INTO users (email, auth_provider, google_sub, email_verified)
    VALUES (${email}, 'google', ${sub}, true)
    RETURNING id, email, name, password_hash, email_verified, auth_provider, google_sub, plan, totp_enabled, created_at`;
  return created[0];
}

export async function markEmailVerified(userId) {
  await sql`UPDATE users SET email_verified = true WHERE id = ${userId}`;
}

/** Set a new password hash (used by the reset flow). */
export async function setPassword(userId, passwordHash) {
  await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userId}`;
}

// --- password reset tokens ---

export async function createPasswordReset(userId, tokenHash, expiresAt) {
  // One pending reset per user: replace any previous one.
  await sql`DELETE FROM password_resets WHERE user_id = ${userId}`;
  await sql`
    INSERT INTO password_resets (token_hash, user_id, expires_at)
    VALUES (${tokenHash}, ${userId}, ${expiresAt.toISOString()})`;
}

/** Consume a reset token: returns userId if valid, else null. Single-use. */
export async function consumePasswordReset(tokenHash) {
  const rows = await sql`
    SELECT user_id, expires_at FROM password_resets WHERE token_hash = ${tokenHash}`;
  const row = rows[0];
  if (!row) return null;
  await sql`DELETE FROM password_resets WHERE token_hash = ${tokenHash}`;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null; // expired
  return row.user_id;
}

/** Revoke every session for a user (e.g. after a password reset). */
export async function deleteSessionsForUser(userId) {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
}

/** Revoke every session except one (e.g. the device changing the password). */
export async function deleteOtherSessions(userId, keepTokenHash) {
  await sql`DELETE FROM sessions WHERE user_id = ${userId} AND token_hash <> ${keepTokenHash}`;
}

// --- two-factor auth ---

/** Store a new (encrypted) secret during setup. Never touches an active one. */
export async function setPendingTotpSecret(userId, encryptedSecret) {
  const rows = await sql`
    UPDATE users SET totp_secret = ${encryptedSecret}, totp_last_step = NULL
    WHERE id = ${userId} AND totp_enabled = false
    RETURNING id`;
  return rows.length > 0;
}

/** Turn 2FA on and store its recovery codes (hashed), replacing any old ones. */
export async function enableTotp(userId, usedStep, recoveryHashes) {
  await sql`DELETE FROM recovery_codes WHERE user_id = ${userId}`;
  await sql`
    INSERT INTO recovery_codes (user_id, code_hash)
    SELECT ${userId}, unnest(${recoveryHashes}::text[])`;
  await sql`UPDATE users SET totp_enabled = true, totp_last_step = ${usedStep} WHERE id = ${userId}`;
}

export async function disableTotp(userId) {
  await sql`UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL WHERE id = ${userId}`;
  await sql`DELETE FROM recovery_codes WHERE user_id = ${userId}`;
}

/** Record a code's time step as used, only if it's newer than the last one, so
 *  two simultaneous requests can't both spend the same code. True if it won. */
export async function markTotpStepUsed(userId, step) {
  const rows = await sql`
    UPDATE users SET totp_last_step = ${step}
    WHERE id = ${userId} AND (totp_last_step IS NULL OR totp_last_step < ${step})
    RETURNING id`;
  return rows.length > 0;
}

/** Spend a recovery code. True if it existed (it's deleted either way). */
export async function consumeRecoveryCode(userId, codeHash) {
  const rows = await sql`
    DELETE FROM recovery_codes WHERE user_id = ${userId} AND code_hash = ${codeHash}
    RETURNING code_hash`;
  return rows.length > 0;
}

// --- 2FA login challenges (password OK, waiting for the code) ---

export async function createLoginChallenge(userId, tokenHash, expiresAt) {
  await sql`DELETE FROM login_challenges WHERE user_id = ${userId} AND expires_at < now()`;
  await sql`
    INSERT INTO login_challenges (token_hash, user_id, expires_at)
    VALUES (${tokenHash}, ${userId}, ${expiresAt.toISOString()})`;
}

/** The challenge's userId if it's live, else null. Not consumed here, so a
 *  mistyped code can be retried (attempts are rate-limited by the route). */
export async function findLoginChallenge(tokenHash) {
  const rows = await sql`SELECT user_id, expires_at FROM login_challenges WHERE token_hash = ${tokenHash}`;
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await deleteLoginChallenge(tokenHash);
    return null;
  }
  return row.user_id;
}

/** Delete a challenge. True if it existed, so only one request can use it. */
export async function deleteLoginChallenge(tokenHash) {
  const rows = await sql`DELETE FROM login_challenges WHERE token_hash = ${tokenHash} RETURNING token_hash`;
  return rows.length > 0;
}

// --- email verification tokens ---

export async function createVerification(userId, tokenHash, expiresAt) {
  // One pending token per user: replace any previous one.
  await sql`DELETE FROM email_verifications WHERE user_id = ${userId}`;
  await sql`
    INSERT INTO email_verifications (token_hash, user_id, expires_at)
    VALUES (${tokenHash}, ${userId}, ${expiresAt.toISOString()})`;
}

/** Consume a verification token: returns userId if valid, else null. Deletes it. */
export async function consumeVerification(tokenHash) {
  const rows = await sql`
    SELECT user_id, expires_at FROM email_verifications WHERE token_hash = ${tokenHash}`;
  const row = rows[0];
  if (!row) return null;
  await sql`DELETE FROM email_verifications WHERE token_hash = ${tokenHash}`;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null; // expired
  return row.user_id;
}

// --- sessions ---

export async function createSession(userId, tokenHash, expiresAt) {
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${tokenHash}, ${userId}, ${expiresAt.toISOString()})`;
}

export async function findLiveSession(tokenHash) {
  const rows = await sql`
    SELECT s.user_id, s.expires_at, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash}`;
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await deleteSession(tokenHash);
    return null;
  }
  return { userId: row.user_id, email: row.email, expiresAt: row.expires_at };
}

export async function deleteSession(tokenHash) {
  await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
}

/** Permanently delete a user. Child rows (sessions, api_keys, usage_daily,
 *  email_verifications, password_resets) are removed by ON DELETE CASCADE. */
export async function deleteUser(userId) {
  await sql`DELETE FROM users WHERE id = ${userId}`;
}
