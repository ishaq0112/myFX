// USAGE METERING MIDDLEWARE  ->  runs after requireApiKey on /v1/*
// ------------------------------------------------------------------
// For the key's owner (req.apiUserId) and plan (req.apiPlan):
//   1. per-minute rate limit  (in-memory sliding window)
//   2. monthly quota          (month-to-date total vs plan.monthly)
//   3. count the served call   (persisted; rejected calls are NOT counted)
// Exceeding (1) or (2) returns 429. Enterprise (null limits) is unlimited.
//
// The rate-limit window is in-memory: it resets on restart and is per-instance.
// That's fine for a single-node deploy; use a shared store (Redis) to scale out.

import { limitsFor } from '../plans.js';
import { initUsage, monthToDateTotal, recordCall } from './store.js';

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

export async function meterUsage(req, res, next) {
  try {
    const userId = req.apiUserId;
    const limits = limitsFor(req.apiPlan || 'free');
    const endpoint = ENDPOINTS[req.path] || 'other';
    await initUsage();

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
