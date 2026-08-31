// AUTH MIDDLEWARE
// ------------------------------------------------------------------
// requireAuth: gate a route behind a valid session token. Reads
//   Authorization: Bearer <token>
// hashes it, looks up a live session, and attaches req.user = { id, email }.
// Responds 401 on any failure. Never reveals why (missing vs bad vs expired).

import { hashToken } from './tokens.js';
import { findLiveSession } from './store.js';

function bearer(req) {
  const h = req.headers.authorization || '';
  const [scheme, value] = h.split(' ');
  return scheme === 'Bearer' && value ? value.trim() : null;
}

export async function requireAuth(req, res, next) {
  try {
    const raw = bearer(req);
    if (!raw) return res.status(401).json({ error: 'Authentication required.' });

    const session = await findLiveSession(hashToken(raw));
    if (!session) return res.status(401).json({ error: 'Invalid or expired token.' });

    req.user = { id: session.userId, email: session.email };
    req.sessionTokenHash = hashToken(raw);
    next();
  } catch (err) {
    next(err);
  }
}
