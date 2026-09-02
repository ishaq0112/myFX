# MyFX — To-do / later

Running list of deferred work. Done items live in the code + README.

## Deferred — auth
- [ ] **Google sign-in setup** — *code is already built and tested; just needs
      credentials.* Create an OAuth client in Google Cloud Console, add
      `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (+ `APP_SECRET`) to `.env`,
      redirect URI `http://localhost:3000/auth/google/callback`. Then
      `/auth/google` goes live. Until then it returns 503 (harmless).
- [ ] **Real email delivery** — currently dev-console mode (verification links
      are logged / returned as `dev_verify_url`). Set `RESEND_API_KEY` +
      `MAIL_FROM` in `.env` to send real emails.
- [ ] **Login rate-limiting** — throttle repeated failed logins (brute-force).
- [ ] **Password reset** — "forgot password" flow (email a reset link).

## Next feature (Stage 3)
- [ ] **Stripe billing** — wire real payment + let a plan change move the user's
      `plan` column. The plans, quotas, and per-plan limits are already live.

## Housekeeping
- [ ] **Rotate the Neon password** — it was exposed in plaintext during setup.
      Reset it in the Neon dashboard and update `DATABASE_URL` in `.env`.
- [ ] **Existing test accounts** (e.g. `me@test.com`) predate email verification
      and are now `unverified` → 403 on login. Re-signup, use
      `/auth/resend-verification`, or mark them verified.

## Done
- [x] Stage 1: public FX API (ECB + NBP), daily scrape persisted to Neon.
- [x] Email/password accounts + sessions (scrypt, revocable Bearer tokens).
- [x] Email verification required before login.
- [x] Google OAuth **code** (pending credentials above to activate).
- [x] UUID primary keys for users.
- [x] API keys: create/list/revoke, `/v1/*` gated behind `X-API-Key`.
- [x] Usage metering + per-plan quotas/rate limits (enforced with 429),
      `/usage` endpoint, dashboard wired to real usage (`src/usage/`, `src/plans.js`).
