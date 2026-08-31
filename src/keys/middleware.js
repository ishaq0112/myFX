// API KEY MIDDLEWARE  ->  gates /v1/*
// ------------------------------------------------------------------
// Reads the key from the `X-API-Key` header, hashes it, and looks up a usable
// key (active + not expired). On success attaches req.apiKeyId / req.apiUserId
// and records last_used_at lazily (fire-and-forget, never blocks the request).

import { hashKey } from './keys.js';
import { keysAvailable, initKeys, findUsableKey, touchLastUsed } from './store.js';

export async function requireApiKey(req, res, next) {
  try {
    if (!keysAvailable()) {
      return res.status(503).json({ error: 'API is unavailable: DATABASE_URL is not configured.' });
    }
    await initKeys();

    const presented = req.headers['x-api-key'];
    if (!presented) {
      return res.status(401).json({ error: 'Missing API key. Send it in the X-API-Key header.' });
    }

    const found = await findUsableKey(hashKey(String(presented).trim()));
    if (!found) {
      return res.status(401).json({ error: 'Invalid, expired, or revoked API key.' });
    }

    req.apiKeyId = found.id;
    req.apiUserId = found.userId;
    touchLastUsed(found.id).catch(() => {}); // best-effort; don't block or fail
    next();
  } catch (err) {
    next(err);
  }
}
