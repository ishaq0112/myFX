// YOUR PUBLIC API  (Stage 1 — no keys/billing yet)
// ------------------------------------------------------------------
// This is the product your customers consume. It serves live exchange
// rates as JSON, branded as YOUR service, sourced from the ECB feed.
//
// Start:  npm start
//
// Endpoints:
//   GET /v1/latest?base=USD              -> all rates relative to base
//   GET /v1/convert?from=USD&to=INR&amount=100
//   GET /health                          -> uptime/status check

import express from 'express';
import { getRates, convert } from './src/rateEngine.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Your product's brand name — change this to whatever you'll sell it as.
const PROVIDER = 'MyFX';

// GET /v1/latest?base=USD  -> every currency relative to `base`
app.get('/v1/latest', async (req, res) => {
  try {
    const { base = 'USD' } = req.query;
    const data = await getRates(base);
    res.json({
      provider: PROVIDER,
      source: 'European Central Bank',
      ...data, // base, date, rates
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
    res.json({ provider: PROVIDER, source: 'European Central Bank', ...data });
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
      currencies: Object.keys(rates).sort(),
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
    },
  });
});

app.listen(PORT, () => {
  console.log(`${PROVIDER} API running at http://localhost:${PORT}`);
  console.log(`Try: http://localhost:${PORT}/v1/latest?base=USD`);
});
