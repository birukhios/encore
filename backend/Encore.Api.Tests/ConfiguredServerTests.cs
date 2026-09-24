using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Encore.Api.Web;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Encore.Api.Tests;

public sealed class PlatformApp : EncoreApp
{
    public const string Email = "operator@encore.test";
    public const string Secret = "platform-test-password-1";
    protected override Dictionary<string, string> Settings() => new() { ["ENCORE_PLATFORM_EMAIL"] = Email, ["ENCORE_PLATFORM_PASSWORD"] = Secret };
}

/// <summary>The platform console: separate accounts, suspension, access resets, and no secrets in its data.</summary>
public sealed class PlatformConsoleTests(PlatformApp app) : ServerTest(app), IClassFixture<PlatformApp>
{
    [Fact]
    public async Task Console_suspension_and_access_reset()
    {
        var (c, b, mail, pw) = await Staff();
        var tenant = Tenant(b);
        var e = await Concert(c);
        var (g, _) = await GuestClient("Platform Guest");
        await Act(c, "config", new { group = "payments", values = new { cash = true, ticketCash = true } });
        Assert.Equal(201, await g.Status("order", new { tenant, kind = "booking", @event = (string)e["id"]!, qty = 1, payment = "cash" }));

        var platform = App.Admin();
        Assert.Equal(401, await platform.Status("platform/data"));
        Assert.Equal(401, await c.Status("platform/data")); // organizer sessions never open the console
        Assert.Equal(401, await platform.Status("platform/signin", new { email = PlatformApp.Email, password = "wrong-password" }));
        Assert.Equal(200, await platform.Status("platform/signin", new { email = PlatformApp.Email, password = PlatformApp.Secret }));
        Assert.Equal(200, await c.Status("me"));
        var staffOnPlatformCookie = App.Admin();
        staffOnPlatformCookie.Cookies = new(platform.Cookies);
        Assert.Equal(401, await staffOnPlatformCookie.Status("me")); // and a console session is not an organizer session

        var (status, data) = await platform.Call("platform/data");
        Assert.Equal(200, status);
        var mine = data["tenants"]!.AsArray().First(t => (string)t!["id"]! == tenant)!;
        Assert.Equal("cash", (string)mine["bookings"]![0]!["settlement"]!);
        Assert.Equal(mail, (string)mine["team"]![0]!["email"]!);
        var raw = data.ToJsonString();
        foreach (var secret in new[] { "\"token\"", "\"password\"", "\"recovery\"" }) Assert.DoesNotContain(secret, raw);

        Assert.Equal(400, await platform.Status("platform/tenant/status", new { tenant, status = "suspended", note = "" }));
        Assert.Equal(200, await platform.Status("platform/tenant/status", new { tenant, status = "suspended", note = "Review" }));
        Assert.Equal(401, await c.Status("me")); // staff sessions ended
        var (refused, why) = await App.Admin().Call("signin", new { email = mail, password = pw });
        Assert.Equal((403, "TENANT_SUSPENDED"), (refused, (string)why["code"]!));
        Assert.DoesNotContain((await g.Call("workspaces")).Body.AsArray(), w => (string)w!["id"]! == tenant);
        Assert.Equal(404, await g.Status("public?tenant=" + tenant));

        Assert.Equal(200, await platform.Status("platform/tenant/status", new { tenant, status = "active" }));
        Assert.Equal(200, await App.Admin().Status("signin", new { email = mail, password = pw }));
        Assert.Contains((await g.Call("workspaces")).Body.AsArray(), w => (string)w!["id"]! == tenant);
        var actions = (await platform.Call("platform/data")).Body["platformAudit"]!.AsArray().Select(a => (string)a!["action"]!).Take(3);
        Assert.Equal(["reactivate", "suspend", "signin"], actions);

        var userId = (string)mine["team"]![0]!["id"]!;
        Assert.Equal(401, await App.Admin().Status("platform/user/reset", new { user = userId }));
        var (resetStatus, reset) = await platform.Call("platform/user/reset", new { user = userId });
        Assert.Equal((200, mail), (resetStatus, (string)reset["email"]!));
        var fresh = Password();
        var anon = App.Admin();
        Assert.Equal(401, await anon.Status("recover", new { email = mail, password = fresh, recovery = "old-or-wrong" }));
        Assert.Equal(200, await anon.Status("recover", new { email = mail, password = fresh, recovery = (string)reset["recovery"]! }));
        Assert.Equal(200, await anon.Status("signin", new { email = mail, password = fresh }));
        Assert.Equal("reset_access", (string)(await platform.Call("platform/data")).Body["platformAudit"]![0]!["action"]!);
        await platform.Call("platform/signout", new { });
        Assert.Equal(401, await platform.Status("platform/data"));
    }

    [Fact]
    public async Task Accounts_from_the_python_server_sign_in_and_are_upgraded()
    {
        var (_, _, mail, _) = await Staff();
        // The hash format every account created by the Python server has (scrypt), for "test-only password é".
        const string legacy = "9d2df13d3a359e51ff945e14462c972c:b197a825e86db49348952871e05c7d33ab8057cc375179e13a58986aa081486858d2491379975408999366d75ef5ccafe655a1c47ab8473faada4ad8bca8cd8f";
        await App.Scoped(async sp =>
        {
            var db = sp.GetRequiredService<Persistence.EncoreDbContext>();
            return await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE users SET password={legacy} WHERE email={mail}");
        });
        Assert.Equal(200, await App.Admin().Status("signin", new { email = mail, password = "test-only password é" }));
        var stored = await App.Scoped(sp => Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.SingleAsync(
            sp.GetRequiredService<Persistence.EncoreDbContext>().Users, u => u.Email == mail));
        Assert.DoesNotContain(':', stored.Password); // re-hashed with ASP.NET Core Identity
        Assert.Equal(200, await App.Admin().Status("signin", new { email = mail, password = "test-only password é" }));
    }
}

/// <summary>An SMS provider is chosen but its credentials are missing: sign-in fails closed with a clear message.</summary>
public sealed class UnconfiguredSmsApp : EncoreApp
{
    protected override Dictionary<string, string> Settings() => new() { ["SMS_PROVIDER"] = "twilio" };
}

public sealed class SmsNotConfiguredTests(UnconfiguredSmsApp app) : ServerTest(app), IClassFixture<UnconfiguredSmsApp>
{
    [Fact]
    public async Task Sign_in_fails_closed_without_a_provider()
    {
        var (status, body) = await App.Guest().Call("guest/otp", new { phone = "0933000111" });
        Assert.Equal((503, "SMS_NOT_CONFIGURED"), (status, (string)body["code"]!));
        Assert.False((bool)(await App.Guest().Call("health")).Body["sms"]!);
    }
}

/// <summary>AfroMessage stand-in: rejects /send, or issues and verifies challenge codes, as the test configures it.</summary>
public sealed class FakeAfroMessage : HttpMessageHandler
{
    public List<Uri> Requests { get; } = [];
    public Func<Uri, (HttpStatusCode, string)> Reply { get; set; } = _ => (HttpStatusCode.OK, """{"acknowledge":"success","response":{}}""");

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        lock (Requests) Requests.Add(request.RequestUri!);
        var (status, body) = Reply(request.RequestUri!);
        return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
    }
}

public sealed class AfroMessageApp : EncoreApp
{
    public FakeAfroMessage Gateway { get; } = new();
    protected override Dictionary<string, string> Settings() => new()
    {
        ["SMS_PROVIDER"] = "afromessage", ["AFROMESSAGE_TOKEN"] = "test-token", ["AFROMESSAGE_CHALLENGE"] = "1",
    };
    protected override HttpMessageHandler? SmsGateway() => Gateway;
}

public sealed class AfroMessageSignInTests(AfroMessageApp app) : ServerTest(app), IClassFixture<AfroMessageApp>
{
    private FakeAfroMessage Gateway => ((AfroMessageApp)App).Gateway;

    [Fact]
    public async Task The_provider_issues_and_verifies_the_code_and_encore_never_stores_it()
    {
        Gateway.Reply = uri => uri.AbsolutePath switch
        {
            "/api/challenge" => (HttpStatusCode.OK, """{"acknowledge":"success","response":{"code":"A1B2C3","verificationId":"vid-42"}}"""),
            "/api/verify" when uri.Query.Contains("code=A1B2C3") && uri.Query.Contains("vc=vid-42") => (HttpStatusCode.OK, """{"acknowledge":"success","response":{}}"""),
            _ => (HttpStatusCode.OK, """{"acknowledge":"error","response":{"errors":["code not found"]}}"""),
        };
        var g = App.Guest();
        Assert.Equal(200, await g.Status("guest/otp", new { phone = "0966 123 123" }));
        var stored = await App.Scoped(sp => Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.SingleAsync(
            sp.GetRequiredService<Persistence.EncoreDbContext>().Otps, o => o.Phone == "+251966123123"));
        Assert.Equal("provider:vid-42", stored.Code); // the code itself is never stored
        Assert.Equal(400, await g.Status("guest/verify", new { phone = "0966123123", code = "WRONG1" }));
        var (status, body) = await g.Call("guest/verify", new { phone = "0966123123", code = "A1B2C3", name = "Provider Guest", acceptTerms = true });
        Assert.Equal((200, "Provider Guest"), (status, (string)body["guest"]!["name"]!));
        Assert.Equal("+251966123123", (string)(await g.Call("guest/me")).Body["guest"]!["phone"]!);
        Assert.Equal(2, Gateway.Requests.Count(u => u.AbsolutePath == "/api/verify"));
    }

    [Fact]
    public async Task A_refused_message_is_logged_for_operators_without_the_number_or_the_reason_reaching_the_guest()
    {
        Gateway.Reply = _ => (HttpStatusCode.Forbidden, "invalid sender name");
        var (status, body) = await App.Guest().Call("guest/otp", new { phone = "0955 123 456" });
        Assert.Equal((502, "SMS_FAILED"), (status, (string)body["code"]!));
        string logged;
        lock (App.Logs) logged = string.Join("\n", App.Logs);
        Assert.Contains("invalid sender name", logged);             // operators see the provider's reason
        Assert.DoesNotContain("955123456", logged);                 // the full number does not reach the log
        Assert.DoesNotContain("invalid sender", (string)body["error"]!); // nor does the reason reach the guest
    }
}

/// <summary>.env loading, without touching variables other tests use.</summary>
public sealed class EnvFileTests
{
    [Fact]
    public void Env_file_fills_gaps_without_overriding()
    {
        var key = "ENCORE_T_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();
        var path = Path.Combine(Directory.CreateTempSubdirectory().FullName, ".env");
        File.WriteAllText(path, $"# comment\n{key}_TOKEN=\"from-file\"\n{key}_ENV=production\nbroken line\n{key}_PORT=8081   # organizer admin\n{key}_SECRET=\"keeps # inside quotes\"\n");
        Environment.SetEnvironmentVariable(key + "_ENV", "development"); // a real variable must win
        try
        {
            Assert.Equal(3, EncoreOptions.LoadEnvFile(path, honourSkip: false));
            Assert.Equal("from-file", Environment.GetEnvironmentVariable(key + "_TOKEN"));
            Assert.Equal("development", Environment.GetEnvironmentVariable(key + "_ENV"));
            Assert.Equal("8081", Environment.GetEnvironmentVariable(key + "_PORT"));                     // inline comments are stripped
            Assert.Equal("keeps # inside quotes", Environment.GetEnvironmentVariable(key + "_SECRET")); // quoted values keep theirs
            Assert.Equal(0, EncoreOptions.LoadEnvFile(path + ".missing", honourSkip: false));
        }
        finally
        {
            foreach (var suffix in new[] { "_TOKEN", "_ENV", "_PORT", "_SECRET" }) Environment.SetEnvironmentVariable(key + suffix, null);
        }
    }
}
