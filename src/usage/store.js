// USAGE PERSISTENCE  (in Neon)
// ------------------------------------------------------------------
// One row per (user, day, endpoint). We aggregate on read to get month-to-date
// totals, today's count, and the per-endpoint breakdown the dashboard shows.
// Daily granularity keeps one table while still answering "today" and "this
// month". Quotas are per-user (all of a user's keys share the plan quota).

import { sql, hasDb } from '../db.js';
import { initAuth } from '../auth/store.js';

let initDone = null;

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

/** Full summary for the dashboard: this month, today, and the per-endpoint split. */
export async function usageSummary(userId) {
  const monthRows = await sql`
    SELECT endpoint, COALESCE(SUM(count), 0) AS c
    FROM usage_daily
    WHERE user_id = ${userId} AND day >= date_trunc('month', CURRENT_DATE)
    GROUP BY endpoint`;
  const todayRows = await sql`
    SELECT COALESCE(SUM(count), 0) AS c
    FROM usage_daily
    WHERE user_id = ${userId} AND day = CURRENT_DATE`;

  const byEndpoint = { latest: 0, convert: 0, currencies: 0 };
  let month = 0;
  for (const r of monthRows) {
    const c = Number(r.c);
    if (r.endpoint in byEndpoint) byEndpoint[r.endpoint] = c;
    month += c;
  }
  return { month, today: Number(todayRows[0].c), byEndpoint };
}
