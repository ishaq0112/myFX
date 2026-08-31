// DB CHECK  —  npm run db:check
// ------------------------------------------------------------------
// Confirms persistence is wired up and shows what's currently stored.
// Connects using DATABASE_URL (from .env), then prints the latest snapshot.
//
//   npm run db:check
//
// Exits non-zero if configured for Neon but the connection/query fails, so it
// can double as a deploy/health probe.

import { storeMode, initStore, getLatestSnapshot } from './store.js';

const mode = storeMode();
console.log(`Store mode: ${mode}`);

if (mode === 'memory') {
  console.log('\nNo DATABASE_URL set — running in in-memory mode (nothing persists).');
  console.log('Set DATABASE_URL in .env to persist to Neon, then re-run this check.');
  process.exit(0);
}

try {
  await initStore(); // creates rate_snapshots if missing
  console.log('Connected to Neon ✓  (table ready)');

  const snap = await getLatestSnapshot();
  if (!snap) {
    console.log('\nNo snapshot stored yet.');
    console.log('Start the API and hit an endpoint once to trigger the first daily scrape:');
    console.log('  npm start   ->   http://localhost:3000/v1/latest?base=USD');
    process.exit(0);
  }

  const currencyCount = Object.keys(snap.rates || {}).length;
  const scrapedDay = new Date(snap.scrapedAt).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  console.log('\nLatest stored snapshot:');
  console.log(`  Feed date:      ${snap.dataDate}`);
  console.log(`  Scraped at:     ${snap.scrapedAt}  (${scrapedDay})`);
  console.log(`  Sources:        ${(snap.sources || []).join(', ')}`);
  console.log(`  Currencies:     ${currencyCount}`);
  console.log(`  Fresh today?    ${scrapedDay === today ? 'yes — served from store, no scrape needed' : 'no — next request will re-scrape'}`);

  // A couple of sample rates as a sanity check.
  const sample = ['USD', 'GBP', 'INR', 'JPY']
    .filter((c) => snap.rates && c in snap.rates)
    .map((c) => `${c}=${snap.rates[c]}`)
    .join('  ');
  if (sample) console.log(`  Sample (per EUR): ${sample}`);
} catch (e) {
  console.error('\nDB check FAILED:', e.message);
  if (e.cause?.message) console.error('cause:', e.cause.message);
  console.error('\nCheck that DATABASE_URL in .env is your current Neon connection string.');
  process.exit(1);
}
