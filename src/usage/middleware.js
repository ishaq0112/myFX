// USAGE METERING MIDDLEWARE  ->  runs after requireApiKey on /v1/*
// ------------------------------------------------------------------
// For the key's owner (req.apiUserId) and plan (req.apiPlan):
//   1. per-minute rate limit  (in-memory sliding window)
//   2. monthly quota          (month-to-date total vs plan.monthly)
//   3. count the served call   (persisted; rejected calls are NOT counted)
//   4. once the response is sent, log the outcome (status + latency) for the
//      Activity Log and error rate. This covers 429 rejections too.
// Exceeding (1) or (2) returns 429. Enterprise (null limits) is unlimited.
//
// The rate-limit window is in-memory: it resets on restart and is per-instance.
// That's fine for a single-node deploy; use a shared store (Redis) to scale out.

import { limitsFor } from '../plans.js';
import { initUsage, monthToDateTotal, recordCall, recordOutcome, pruneRequestLog } from './store.js';

const windows = new Map(); // userId -> ascending array of request timestamps (ms)

function rateLimited(userId, perMinute) {
  if (!perMinute) return false; // unlimited
  const now = Date.now();
  const cutoff = now - 60_000;
  let arr = windows.get(userId);
  if (!arr) { arr = []; windows.set(userId, arr); }
  while (arr.length && arr[0] < cutoff) arr.shift(); // drop entries older than 60s
  if (arr.length >= perMinute) return true;
  arr.push(now);
  return false;
}

const ENDPOINTS = { '/latest': 'latest', '/convert': 'convert', '/currencies': 'currencies' };

// Only these query params are kept in the Activity Log (short, never secrets).
const LOGGED_PARAMS = ['base', 'symbols', 'from', 'to', 'amount'];
function pickParams(query) {
  const out = new URLSearchParams();
  for (const k of LOGGED_PARAMS) {
    if (query[k] != null) out.set(k, String(query[k]).slice(0, 40));
  }
  return out.toString() || null;
}

// Keep the request log bounded: trim to each user's newest rows once an hour.
setInterval(() => {
  initUsage().then(pruneRequestLog).catch(() => {});
}, 60 * 60 * 1000).unref();

export async function meterUsage(req, res, next) {
  try {
    const userId = req.apiUserId;
    const limits = limitsFor(req.apiPlan || 'free');
    const endpoint = ENDPOINTS[req.path] || 'other';
    await initUsage();

    // Log the outcome after the response goes out, so it never adds latency.
    // Capture the path now: once routing leaves this /v1 mount, Express puts the
    // prefix back on req.path, so reading it in the callback would be inconsistent.
    const startedAt = req.receivedAt ?? Date.now();
    const path = req.path.slice(0, 64);
    const params = pickParams(req.query);
    res.on('finish', () => {
      recordOutcome({
        userId,
        keyId: req.apiKeyId,
        path,
        params,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }).catch(() => {}); // best-effort; a logging failure must not affect the API
    });

    // 1) per-minute rate limit
    if (rateLimited(userId, limits.perMinute)) {
      res.set('Retry-After', '60');
      return res.status(429).json({
        error: `Rate limit exceeded: ${limits.perMinute} requests/min on the ${limits.label} plan. Slow down or upgrade.`,
      });
    }

    // 2) monthly quota
    if (limits.monthly != null) {
      const used = await monthToDateTotal(userId);
      res.set('X-Quota-Limit', String(limits.monthly));
      if (used >= limits.monthly) {
        res.set('X-Quota-Remaining', '0');
        return res.status(429).json({
          error: `Monthly quota reached: ${limits.monthly.toLocaleString('en-US')} requests on the ${limits.label} plan. Upgrade for more.`,
        });
      }
      res.set('X-Quota-Remaining', String(limits.monthly - used - 1));
    }
    if (limits.perMinute != null) res.set('X-RateLimit-Limit', String(limits.perMinute));

    // 3) count this (served) call before responding, so the total stays accurate
    await recordCall(userId, endpoint);
    next();
  } catch (err) {
    next(err);
  }
}
