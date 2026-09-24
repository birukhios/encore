# Encore concert platform

> Deploying for real guests and money? Follow **[PRODUCTION.md](PRODUCTION.md)** and run `npm run check`.

Two web apps and one server, on one address:

| App | Local address | Who |
| --- | --- | --- |
| Organizer admin | http://127.0.0.1:8080/admin | Owners, admins, service and gate staff (email + password) |
| Guest web app | http://127.0.0.1:8080/ | Concert guests (mobile number + SMS code) |
| Platform console | http://127.0.0.1:8080/admin/platform | Encore's own operators |

The apps call `/admin/api/*` and `/api/*`; organizer, guest and platform sessions use separate cookies and never open each other's routes.

**Stack:** React + Vite screens (`src/`), a .NET 8 Web API (`backend/Encore.Api`: Controllers → Services → Repositories, EF Core, Swagger UI in development), PostgreSQL. Passwords are hashed with ASP.NET Core Identity's hasher. Next.js shells for the same screens live in `apps/` (see [TECH_STACK.md](TECH_STACK.md)).

## Run locally

Needs **Node.js 20+** and the **.NET 8 SDK** (Mac: `brew install --cask dotnet-sdk@8`).

```
npm ci
npm run build
npm start
```

or double-click `Start_Encore.command` on a Mac. `npm start` opens the organizer admin.

**Database.** Encore uses PostgreSQL only — the same engine in development, tests and production. Point `DATABASE_URL` at it in `.env`:

```
DATABASE_URL=postgresql://encore:password@localhost:5432/encore
```

No database installed? Let Encore run a private one inside `data/postgres` by setting `ENCORE_LOCAL_DB=1` in `.env` (it uses the `embedded-postgres` npm package). Tables are created, and later changes applied, by EF Core migrations on start-up.

- **Development with hot reload:** `npm run dev` → admin http://127.0.0.1:5173/admin, guest http://127.0.0.1:5174/, API and Swagger UI http://127.0.0.1:8080/swagger. Uses `DATABASE_URL` if set, otherwise a private PostgreSQL in `data/postgres`.
- **Tests:** `npm test` — the whole .NET suite (xUnit): HTTP journeys against the real app, the money and workspace rules, SMS providers, and golden cases recorded from the original rules. It starts a throwaway PostgreSQL; set `DATABASE_URL` to test against a server of your choice. Pass filters through: `npm test -- --filter GuestJourneyTests`.
- **Build:** `npm run build` (web apps into `dist/`, then the API).
- **Operator tools:** `npm run check` (production readiness), `npm run sms:test -- +251911234567`, `npm run sms:balance`, `npm run platform-admin`.

There are no default accounts. Create a workspace at `/admin/signup` and save the one-time recovery code.

Without an SMS provider, messages (sign-in codes, booking and order updates) are **printed in the server log and not delivered** (`[DEV SMS - NOT DELIVERED]`). In production set `SMS_PROVIDER` and its credentials — see **Guest sign-in (SMS)** below.

## Features

**Organizer admin**
- Accounts with hashed passwords (ASP.NET Core Identity), server sessions, recovery codes, password change, invitations, member removal, Owner/Admin/Service/Gate roles enforced on the server, tenant isolation, optimistic concurrency.
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

## Organizer profile, ratings, menu categories, tips and VAT

- **Guest home:** search venues and cities, a "Coming up" rail of the next events across venues, venue cards with photo, logo, star rating, address and event count, and a "How Encore works" section.
- **Organizer page:** hero with logo, rating and address; upcoming events; photo mosaic with a viewer; guest reviews; a side panel with **Open in Google Maps** and contact details. The map link is the organizer's Google Maps link, or a Google Maps search for the address and city.
- **Ratings:** guests who booked or ordered with an organizer can give 1–5 stars and an optional comment (one rating per guest, updatable). Averages appear on the home page and organizer page; organizers see recent reviews on the Overview.
- **Location & photos** (Settings): city, address, Google Maps link (google.com/maps or maps.app.goo.gl), up to 12 photos.
- **Menu categories** (Settings): add, rename (updates items), reorder, remove when empty.
- **Tips:** fixed amounts in the workspace currency (default 20, 50, 100) plus an optional custom amount; never preselected, never taxed.
- **VAT** (Settings): on/off, rate (15% standard), prices VAT-inclusive or VAT added, apply to tickets and/or menu, TIN (10 digits) and VAT registration number. Calculated on the server with exact round-half-up to the cent; the bag shows the server's quote. Turnover tax (TOT) is not offered. Encore receipts are **not fiscal receipts** and this is not tax advice.
- **Payments:** wallet checkout (AfroPay) is not connected yet, so it fails closed. Until then each organizer chooses in **Settings → Payments**: cash for food & drink orders, and "reserve tickets and pay at the entrance". Cash is only ever marked paid when staff record it.
- **Entry:** staff check guests in by scanning each ticket's QR code **or by typing the booking reference** (e.g. `EN-ABC123`, case-insensitive, prefix optional), which admits that booking's tickets one at a time.
- **Wallet logos:** add official logo files you are permitted to use to `public/wallets/` as `telebirr.png`, `cbe-birr.png`, `mpesa.png`, `awash-birr.png` (svg/webp/jpg also work), then rebuild; otherwise checkout shows the wallet names.

## Check-ins, navigation and brand

- **Check-ins** (admin, Owner/Admin/Gate): per-event arrival totals and progress, one row per ticket with check-in time and the staff member who admitted it, search by name, phone (any format) or reference, filter by arrival status, sort, check in from the list, scan tickets, and export CSV. Staff names are never sent to guests.
- **Guest back navigation:** every venue screen has a back link — "All venues" on the venue page, "<venue> events" elsewhere; the Encore logo also returns home.
- **Brand:** the Encore logo (crimson “e” mark + wordmark) is an SVG component (`src/shared/Logo.jsx`) used across both apps, favicon and app icons.
- **Wallet logos:** official Telebirr, CBE Birr, M-PESA and Awash Birr logo files in `public/wallets/` appear on checkout.
- **UI/UX pass** (ui-ux-pro-max checklist): SVG icons instead of emoji/text symbols, 44px touch targets on touch screens, 4.5:1 contrast for secondary text, visible focus on composite inputs, minimum text sizes, 16px inputs on phones.

## Using the app

- **Organizers:** the **Guide** page in the admin sidebar is a handbook — set-up in eight steps, how ticket sales, table ordering, staff orders, check-in, stock and reports work, a routine for running a night, who can do what, and answers to common questions. It prints.
- **Guests:** **Help → How to use this app** explains the seven steps from finding a concert to following an order.

## App states

Loading, empty, error and offline states are part of the product: skeleton placeholders while data loads, a retry button on every failed load, an offline bar when the connection drops, and an error boundary that keeps the app usable if a screen crashes.

## Dashboard, reports and analytics

- **Dashboard:** 7- or 30-day sales, tickets, orders and tips, each compared with the previous period; a daily sales trend; live order status (placed, preparing, ready); upcoming events with how many tickets are sold; top tipped tables; best sellers; ratings; and a setup checklist that disappears once setup is done. **Export PDF** creates a branded summary.
- **Reports** (Owner/Admin): filter by period (today, 7, 30 or 90 days, all time, or custom dates) and event. Every figure is compared with the previous period of the same length. The report has six tabs:
  - **Overview:** 8 key figures, suggestions to grow sales (ranked from the data), a sales trend, key findings, where the money comes from, and the 10 latest bookings and orders.
  - **Sales:** each event's share of tickets sold, no-show rate and food & drink sales per checked-in guest, plus payment methods, weekdays and a daily breakdown.
  - **Menu:** best sellers with attach rate and revenue share, how much revenue the top items bring in, category mix, and slow movers.
  - **Tables & tips:** top tipped tables with tip rate and average tip, and the busiest tables.
  - **Guests:** paying and returning guests, spend per guest, guest segments, and top guests.
  - **Timing:** a weekday × hour heatmap, the busiest hours and the busiest weekdays.

  Export all of it as CSV (includes the previous period) or as a branded PDF.
- **Check-ins:** click a guest's name to see their tickets, orders and payments, and export them as CSV or PDF.
- **VAT** is added on top of listed prices. Existing workspaces were switched automatically. All tickets and orders are paid online; there is no pay-at-venue option. The wallet the guest chose is recorded for payment reports.

## Stock, waiters, staff orders and printing

- **Store stock** (Owner/Admin, Stock → Store items): add supplies grouped by your own **stock categories** (Settings → Stock categories, or **+ New category** in the item form), such as beer, wine, bread, meat or cleaning products, with a category, unit (bottles, crates, kg, liters, loaves, pieces…), reorder level, cost per unit and supplier. Quick add suggests common items. **Adjust** records deliveries (and updates the cost), kitchen or bar use, waste and counts; decimals are allowed (e.g. 2.25 kg). The page shows reorder alerts, store value at cost, 7-day usage and days of cover, and exports a CSV including a shopping list.
- **Menu item stock** (Stock → Menu items): turn on **Track stock** for a menu item and set its opening count and low-stock alert. Guest orders and staff orders reduce stock; cancelling an unpaid order puts it back. Nobody can order more than is in stock, sold-out items are hidden from guests, and guests see "Only N left" at or below the alert. The Stock page shows levels, low and out-of-stock counts, stock value, 7-day sales and days of cover. You can record deliveries, waste and counts; every change is logged with who made it. Exports to CSV.
- **Waiters** (Owner/Admin): each waiter gets a unique random 4-digit number, which is never reused in the workspace and can be regenerated if a badge is lost. Print a badge. Guests can enter the number in their bag, and the tip is credited to that waiter. The page shows tips, orders and average tip per waiter for 7 days, 30 days or all time, with CSV export. Reports → Tables & tips includes **Tips by waiter**.
- **Staff orders** (Owner/Admin/Service): **Orders → New order** lets a waiter take an order at the table: choose items (stock-aware), table, waiter, optional guest name and tip, then **Cash**, **Card at venue** or **Not paid yet**. Prices, service charge, VAT and stock are checked on the server.
- **Cash for guest orders** (Settings → Payments, on by default): at checkout guests choose **Mobile wallet** or **Cash** for food & drink orders. A cash order goes to the kitchen marked **Pay cash** and staff are notified to collect. The waiter taps **Record payment → Cash** when paid. Tickets are always paid online.
- **Printing:** every order has **Print**, with a customer receipt (items, service charge, VAT, tip, total, paid status, TIN) or a large-type kitchen ticket, sized for 80 mm receipt printers.
- **Tips & service charge** (Settings): choose **Tips only**, **Service charge only**, **Both** or **Neither**, plus the service charge percentage. The service charge applies to food & drink orders only, VAT is charged on it, and tips are never taxed. Bank transfers are not accepted.

## Platform console (`/admin/platform`)

For Encore's own operators, separate from organizer accounts: its own table, a 12-hour session cookie, and a stricter sign-in rate limit. Organizer sessions cannot open it, and a platform session does not open an organizer workspace.

- **Create the account:** set `ENCORE_PLATFORM_EMAIL` and `ENCORE_PLATFORM_PASSWORD` (12+ characters) and restart, or run `npm run platform-admin`. On Render, set both in the service's Environment tab.
- **Overview:** platform sales total (in the most common currency; other currencies are listed but not added up), organizations, paying guests, tickets, orders, VAT and tips, compared with the previous period. Also a platform sales trend, findings (how concentrated sales are, inactive organizations, new guests), each organization's share of sales, an organization leaderboard, and guest account growth.
- **Organizations:** search, filter by status, CSV export. Each organization's detail view shows a summary, the full analytics tabs, events, team (with **End sessions**), and **Suspend / Reactivate** with a required reason. Suspending signs out and blocks its staff and hides it from guests. Existing guest receipts still work, and nothing is deleted.
- **Analytics:** the same six report tabs across all organizations or for one, with CSV and PDF export.
- **Guests:** every guest account with organizations used, tickets, orders, total spent and last activity, plus conversion and lifetime value.
- **Accounts:** organizer staff across organizations, with role counts, last sign-in, **End sessions**, and **Reset password**. A reset shows a one-time recovery code; the person then uses **Forgot password?** to choose a new password. Every reset is logged.
- **Activity:** organizer and guest actions (last 300) and the platform admin log (sign-ins, suspensions, ended sessions).
- **System:** database, environment, SMS and payment status, session and sign-in code counts.

## Appearance

Organizers choose the default look in Settings → Appearance (guest app and dashboard separately: Light, Black, or follow the device). Anyone can also flip light/dark for themselves with the ☾/☀ button in either app's header; that choice is remembered on their device.

## Payments — online payments are not live

AfroPay is **not integrated**; no provider API was invented. `POST /api/checkout` always fails with `PAYMENT_NOT_CONFIGURED`. The only way to reserve is **pay at the venue**: records are created unpaid, staff collect payment in person and record it. Nothing is ever marked paid by the guest or by the payment screen. To integrate AfroPay, supply the merchant API documentation (checkout creation, verification, webhook signatures, refunds).

## Guest sign-in (SMS)

Guests sign in with their phone number and a 6-digit code. Choose a provider and set its variables:

| `SMS_PROVIDER` | Variables |
| --- | --- |
| `afromessage` | `AFROMESSAGE_TOKEN`; optional `AFROMESSAGE_SENDER` (default `Afropay`), `AFROMESSAGE_CALLBACK`, `AFROMESSAGE_CHALLENGE=1` |
| `twilio` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (or `TWILIO_MESSAGING_SERVICE_SID`) |
| `africastalking` | `AT_USERNAME`, `AT_API_KEY`, `AT_FROM` (optional) |
| `geezsms` | `GEEZSMS_TOKEN`, `GEEZSMS_FROM` (optional) |
| `http` | `SMS_HTTP_URL`, `SMS_HTTP_AUTH`, `SMS_HTTP_BODY` (template with `{phone}` and `{text}`) — any other gateway |

Where to put them:

- **Local development:** copy `.env.example` to `.env` in the project folder and fill in the values. Encore reads it at
  start-up; real environment variables always win, and `.env` is git-ignored — never commit it.
- **Render (live):** service → **Environment** → *Add Environment Variable*, then **Save Changes** (the service restarts).
  Secrets never belong in `render.yaml`; it only declares the keys with `sync: false`.
- **Docker or a VPS:** pass them with `--env-file .env`, your process manager's environment, or a secret manager.

Every attempt is logged, in both directions:

```
SMS -> GET https://api.afromessage.com/api/send?sender=Afropay&to=+2519****4567&message=<27 chars hidden>
SMS <- 200 {"acknowledge":"error","response":{"errors":["sender name not approved"]}}
```

The guest's number is masked and the message (which contains the sign-in code) is hidden. Set `SMS_DEBUG=1`
to log both in full while troubleshooting, then turn it off — a code in a log file is a code anyone can use.

Prove delivery before launch:

```
npm run sms:test -- +251911234567
```

### AfroMessage (Ethiopia)

Encore calls the documented API: `GET https://api.afromessage.com/api/send` with a `Bearer` token and
`sender`, `to`, `message` (plus `callback` when set). The `from` identifier is **not** sent — the token identifies the account.
The sender name defaults to **Afropay**; set `AFROMESSAGE_SENDER` to use a different approved name. A message counts as sent **only** when the reply is
`{"acknowledge": "success", ...}`; anything else is reported as a failure and the guest sees a clear error.

With `AFROMESSAGE_CHALLENGE=1`, sign-in uses AfroMessage's own security-code endpoints:

- `GET /api/challenge` generates, formats and sends the code, and returns a `verificationId`.
- Encore stores **only** that id (`provider:<verificationId>`) — the code itself is never kept.
- `GET /api/verify?to=…&vc=<verificationId>&code=<what the guest typed>` decides whether the code is right.

Wording and format: `AFROMESSAGE_PREFIX` (default "Your Afropay code is"), `AFROMESSAGE_POSTFIX`,
`AFROMESSAGE_CODE_TYPE` (`0` numeric, `1` letters, `2` alphanumeric); `len` follows Encore's 6 characters and `ttl`
its 5-minute expiry. If the reply carries neither a code nor a verification id, sign-in fails rather than leaving a
code nobody can check.

**Cloudflare:** AfroMessage sits behind Cloudflare, which answers unknown user agents with
`403 error code: 1010`. Encore sends a normal `User-Agent` (override with `SMS_USER_AGENT`), which resolves it.

Check the account without sending anything:

```
npm run sms:balance
```

Codes are stored as HMAC hashes, expire in 5 minutes, allow 5 attempts, need a 60-second wait before resending, and are
limited to 5 per number per hour and 20 per IP per hour. Until a provider is configured, sign-in answers
`SMS_NOT_CONFIGURED` and nothing is sent.

## Deploy on Render

`render.yaml` creates a **Render PostgreSQL database** (`encore-db`) and a Docker web service connected to it through `DATABASE_URL`. The image (see `Dockerfile`) builds the web apps with Node and publishes the .NET API; one port serves everything. All data — organizations, accounts, bookings, orders — and uploaded photos are stored in PostgreSQL, so restarts and redeploys keep everything.

1. Push to GitHub. In Render open **Blueprints → encore → Sync** (or enable auto-sync). Environment variable and database changes in `render.yaml` are only applied when the Blueprint syncs; redeploying the service alone is not enough.
2. Guest app: `https://<service>.onrender.com/` · Organizer admin: `https://<service>.onrender.com/admin` (create the organizer at `/admin/signup`).
3. Check `https://<service>.onrender.com/api/health` — it reports the database and whether SMS delivers.
4. **Plans:** the blueprint uses Render's free web service (sleeps when idle; first request takes ~1 minute) and free PostgreSQL, which **expires after 30 days**. Upgrade the database plan before then to keep data.

Existing data carries over unchanged: the first start of the .NET API records the existing tables as its baseline migration without altering them, and accounts created before the move keep their passwords (re-hashed with ASP.NET Core Identity at their next sign-in).

## Deploying elsewhere

1. One HTTPS hostname, e.g. `tickets.example.com` (guest app at `/`, organizer admin at `/admin`; table QR codes point at it).
2. Configure environment from `.env.example`: `ENCORE_ENV=production`, `PUBLIC_ORIGIN` (https), `ENCORE_SECRET`, `DATABASE_URL`, `TRUST_PROXY=1` behind the proxy. The server **refuses to start** in production with an http origin or no secret.
3. `docker build -t encore . && docker run -d -p 127.0.0.1:8080:8080 --env-file .env encore`
4. Put `deploy/Caddyfile` (or equivalent) in front for TLS.
5. Back up PostgreSQL (it holds every record and uploaded image).

Production security headers: HSTS, CSP with hashed inline scripts, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera allowed for scanning), HttpOnly/Secure cookies (admin `SameSite=Strict`; guest `Lax` so table QR links opened from the camera keep the session).

## Before selling real tickets

These are **not done** and block calling this production-ready:
- SMS credentials for one of the built-in providers (guest sign-in does not work in production without them).
- AfroPay (online payment), refunds, reconciliation.
- No load testing. Rate limits are kept in memory per server instance, so run one instance (as the Render blueprint does).
- The Docker image has not yet been built and run on Render after the move to .NET; do that on a staging service first.
- No email delivery; admin password recovery is code-based.
- Legal review of the platform terms/privacy text in `src/guest/content.js` and organizer terms.
- Monitoring, automated backups, and a security review of the deployment.
