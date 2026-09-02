// AUTH PERSISTENCE  (users + sessions + email verification, in Neon)
// ------------------------------------------------------------------
// Tables:
//   users               — id, email (unique), password_hash (nullable for
//                          Google accounts), email_verified, auth_provider,
//                          google_sub (unique), created_at
//   sessions            — token_hash (PK), user_id, expires_at
//   email_verifications — token_hash (PK), user_id, expires_at
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
  })();
  return initDone;
}

/** Insert an email/password user (unverified). Throws 'EMAIL_TAKEN' on dup. */
export async function createUser(email, passwordHash, name = null) {
  try {
    const rows = await sql`
      INSERT INTO users (email, password_hash, name, auth_provider, email_verified)
      VALUES (${email}, ${passwordHash}, ${name}, 'password', false)
      RETURNING id, email, name, email_verified, auth_provider, created_at`;
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
    SELECT id, email, name, password_hash, email_verified, auth_provider, google_sub, created_at
    FROM users WHERE email = ${email}`;
  return rows[0] || null;
}

export async function findUserById(id) {
  const rows = await sql`
    SELECT id, email, name, password_hash, email_verified, auth_provider, google_sub, plan, created_at
    FROM users WHERE id = ${id}`;
  return rows[0] || null;
}

/** Find or create a Google-authenticated user, linking by google_sub then email.
 *  Google emails are verified by Google, so email_verified is set true. */
export async function upsertGoogleUser({ sub, email }) {
  // 1. Already linked by Google subject id?
  let rows = await sql`
    SELECT id, email, password_hash, email_verified, auth_provider, google_sub, created_at
    FROM users WHERE google_sub = ${sub}`;
  if (rows[0]) return rows[0];

  // 2. Existing account with this email (e.g. signed up with password)? Link it.
  rows = await sql`
    SELECT id, email, password_hash, email_verified, auth_provider, google_sub, created_at
    FROM users WHERE email = ${email}`;
  if (rows[0]) {
    const updated = await sql`
      UPDATE users
      SET google_sub = ${sub}, email_verified = true
      WHERE id = ${rows[0].id}
      RETURNING id, email, password_hash, email_verified, auth_provider, google_sub, created_at`;
    return updated[0];
  }

  // 3. Brand new Google user (no password).
  const created = await sql`
    INSERT INTO users (email, auth_provider, google_sub, email_verified)
    VALUES (${email}, 'google', ${sub}, true)
    RETURNING id, email, password_hash, email_verified, auth_provider, google_sub, created_at`;
  return created[0];
}

export async function markEmailVerified(userId) {
  await sql`UPDATE users SET email_verified = true WHERE id = ${userId}`;
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
