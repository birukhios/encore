# Encore .NET API

This is the single .NET 8 API entry point for the admin and guest Next.js apps. It currently forwards the existing API contract to the loopback Python listeners while native business rules are migrated. The relay keeps current sessions, OTP verification, tenant checks, pricing and pay-at-venue settlement in force; it is not the final all-.NET backend.

Run PostgreSQL and the existing Python server first, bound to loopback. Then:

```sh
export DATABASE_URL='postgresql://...'
export ASPNETCORE_URLS='http://127.0.0.1:8080'
dotnet run --project backend/Encore.Api
```

The Next.js apps target port 8080 by default. `ENCORE_BACKEND_URL` can override it. `Legacy__Admin` and `Legacy__Guest` override the internal Python listener addresses if their ports differ. Never expose the Python listeners to the public network when using the bridge. Swagger UI is available at `/swagger` in development. `/bridge/health` checks PostgreSQL access. `python3 backend/test_bridge.py` runs a disposable-account smoke check against the running stack.

`EncoreIdentityDbContext` is deliberately separate from the legacy `users` and `sessions` tables. Its migration adds ASP.NET Core Identity tables without changing existing accounts. Identity is not yet used to authenticate the current apps. Do not switch account handling until a tested migration for existing scrypt hashes, roles, invitations, recovery and session behavior is complete.

## Data layer (migration phase 2)

`Persistence/EncoreDbContext` maps the tables `db.py` owns. Its baseline migration uses the same `IF NOT EXISTS`
DDL, so applying it to the live database changes nothing; its history lives in `__encore_migrations`, apart
from Identity's. `WorkspaceRepository` saves the workspace document only if its version is unchanged.

```sh
dotnet tool restore                      # dotnet-ef, pinned in .config/dotnet-tools.json
DATABASE_URL='postgresql://...' dotnet test Encore.Api.Tests
```
