using Encore.Api.Persistence;
using Npgsql;

namespace Encore.Api.Tests;

public sealed class ConnectionStringTests
{
    [Fact]
    public void Render_internal_url_without_a_port()
    {
        var c = new NpgsqlConnectionStringBuilder(ConnectionString.FromUrl("postgresql://encore:p%40ss@dpg-abc-a/encore_db"));
        Assert.Equal(("dpg-abc-a", 5432, "encore", "p@ss", "encore_db"), (c.Host, c.Port, c.Username, c.Password, c.Database));
    }

    [Fact]
    public void External_url_with_port_and_ssl()
    {
        var c = new NpgsqlConnectionStringBuilder(ConnectionString.FromUrl("postgres://u:pw@db.example.com:6543/app?sslmode=require"));
        Assert.Equal(("db.example.com", 6543, "app", SslMode.Require), (c.Host, c.Port, c.Database, c.SslMode));
    }

    [Fact]
    public void Other_schemes_are_refused() =>
        Assert.Throws<ArgumentException>(() => ConnectionString.FromUrl("mysql://u:p@h/db"));
}
