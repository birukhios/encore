using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Encore.Api.Persistence;
using Npgsql;

namespace Encore.Api.Tests;

internal static class TestSetup
{
    // A developer's .env must never change what the tests prove.
    [ModuleInitializer]
    internal static void SkipDotEnv() => Environment.SetEnvironmentVariable("ENCORE_SKIP_DOTENV", "1");

    public static string DatabaseUrl() => Environment.GetEnvironmentVariable("DATABASE_URL")
        ?? throw new InvalidOperationException("Set DATABASE_URL to a PostgreSQL server for the .NET tests (npm test does this).");
}

/// <summary>
/// The real application in-process, on its own empty PostgreSQL database, with SMS written to a file instead of sent.
/// Subclasses change settings (SMS provider, platform operator) or fake an SMS gateway.
/// </summary>
public class EncoreApp : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly string _database = "encore_it_" + Guid.NewGuid().ToString("N")[..12];
    private readonly string _folder = Directory.CreateTempSubdirectory("encore-it-").FullName;
    private string _admin = "";
    public string SmsFile => Path.Combine(_folder, "sms.jsonl");
    public List<string> Logs { get; } = [];

    protected virtual Dictionary<string, string> Settings() => [];
    protected virtual HttpMessageHandler? SmsGateway() => null;

    public async Task InitializeAsync()
    {
        _admin = ConnectionString.FromUrl(TestSetup.DatabaseUrl());
        await using var c = new NpgsqlConnection(_admin);
        await c.OpenAsync();
        await new NpgsqlCommand($"CREATE DATABASE {_database}", c).ExecuteNonQueryAsync();
        // Stand-ins for the built web apps, so page routing and the CSP header can be checked without a build.
        Directory.CreateDirectory(Path.Combine(_folder, "dist", "assets"));
        await File.WriteAllTextAsync(Path.Combine(_folder, "dist", "admin.html"), "<html><script>window.app='admin'</script><div>src/admin</div></html>");
        await File.WriteAllTextAsync(Path.Combine(_folder, "dist", "guest.html"), "<html><div>src/guest</div></html>");
        await File.WriteAllTextAsync(Path.Combine(_folder, "dist", "assets", "app.js"), new string('x', 4000));
        await File.WriteAllTextAsync(SmsFile, "");
        _ = Server; // start now, so migrations run before the first test
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var connection = new NpgsqlConnectionStringBuilder(_admin) { Database = _database };
        var settings = new Dictionary<string, string>
        {
            ["DATABASE_URL"] = $"postgresql://{Uri.EscapeDataString(connection.Username ?? "")}:{Uri.EscapeDataString(connection.Password ?? "")}@{connection.Host}:{connection.Port}/{_database}",
            ["SMS_PROVIDER"] = "file",
            ["SMS_FILE"] = SmsFile,
            ["ENCORE_TEST_MODE"] = "1",
            ["ENCORE_ROOT"] = _folder,
            ["ENCORE_DATA"] = Path.Combine(_folder, "data"),
            ["PUBLIC_ORIGIN"] = "http://localhost",
        };
        foreach (var (k, v) in Settings()) settings[k] = v;
        foreach (var (k, v) in settings) builder.UseSetting(k, v);
        builder.UseEnvironment("Testing");
        builder.ConfigureTestServices(services =>
        {
            services.AddLogging(l => l.AddProvider(new ListLogger(Logs)));
            if (SmsGateway() is { } gateway) services.AddHttpClient("sms").ConfigurePrimaryHttpMessageHandler(() => gateway);
        });
    }

    public Client Admin() => new(CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false, AllowAutoRedirect = false }), "/admin/api/");

    public Client Guest() => new(CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false, AllowAutoRedirect = false }), "/api/");

    public HttpClient Raw() => CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false, AllowAutoRedirect = false });

    /// <summary>Messages the server has "sent", oldest first.</summary>
    public List<(string Phone, string Text)> Sent() =>
        File.ReadAllLines(SmsFile).Where(l => l.Trim().Length > 0)
            .Select(l => JsonNode.Parse(l)!).Select(m => ((string)m["phone"]!, (string)m["text"]!)).ToList();

    /// <summary>The newest sign-in code texted to this number.</summary>
    public string CodeFor(string phone)
    {
        var text = Sent().Last(m => m.Phone == phone).Text;
        return Regex.Match(text, @"\b(\d{6})\b").Groups[1].Value;
    }

    public async Task<T> Scoped<T>(Func<IServiceProvider, Task<T>> work)
    {
        using var scope = Services.CreateScope();
        return await work(scope.ServiceProvider);
    }

    public new async Task DisposeAsync()
    {
        await base.DisposeAsync();
        NpgsqlConnection.ClearAllPools();
        await using var c = new NpgsqlConnection(_admin);
        await c.OpenAsync();
        await new NpgsqlCommand($"DROP DATABASE IF EXISTS {_database} WITH (FORCE)", c).ExecuteNonQueryAsync();
        try { Directory.Delete(_folder, true); } catch (IOException) { }
    }

    private sealed class ListLogger(List<string> lines) : ILoggerProvider, ILogger
    {
        public ILogger CreateLogger(string categoryName) => this;
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            lock (lines) lines.Add(formatter(state, exception));
        }
        public void Dispose() { }
    }
}

/// <summary>A browser tab: keeps its own cookies and talks to one app (admin or guest).</summary>
public sealed class Client(HttpClient http, string prefix)
{
    public Dictionary<string, string> Cookies { get; set; } = [];

    /// <summary>GET without data, POST with it. Returns the status and the parsed JSON reply.</summary>
    public async Task<(int Status, JsonNode Body)> Call(string path, object? data = null, string? origin = null)
    {
        using var request = new HttpRequestMessage(data is null ? HttpMethod.Get : HttpMethod.Post, prefix + path);
        if (data is not null)
            request.Content = new StringContent(data is JsonNode n ? n.ToJsonString() : JsonSerializer.Serialize(data), Encoding.UTF8, "application/json");
        if (Cookies.Count > 0) request.Headers.Add("Cookie", string.Join("; ", Cookies.Select(c => $"{c.Key}={c.Value}")));
        if (origin is not null) request.Headers.Add("Origin", origin);
        using var response = await http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        if (response.Headers.TryGetValues("Set-Cookie", out var cookies))
            foreach (var cookie in cookies)
            {
                var pair = cookie.Split(';')[0].Split('=', 2);
                if (pair[1].Length > 0) Cookies[pair[0]] = pair[1];
                else Cookies.Remove(pair[0]);
            }
        return ((int)response.StatusCode, JsonNode.Parse(text.Length > 0 ? text : "null") ?? JsonValue.Create("")!);
    }

    public async Task<int> Status(string path, object? data = null, string? origin = null) => (await Call(path, data, origin)).Status;
}

/// <summary>Shared steps from the old Python suite: sign up an organizer, act on the workspace, sign in a guest.</summary>
public abstract class ServerTest(EncoreApp app)
{
    protected EncoreApp App => app;

    protected static string Password() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(18));

    protected async Task<(Client Client, JsonNode Body, string Mail, string Password)> Staff()
    {
        var c = app.Admin();
        var pw = Password();
        var mail = Convert.ToHexString(RandomNumberGenerator.GetBytes(5)).ToLowerInvariant() + "@example.com";
        var (status, body) = await c.Call("signup", new { name = "Test Organizer", team = "Test Workspace", email = mail, password = pw });
        Assert.Equal(201, status);
        return (c, body, mail, pw);
    }

    protected static async Task<(int Status, JsonNode Body)> Act(Client c, string op, object data)
    {
        var me = (await c.Call("me")).Body;
        Assert.NotNull(me["version"]);
        return await c.Call("action", new JsonObject { ["op"] = op, ["version"] = me["version"]!.DeepClone(), ["data"] = (data as JsonNode)?.DeepClone() ?? JsonSerializer.SerializeToNode(data) });
    }

    protected async Task<(Client Client, JsonNode Guest)> GuestClient(string name = "Guest")
    {
        var g = app.Guest();
        var phone = "09" + string.Concat(Enumerable.Range(0, 8).Select(_ => RandomNumberGenerator.GetInt32(10)));
        var (status, reply) = await g.Call("guest/otp", new { phone });
        Assert.Equal(200, status);
        var code = app.CodeFor((string)reply["phone"]!);
        Assert.Equal("""{"needsName":true}""", (await g.Call("guest/verify", new { phone, code })).Body.ToJsonString());
        var (ok, body) = await g.Call("guest/verify", new { phone, code, name, acceptTerms = true });
        Assert.Equal(200, ok);
        return (g, body["guest"]!);
    }

    protected static async Task<JsonNode> Concert(Client c, int capacity = 10, string price = "100")
    {
        await Act(c, "event", new { name = "Show", description = "Live", date = "2026-11-02T18:00", venue = "Hall", price, capacity, published = true });
        return (await c.Call("me")).Body["state"]!["events"]!.AsArray()[^1]!;
    }

    protected static async Task<JsonNode> State(Client c) => (await c.Call("me")).Body["state"]!;

    protected static string Tenant(JsonNode signup) => (string)signup["user"]!["tenant"]!;
}

[CollectionDefinition("server")]
public sealed class ServerCollection : ICollectionFixture<EncoreApp>;
