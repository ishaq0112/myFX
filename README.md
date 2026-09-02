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
  (ECB wins on overlaps). **Scrapes once per day and persists the result**
  (see `store.js`); every request that day is served from storage. Survives any
  single source failing, and falls back to the last stored snapshot if all fail.
- **src/store.js** — persistence layer. Stores the daily snapshot in **Neon**
  (serverless Postgres) via `DATABASE_URL`, with an in-memory fallback if unset.
- **src/rateEngine.js** — converts the merged EUR table into any base currency.
- **server.js** — your public HTTP API.

**Coverage: ~149 currencies** (ECB majors + NBP's long tail of exotic ones).

## Run it

```bash
npm install
npm start
```

Runs out of the box with an **in-memory** store (rates lost on restart). To
**persist** the daily snapshot, add a Neon database — see below.

### Persistence (daily scrape → Neon)

Rates are scraped **once per calendar day (UTC)** and stored; every request that
day is served from the store — no re-scraping. The first visitor of a new day
triggers the next scrape. To keep data across restarts, point it at a
[Neon](https://neon.tech) (serverless Postgres) database:

1. Create a free Neon project and copy its **connection string**.
2. `cp .env.example .env` and paste the string into `DATABASE_URL`.
3. `npm start` — you'll see `Persistence: neon` on boot.

The `rate_snapshots` table is created automatically on first run. `.env` is
gitignored, so your credentials stay out of version control.

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

## Accounts & authentication

Two ways to register — **email/password** or **Sign in with Google** — and a
**verified email is required** either way. Accounts live in Neon. Passwords are
hashed with scrypt (salted, `node:crypto`); logins return an opaque **session
token** — only its SHA-256 hash is stored, sent as `Authorization: Bearer
<token>`. Sessions last 30 days and are revocable. Requires `DATABASE_URL`.

### Email / password

**`POST /auth/signup`** `{ "email", "password" }` — creates an *unverified*
account (password ≥ 8 chars) and emails a verification link. Returns `201`; in
dev mode (no email provider) the response includes `dev_verify_url` and the link
is printed to the server console. `409` if the email is taken.

**`GET /auth/verify?token=…`** — marks the email verified and returns a session
token. Links expire in 24h.

**`POST /auth/resend-verification`** `{ "email" }` — sends a new link (generic
reply, doesn't reveal whether the email exists).

**`POST /auth/login`** `{ "email", "password" }` — returns a session token.
`401` bad credentials, **`403` if the email isn't verified yet**.

### Sign in with Google

**`GET /auth/google`** — redirects to Google's consent screen (open in a
browser). After consent, Google redirects to **`GET /auth/google/callback`**,
which verifies the account (rejects unverified Google emails), creates/links the
user, and returns a session token. If the email matches an existing
password account, the two are linked.

Setup: create an OAuth client in Google Cloud Console and set `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` (and optionally `APP_SECRET`) in `.env`. Redirect URI:
`http://localhost:3000/auth/google/callback`. See `.env.example`.

### Session routes
**`GET /auth/me`** *(Bearer)* — current account. **`POST /auth/logout`**
*(Bearer)* — revokes the token.

## API keys

`/v1/*` requires an **API key**, sent as `X-API-Key: myfx_live_…`. A logged-in
user (session Bearer token) manages their keys. Keys are stored as a SHA-256
hash only, and the full secret is shown **once**, at creation (identify keys
afterward by their `name`/`id`). A key works only while `status = 'active'` and
it hasn't passed its optional `expires_at`.

- **`POST /keys`** *(Bearer)* `{ name?, expires_in_days? }` — create a key.
  Returns the full `key` once, plus its metadata. `expires_in_days` is optional
  (omit for a key that never expires).
- **`GET /keys`** *(Bearer)* — list your keys (name + status + timestamps,
  never the secret).
- **`DELETE /keys/:id`** *(Bearer)* — revoke a key (soft: `status='revoked'`).

```bash
# 1. create a key (needs a session token from /auth/login or /auth/verify)
curl -X POST localhost:3000/keys -H "Authorization: Bearer <session>" \
  -H 'Content-Type: application/json' -d '{"name":"my app"}'
# 2. call the API with it
curl "localhost:3000/v1/latest?base=USD" -H "X-API-Key: myfx_live_..."
```

Statuses: `active` (works) · `suspended` (temporarily off, reversible) ·
`revoked` (permanently off). Usage metering & rate limits build on this next.

> **Notes:** passwords travel in the request body — serve over **HTTPS** in
> production. Email delivery uses Resend when `RESEND_API_KEY` is set, otherwise
> dev-console mode. Still deferred: login rate-limiting and password reset. The
> `/v1/*` rate endpoints remain open — gating them behind per-user **API keys**
> is the next step.

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
1. ✅ **Stage 1:** Working public API + daily scrape persisted to Neon.
2. ✅ **Stage 2:** User accounts & auth → API keys → **usage metering & per-plan
   rate limits/quotas (enforced with 429; see `src/usage/`, `src/plans.js`)**.
3. 🔨 **Stage 3:** Sign-up dashboard ✅ → **Stripe billing (next — the plans and
   quotas are live; wiring real payment is what's left)**.
