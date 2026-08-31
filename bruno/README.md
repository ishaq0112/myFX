# MyFX API — Bruno collection

Open in [Bruno](https://www.usebruno.com/): **Open Collection → select `bruno/`**.

## Setup
1. Pick the **Local** environment (top-right) — points at `http://localhost:3000`.
2. Start the API: `npm start`.

## Run order (top to bottom)
1. **Health**
2. **Auth → Signup** → captures the dev verify link into `verifyUrl`
3. **Auth → Verify email** → auto-reads that token, verifies, stores session `token`
   *(or **Login** if already verified)*
4. **API Keys → Create key** → needs `token`; stores secret in `apiKey`, id in `keyId`
5. **Rates → Latest / Convert / Currencies** → use `apiKey` via `X-API-Key`
6. **API Keys → List / Revoke** → Revoke uses `keyId`

## Variables (auto-filled by scripts)
`baseUrl` · `token` · `apiKey` · `keyId` · `verifyUrl`

> `/auth/*`, `/keys`, and `/v1/*` need `DATABASE_URL` set on the server.
