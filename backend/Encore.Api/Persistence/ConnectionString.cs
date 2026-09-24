using Npgsql;

namespace Encore.Api.Persistence;

/// <summary>
/// Turns DATABASE_URL (postgres://user:password@host:port/database?sslmode=require), as Render and most hosts give it,
/// into an Npgsql connection string. A missing port means 5432; a "host" query value (a socket folder) wins over the
/// URL's host.
/// </summary>
public static class ConnectionString
{
    public static string FromUrl(string url)
    {
        var uri = new Uri(url.Trim());
        if (uri.Scheme is not ("postgres" or "postgresql"))
            throw new ArgumentException("DATABASE_URL must start with postgres:// or postgresql://.");
        var credentials = uri.UserInfo.Split(':', 2);
        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.IsDefaultPort || uri.Port <= 0 ? 5432 : uri.Port,
            Username = Uri.UnescapeDataString(credentials[0]),
            Password = credentials.Length > 1 ? Uri.UnescapeDataString(credentials[1]) : null,
            Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')) is { Length: > 0 } name ? name : "postgres",
        };
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            var value = parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : "";
            switch (parts[0].ToLowerInvariant())
            {
                case "sslmode":
                    builder.SslMode = Enum.Parse<SslMode>(value.Replace("-", ""), ignoreCase: true);
                    break;
                case "host":
                    builder.Host = value;
                    break;
            }
        }
        return builder.ConnectionString;
    }
}
