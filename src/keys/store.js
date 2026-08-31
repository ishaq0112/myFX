// API KEY PERSISTENCE  (in Neon)
// ------------------------------------------------------------------
// Table: api_keys — one row per key. We store only the SHA-256 hash of each
// key (never the secret). A key is USABLE only when status = 'active' AND it
// hasn't passed its expires_at deadline.
//
//   status:      'active' | 'suspended' | 'revoked' | 'expired'
//                ('expired' is set lazily once expires_at passes — see
//                 expireStaleKeys; access checks reject it either way.)
//   expires_at:  optional deadline (NULL = never)
//   revoked_at:  audit note — when it was revoked

import { sql, hasDb } from '../db.js';
import { initAuth } from '../auth/store.js';

let initDone = null;

export function keysAvailable() {
  return hasDb;
}

/** Create the api_keys table (after ensuring users exists for the FK). */
export function initKeys() {
  if (initDone) return initDone;
  initDone = (async () => {
    if (!hasDb) return;
    await initAuth(); // api_keys references users(id)
    await sql`
      CREATE TABLE IF NOT EXISTS api_keys (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         TEXT,
        key_hash     TEXT UNIQUE NOT NULL,
        status       TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','suspended','revoked','expired')),
        expires_at   TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at   TIMESTAMPTZ
      )`;
    await sql`CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys (user_id)`;

    // Migration: allow the new 'expired' status on tables created before it.
    await sql`ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_status_check`;
    await sql`ALTER TABLE api_keys ADD CONSTRAINT api_keys_status_check
              CHECK (status IN ('active','suspended','revoked','expired'))`;
  })();
  return initDone;
}

export async function createKey({ userId, name, keyHash, expiresAt }) {
  const rows = await sql`
    INSERT INTO api_keys (user_id, name, key_hash, expires_at)
    VALUES (${userId}, ${name}, ${keyHash}, ${expiresAt})
    RETURNING id, name, status, expires_at, last_used_at, created_at, revoked_at`;
  return rows[0];
}

/** Optimistically flip any of this user's active-but-past-expiry keys to
 *  'expired' so their stored status matches reality. Cheap no-op when none are
 *  due. Returns how many were transitioned. */
export async function expireStaleKeys(userId) {
  const rows = await sql`
    UPDATE api_keys
    SET status = 'expired'
    WHERE user_id = ${userId}
      AND status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at <= now()
    RETURNING id`;
  return rows.length;
}

export async function listKeys(userId) {
  await expireStaleKeys(userId); // materialize 'expired' before reading
  return await sql`
    SELECT id, name, status, expires_at, last_used_at, created_at, revoked_at
    FROM api_keys
    WHERE user_id = ${userId}
    ORDER BY created_at DESC`;
}

/** Resolve a presented key hash to its owner — only if usable
 *  (active and not past its expiry). Returns { id, userId } or null. */
export async function findUsableKey(keyHash) {
  const rows = await sql`
    SELECT id, user_id FROM api_keys
    WHERE key_hash = ${keyHash}
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())`;
  const row = rows[0];
  return row ? { id: row.id, userId: row.user_id } : null;
}

export async function touchLastUsed(id) {
  await sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`;
}

/** Revoke one of the user's own keys. Returns true if a key was revoked. */
export async function revokeKey(userId, keyId) {
  const rows = await sql`
    UPDATE api_keys
    SET status = 'revoked', revoked_at = now()
    WHERE id = ${keyId} AND user_id = ${userId} AND status <> 'revoked'
    RETURNING id`;
  return rows.length > 0;
}
