// PASSWORD HASHING  (scrypt, from node:crypto — no dependencies)
// ------------------------------------------------------------------
// We never store raw passwords. Each password is hashed with a random 16-byte
// salt using scrypt (memory-hard). Stored format:  scrypt$<saltHex>$<hashHex>
// Verification is constant-time to avoid timing attacks.

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scryptAsync(password, salt, expected.length);
  // timingSafeEqual throws on length mismatch — guard first.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
