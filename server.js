// YOUR PUBLIC API
// ------------------------------------------------------------------
// This is the product your customers consume. It serves live exchange rates as
// JSON, branded as YOUR service, sourced from the ECB + NBP feeds.
//
// Start:  npm start
//
// Endpoints:
//   GET  /v1/latest?base=USD             -> all rates relative to base  (needs API key)
//   GET  /v1/convert?from=USD&to=INR&amount=100                         (needs API key)
//   GET  /v1/currencies                  -> supported currency list     (needs API key)
//   POST /auth/signup | /auth/login ...  -> accounts (see src/auth)
//   POST /keys | GET /keys | DELETE ...  -> API keys (see src/keys)
//   GET  /health                         -> uptime/status check

import express from 'express';
import { getRates, convert } from './src/rateEngine.js';
import { CURRENCY_NAMES } from './src/currencyNames.js';
import { ensureStore, storeMode } from './src/dataSource.js';
import authRouter from './src/auth/routes.js';
import { initAuth, authAvailable } from './src/auth/store.js';
import { googleConfigured } from './src/auth/google.js';
import { mailerMode } from './src/auth/mailer.js';
import keysRouter from './src/keys/routes.js';
import { initKeys } from './src/keys/store.js';
import { requireApiKey } from './src/keys/middleware.js';
import usageRouter from './src/usage/routes.js';
import { initUsage } from './src/usage/store.js';
import { meterUsage } from './src/usage/middleware.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Your product's brand name — change this to whatever you'll sell it as.
const PROVIDER = 'MyFX';

app.use(express.json()); // parse JSON request bodies (for /auth/*)
app.use('/app', express.static('web')); // dashboard SPA, served same-origin
app.use(authRouter); // /auth/signup, /auth/login, /auth/logout, /auth/me
app.use(keysRouter); // /keys (create/list/revoke) — session-protected
app.use(usageRouter); // /usage — session-protected (this month's metered usage)

// Everything under /v1/* requires a valid API key (X-API-Key header), then is
// metered: per-minute rate limit + monthly quota (429 when exceeded).
app.use('/v1', requireApiKey, meterUsage);

// GET /v1/latest?base=USD  -> every currency relative to `base`
app.get('/v1/latest', async (req, res) => {
  try {
    const { base = 'USD' } = req.query;
    const data = await getRates(base);
    res.json({
      provider: PROVIDER,
      source: data.sources?.join(' + ') || 'unknown', // reflects the live source set
      ...data, // base, date, count, sources, rates
    });
  } catch (err) {
    res.status(400).json({ provider: PROVIDER, error: err.message });
  }
});

// GET /v1/convert?from=USD&to=INR&amount=100  -> single conversion
app.get('/v1/convert', async (req, res) => {
  try {
    const { from = 'USD', to, amount = 1 } = req.query;
    if (!to) {
      return res.status(400).json({ provider: PROVIDER, error: 'Query param "to" is required.' });
    }
    const data = await convert(amount, from, to);
    res.json({ provider: PROVIDER, source: data.sources?.join(' + ') || 'unknown', ...data });
  } catch (err) {
    res.status(400).json({ provider: PROVIDER, error: err.message });
  }
});

// GET /v1/currencies  -> the full list of currencies your API supports
app.get('/v1/currencies', async (_req, res) => {
  try {
    const { rates, sources } = await getRates('EUR');
    res.json({
      provider: PROVIDER,
      count: Object.keys(rates).length,
      sources,
      currencies: Object.keys(rates).sort().map((c) => ({ code: c, name: CURRENCY_NAMES[c] || null })),
    });
  } catch (err) {
    res.status(500).json({ provider: PROVIDER, error: err.message });
  }
});

// Simple health check (useful once you deploy this).
app.get('/health', (_req, res) => {
  res.json({ provider: PROVIDER, status: 'ok' });
});

// Landing info at the root.
app.get('/', (_req, res) => {
  res.json({
    provider: PROVIDER,
    message: 'Live exchange-rate API.',
    endpoints: {
      latest: '/v1/latest?base=USD',
      convert: '/v1/convert?from=USD&to=INR&amount=100',
      currencies: '/v1/currencies',
      signup: 'POST /auth/signup',
      login: 'POST /auth/login',
      me: 'GET /auth/me',
    },
  });
});

// Error handler — catches malformed JSON bodies and any thrown route errors.
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ provider: PROVIDER, error: 'Invalid JSON body.' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ provider: PROVIDER, error: 'Internal server error.' });
});

app.listen(PORT, async () => {
  console.log(`${PROVIDER} API running at http://localhost:${PORT}`);
  try {
    await ensureStore();
    console.log(`Persistence: ${storeMode()}${storeMode() === 'memory' ? ' (set DATABASE_URL to persist to Neon)' : ' (Neon)'}`);
    if (authAvailable()) {
      await initAuth();
      await initKeys();
      await initUsage();
      console.log('Auth: ready (email/password + verification)');
      console.log(`  Google sign-in: ${googleConfigured() ? 'enabled' : 'not configured (set GOOGLE_CLIENT_ID/SECRET)'}`);
      console.log(`  Email delivery: ${mailerMode() === 'resend' ? 'Resend' : 'dev console (links logged here)'}`);
      console.log('  API keys: ready (/keys) — /v1/* now requires X-API-Key');
      console.log('  Usage metering: on — per-plan quota + rate limit enforced (/usage)');
    } else {
      console.log('Auth: disabled (set DATABASE_URL to enable accounts)');
    }
  } catch (err) {
    console.error('Store init failed:', err.message);
  }
  console.log(`Try: http://localhost:${PORT}/v1/latest?base=USD`);
});
