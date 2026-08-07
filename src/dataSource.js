// DATA SOURCE LAYER  (aggregator)
// ------------------------------------------------------------------
// Your product's rates come from MULTIPLE free, official, redistributable
// central-bank feeds, merged into one EUR-based table. Adding a source here
// is the ONLY thing that changes when you widen coverage — the rate engine,
// API, and everything downstream stay identical.
//
// Each source module returns: { name, date, ratesPerEur }
// where ratesPerEur[CUR] = units of CUR per 1 EUR.

import { fetchEcb } from './sources/ecb.js';
import { fetchNbp } from './sources/nbp.js';

// Priority order: an earlier source WINS when two sources cover the same
// currency. ECB first (euro-area authority), then NBP for the long tail.
const SOURCES = [fetchEcb, fetchNbp];

// Rates change ~once per business day, so cache and refresh at most hourly.
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache = null;

/**
 * Fetch every source, merge into one EUR-based rate table.
 * @returns {Promise<{date, rates, provenance, sources}>}
 */
export async function getEuroRates() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  // Fetch all sources at once; a single source failing must NOT take the
  // whole API down — we just use whatever succeeded.
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
    throw new Error('All rate sources failed — no data available.');
  }

  const data = { date, rates, provenance, sources };
  cache = { fetchedAt: Date.now(), data };
  return data;
}

// Quick manual check (Windows-safe):  npm run test:source
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/dataSource.js')) {
  getEuroRates()
    .then((d) => {
      console.log('Sources used:', d.sources.join(', '));
      console.log('Currency count:', Object.keys(d.rates).length);
      console.log('Date:', d.date);
    })
    .catch((e) => {
      console.error('Error:', e.message);
      process.exit(1);
    });
}
