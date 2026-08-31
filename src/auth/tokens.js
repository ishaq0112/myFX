// SESSION TOKENS  (from node:crypto — no dependencies)
// ------------------------------------------------------------------
// On login/signup we mint a random opaque token and hand the RAW value to the
// client (used as `Authorization: Bearer <token>`). We store only its SHA-256
// hash in the DB, so a database leak can't be replayed as a valid login.

import { randomBytes, createHash } from 'node:crypto';

// How long a session stays valid.
export const SESSION_TTL_DAYS = 30;

export function newToken() {
  const raw = randomBytes(32).toString('base64url'); // ~43 chars, URL-safe
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

export function sessionExpiry(from = new Date()) {
  return new Date(from.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}
