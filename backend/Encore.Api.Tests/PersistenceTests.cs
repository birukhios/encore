using System.Text.Json.Nodes;
using Encore.Api.Data;
using Encore.Api.Persistence;
using Encore.Api.Repositories;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Encore.Api.Tests;

/// <summary>
/// Runs against a real PostgreSQL named by DATABASE_URL (npm test starts a throwaway one).
/// Every test gets its own empty database so the tests can run in any order.
/// </summary>
public sealed class PersistenceTests : IAsyncLifetime
{
    private readonly string _name = "encore_test_" + Guid.NewGuid().ToString("N")[..12];
    private string _admin = "";
    private string _connection = "";

    public async Task InitializeAsync()
    {
        var url = Environment.GetEnvironmentVariable("DATABASE_URL")
            ?? throw new InvalidOperationException("Set DATABASE_URL to a PostgreSQL server for the .NET tests.");
        _admin = DatabaseUrl.ToConnectionString(url);
        await using (var c = new NpgsqlConnection(_admin))
        {
            await c.OpenAsync();
            await new NpgsqlCommand($"CREATE DATABASE {_name}", c).ExecuteNonQueryAsync();
        }
        _connection = new NpgsqlConnectionStringBuilder(_admin) { Database = _name }.ConnectionString;
    }

    public async Task DisposeAsync()
    {
        NpgsqlConnection.ClearAllPools();
        await using var c = new NpgsqlConnection(_admin);
        await c.OpenAsync();
        await new NpgsqlCommand($"DROP DATABASE IF EXISTS {_name} WITH (FORCE)", c).ExecuteNonQueryAsync();
    }

    private EncoreDbContext Context()
    {
        var options = new DbContextOptionsBuilder<EncoreDbContext>();
        EncoreDbContext.Configure(options, _connection);
        return new EncoreDbContext(options.Options);
    }

    private async Task Sql(string sql)
    {
        await using var c = new NpgsqlConnection(_connection);
        await c.OpenAsync();
        await new NpgsqlCommand(sql, c).ExecuteNonQueryAsync();
    }

    // The schema as an older Python release left it: no avatar, no tenant status columns.
    private const string OldPythonSchema = """
        CREATE TABLE tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL,version INTEGER DEFAULT 0);
        CREATE TABLE users(id TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,recovery TEXT NOT NULL,role TEXT NOT NULL);
        INSERT INTO tenants(id,name,state,version) VALUES('t1','Blue Note','{"name":"Blue Note","currency":"ETB","events":[{"id":"e1","title":"Late set","price":150000}],"tables":[],"menu":[],"orders":[],"bookings":[],"waiters":[],"stockLog":[],"inventory":[],"settings":{"tax":{"regime":"vat","rate":15}},"futureField":{"kept":true}}',4);
        INSERT INTO users VALUES('u1','t1','Owner','owner@example.test','scrypt$x','r','owner');
        """;

    [Fact]
    public async Task Baseline_applies_to_an_existing_python_database_without_touching_its_rows()
    {
        await Sql(OldPythonSchema);
        await using var db = Context();
        await db.Database.MigrateAsync();

        var user = await db.Users.SingleAsync();
        Assert.Equal(("t1", "owner@example.test", ""), (user.TenantId, user.Email, user.Avatar));
        var tenant = await db.Tenants.SingleAsync();
        Assert.Equal(("active", 4), (tenant.Status, tenant.Version));
        Assert.Empty(await db.Database.GetPendingMigrationsAsync());
    }

    [Fact]
    public async Task Baseline_creates_every_table_on_an_empty_database()
    {
        await using var db = Context();
        await db.Database.MigrateAsync();
        // Touching each set proves the mapping matches the tables the baseline created.
        Assert.Equal(0, await db.Tenants.CountAsync() + await db.Users.CountAsync() + await db.Sessions.CountAsync()
            + await db.Invites.CountAsync() + await db.Audit.CountAsync() + await db.Guests.CountAsync()
            + await db.GuestSessions.CountAsync() + await db.Otps.CountAsync() + await db.OtpLog.CountAsync()
            + await db.Notifications.CountAsync() + await db.Ratings.CountAsync() + await db.Uploads.CountAsync()
            + await db.PlatformAdmins.CountAsync() + await db.PlatformSessions.CountAsync() + await db.PlatformAudit.CountAsync());
        await db.Database.MigrateAsync(); // running it twice is harmless
    }

    [Fact]
    public async Task Workspace_round_trips_and_keeps_fields_dotnet_does_not_know_yet()
    {
        await Sql(OldPythonSchema);
        await using var db = Context();
        await db.Database.MigrateAsync();
        var repo = new WorkspaceRepository(db);

        var loaded = await repo.FindAsync("t1", default);
        Assert.NotNull(loaded);
        Assert.Equal(150000, (int)loaded.Document.Events[0]["price"]!);
        loaded.Document.Name = "Blue Note Addis";
        Assert.True(await repo.SaveAsync("t1", loaded.Document, 4, default));

        var saved = JsonNode.Parse((await db.Tenants.AsNoTracking().SingleAsync()).State)!;
        Assert.True((bool)saved["futureField"]!["kept"]!);
        Assert.Equal(15, (int)saved["settings"]!["tax"]!["rate"]!);
        Assert.Equal("Blue Note Addis", (await db.Tenants.AsNoTracking().SingleAsync()).Name);
    }

    [Fact]
    public async Task A_stale_save_is_refused_and_changes_nothing()
    {
        await Sql(OldPythonSchema);
        await using var db = Context();
        await db.Database.MigrateAsync();
        var repo = new WorkspaceRepository(db);
        var loaded = (await repo.FindAsync("t1", default))!;

        Assert.True(await repo.SaveAsync("t1", loaded.Document, 4, default));
        loaded.Document.Name = "Overwrite";
        Assert.False(await repo.SaveAsync("t1", loaded.Document, 4, default));

        var row = await db.Tenants.AsNoTracking().SingleAsync();
        Assert.Equal((5, "Blue Note"), (row.Version!.Value, row.Name));
    }

    [Fact]
    public async Task Missing_workspace_is_null_not_an_error()
    {
        await using var db = Context();
        await db.Database.MigrateAsync();
        Assert.Null(await new WorkspaceRepository(db).FindAsync("nope", default));
    }
}
