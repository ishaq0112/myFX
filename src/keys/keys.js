// API KEY GENERATION  (node:crypto — no dependencies)
// ------------------------------------------------------------------
// A key looks like:  myfx_live_<40 url-safe random chars>
// We return the RAW key to the user exactly once (at creation) and store only
// its SHA-256 hash — a DB leak can't be replayed as a working key.

import { randomBytes, createHash } from 'node:crypto';

const PREFIX = 'myfx_live_';

export function generateKey() {
  const secret = randomBytes(30).toString('base64url'); // ~40 chars, URL-safe
  const key = PREFIX + secret;
  return {
    key, // full secret — shown once, never stored
    hash: hashKey(key), // what we store
  };
}

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}
