// USAGE ROUTE  ->  GET /usage  (session-protected)
// ------------------------------------------------------------------
// Returns the logged-in user's current-month usage against their plan, so the
// dashboard can show real numbers (requests this month/today + per-endpoint).

import express from 'express';
import { hasDb } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { findUserById } from '../auth/store.js';
import { limitsFor } from '../plans.js';
import { initUsage, usageSummary, dailySeries } from './store.js';

const router = express.Router();

// GET /usage/daily?days=30  -> per-day request counts for the chart
router.get('/usage/daily', requireAuth, async (req, res, next) => {
  try {
    if (!hasDb) return res.status(503).json({ error: 'Usage unavailable: DATABASE_URL is not configured.' });
    await initUsage();
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    res.json({ days: await dailySeries(req.user.id, days) });
  } catch (err) {
    next(err);
  }
});

router.get('/usage', requireAuth, async (req, res, next) => {
  try {
    if (!hasDb) return res.status(503).json({ error: 'Usage unavailable: DATABASE_URL is not configured.' });
    await initUsage();
    const user = await findUserById(req.user.id);
    const plan = user?.plan || 'free';
    const limits = limitsFor(plan);
    const { month, today, byEndpoint } = await usageSummary(req.user.id);
    res.json({
      period: new Date().toISOString().slice(0, 7), // YYYY-MM
      plan,
      limits: { monthly: limits.monthly, perMinute: limits.perMinute },
      used: month,
      today,
      remaining: limits.monthly != null ? Math.max(0, limits.monthly - month) : null,
      byEndpoint,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
