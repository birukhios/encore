using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Encore.Api.Web;

/// <summary>
/// Everything Encore reads from the environment. Names are unchanged from the Python server, so a Render service
/// or a local .env keeps working. Read once at start-up, except SMS settings, which SmsService reads on each use.
/// </summary>
public sealed class EncoreOptions
{
    public required bool Production { get; init; }
    public required string AdminOrigin { get; init; }
    public required string GuestOrigin { get; init; }
    public required bool TrustProxy { get; init; }
    /// <summary>Contract tests create many accounts from one address; this lifts rate limits. Never honoured in production.</summary>
    public required bool TestMode { get; init; }
    public required string DataDir { get; init; }
    public required string WebRoot { get; init; }
    public required string DatabaseUrl { get; init; }
    private readonly string? _secret;
    private byte[]? _secretBytes;

    /// <summary>Online card/wallet payments (AfroPay) are not connected yet: checkout fails closed until they are.</summary>
    public bool PaymentsReady => false;

    public const int AdminSessionDays = 7, GuestSessionDays = 30, PlatformSessionHours = 12;

    public EncoreOptions(string? secret = null) => _secret = secret;

    public static EncoreOptions From(IConfiguration config)
    {
        string Get(string name) => (config[name] ?? "").Trim();
        var production = Get("ENCORE_ENV") == "production";
        var port = Get("PORT") is { Length: > 0 } p ? p : "8080";
        var publicOrigin = (Get("PUBLIC_ORIGIN") is { Length: > 0 } o ? o : Get("RENDER_EXTERNAL_URL")).TrimEnd('/');
        if (publicOrigin.Length == 0) publicOrigin = $"http://127.0.0.1:{port}";
        var root = FindRoot(Get("ENCORE_ROOT"));
        return new EncoreOptions(Get("ENCORE_SECRET") is { Length: > 0 } s ? s : null)
        {
            Production = production,
            // One origin serves both apps (guest at /, organizer admin at /admin). The dev servers override these.
            AdminOrigin = (Get("ADMIN_ORIGIN") is { Length: > 0 } a ? a : publicOrigin).TrimEnd('/'),
            GuestOrigin = (Get("GUEST_ORIGIN") is { Length: > 0 } g ? g : publicOrigin).TrimEnd('/'),
            TrustProxy = Get("TRUST_PROXY") == "1",
            TestMode = Get("ENCORE_TEST_MODE") == "1" && !production,
            DataDir = Get("ENCORE_DATA") is { Length: > 0 } d ? d : Path.Combine(root, "data"),
            WebRoot = Path.Combine(root, "dist"),
            DatabaseUrl = Get("DATABASE_URL"),
        };
    }

    /// <summary>Key for hashing one-time codes: ENCORE_SECRET, else a generated key file in the data directory.</summary>
    public byte[] Secret()
    {
        if (_secretBytes is not null) return _secretBytes;
        if (_secret is not null) return _secretBytes = Encoding.UTF8.GetBytes(_secret);
        Directory.CreateDirectory(DataDir);
        var path = Path.Combine(DataDir, "secret.key");
        if (!File.Exists(path))
        {
            File.WriteAllBytes(path, RandomNumberGenerator.GetBytes(32));
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        return _secretBytes = File.ReadAllBytes(path);
    }

    public bool DatabaseConfigured => DatabaseUrl.StartsWith("postgres://", StringComparison.Ordinal) || DatabaseUrl.StartsWith("postgresql://", StringComparison.Ordinal);

    /// <summary>Where the data lives, without credentials: postgresql://user:pass@host:5432/name -> host:5432/name.</summary>
    public string DescribeDatabase()
    {
        if (DatabaseUrl.Length == 0) return "PostgreSQL (not configured)";
        var tail = DatabaseUrl.Split('@')[^1].Split('?')[0].TrimStart('/');
        return $"PostgreSQL ({(tail.Length > 0 ? tail : "local socket")})";
    }

    /// <summary>The repository root (holds dist/ and data/): ENCORE_ROOT, else the nearest folder with package.json.</summary>
    private static string FindRoot(string configured)
    {
        if (configured.Length > 0) return configured;
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
                if (File.Exists(Path.Combine(dir.FullName, "package.json"))) return dir.FullName;
        return Directory.GetCurrentDirectory();
    }

    /// <summary>
    /// Read KEY=VALUE lines from .env so local runs need no shell setup. Real environment variables always win, so
    /// hosts such as Render are unaffected. Quoted values are kept exactly; unquoted "  # note" is a comment. Never commit .env.
    /// </summary>
    public static int LoadEnvFile(string path, bool honourSkip = true)
    {
        if ((honourSkip && Environment.GetEnvironmentVariable("ENCORE_SKIP_DOTENV") == "1") || !File.Exists(path)) return 0;
        var loaded = 0;
        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#') || !line.Contains('=')) continue;
            var key = line[..line.IndexOf('=')].Trim();
            var value = line[(line.IndexOf('=') + 1)..].Trim();
            if (value.Length > 1 && (value[0] is '"' or '\'') && value[^1] == value[0]) value = value[1..^1];
            else value = InlineComment.Split(value, 2)[0].Trim();
            if (key.Length > 0 && Environment.GetEnvironmentVariable(key) is null)
            {
                Environment.SetEnvironmentVariable(key, value);
                loaded++;
            }
        }
        return loaded;
    }

    private static readonly Regex InlineComment = new(@"\s+#");

    /// <summary>
    /// Settings problems. Blocking ones stop the server from starting; SMS problems are warnings, because the rest of
    /// Encore works and guest sign-in fails closed with a clear message until SMS is fixed.
    /// </summary>
    public List<(string Message, bool Blocking)> ProductionProblems(Services.SmsService sms)
    {
        var problems = new List<(string, bool)>();
        if (!DatabaseConfigured) problems.Add(("DATABASE_URL must be a PostgreSQL connection string; Encore has no other database.", true));
        if (!Production) return problems;
        foreach (var (name, origin) in new[] { ("ADMIN_ORIGIN", AdminOrigin), ("GUEST_ORIGIN", GuestOrigin) })
            if (!origin.StartsWith("https://", StringComparison.Ordinal)) problems.Add(($"{name} must be an https:// origin in production.", true));
        if (_secret is null) problems.Add(("ENCORE_SECRET must be set in production (32+ random bytes, base64 or hex).", true));
        var status = sms.Status();
        if (!status.Delivers) problems.Add(($"SMS is not delivering ({status.Label}); guests cannot sign in.", false));
        return problems;
    }
}
