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

**The backend runs on .NET; Python has been retired.** `backend/Encore.Api` is the only server: Controllers → Services → Repositories over EF Core and PostgreSQL, with checked-in migrations and Swagger UI in development. It serves the built screens (`dist/`), `/admin/api/*`, `/api/*` and `/uploads/*` on one origin. Every business rule from the Python server was ported and is checked against golden cases recorded from it (see `backend/Encore.Api.Tests/ParityTests.cs`). Organizer and platform passwords use ASP.NET Core Identity's password hasher; accounts from the Python server are verified with their scrypt hash and re-hashed at the next sign-in. Guests keep phone + SMS OTP.

Identity is used for password hashing only. Accounts stay in the existing `users` and `platform_admins` tables with Encore's own server sessions; the separate `EncoreIdentityDbContext` and its `InitialIdentity` migration (in `Data/` and `Migrations/`) are not used by the running app. Moving accounts into the Identity user store (UserManager, AspNetUsers) is a separate change with its own data migration.

The React screens in `src/` are served by the Vite build (`npm run build`) and by the Next.js shells below. Tooling is npm only.

## Run the Next.js shells

Install the repository's packages and each application's packages, then run its `dev` or `build` script:

```sh
npm install
npm install --prefix apps/admin
npm install --prefix apps/guest
npm run dev --prefix apps/admin
npm run dev --prefix apps/guest
```

Admin defaults to port 3001 and guest to port 3002. Both proxy API calls to the .NET API on port 8080 (`npm start`, or `dotnet run --project backend/Encore.Api`). `ENCORE_BACKEND_URL` can override the address. Set `ADMIN_ORIGIN=http://127.0.0.1:3001` and `GUEST_ORIGIN=http://127.0.0.1:3002` for the API when developing sign-in flows through them.

## Remaining work

1. Move screens from JavaScript to TypeScript and shadcn/ui gradually, with browser checks at 320, 375, 768 px and desktop.
2. Decide whether the Next.js shells replace the Vite build in production; today the Docker image serves the Vite build.
3. Keep online AfroPay checkout closed until the exact merchant contract is verified. Media stays in the database.

The new apps use Next.js 16.3.6. A production dependency audit reports no guest-app advisories. The admin app retains the existing jsPDF 2.5.2 and jspdf-autotable 3.8.4 versions to preserve receipt behavior; npm reports three advisories across those packages and their DOMPurify dependency. Upgrading them requires PDF export regression checks before public deployment.
