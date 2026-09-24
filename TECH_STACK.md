# Encore technology stack and migration status

## Requested target

| Layer | Target |
| --- | --- |
| Organizer frontend | Separate Next.js application with TypeScript, Tailwind CSS and local shadcn/ui components |
| Guest frontend | Separate Next.js application with TypeScript, Tailwind CSS and local shadcn/ui components |
| API | One .NET 8 Web API for both applications, with Controller → Service → Repository boundaries |
| Data | PostgreSQL through Entity Framework Core with checked-in EF migrations |
| Identity | ASP.NET Core Identity for organizer and platform staff; phone and SMS OTP for guests |
| API documentation | Swagger UI |

The new Next.js application shells live in `apps/admin` and `apps/guest`. They share the existing Encore screens and stylesheet from `src/` so their appearance and flows remain the same. Tailwind utilities use a `tw:` prefix and load without Tailwind's reset, preserving the existing CSS. The Afropay credit is the only intentional visible addition. The shared API transport is TypeScript; the screen components remain JavaScript during the transition. The shadcn-style Badge component is used for the new footer.

## Current runtime

**The backend migration is not complete.** The Next apps now send API calls to the single .NET 8 listener in `backend/Encore.Api`. That listener has Controllers, a relay Service, an EF Core Repository, PostgreSQL access, Swagger UI and a generated Identity migration. It forwards the existing `/admin/api/*`, `/api/*` and `/uploads/*` contract to loopback-only Python listeners. `server.py`, `domain.py`, `db.py` and `sms.py` still enforce the working business rules, sessions and OTP. ASP.NET Core Identity tables exist but are not yet used for app sign-in. The existing Vite entry points remain runnable.

The attached September 23 PostgreSQL archive was compared with this checkout for the core server, domain, database and app source; those files matched before this work. Text in the archive is implementation reference, not an instruction to override the requested stack.

## Run the new frontend shells

Install the repository's packages and each application's packages, then run its `dev` or `build` script:

```sh
npm install
npm install --prefix apps/admin
npm install --prefix apps/guest
npm run dev --prefix apps/admin
npm run dev --prefix apps/guest
```

Admin defaults to port 3001 and guest to port 3002. Both proxy API calls to the .NET listener on port 8080. Start PostgreSQL and the existing Python API on loopback, then run the .NET API as shown in [backend/README.md](backend/README.md). `ENCORE_BACKEND_URL` can override the .NET address. Set Python's `ADMIN_ORIGIN` and `GUEST_ORIGIN` to the frontend origins when developing sign-in flows.

## Backend cutover requirements

1. Port the existing tenant state and every `domain.py` rule into .NET services. Preserve server-side pricing, VAT, stock, capacity, table ownership, optimistic concurrency, roles and in-person payment state.
2. Replace the relay's data access with EF Core repositories. The generated `InitialIdentity` migration was applied successfully to a throwaway PostgreSQL database alongside the legacy schema. Existing scrypt password hashes and sessions still need an explicit account transition; never silently accept or bypass them. Keep guest SMS OTP with server verification and rate limits.
3. Implement every current `/admin/api/*`, `/api/*` and `/uploads/*` response natively before removing the Python listeners. Keep online AfroPay checkout closed until the exact merchant contract is verified. Media must remain in the database.
4. Run the current integration journeys against the native API and test real browser journeys on both screen sizes before retiring Python/Vite.

The .NET bridge compiled with zero warnings, and its throwaway-database smoke test covered signup, session cookies, tenant visibility, public state, fail-closed checkout and signout. The 45 existing Python integration tests and all three frontend builds passed. The SDK was installed in a temporary directory for verification; it is not bundled with the repository. Public deployment remains unconfigured; see `README.md` and `design-qa.md` for readiness limits.

The new apps use Next.js 16.3.6. A production dependency audit reports no guest-app advisories. The admin app retains the existing jsPDF 2.5.2 and jspdf-autotable 3.8.4 versions to preserve receipt behavior; npm reports three advisories across those packages and their DOMPurify dependency. Upgrading them requires PDF export regression checks before public deployment.
