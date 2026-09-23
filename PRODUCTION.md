# Encore — production deployment

This edition has **no demo mode**: sign-in codes are never shown on screen, payments are never simulated, and
SMS "log" mode is disabled. Everything below must be in place before real guests and real money.

## 1. Check readiness

```
ENCORE_ENV=production python3 server.py --check
```

It lists what **must be fixed** (the server refuses to start in production until then) and what to **note**.

## 2. Required configuration

| Variable | Value |
| --- | --- |
| `ENCORE_ENV` | `production` |
| `ENCORE_SECRET` | 32+ random bytes, e.g. `python3 -c "import secrets;print(secrets.token_hex(32))"` |
| `DATABASE_URL` | PostgreSQL connection string (recommended). Without it, SQLite in `ENCORE_DATA` — back it up. |
| `PUBLIC_ORIGIN` or `ADMIN_ORIGIN` + `GUEST_ORIGIN` | `https://…` addresses |
| `ENCORE_SINGLE_PORT` | `1` on one-port hosts such as Render (guest at `/`, admin at `/admin`) |
| `TRUST_PROXY` | `1` only behind a trusted proxy that sets `X-Forwarded-For` |
| `SMS_PROVIDER` | a real SMS provider (see §3) |
| `ENCORE_PLATFORM_EMAIL`, `ENCORE_PLATFORM_PASSWORD` | platform console operator (12+ character password), or run `python3 server.py --create-platform-admin` |

Set secrets in your host's secret store. Never commit them.

## 3. Not connected yet — must be completed before launch

These need information only the business can provide. Encore fails closed until they are done.

1. **SMS credentials (guest sign-in).** Providers are built in: `afromessage`, `twilio`, `africastalking`, `geezsms`,
   and a generic `http` gateway. Set `SMS_PROVIDER` and that provider's variables (see README), then prove delivery with
   `python3 server.py --sms-test +2519...`. Until this is done guest sign-in returns "temporarily unavailable".
2. **AfroPay online payments (tickets and wallet payments).** Requires AfroPay's merchant API documentation and
   credentials: payment request, callback/webhook signature verification, status lookup and refunds. Until then
   `/api/checkout` returns `PAYMENT_NOT_CONFIGURED` and no one is charged. Food & drink orders still work with **cash**
   (Settings → Payments), which staff record as paid.

## 4. Deploy on Render

`render.yaml` in this edition creates the web service and PostgreSQL without demo mode.

1. Push this folder to your Git repository and create a **Blueprint** from it (or **Sync** an existing one).
2. In the service's **Environment** tab set `SMS_PROVIDER`, `ENCORE_PLATFORM_EMAIL` and `ENCORE_PLATFORM_PASSWORD`.
   Remove any old `ENCORE_DEMO` variable.
3. **Plans:** use a paid web service (the free plan sleeps when idle; the first request then takes ~30–50 seconds)
   and a paid PostgreSQL plan (free databases expire after 30 days).
4. After deploy: open `/api/health` (expect `"demo": false, "database": "PostgreSQL"`), create the first organizer at
   `/admin/signup`, and sign in to `/admin/platform`.

Other hosts: `Dockerfile` builds both apps; see `deploy/Caddyfile` for HTTPS in front of two ports.

## 5. Operations

- **Backups:** enable PostgreSQL backups (or copy `ENCORE_DATA` daily for SQLite). Uploaded photos are stored in the database.
- **Monitoring:** point an uptime check at `/api/health` (GET or HEAD).
- **Accounts:** organizers keep their one-time recovery code; the platform console can issue a new one (Accounts → Reset password).
- **Fiscal receipts:** Encore receipts are not fiscal receipts. Confirm VAT and receipt obligations with your accountant.
- **Legal:** each organizer publishes terms and privacy in Settings → Terms & privacy; review them before launch.

## 6. Verified in this edition

- 39 automated tests on SQLite and PostgreSQL (accounts, tenant isolation, pricing with VAT and service charge,
  stock, waiters and tips, cash orders, check-in, platform console, suspension, HEAD/robots/gzip).
- Security headers (CSP, HSTS in production, frame and content-type protection), rate-limited sign-in and codes,
  hashed passwords, codes and sessions, server-side pricing, single-use tickets.
