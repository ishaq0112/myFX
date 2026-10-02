// USAGE PERSISTENCE  (in Neon)
// ------------------------------------------------------------------
// One row per (user, day, endpoint). We aggregate on read to get month-to-date
// totals, today's count, and the per-endpoint breakdown the dashboard shows.
// Daily granularity keeps one table while still answering "today" and "this
// month". Quotas are per-user (all of a user's keys share the plan quota).

import { sql, hasDb } from '../db.js';
import { initAuth } from '../auth/store.js';
import { initKeys } from '../keys/store.js';

let initDone = null;

// The Activity Log only shows recent calls, so request_log keeps each user's
// newest rows and an hourly prune trims the rest (see pruneRequestLog).
const LOG_KEEP_PER_USER = 200;

export function initUsage() {
  if (initDone) return initDone;
  initDone = (async () => {
    if (!hasDb) return;
    await initAuth(); // usage_daily references users(id)
    await sql`
      CREATE TABLE IF NOT EXISTS usage_daily (
        user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day      DATE NOT NULL,
        endpoint TEXT NOT NULL,
        count    BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day, endpoint)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS usage_daily_user_day_idx ON usage_daily (user_id, day)`;

    // Per-call log for the dashboard's Activity Log (status, latency, which key).
    await initKeys(); // request_log.key_id references api_keys(id)
    await sql`
      CREATE TABLE IF NOT EXISTS request_log (
        id          BIGSERIAL PRIMARY KEY,
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_id      UUID REFERENCES api_keys(id) ON DELETE SET NULL,
        path        TEXT NOT NULL,
        params      TEXT,
        status      SMALLINT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS request_log_user_id_idx ON request_log (user_id, id DESC)`;

    // Daily outcome counters for the error rate. Unlike usage_daily (served
    // calls only, for quotas), this counts every call that reached a valid key,
    // including 429 rejections.
    await sql`
      CREATE TABLE IF NOT EXISTS outcome_daily (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day     DATE NOT NULL,
        total   BIGINT NOT NULL DEFAULT 0,
        failed  BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
      )`;
  })();
  return initDone;
}

/** Increment today's counter for one endpoint (upsert). */
export async function recordCall(userId, endpoint) {
  await sql`
    INSERT INTO usage_daily (user_id, day, endpoint, count)
    VALUES (${userId}, CURRENT_DATE, ${endpoint}, 1)
    ON CONFLICT (user_id, day, endpoint)
    DO UPDATE SET count = usage_daily.count + 1`;
}

/** Record one finished /v1 call: append it to request_log and bump today's
 *  outcome counters. One round trip (data-modifying CTE). */
export async function recordOutcome({ userId, keyId, path, params, status, durationMs }) {
  const failed = status >= 400 ? 1 : 0;
  await sql`
    WITH logged AS (
      INSERT INTO request_log (user_id, key_id, path, params, status, duration_ms)
      VALUES (${userId}, ${keyId ?? null}, ${path}, ${params}, ${status}, ${durationMs})
    )
    INSERT INTO outcome_daily (user_id, day, total, failed)
    VALUES (${userId}, CURRENT_DATE, 1, ${failed})
    ON CONFLICT (user_id, day)
    DO UPDATE SET total = outcome_daily.total + 1, failed = outcome_daily.failed + EXCLUDED.failed`;
}

/** Trim request_log to each user's newest LOG_KEEP_PER_USER rows. */
export async function pruneRequestLog() {
  if (!hasDb) return;
  await sql`
    DELETE FROM request_log r
    USING (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY id DESC) AS rn
        FROM request_log
      ) ranked
      WHERE rn > ${LOG_KEEP_PER_USER}
    ) old
    WHERE r.id = old.id`;
}

/** The user's most recent calls, newest first, with the key's name. */
export async function recentActivity(userId, limit = 5) {
  const n = Math.max(1, Math.min(50, Number(limit) || 5));
  const rows = await sql`
    SELECT r.path, r.params, r.status, r.duration_ms, r.created_at, k.name AS key_name
    FROM request_log r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.user_id = ${userId}
    ORDER BY r.id DESC
    LIMIT ${n}`;
  return rows.map((r) => ({
    path: r.path,
    params: r.params,
    status: Number(r.status),
    duration_ms: Number(r.duration_ms),
    key_name: r.key_name ?? null,
    created_at: r.created_at,
  }));
}

/** Month-to-date request total for a user (used for quota enforcement). */
export async function monthToDateTotal(userId) {
  const rows = await sql`
    SELECT COALESCE(SUM(count), 0) AS total
    FROM usage_daily
    WHERE user_id = ${userId} AND day >= date_trunc('month', CURRENT_DATE)`;
  return Number(rows[0].total);
}

/** Requests per day for the last N days (oldest→newest), zero-filled for quiet
 *  days via generate_series, so the chart always has a continuous line. */
export async function dailySeries(userId, days = 30) {
  const n = Math.max(2, Math.min(90, Number(days) || 30));
  const rows = await sql`
    SELECT to_char(gd, 'YYYY-MM-DD') AS day, COALESCE(SUM(u.count), 0) AS count
    FROM generate_series(CURRENT_DATE - make_interval(days => ${n - 1}), CURRENT_DATE, INTERVAL '1 day') gd
    LEFT JOIN usage_daily u ON u.day = gd::date AND u.user_id = ${userId}
    GROUP BY gd
    ORDER BY gd`;
  return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}

/** Full summary for the dashboard: this month, today, the per-endpoint split,
 *  the same span of last month (for the trend), and this month's outcomes. */
export async function usageSummary(userId) {
  const [monthRows, todayRows, prevRows, outRows] = await Promise.all([
    sql`
      SELECT endpoint, COALESCE(SUM(count), 0) AS c
      FROM usage_daily
      WHERE user_id = ${userId} AND day >= date_trunc('month', CURRENT_DATE)
      GROUP BY endpoint`,
    sql`
      SELECT COALESCE(SUM(count), 0) AS c
      FROM usage_daily
      WHERE user_id = ${userId} AND day = CURRENT_DATE`,
    // Last month from day 1 to today's day-of-month, clamped to that month's
    // length (e.g. on Mar 30 it compares against Feb 1-28).
    sql`
      WITH b AS (
        SELECT date_trunc('month', CURRENT_DATE)::date AS m0,
               (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date AS p0
      )
      SELECT COALESCE(SUM(u.count), 0) AS c
      FROM usage_daily u, b
      WHERE u.user_id = ${userId}
        AND u.day >= b.p0
        AND u.day <= LEAST(b.p0 + (CURRENT_DATE - b.m0), b.m0 - 1)`,
    sql`
      SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(failed), 0) AS failed
      FROM outcome_daily
      WHERE user_id = ${userId} AND day >= date_trunc('month', CURRENT_DATE)`,
  ]);

  const byEndpoint = { latest: 0, convert: 0, currencies: 0 };
  let month = 0;
  for (const r of monthRows) {
    const c = Number(r.c);
    if (r.endpoint in byEndpoint) byEndpoint[r.endpoint] = c;
    month += c;
  }
  return {
    month,
    today: Number(todayRows[0].c),
    byEndpoint,
    previous: Number(prevRows[0].c),
    outcomes: { total: Number(outRows[0].total), failed: Number(outRows[0].failed) },
  };
}
