# Encore — working agreement for AI-assisted development

Encore is a live-venue platform: guest web app (`/`), organizer admin (`/admin`), platform console (`/admin/platform`).
Read `README.md` for features, `PRODUCTION.md` before any release, and `Encore_Developer_Guide` for architecture.

## Non-negotiable rules

1. **Never fake a payment or a delivered SMS.** If a provider is not configured, fail closed with a clear message.
2. **The server decides money.** Prices, VAT, service charge, tips, stock and payment state are recomputed in `backend/Encore.Api/Domain`. The browser only previews.
3. **Amounts are integer cents.** Use `Values.MoneyCents()`, `Values.Whole()`, `Values.Number()`; never floats for money.
4. **Never commit** `data/`, `.env`, passwords, recovery codes, API keys or customer data.
5. **Tenant isolation.** Every staff query is scoped to the signed-in user's tenant; guest queries to the signed-in guest.
6. **Tests with every rule change.** `npm test` runs the .NET suite against PostgreSQL, the only database Encore supports.
7. **No demo or dummy data in the product.** Sample content belongs in local scripts, never in the repository or a deployed database.

## Where code goes

| Concern | File |
| --- | --- |
| HTTP endpoints (thin: read request, call a service, reply) | `backend/Encore.Api/Controllers/*` |
| Sessions, cookies, accounts, orders, rate limits, notifications | `backend/Encore.Api/Services/*` |
| Business rules, validation, pricing, stock | `backend/Encore.Api/Domain/*` |
| Data access | `backend/Encore.Api/Repositories/*` |
| PostgreSQL schema (EF Core) and migrations | `backend/Encore.Api/Persistence/*` |
| SMS providers | `backend/Encore.Api/Services/SmsService.cs` |
| Request pipeline, errors, static files, settings | `backend/Encore.Api/Web/*` |
| Tests | `backend/Encore.Api.Tests/*` |
| Organizer admin UI | `src/admin/*` |
| Guest UI | `src/guest/*` |
| Shared UI, API client, theme | `src/shared/*` |
| Analytics (pure functions) | `src/admin/reportData.js` |

## Style

- Plain language in every user-facing message; say what happened and what to do next.
- Comments explain *why*, not *what*. Keep them rare and useful.
- Mobile-first guest app; verify at 320, 375, 768 px and desktop.
- Brand: crimson `#E61E32`, black, white, steel grey; Manrope; icons from `src/icons.json`.
- New workspace fields get defaults in `WorkspaceRules.Blank()` **and** `WorkspaceRules.Upgrade()`; schema changes are EF Core migrations (`cd backend && dotnet tool restore && dotnet ef migrations add <Name> --project Encore.Api --context EncoreDbContext --output-dir Persistence/Migrations`).

## Review expectations for AI-generated code

- Every change is reviewed by a person before merge; PR template requires the AI disclosure checkboxes.
- Security-sensitive areas (auth, payments, permissions, SQL, file uploads) need a second reviewer.
- New endpoints or actions must state which roles may call them and have a test proving the refusal.
