// TWO-FACTOR AUTH  (authenticator-app codes, RFC 6238 TOTP)
// ------------------------------------------------------------------
// Standard 30-second, 6-digit, SHA-1 codes: what Google Authenticator, Authy,
// 1Password, etc. expect. Built on node:crypto; qrcode-generator only draws
// the setup QR code.
//
// - Secrets are stored ENCRYPTED (AES-256-GCM, key derived from APP_SECRET), so
//   a database leak alone can't mint codes.
// - A code's time step is recorded when used, so the same code can't be replayed.
// - Recovery codes are stored as SHA-256 hashes (they're high-entropy, so a fast
//   hash is fine) and work even if APP_SECRET changes.
//
// Needs a STABLE APP_SECRET. If it changes, stored secrets can't be decrypted:
// affected users sign in with a recovery code and set 2FA up again.

import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import qrcode from 'qrcode-generator';

const ISSUER = 'MyFX';
const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // also accept the previous/next step, for phone clock drift
const RECOVERY_COUNT = 10;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const APP_SECRET = process.env.APP_SECRET;
const ENC_KEY = APP_SECRET ? createHash('sha256').update(`myfx-totp:${APP_SECRET}`).digest() : null;

/** 2FA can only be offered with a stable key to encrypt secrets. */
export function totpAvailable() {
  return Boolean(ENC_KEY);
}

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/[\s=]/g, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32 secret');
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

function codeAt(key, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** A new random secret (160 bits, base32) to show the user during setup. */
export function generateSecret() {
  return base32Encode(randomBytes(20));
}

/** The current code for a secret (used by tests and tooling). */
export function generateTotp(secret, now = Date.now()) {
  return codeAt(base32Decode(secret), stepAt(now));
}

/** Check a 6-digit code. Returns the matched time step (record it as used so the
 *  code can't be replayed), or null. Steps at or before lastStep are rejected. */
export function verifyTotp(secret, code, lastStep = null, now = Date.now()) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secret);
  const last = lastStep == null ? null : Number(lastStep);
  const cur = stepAt(now);
  for (let s = cur - WINDOW; s <= cur + WINDOW; s++) {
    if (last != null && s <= last) continue;
    if (timingSafeEqual(Buffer.from(codeAt(key, s)), Buffer.from(c))) return s;
  }
  return null;
}

/** The otpauth:// URI an authenticator app reads from the QR code. */
export function otpauthUrl(email, secret) {
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** The setup QR code as an image data URL (rendered server-side, so the
 *  dashboard loads no third-party script). */
export function qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 12);
}

// --- secret encryption at rest ---

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(stored) {
  const [v, iv, tag, ct] = String(stored).split(':');
  if (v !== 'v1' || !ENC_KEY) throw new Error('Cannot decrypt 2FA secret (format or APP_SECRET)');
  const d = createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// --- recovery codes ---

/** Ten single-use codes like "k7m2q-x4bfa" (50 bits each). Shown once. */
export function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_COUNT }, () => {
    const s = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Hash for storage/lookup; ignores case, spaces, and dashes in what's typed. */
export function hashRecoveryCode(code) {
  const norm = String(code ?? '').toLowerCase().replace(/[^a-z2-7]/g, '');
  return createHash('sha256').update(norm).digest('hex');
}
