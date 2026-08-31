// RATE ENGINE
// ------------------------------------------------------------------
// The ECB gives us EUR-based rates only. But your customers will ask for
// USD, INR, GBP, etc. as their base. This module does the "cross-rate"
// math so any currency can be the base.
//
// Cross-rate formula:
//   rate(BASE -> TARGET) = eurRate[TARGET] / eurRate[BASE]
// Example (base USD -> INR):
//   eurRate[INR] / eurRate[USD]

import { getEuroRates } from './dataSource.js';

/**
 * Get all rates relative to a chosen base currency.
 * @param {string} base  3-letter code, e.g. "USD" (default "USD").
 * @returns {Promise<{base, date, rates}>}
 */
export async function getRates(base = 'USD') {
  const code = String(base).toUpperCase().trim();
  const { date, rates: eur, sources } = await getEuroRates();

  if (!(code in eur)) {
    throw new Error(`Unsupported base currency: "${code}".`);
  }

  const baseRate = eur[code];
  const rates = {};
  for (const [cur, r] of Object.entries(eur)) {
    // Round to 6 significant-ish decimals to avoid floating-point noise.
    rates[cur] = Math.round((r / baseRate) * 1e6) / 1e6;
  }

  return { base: code, date, count: Object.keys(rates).length, sources, rates };
}

/**
 * Convert a specific amount from one currency to another.
 * @param {number} amount
 * @param {string} from  source currency (default "USD")
 * @param {string} to    target currency
 */
export async function convert(amount, from = 'USD', to) {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid amount: "${amount}" is not a number.`);
  }

  const fromCode = String(from).toUpperCase().trim();
  const toCode = String(to).toUpperCase().trim();
  const { date, rates: eur, sources } = await getEuroRates();

  if (!(fromCode in eur)) throw new Error(`Unsupported currency: "${fromCode}".`);
  if (!(toCode in eur)) throw new Error(`Unsupported currency: "${toCode}".`);

  const rate = eur[toCode] / eur[fromCode];
  return {
    from: fromCode,
    to: toCode,
    amount: value,
    rate: Math.round(rate * 1e6) / 1e6,
    result: Math.round(value * rate * 100) / 100,
    date,
    sources,
  };
}
