# Encore → Next.js + .NET 8 migration plan

Target stack (see TECH_STACK.md): two Next.js + TypeScript + Tailwind + shadcn/ui frontends (organizer, guest),
one .NET 8 Web API (Controller → Service → Repository), EF Core on PostgreSQL with checked-in migrations,
Swagger UI, ASP.NET Core Identity.

Work happens on the `migration/dotnet-next` branch. `main` keeps deploying the Python server until the
.NET API passes every contract test.

## Decisions

1. **The HTTP contract does not change.** `/admin/api/*`, `/api/*` and `/uploads/*` keep the same paths,
   JSON shapes, status codes and cookies. The existing screens keep working while the backend is swapped.
2. **The same tests judge both servers.** The Python HTTP test suite can target any running server
   (`ENCORE_TEST_BASE_URL`). A route counts as ported only when those tests pass against .NET.
3. **The live database is kept.** EF Core maps the existing tables; a baseline migration describes them, so
   Render's data carries over with no data migration. The per-organization workspace document stays a
   single column, modelled as typed C# classes. Normalizing bookings and orders into tables is a later,
   separate step with its own migration.
4. **Identity without locking anyone out.** Organizer and platform accounts move to ASP.NET Core Identity.
   Existing scrypt hashes are checked by a legacy-aware password hasher and re-hashed to Identity's format
   on the next successful sign-in. Nothing is bypassed. Guests keep phone + SMS code.
5. **Strangler, not big bang.** The relay stays until the end. Each route group is implemented natively and
   removed from the relay only when its tests pass. Python is retired when nothing relays.

## Phases

| # | Phase | Done when |
| --- | --- | --- |
| 0 | Baseline branch, footer shipped on `main` | ✅ |
| 1 | Contract tests can target any server; test-only SMS sink and rate-limit relaxation | Suite passes against Python through the new harness |
| 2 | EF Core data layer over the existing schema; baseline migration; workspace document model | Reads/writes the live schema in tests |
| 3 | Business rules (`domain.py`) as .NET services with xUnit tests mirroring `DomainTests` | Pricing, VAT, stock, waiters, check-in parity |
| 4 | Native endpoints, group by group: health/public → guest OTP + orders → organizer auth → staff actions → platform console → uploads | Contract suite green against .NET for each group |
| 5 | ASP.NET Core Identity for organizer and platform accounts, legacy scrypt re-hash | Existing accounts sign in unchanged |
| 6 | Frontends: Next apps own routing; screens move to TypeScript + shadcn/ui gradually | Both apps build and pass browser checks |
| 7 | Deployment: API + two frontends on Render, Python retired | Live site served by .NET, rollback documented |

## Rules while migrating

- Every rule in CLAUDE.md still applies: never fake a payment or an SMS, the server decides money, integer cents.
- No phase merges to `main` with a red contract suite.
- The SDK used so far lives in `/private/tmp/encore-dotnet` (cleared on reboot). Install .NET 8 SDK permanently
  (`brew install --cask dotnet-sdk@8` or the Microsoft installer) before relying on it.
