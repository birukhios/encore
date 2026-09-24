# Encore .NET API

The one server for Encore: the organizer admin API (`/admin/api`), the guest API (`/api`), uploaded images, and the
built web apps from `dist/`. .NET 8, ASP.NET Core, EF Core on PostgreSQL.

| Folder | What it holds |
| --- | --- |
| `Controllers/` | HTTP endpoints. Thin: read the request, call a service, reply. Each states which roles may call it. |
| `Services/` | Accounts and sessions (`StaffService`, `GuestService`, `PlatformService`), SMS, rate limits, notifications. |
| `Domain/` | Business rules: pricing, VAT, stock, check-in, settings, staff actions. Pure functions over the workspace document. |
| `Repositories/` | Data access over EF Core. |
| `Persistence/` | `EncoreDbContext`, entities, the workspace document, and migrations (`Persistence/Migrations`). |
| `Security/` | Passwords: ASP.NET Core Identity's hasher, and scrypt to verify accounts from the Python server. |
| `Web/` | Request pipeline (body checks, transactions, errors, HEAD, gzip), static files, settings, command-line tools. |

Run it through npm from the repository root (`npm start`, `npm run dev`, `npm test`), or directly:

```sh
DATABASE_URL='postgresql://...' dotnet run --project backend/Encore.Api     # http://127.0.0.1:8080
```

Swagger UI is at `/swagger` when `ASPNETCORE_ENVIRONMENT=Development` (`npm run dev` sets it).

## Database

`EncoreDbContext` maps the tables the Python server created. The baseline migration uses the same
`IF NOT EXISTS` DDL, so applying it to the live database changes nothing; its history lives in `__encore_migrations`.
Migrations run on start-up. To change the schema:

```sh
cd backend
dotnet tool restore                      # dotnet-ef, pinned in .config/dotnet-tools.json
dotnet ef migrations add <Name> --project Encore.Api --context EncoreDbContext --output-dir Persistence/Migrations
```

Writes run in one transaction per request behind a PostgreSQL advisory lock, so stock, capacity and workspace versions
never race. `WorkspaceRepository.SaveAsync` also checks the version in the same statement.

## Tests

`npm test` starts a throwaway PostgreSQL and runs `Encore.Api.Tests`: HTTP journeys against the real app in-process,
SMS providers with a fake gateway, and `ParityTests`, which replay golden cases recorded from the original Python rules.
