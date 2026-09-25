// LOGIN RATE LIMITER  ->  throttles repeated FAILED logins (brute-force defense)
// ------------------------------------------------------------------
// Two independent counters per attempt:
//   - by email  -> stops someone hammering one account from anywhere
//   - by IP     -> stops one source trying many accounts
// After MAX_FAILS failures inside WINDOW_MS, that key is blocked (429) until the
// window rolls off. A correct password clears the counters.
//
// In-memory + per-instance (fine for a single node; use Redis to scale out).
// NOTE: req.ip is the socket IP unless you enable Express `trust proxy` behind a
// real reverse proxy — do that in production so the per-IP limit is meaningful.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILS = 5;

const attempts = new Map(); // key -> { count, resetAt }

function bucket(key) {
  const now = Date.now();
  let e = attempts.get(key);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(key, e);
  }
  return e;
}

/** Returns seconds until unblocked if any key is currently blocked, else 0. */
export function loginBlockedFor(keys) {
  const now = Date.now();
  let wait = 0;
  for (const k of keys) {
    const e = attempts.get(k);
    if (e && now <= e.resetAt && e.count >= MAX_FAILS) {
      wait = Math.max(wait, Math.ceil((e.resetAt - now) / 1000));
    }
  }
  return wait;
}

export function recordLoginFailure(keys) {
  for (const k of keys) bucket(k).count += 1;
}

export function recordLoginSuccess(keys) {
  for (const k of keys) attempts.delete(k);
}

// Periodically drop expired buckets so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of attempts) if (now > e.resetAt) attempts.delete(k);
}, WINDOW_MS).unref();
