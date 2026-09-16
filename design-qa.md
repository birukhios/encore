# Design and product verification

final result: blocked

## Source

- Uploaded `image.png`: 399 × 501, supplied crimson/black/white/steel-grey color board. This is a palette reference, not a screen layout to clone.
- Prior Lukana Figma extraction: Manrope, 53 original icon components, rounded controls/cards and dashboard structure.
- Colors: #E61E32, #000000, #FFFFFF, #B3B3B3. The compressed reference image's dominant red sample is #E51E31; use its labeled RGB 230,30,50.

## Browser evidence

Cloud browser rendered `/admin/signup`, `/admin/signin`, and `/`. Sign-up and sign-in screenshots were emitted in the working conversation. Sign-in and the original palette board were returned together as one comparison input. Viewport approximately 1363 × 936 screenshot pixels at desktop density. Sign-in and sign-up are not states present in the palette source, so no exact frame-parity claim is made.

Fonts/typography: Manrope is bundled; clear display/body/form hierarchy. Sign-in heading 32px, body 14px, compact labels and clear wrapping. Spacing/layout: two-column organizer auth screen, generous form widths and visible primary action. Colors/tokens: crimson actions and accent icons against black/white surfaces and grey secondary text. Assets: original extracted icon geometry; actual user uploads supported for menu and event covers; no fabricated concert photography. Copy: user-facing prototype/demo/import commentary removed, genuine payment configuration status retained.

## Findings and verification history

- P1 resolved: initial preview only started Vite and could not reach the Python API. `dev.mjs` now starts both. Public directory rendered without its prior JSON/network error after restart.
- P2 resolved: booking form reused a generic Save changes CTA. Updated to Continue to AfroPay.
- P2 resolved: guest listings said On sale without a connected provider. Updated to Upcoming.
- P2 resolved: narrow admin navigation could lose its accessible name. Explicit aria-label added.
- P0 open: AfroPay provider contract not verified; checkout intentionally unavailable. Paid ticket fulfillment, payment-backed order flow, paid guest table booking, receipt delivery and refunds are unfinished. Never label this release live-ready.
- Coverage gap: authenticated dashboard and full mobile interaction screenshots were not completed. Authentication endpoints are covered by isolated integration tests; no browser credentials were requested from the user and no authentication bypass was introduced.

Primary checks completed: public navigation into organizer sign-in/sign-up; server integration tests for real account lifecycle, role/tenant enforcement, stale updates, image validation, table-link binding and payment rejection. Browser logs checked: extension-origin metadata errors were observed; no application runtime exception in the final public/auth screen inspection.

## Remaining work

1. Confirm the exact AfroPay service and merchant API contract; implement the payment and fulfillment requirements listed in README.
2. Run authenticated desktop and small-screen guest browser walkthroughs with a configured test account and sandbox payments.
3. Review every paid success/error/cancellation/retry state and complete launch security/deployment gates.

This file records partial verification and does not certify visual perfection, exhaustive Figma component parity, or production readiness.

## September 16 checkout update

Scoped checkout component was browser-rendered in the isolated `/tests/checkout.html` fixture. Original source: supplied AfroPay donation checkout screenshot (1523 × 946); implementation screenshot: 1363 × 936, emitted in conversation. Adaptations: organizer-name strip replaces municipal campaign branding, donation copy becomes booking/order copy, wallet names are text labels pending official assets, unknown processing fees are explicit. Blue checkout surface retained while the platform remains crimson. Wallet radio switching and invalid-number feedback tested. Server quote/availability/table/tip tests pass. Fixed a zero-tip booking subtotal label during review. Overall product QA remains blocked by the live payment contract and end-to-end fulfillment gaps previously listed.

## September 16 fulfillment and local-run update

Result: guest/staff journeys verified locally; online payment still blocked.

- Startup: macOS system python3 (3.9, no scrypt) was the local blocker. `launch.py` now finds a suitable 3.11+ interpreter (python.org, Homebrew, uv) and re-executes itself, or prints install steps. `npm run build` no longer relies on a `vite` bin link. `dev.mjs` starts the API through `launch.py`.
- Browser walkthrough in the in-app browser against a disposable data directory (deleted afterwards): sign-up with recovery code; event and menu images uploaded via `/api/upload`; two tables with distinct tokens; mobile (375×812) guest table-QR menu, bag, 10% tip, AfroPay review (fails closed), "Reserve · pay at the venue", receipt, 2-ticket booking with per-ticket QR, Tickets tab tracking; desktop admin Overview, Orders (Mark Preparing, Record payment), Bookings (Record payment, Check in), Team, Settings; guest receipt then showed "Paid at the venue (Cash)".
- Fixed during review: 10 extracted icons had `scale(0 …)` transforms that made them invisible (e.g. menu "+"); cramped receipt totals; wrapped guest-list actions; "Checkout with AfroPay" label; POST rejections sent before draining the body caused intermittent connection resets (flaky CSRF test) — body is now read first (0 failures in 15 runs).
- Not browser-tested: invite acceptance, Service/Gate role screens, password change/recovery screens (all covered by integration tests), file-picker upload UI itself (endpoint exercised from the page session), Mac Finder double-click of Start_Encore.command.

## September 16 — separate guest app, phone OTP, full settings

Result: local end-to-end journeys verified in the in-app browser against a disposable data directory (deleted afterwards). Production launch still blocked on SMS provider and AfroPay (see README).

Verified in browser — admin (800 px pane, sidebar collapsed): sign-up with recovery code; event created via form with cover upload through the upload component; menu item with photo and "served at" one concert; Settings → Appearance (swatch/hex, too-light accent rejected with message, dark mode, logo upload, live phone preview, unsaved-changes bar), Help & support (contacts + FAQ), Terms; Orders (Mark preparing/ready, record payment dialog); Bookings (record payment, ticket check-in by pasted code, duplicate scan rejected); notification bell count.
Verified in browser — guest (375×812, dark theme): organizer auto-selected; logo/cover/dark mode applied; menu locked behind table scan; reserve 2 tickets → phone sheet → dev SMS code → auto-verify → name + terms → checkout resumed; online wallet pay rejected honestly; pay-at-venue receipt with 2 ticket QRs; menu then filtered to the ticketed concert; table code for another concert showed that concert's menu and ticket-holder block; own table code → order with 10% tip → receipt; notifications (5) and SMS log (code, booking, order ready); order progress bar and Paid badge after staff actions; account sheet, Help screen.
Fixed during review: invisible icon transforms (earlier), inline file-guard syntax error, hidden sidebar shadow bleeding at tablet width, Overview "Create event" not opening the form, +251 prefix wrapping, 5 tip options wrapping, signed-out guest check logged as 401 error, responses sent before commit (session race), guest/admin port route leakage returning 401 instead of 404.
Not verified: live camera scanning (camera blocked in the test browser; jsQR/BarcodeDetector path untested on a device), Enter-key submission (automation cannot synthesize implicit submit), invite acceptance and Service/Gate screens in browser (covered by tests), real SMS delivery, Docker image build (Docker not installed here), physical phones on a LAN/HTTPS host.

## September 16 — icons and responsive layouts

- Icons: 5 extracted icons (1220 settings, 1101 support, 1227 venue, 1237, 1072) had strokes erased by zero-scale transforms such as `scale(0.0 1.077)`; all zero-axis scales repaired without changing geometry and compared before/after. Scan-ticket now uses the ticket icon. Added favicon (SVG + 32 px), apple-touch-icon, 192/512 app icons and a guest web manifest, generated from Figma icon 1199 on crimson.
- Responsive: guest app has phone (≤380, default), tablet (≥720: 2-column grids, floating nav, centred sheets), desktop (≥1024: header navigation, 3-column events, 2-column bag) and wide (≥1440) layouts. Admin fixed grid/flex min-width overflow that clipped Orders actions on 320 px phones.
- Verified: automated off-screen overflow sweep of every guest view (+ account sheet) at 320, 360, 390, 768, 1024, 1440 and every admin page plus four settings sections at 320, 768, 1024, 1440 — no overflow; screenshots reviewed at 320/360 phone, 768 tablet, 1440 desktop. Not verified on physical devices.
