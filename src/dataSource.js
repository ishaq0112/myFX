// DATA SOURCE LAYER  (aggregator + daily scrape scheduler)
// ------------------------------------------------------------------
// Rates change ~once per business day. So instead of re-fetching on every
// request, we scrape ONCE PER DAY and persist the result (see store.js).
//
// Flow on each request:
//   1. Look at the latest stored snapshot.
//   2. Was it scraped TODAY (UTC)? -> serve it, no scraping.
//   3. Otherwise -> scrape ECB + NBP, store it (stamped with today), serve it.
// So the first visitor each day triggers the scrape; everyone else is served
// from the database.
//
// Each source module returns: { name, date, ratesPerEur }
// where ratesPerEur[CUR] = units of CUR per 1 EUR.

import { fetchEcb } from './sources/ecb.js';
import { fetchNbp } from './sources/nbp.js';
import { initStore, getLatestSnapshot, saveSnapshot, storeMode } from './store.js';

export { storeMode };

// Priority order: an earlier source WINS when two sources cover the same
// currency. ECB first (euro-area authority), then NBP for the long tail.
const SOURCES = [fetchEcb, fetchNbp];

let ready = null;
/** Ensure the persistence layer is initialized (idempotent). */
export function ensureStore() {
  return (ready ??= initStore());
}

// "Today" is measured in UTC so the day boundary is unambiguous no matter
// where the server or its callers are. (ECB publishes ~16:00 CET on business
// days; before that you'll be served the previous business day's rates.)
const todayUTC = () => new Date().toISOString().slice(0, 10);
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

let inFlight = null; // ensures two same-day requests don't both scrape
// After an all-sources failure we serve the last snapshot and back off for this
// long before hitting upstream again — otherwise every request would re-scrape
// (thundering herd) while ECB/NBP are down.
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;
let retryAfter = 0;

/**
 * Get the merged EUR-based rate table, scraping at most once per calendar day.
 * @returns {Promise<{date, rates, provenance, sources}>}
 */
export async function getEuroRates() {
  await ensureStore();

  const snap = await getLatestSnapshot();
  if (snap && dayOf(snap.scrapedAt) === todayUTC()) {
    return toData(snap); // already scraped today -> serve stored data
  }

  // A recent scrape failed — serve the last snapshot instead of hammering the
  // upstream feeds on every request until the back-off elapses.
  if (snap && Date.now() < retryAfter) {
    return toData(snap);
  }

  // New day (or nothing stored yet). Scrape once; concurrent callers share it.
  if (inFlight) return inFlight;
  inFlight = scrapeAndStore().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Fetch every source, merge into one EUR table, persist, and return it. */
async function scrapeAndStore() {
  // A single source failing must NOT take the whole API down — we use whatever
  // succeeded.
  const settled = await Promise.allSettled(SOURCES.map((fn) => fn()));

  const rates = {};
  const provenance = {}; // CUR -> which source supplied it
  const sources = [];
  let date = null;

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const src = result.value;
    sources.push(src.name);
    if (!date && src.date) date = src.date;

    for (const [code, value] of Object.entries(src.ratesPerEur)) {
      if (!(code in rates)) {
        rates[code] = value; // first source wins (priority order)
        provenance[code] = src.name;
      }
    }
  }

  if (Object.keys(rates).length === 0) {
    // Every source failed. Rather than error out, serve the last snapshot we
    // stored (stale rates beat no rates) and back off so we don't re-scrape on
    // every subsequent request. Only throw if we have nothing at all.
    const prev = await getLatestSnapshot();
    if (prev) {
      retryAfter = Date.now() + FAIL_COOLDOWN_MS;
      return toData(prev);
    }
    throw new Error('All rate sources failed and no stored snapshot exists.');
  }

  // A source can return rates but an unparseable date; data_date is NOT NULL,
  // so fall back to today (UTC) rather than crashing the insert.
  if (!date) date = todayUTC();

  const stored = await saveSnapshot({ dataDate: date, rates, provenance, sources });
  retryAfter = 0; // healthy again — clear any back-off
  return toData(stored);
}

function toData(snap) {
  return {
    date: snap.dataDate,
    rates: snap.rates,
    provenance: snap.provenance,
    sources: snap.sources,
  };
}

// Quick manual check (Windows-safe):  npm run test:source
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/dataSource.js')) {
  getEuroRates()
    .then((d) => {
      console.log('Store mode:', storeMode());
      console.log('Sources used:', d.sources.join(', '));
      console.log('Currency count:', Object.keys(d.rates).length);
      console.log('Feed date:', d.date);
    })
    .catch((e) => {
      console.error('Error:', e.message);
      process.exit(1);
    });
}
