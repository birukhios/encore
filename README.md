# Encore concert platform

Two separate web apps backed by one Python/SQLite server:

| App | Default address | Who |
| --- | --- | --- |
| Organizer admin | http://127.0.0.1:8081/admin | Owners, admins, service and gate staff (email + password) |
| Guest web app | http://127.0.0.1:8082/ | Concert guests (mobile number + SMS code) |

Each port serves only its own app and API routes; admin sessions never work on the guest port and vice versa.

## Run locally

Needs Python 3.11+ (macOS's built-in `python3` 3.9 is not enough — the launcher finds a newer one automatically or tells you how to install it).

```
python3 launch.py
```

or double-click `Start_Encore.command` on a Mac. `dist/` must be built (`npm install && npm run build`, Node 20+).

- **Development with hot reload:** `npm run dev` → admin http://127.0.0.1:5173/admin, guest http://127.0.0.1:5174/
- **Tests:** `npm test` (21 integration tests, disposable database)
- **Build:** `npm run build`

There are no default accounts. Create a workspace at `/admin/signup` and save the one-time recovery code.

In development, SMS messages (sign-in codes, booking and order updates) are **printed in the server terminal and not delivered**.

## Features

**Organizer admin**
- Accounts with scrypt passwords, server sessions, recovery codes, password change, invitations, member removal, Owner/Admin/Service/Gate roles enforced on the server, tenant isolation, optimistic concurrency.
- Events with cover uploads, capacity tracking, publish/draft, delete when unused.
- Menu items with photos, categories, availability, and *served at*: all concerts or selected concerts.
- Tables bound to a concert with a permanent unguessable QR token and a 6-character code for manual entry; printable QR.
- Bookings: filters, record in-person payment, check in all, **scan ticket QR** (camera or pasted code, one use per ticket).
- Orders: Placed → Preparing → Ready → Delivered, record payment, cancel. Guests are notified at each step.
- Notification bell for new bookings and orders.
- **Settings** — Workspace (name, description, currency, guest link) · Appearance (accent color with contrast check, guest light/dark/system mode, logo, cover, live preview) · Ticketing (on/off, max per order, show remaining) · Table ordering (on/off, require scan, ticket holders only, per-concert menus) · Tips (on/off, presets, custom) · Payments (pay at venue, AfroPay status) · Notifications (SMS toggles, delivery status) · Help & support (email, phone, hours, FAQ editor) · Terms & privacy.

**Guest app (mobile-first)**
- Sign up / sign in with mobile number and 6-digit SMS code (Ethiopian formats and international E.164). New guests give a name and accept terms. 30-day session.
- Browse events → reserve tickets → review → *Reserve · pay at the venue*. Each ticket has its own QR code.
- Menu shows the menus of concerts the guest holds tickets for. Ordering requires **scanning the table QR** (camera) or typing the table code; the table's concert decides the menu. Organizers can restrict ordering to ticket holders.
- Bag with optional tips (never preselected), checkout, receipt with private link.
- Tickets & orders with live progress; notifications screen with unread badge (in-app always, SMS when enabled and configured).
- Account, Help & support (organizer contacts + FAQ + platform FAQ), Terms & conditions, Privacy.
- Organizer branding and dark mode applied.

## Organizer profile, menu categories and Ethiopian tax

- **Location & photos** (Settings): city, address, map link and up to 12 photos. The guest organizer list shows the first photo, logo, location and upcoming events; the organizer page shows the address, a Directions button and a photo gallery.
- **Menu categories** (Settings): add, rename (updates items), reorder and remove (only when empty). Menu items must use a configured category; guests see categories in this order.
- **Taxes (VAT/TOT)** (Settings): VAT-registered (15% standard rate), turnover tax (TOT, configurable rate) or no tax; prices tax-inclusive or tax added at checkout; apply to tickets and/or menu orders; TIN (10 digits) and VAT registration number. Tax is calculated on the server, shown in the booking sheet, bag, checkout, receipts and staff order queue. Tips are never taxed. Encore receipts are **not fiscal receipts** and this is not tax advice — organizers should confirm registration, rates and receipt obligations with the Ministry of Revenues or an accountant.

## Appearance

Organizers choose the default look in Settings → Appearance (guest app and dashboard separately: Light, Black, or follow the device). Anyone can also flip light/dark for themselves with the ☾/☀ button in either app's header; that choice is remembered on their device.

## Payments — online payments are not live

AfroPay is **not integrated**; no provider API was invented. `POST /api/checkout` always fails with `PAYMENT_NOT_CONFIGURED`. The only way to reserve is **pay at the venue**: records are created unpaid, staff collect payment in person and record it. Nothing is ever marked paid by the guest or by the payment screen. To integrate AfroPay, supply the merchant API documentation (checkout creation, verification, webhook signatures, refunds).

## SMS — provider not connected

`sms.py` is a provider adapter. Development prints messages to the terminal. In production (`ENCORE_ENV=production`) sign-in codes are refused with `SMS_NOT_CONFIGURED` until a real provider is implemented against its documented API and registered in `sms.PROVIDERS`. Codes are 6 digits, stored as HMAC hashes, expire in 5 minutes, allow 5 attempts, 60 s resend wait, 5 sends per number per hour, 20 per IP per hour.

## Deploy on Render

`render.yaml` creates a **Render PostgreSQL database** (`encore-db`) and a web service connected to it through `DATABASE_URL`. All data — organizations, accounts, bookings, orders — and uploaded photos are stored in PostgreSQL, so restarts and redeploys keep everything. Locally, without `DATABASE_URL`, Encore uses SQLite.

1. Push to GitHub. In Render open **Blueprints → encore → Sync** (or enable auto-sync). Environment variable and database changes in `render.yaml` are only applied when the Blueprint syncs; redeploying the service alone is not enough.
2. Guest app: `https://<service>.onrender.com/` · Organizer admin: `https://<service>.onrender.com/admin` (create the organizer at `/admin/signup`).
3. Check `https://<service>.onrender.com/api/health` — it reports `"database": "PostgreSQL"` and `"demo": true` when configured correctly.
4. **Demo mode (`ENCORE_DEMO=1`):** guest sign-in shows the code on screen with *Use code*, and online checkout simulates payment. Anyone can sign in as any number — set `ENCORE_DEMO=0` before real guests.
5. **Plans:** the blueprint uses Render's free web service (sleeps when idle; first request takes ~1 minute) and free PostgreSQL, which **expires after 30 days**. Upgrade the database plan before then to keep data.

## Deploying elsewhere

1. Two HTTPS hostnames, e.g. `admin.example.com` and `tickets.example.com` (table QR codes point at the guest hostname).
2. Configure environment from `.env.example`: `ENCORE_ENV=production`, `ADMIN_ORIGIN`, `GUEST_ORIGIN` (https), `ENCORE_SECRET`, `ENCORE_DATA`, `TRUST_PROXY=1` behind the proxy. The server **refuses to start** in production with http origins or no secret.
3. `docker build -t encore . && docker run -d -p 127.0.0.1:8081:8081 -p 127.0.0.1:8082:8082 -v encore-data:/data --env-file .env encore`
4. Put `deploy/Caddyfile` (or equivalent) in front for TLS.
5. Back up the data volume (SQLite database, uploads, secret).

Production security headers: HSTS, CSP with hashed inline scripts, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera allowed for scanning), HttpOnly/Secure cookies (admin `SameSite=Strict`; guest `Lax` so table QR links opened from the camera keep the session).

## Before selling real tickets

These are **not done** and block calling this production-ready:
- A real SMS provider (guest sign-in does not work in production without it).
- AfroPay (online payment), refunds, reconciliation.
- The server uses Python's standard-library threaded HTTP server with SQLite. It is fine for a single venue's load behind a TLS proxy, but has no load testing, and rate limits are per process in memory.
- No email delivery; admin password recovery is code-based.
- Legal review of the platform terms/privacy text in `src/guest/content.js` and organizer terms.
- Monitoring, automated backups, and a security review of the deployment.
