# MyFX — To-do / later

Running list of deferred work. Done items live in the code + README.

## P0 — launch blockers
- [ ] **Dodo Payments** — *parked until go-ahead.* Checkout, a webhook that
      updates the user's `plan`, and wiring the Billing buttons that still only
      show a toast: *Choose Business*, *Downgrade to Free*, *Update* card. Plans,
      quotas, and per-plan limits are already live.
- [ ] **Deployment** — hosting with HTTPS and a domain. Set `APP_URL` to the
      real address, and enable Express `trust proxy` so the per-IP login limit
      sees the real client IP behind the proxy.
- [ ] **Email for real customers** — *Resend is live locally
      (`RESEND_API_KEY` set; tested end-to-end) but in testing mode: the default
      `onboarding@resend.dev` sender only delivers to the Resend account's own
      email.* To open it up: verify a domain in Resend, set
      `MAIL_FROM=MyFX <noreply@yourdomain.com>`, and swap the onboarding
      (full-access) key for a **Sending access** key. Shares the domain with
      deployment, so do them together.

## Dashboard
- [ ] **Sideways scroll at ~1070px wide** — the Quick Actions card on the
      Overview gets cut off and the page scrolls horizontally.

## Deferred — auth
- [ ] **Google sign-in setup** — *code is already built and tested; just needs
      credentials.* Create an OAuth client in Google Cloud Console, add
      `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (+ `APP_SECRET`) to `.env`,
      redirect URI `http://localhost:3000/auth/google/callback`. Then
      `/auth/google` goes live. Until then it returns 503 (harmless).

## Housekeeping
- [ ] **Docs base URL** — `https://api.myfx.dev` is a placeholder; update it
      once the real domain exists.
- [ ] **Test accounts** — old ones like `me@test.com` predate email
      verification and are `unverified` (403 on login); plus throwaway
      `reset_*`, `uiflow_*`, and `deeplink_*` accounts created while testing.
      Delete them.

## Done
- [x] Stage 1: public FX API (ECB + NBP), daily scrape persisted to Neon.
- [x] Email/password accounts + sessions (scrypt, revocable Bearer tokens).
- [x] Email verification required before login.
- [x] Password reset — "forgot password" flow: emailed single-use 1h token,
      revokes existing sessions on reset (`/auth/forgot-password`, `/auth/reset-password`).
- [x] Delete account — `DELETE /auth/me`, type-your-email confirmation, cascades
      to sessions/API keys/usage/tokens.
- [x] Google OAuth **code** (pending credentials above to activate).
- [x] UUID primary keys for users.
- [x] API keys: create/list/revoke, `/v1/*` gated behind `X-API-Key`.
- [x] Login rate-limiting — brute-force throttle by email + IP (`src/auth/loginLimiter.js`).
- [x] Usage metering + per-plan quotas/rate limits (enforced with 429),
      `/usage` endpoint, dashboard wired to real usage (`src/usage/`, `src/plans.js`).
- [x] Email delivery via Resend (testing mode; see P0 for going live).
- [x] Overview wired to real data: error rate (`outcome_daily`), month-over-month
      trend, and the Activity Log (`request_log`, newest 200 calls per user,
      `GET /usage/activity`).
- [x] Rotated the Neon password (it was exposed in plaintext during setup).
- [x] Settings wired: save name (`PATCH /auth/me`), change password (signs out
      other devices), and two-factor auth with an authenticator app: QR setup,
      10 recovery codes, a code step at login, and the same gate on password
      reset, email verification, and Google (`src/auth/totp.js`).
