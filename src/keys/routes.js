// API KEY MANAGEMENT ROUTES  ->  mounted at /keys
// ------------------------------------------------------------------
// These are for a logged-in USER (session Bearer token) to manage their keys:
//   POST   /keys         { name?, expires_in_days? }  -> create (secret shown once)
//   GET    /keys                                      -> list your keys
//   DELETE /keys/:id                                  -> revoke a key
//
// The keys themselves are used to call /v1/* via the X-API-Key header.

import express from 'express';
import { requireAuth } from '../auth/middleware.js';
import { generateKey } from './keys.js';
import { keysAvailable, initKeys, createKey, listKeys, revokeKey } from './store.js';

const router = express.Router();

const MAX_NAME = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(async (req, res, next) => {
  if (!keysAvailable()) {
    return res.status(503).json({ error: 'API keys unavailable: DATABASE_URL is not configured.' });
  }
  try {
    await initKeys();
    next();
  } catch (err) {
    next(err);
  }
});

// POST /keys  -> create a new key; the full secret is returned ONCE
router.post('/keys', requireAuth, async (req, res, next) => {
  try {
    const name = req.body?.name != null ? String(req.body.name).trim().slice(0, MAX_NAME) : null;

    // Optional expiry: expires_in_days (positive number). Omit for a key that
    // never expires.
    let expiresAt = null;
    const days = req.body?.expires_in_days;
    if (days != null) {
      const n = Number(days);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: 'expires_in_days must be a positive number.' });
      }
      expiresAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
    }

    const { key, hash } = generateKey();
    const stored = await createKey({
      userId: req.user.id,
      name,
      keyHash: hash,
      expiresAt,
    });

    res.status(201).json({
      message: 'Store this key now — it will not be shown again.',
      key, // the full secret, shown exactly once
      api_key: stored, // metadata (no secret)
    });
  } catch (err) {
    next(err);
  }
});

// GET /keys  -> list the caller's keys (never includes the secret)
router.get('/keys', requireAuth, async (req, res, next) => {
  try {
    const keys = await listKeys(req.user.id);
    res.json({ count: keys.length, keys });
  } catch (err) {
    next(err);
  }
});

// DELETE /keys/:id  -> revoke a key you own
router.delete('/keys/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      return res.status(404).json({ error: 'Key not found.' });
    }
    const revoked = await revokeKey(req.user.id, id);
    if (!revoked) {
      return res.status(404).json({ error: 'Key not found or already revoked.' });
    }
    res.json({ ok: true, revoked: id });
  } catch (err) {
    next(err);
  }
});

export default router;
