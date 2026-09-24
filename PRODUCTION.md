# Encore — production deployment

Everything below must be in place before real guests and real money. There is no demo mode: sign-in codes never appear on screen, and payment is never simulated.

## 1. Check readiness

```
ENCORE_ENV=production npm run check
```

It lists what **must be fixed** (the server refuses to start in production until then) and what to **note**.

## 2. Required configuration

| Variable | Value |
| --- | --- |
| `ENCORE_ENV` | `production` |
| `ENCORE_SECRET` | 32+ random bytes, e.g. `openssl rand -hex 32` |
| `DATABASE_URL` | **Required.** PostgreSQL connection string. Encore has no other database and will not start without it. |
| `PUBLIC_ORIGIN` | the `https://…` address guests and staff use (on Render, `RENDER_EXTERNAL_URL` is used automatically) |
| `TRUST_PROXY` | `1` only behind a trusted proxy that sets `X-Forwarded-For` |
| `SMS_PROVIDER` | a real SMS provider (see §3) |
| `ENCORE_PLATFORM_EMAIL`, `ENCORE_PLATFORM_PASSWORD` | platform console operator (12+ character password), or run `npm run platform-admin` |

Set secrets in your host's secret store (on Render: service → **Environment**). Locally, put them in a `.env` file in
the project folder — Encore reads it at start-up and real environment variables always win. Never commit `.env`.

## 3. Not connected yet — must be completed before launch

These need information only the business can provide. Encore fails closed until they are done.

1. **SMS credentials (guest sign-in).** Providers are built in: `afromessage`, `twilio`, `africastalking`, `geezsms`,
   and a generic `http` gateway. Set `SMS_PROVIDER` and that provider's variables (see README), then prove delivery with
   `npm run sms:test -- +2519...`. Until this is done guest sign-in returns "temporarily unavailable".
2. **AfroPay online payments (tickets and wallet payments).** Requires AfroPay's merchant API documentation and
   credentials: payment request, callback/webhook signature verification, status lookup and refunds. Until then
   `/api/checkout` returns `PAYMENT_NOT_CONFIGURED` and no one is charged. Organizers can take **cash** for orders and
   tickets (Settings → Payments), which staff record as paid.

## 4. Deploy on Render

`render.yaml` creates the Docker web service (Node builds the web apps, .NET 8 runs the API) and PostgreSQL.

1. Push this folder to your Git repository and create a **Blueprint** from it (or **Sync** an existing one).
2. In the service's **Environment** tab set `SMS_PROVIDER` and its credentials, `ENCORE_PLATFORM_EMAIL` and
   `ENCORE_PLATFORM_PASSWORD`. `ENCORE_SINGLE_PORT` is no longer used and can be removed.
3. **First deploy of the .NET server over existing data:** deploy to a staging service with a copy of the database
   first. On start-up it records the existing tables as its baseline migration without changing them; existing
   organizer and platform passwords keep working and are re-hashed at the next sign-in.
4. **Plans:** use a paid web service (the free plan sleeps when idle; the first request then takes ~30–50 seconds)
   and a paid PostgreSQL plan (free databases expire after 30 days).
5. After deploy: open `/api/health` (expect `"database": "PostgreSQL (…)"` and `"sms": true`), create the first
   organizer at `/admin/signup`, and sign in to `/admin/platform`.

Other hosts: `Dockerfile` builds everything into one image listening on `PORT` (default 8080); see `deploy/Caddyfile` for HTTPS in front of it.

**Rolling back:** the previous (Python) release on `main` reads the same tables. Passwords re-hashed by the .NET server
since the switch use a format it does not understand; those people would use **Forgot password?** after a rollback.

## 5. Operations

- **Backups:** enable PostgreSQL backups — it holds every record and uploaded image. If `ENCORE_SECRET` is not set, also keep `secret.key` from `ENCORE_DATA`.
- **Monitoring:** point an uptime check at `/api/health` (GET or HEAD).
- **Accounts:** organizers keep their one-time recovery code; the platform console can issue a new one (Accounts → Reset password).
- **Fiscal receipts:** Encore receipts are not fiscal receipts. Confirm VAT and receipt obligations with your accountant.
- **Legal:** each organizer publishes terms and privacy in Settings → Terms & privacy; review them before launch.

## 6. Verified in this edition

- `npm test`: the .NET suite on PostgreSQL — HTTP journeys (accounts, roles, tenant isolation, pricing with VAT and
  service charge, stock, waiters and tips, cash orders, check-in, platform console, suspension, HEAD/robots/gzip,
  SMS fail-closed and provider-verified codes), SMS provider requests, and golden cases recorded from the original
  Python rules (941 pricing and input cases, 30 scenarios of 60 staff actions and guest orders).
- A published build run in production mode: security headers (CSP, HSTS, frame and content-type protection), Secure
  cookies, origin checks, fail-closed SMS.
- Not yet verified: the Docker image itself (no Docker was available where this was built) and a deploy on Render.
