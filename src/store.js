// PERSISTENCE LAYER  (daily rate snapshots)
// ------------------------------------------------------------------
// Rates change ~once per business day, so we scrape once a day and STORE the
// result. Every request that day is served from storage — no re-scraping.
//
// Primary store: Neon (serverless Postgres) via DATABASE_URL.
// Fallback:      in-memory (if DATABASE_URL is unset) so the app still runs
//                locally before Neon is wired up. Fallback data is lost on
//                restart — set DATABASE_URL to persist.
//
// One row per feed date:
//   data_date (PK) | rates(jsonb) | provenance(jsonb) | sources(jsonb) | scraped_at

import { sql, hasDb } from './db.js';

let mem = { snap: null }; // in-memory fallback snapshot
let initDone = null;

/** 'neon' when persisting to Postgres, 'memory' when using the fallback. */
export function storeMode() {
  return hasDb ? 'neon' : 'memory';
}

/** Create the table if needed (Neon only). Safe to call repeatedly. */
export function initStore() {
  if (initDone) return initDone;
  initDone = (async () => {
    if (!hasDb) return;
    await sql`
      CREATE TABLE IF NOT EXISTS rate_snapshots (
        data_date  DATE PRIMARY KEY,
        rates      JSONB NOT NULL,
        provenance JSONB,
        sources    JSONB,
        scraped_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
  })();
  return initDone;
}

/** Most recently scraped snapshot, or null if none stored yet. */
export async function getLatestSnapshot() {
  if (!hasDb) return mem.snap;
  const rows = await sql`
    SELECT data_date, rates, provenance, sources, scraped_at
    FROM rate_snapshots
    ORDER BY scraped_at DESC
    LIMIT 1`;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    dataDate: toDateStr(r.data_date),
    rates: asObj(r.rates),
    provenance: asObj(r.provenance),
    sources: asObj(r.sources),
    scrapedAt: r.scraped_at, // ISO string from Neon
  };
}

/** Store today's snapshot. Upserts on data_date (re-scraping the same feed
 *  date just refreshes scraped_at). Returns the stored snapshot. */
export async function saveSnapshot(snap) {
  if (!hasDb) {
    mem.snap = { ...snap, scrapedAt: new Date().toISOString() };
    return mem.snap;
  }
  await sql`
    INSERT INTO rate_snapshots (data_date, rates, provenance, sources, scraped_at)
    VALUES (
      ${snap.dataDate},
      ${JSON.stringify(snap.rates)}::jsonb,
      ${JSON.stringify(snap.provenance)}::jsonb,
      ${JSON.stringify(snap.sources)}::jsonb,
      now()
    )
    ON CONFLICT (data_date) DO UPDATE SET
      rates      = EXCLUDED.rates,
      provenance = EXCLUDED.provenance,
      sources    = EXCLUDED.sources,
      scraped_at = now()`;
  return { ...snap, scrapedAt: new Date().toISOString() };
}

// Postgres DATE can come back as a Date or a 'YYYY-MM-DD' string — normalize.
function toDateStr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// jsonb may arrive parsed (object) or raw (string) depending on driver config.
function asObj(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}
