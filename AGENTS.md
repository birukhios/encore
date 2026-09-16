# Encore platform requirements

Guest app and organizer admin are separate routes and account contexts. Keep the guest app mobile-first. Use the supplied crimson red (#E61E32), black, white and steel-grey palette, with original Manrope typography and extracted icon geometry. Do not show demo/Figma-import narration in the customer product.

Use server sessions and enforce tenant ownership and staff roles on the server. Never restore localStorage authentication or fake payment success. AfroPay must be verified against the exact merchant provider contract before implementation; fail closed until configured. Every table has a stable unique ordering token tied to a concert. Media uploads are first-class for both event covers and menu items.

Run Python integration tests and Vite build. Public production deployment is not yet configured; read README and design-qa.md before claiming readiness. Do not include data/, passwords, recovery codes or session secrets in deliverable packages.

AfroPay checkout reference supplied September 16: blue provider header, review rows, wallet selector, Ethiopian phone field. Do not include municipal crest or city campaign affiliation. Replace the merchant strip with the tenant organization name. Wallet labels shown are Telebirr, CBE Birr, M-PESA and Awash Birr; availability has not been API-verified. Provider fees are unknown until the merchant contract is configured; never present an assumed zero fee. New workspaces default to ETB.

Architecture (September 16, second update): admin app on PORT (8081) and guest app on GUEST_PORT (8082) are separate listeners with separate routes and cookies; do not merge them. Guests authenticate with phone + SMS OTP through sms.py; never deliver or display codes outside the dev console adapter, and never bypass OTP. Business rules live in domain.py; server.py is HTTP only. Frontend: src/admin, src/guest, src/shared; icons only from src/icons.json (extracted Figma set). Payment settlement is in-person only ("pay at venue"); staff record payments.

Demo mode (September 16, user request): ENCORE_DEMO=1 shows guest OTP codes on screen instead of sending SMS and makes /api/checkout record a clearly labelled simulated payment ("Demo payment (simulated)", settlement "demo"). It is opt-in per deployment and must be labelled in both UIs; with ENCORE_DEMO unset, checkout still fails closed and OTP requires a real SMS provider in production. Never enable for real guests or real money.
