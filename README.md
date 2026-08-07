# MyFX — Your Own Exchange-Rate API

A live currency-rate API **you own and operate**. It pulls official daily
reference rates from the European Central Bank (ECB), computes rates for any
base currency, and serves them as JSON under your brand. No third-party API
key required — *you* are the provider.

> **Stage 1** of the product: a working public API. API keys, usage metering,
> and billing come in later stages.

## Architecture

```
  ┌ ECB feed  (EUR-based, ~30) ┐
  │ NBP feed  (PLN-based, ~140)│─► dataSource.js ─► rateEngine.js ─► server.js ─► customers
  └ (add more central banks…) ─┘   fetch+merge       cross-rate math   your API      (JSON)
```

- **src/sources/** — one file per central-bank feed. Each normalizes its data
  to "units per 1 EUR". **Adding a source = adding one file here.**
- **src/dataSource.js** — fetches all sources in parallel and merges them
  (ECB wins on overlaps). Caches hourly. Survives any single source failing.
- **src/rateEngine.js** — converts the merged EUR table into any base currency.
- **server.js** — your public HTTP API.

**Coverage: ~149 currencies** (ECB majors + NBP's long tail of exotic ones).

## Run it

```bash
npm install
npm start
```

Then open:

```
http://localhost:3000/v1/latest?base=USD
http://localhost:3000/v1/convert?from=USD&to=INR&amount=100
http://localhost:3000/v1/currencies
```

## Endpoints

### `GET /v1/latest?base=USD`
All supported currencies relative to `base`.
```json
{
  "provider": "MyFX",
  "source": "European Central Bank",
  "base": "USD",
  "date": "2026-08-06",
  "rates": { "EUR": 0.917, "USD": 1, "INR": 83.12, "GBP": 0.78 }
}
```

### `GET /v1/convert?from=USD&to=INR&amount=100`
A single conversion.
```json
{
  "provider": "MyFX",
  "source": "European Central Bank",
  "from": "USD",
  "to": "INR",
  "amount": 100,
  "rate": 83.12,
  "result": 8312,
  "date": "2026-08-06"
}
```

## Data & limitations
- **Sources:** ECB + National Bank of Poland — both official, free, and
  redistributable. ECB provides major currencies; NBP adds ~110 exotic ones.
- **Coverage:** ~149 currencies. See `/v1/currencies` for the live list.
- **Update frequency:** once per business day. Cached hourly.
- These are **reference/mid-market rates**, not live trading rates. For
  real-time rates, add or swap a licensed real-time feed in `src/sources/`
  later — the rest of the system stays the same.

## Adding another source
1. Create `src/sources/yourbank.js` exporting a function that returns
   `{ name, date, ratesPerEur }` (normalize its data to units per 1 EUR).
2. Add it to the `SOURCES` array in `src/dataSource.js` (order = priority).
That's it — coverage widens with zero changes anywhere else.

## Roadmap (next stages)
1. ✅ **Stage 1:** Working public API (this).
2. ⏭ **Stage 2:** API keys + per-customer usage metering & rate limits.
3. ⏭ **Stage 3:** Sign-up dashboard + Stripe billing (a sellable product).
