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
| 1 | Contract tests can target any server; test-only SMS sink and rate-limit relaxation | ✅ 37 contract tests pass through the .NET relay (8 inspect Python directly) |
| 2 | EF Core data layer over the existing schema; baseline migration; workspace document model | ✅ Baseline migration is a no-op on live data; workspace round-trips with a version-checked save (5 xUnit tests) |
| 3 | Business rules (`domain.py`) as .NET services with xUnit tests mirroring `DomainTests` | ✅ All rules ported; 941 pricing/input cases and 30 recorded 60-step scenarios match Python |
| 4 | Native endpoints, group by group: health/public → guest OTP + orders → organizer auth → staff actions → platform console → uploads | ✅ All endpoints native; the Python contract suite passed against .NET before Python was removed |
| 5 | ASP.NET Core Identity for organizer and platform accounts, legacy scrypt re-hash | 🟡 Identity password hasher with scrypt re-hash done; accounts not yet moved into the Identity user store |
| 6 | Frontends: Next apps own routing; screens move to TypeScript + shadcn/ui gradually | Both apps build and pass browser checks |
| 7 | Deployment: API + two frontends on Render, Python retired | 🟡 Python removed, npm-only tooling, Dockerfile and rollback notes updated; image not yet built or deployed |

## Rules while migrating

- Every rule in CLAUDE.md still applies: never fake a payment or an SMS, the server decides money, integer cents.
- No phase merges to `main` with a red contract suite.
- .NET 8 SDK 8.0.425 is pinned in `backend/global.json` (install: `brew install --cask dotnet-sdk@8`); a newer SDK
  alongside it is ignored for this repo. `dotnet tool restore` in `backend/` installs the pinned `dotnet-ef`.
