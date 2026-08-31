// SHARED DB CLIENT
// ------------------------------------------------------------------
// One Neon (serverless Postgres) client, shared by every module that needs
// persistence (rate snapshots, users, sessions, later: API keys & usage).
//
// The Neon HTTP driver is stateless, so a single `sql` tagged-template is all
// we need. If DATABASE_URL is unset, `sql` is null and `hasDb` is false —
// callers decide how to degrade (rate store falls back to memory; auth, which
// is meaningless without persistence, returns a clear "not configured" error).

import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;

export const hasDb = Boolean(url);
export const sql = hasDb ? neon(url) : null;
