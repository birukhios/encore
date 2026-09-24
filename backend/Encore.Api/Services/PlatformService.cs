using System.Text.Json.Nodes;
using Encore.Api.Domain;
using Encore.Api.Persistence;
using Encore.Api.Repositories;
using Encore.Api.Security;
using Encore.Api.Web;
using Microsoft.EntityFrameworkCore;

namespace Encore.Api.Services;

/// <summary>
/// The platform console (/admin/platform) for Encore's own operators. Separate accounts and cookie: an organizer
/// session never opens it, and a platform session never grants organizer access.
/// </summary>
public sealed class PlatformService(
    EncoreOptions options, EncoreDbContext db, AccountRepository accounts, WorkspaceRepository workspaces,
    ActivityRepository activity, Passwords passwords, SmsService sms, RateLimiter limiter, IConfiguration config, ILogger<PlatformService> log)
{
    public const string SessionCookie = "encore_platform";

    public string Cookie(string value, int? maxAge = null) =>
        Http.Cookie(options, SessionCookie, value, maxAge ?? EncoreOptions.PlatformSessionHours * 3600, "Strict");

    public async Task<PlatformAdmin> CurrentAdminAsync(string? token) =>
        (token is { Length: > 0 } ? await accounts.PlatformAdminBySessionAsync(Ids.Digest(token), Ids.Now()) : null)
        ?? throw new NotAllowed("Sign in as a platform administrator to continue.");

    public JsonObject System() => new()
    {
        ["database"] = options.DescribeDatabase(),
        ["production"] = options.Production,
        ["sms"] = sms.StatusJson(),
        ["payments"] = new JsonObject { ["ready"] = options.PaymentsReady, ["label"] = "AfroPay not connected — online checkout is closed" },
        ["guestOrigin"] = options.GuestOrigin,
        ["adminOrigin"] = options.AdminOrigin,
        ["serverTime"] = Ids.Now(),
    };

    public JsonObject Me(PlatformAdmin a) => new()
    {
        ["admin"] = new JsonObject { ["id"] = a.Id, ["name"] = a.Name, ["email"] = a.Email },
        ["system"] = System(),
    };

    public async Task<(JsonObject Body, string Cookie)> SignInAsync(JsonObject v, string ip)
    {
        if (limiter.Limited("platform-auth:" + ip, 10, 900)) throw new ApiException(429, "Too many attempts. Try again in 15 minutes.");
        var a = await accounts.PlatformAdminByEmailAsync(Values.Email(v["email"]));
        var password = Values.Text(v["password"], 200);
        var check = a is null ? PasswordCheck.Wrong : passwords.Verify(password, a.Password);
        if (a is null || check == PasswordCheck.Wrong) throw new NotAllowed("Email or password is incorrect.");
        if (check == PasswordCheck.CorrectButRehash) await accounts.SetPlatformPasswordAsync(a.Id, passwords.Hash(password));
        var token = Sessions.NewToken();
        await accounts.AddPlatformSessionAsync(Ids.Digest(token), a.Id, Ids.Now() + EncoreOptions.PlatformSessionHours * 3600);
        await activity.PlatformAuditAsync(a.Id, "signin");
        return (Me(a), Cookie(token));
    }

    public Task SignOutAsync(string? token) => accounts.EndPlatformSessionAsync(Ids.Digest(token ?? ""));

    /// <summary>Suspending hides the organizer from guests and signs out its staff; a reason is required.</summary>
    public async Task SetTenantStatusAsync(PlatformAdmin a, JsonObject v)
    {
        var loaded = await workspaces.FindAsync(Values.Text(v["tenant"])) ?? throw new NotFound("Organization not found.");
        var status = WorkspaceRules.Str(v["status"]);
        if (status is not ("active" or "suspended")) throw new DomainException("Choose active or suspended.");
        var note = status == "suspended" ? Values.Text(v["note"], 300, false) : "";
        if (status == "suspended" && note.Length == 0) throw new DomainException("Add a reason for the suspension.");
        await workspaces.SetStatusAsync(loaded.Row.Id, status, note);
        if (status == "suspended") await accounts.EndSessionsForTenantAsync(loaded.Row.Id);
        await activity.PlatformAuditAsync(a.Id, status == "suspended" ? "suspend" : "reactivate", loaded.Row.Name, note);
    }

    /// <summary>Issues a one-time recovery code; the person sets their own password on the "Forgot password?" page.</summary>
    public async Task<JsonObject> ResetAccessAsync(PlatformAdmin a, JsonObject v)
    {
        var u = await accounts.UserAsync(Values.Text(v["user"])) ?? throw new NotFound("Account not found.");
        var recovery = Ids.Uid();
        await accounts.SetRecoveryAsync(u.Id, Ids.Digest(recovery));
        await accounts.EndSessionsForUserAsync(u.Id);
        await activity.PlatformAuditAsync(a.Id, "reset_access", u.Email);
        return new JsonObject { ["recovery"] = recovery, ["email"] = u.Email };
    }

    public async Task EndUserSessionsAsync(PlatformAdmin a, JsonObject v)
    {
        var u = await accounts.UserAsync(Values.Text(v["user"])) ?? throw new NotFound("Account not found.");
        await accounts.EndSessionsForUserAsync(u.Id);
        await activity.PlatformAuditAsync(a.Id, "end_sessions", u.Email);
    }

    /// <summary>Create or update the operator named by ENCORE_PLATFORM_EMAIL / ENCORE_PLATFORM_PASSWORD at start-up.</summary>
    public async Task BootstrapAdminAsync()
    {
        var mail = (config["ENCORE_PLATFORM_EMAIL"] ?? "").Trim().ToLowerInvariant();
        var password = config["ENCORE_PLATFORM_PASSWORD"] ?? "";
        if (mail.Length == 0) return;
        if (password.Length < 12)
        {
            log.LogWarning("ENCORE_PLATFORM_PASSWORD must be at least 12 characters; platform admin not created.");
            return;
        }
        var row = await accounts.PlatformAdminByEmailAsync(mail);
        if (row is null)
        {
            await accounts.AddPlatformAdminAsync(new PlatformAdmin
            {
                Id = Ids.Uid(), Name = (config["ENCORE_PLATFORM_NAME"] ?? "").Trim() is { Length: > 0 } n ? n : "Platform admin",
                Email = mail, Password = passwords.Hash(password), Created = (int)Ids.Now(),
            });
        }
        else if (passwords.Verify(password, row.Password) == PasswordCheck.Wrong)
        {
            await accounts.SetPlatformPasswordAsync(row.Id, passwords.Hash(password));
            await accounts.EndPlatformSessionsForAdminAsync(row.Id);
        }
    }

    /// <summary>Everything the console analyses, without secrets (password hashes, session and ticket tokens).</summary>
    public async Task<JsonObject> SnapshotAsync()
    {
        var now = Ids.Now();
        var lastSeen = await db.Sessions.AsNoTracking().GroupBy(s => s.UserId)
            .Select(g => new { User = g.Key, Last = g.Max(s => s.Expires) }).ToDictionaryAsync(x => x.User, x => (long)x.Last - EncoreOptions.AdminSessionDays * 86400L);
        var active = (await db.Sessions.AsNoTracking().Where(s => s.Expires > now).Select(s => s.UserId).Distinct().ToListAsync()).ToHashSet();
        var users = (await db.Users.AsNoTracking().OrderBy(u => u.Name).ToListAsync()).GroupBy(u => u.TenantId)
            .ToDictionary(g => g.Key, g => g.Select(u => new JsonObject
            {
                ["id"] = u.Id, ["tenant"] = u.TenantId, ["name"] = u.Name, ["email"] = u.Email, ["role"] = u.Role, ["avatar"] = u.Avatar,
                ["lastSeen"] = lastSeen.TryGetValue(u.Id, out var seen) ? seen : null, ["signedIn"] = active.Contains(u.Id),
            }).ToList());
        var ratings = await db.Ratings.AsNoTracking().GroupBy(r => r.TenantId)
            .Select(g => new { Tenant = g.Key, Count = g.Count(), Average = g.Average(r => (double)r.Stars) }).ToListAsync();

        var tenants = new JsonArray();
        var names = new Dictionary<string, string>();
        foreach (var r in await workspaces.AllAsync())
        {
            var st = WorkspaceRules.Upgrade(Workspace.Parse(r.State));
            var cfg = st.Settings;
            var records = st.Bookings.Concat(st.Orders).ToList();
            var tax = cfg["tax"]!;
            var rating = ratings.FirstOrDefault(x => x.Tenant == r.Id);
            names[r.Id] = r.Name;
            tenants.Add(new JsonObject
            {
                ["id"] = r.Id, ["name"] = r.Name, ["status"] = r.Status, ["statusNote"] = r.StatusNote, ["version"] = r.Version,
                ["created"] = r.Created != 0 ? r.Created : records.Count > 0 ? records.Min(x => Values.Long(x["created"])) : 0,
                ["currency"] = st.Currency, ["description"] = st.Description,
                ["logo"] = cfg["theme"]!["logo"]?.DeepClone(), ["city"] = cfg["profile"]!["city"]?.DeepClone(), ["address"] = cfg["profile"]!["address"]?.DeepClone(),
                ["support"] = cfg["support"]!.DeepClone(),
                ["tax"] = new JsonObject { ["regime"] = tax["regime"]?.DeepClone(), ["vatRate"] = tax["vatRate"]?.DeepClone(), ["tin"] = tax["tin"]?.DeepClone(), ["vatNumber"] = tax["vatNumber"]?.DeepClone() },
                ["events"] = new JsonArray([.. st.Events.Select(e => (JsonNode?)e.DeepClone())]),
                ["menu"] = new JsonArray([.. st.Menu.Select(e => (JsonNode?)e.DeepClone())]),
                ["tables"] = new JsonArray([.. st.Tables.Select(t => (JsonNode?)WorkspaceRules.Pick(t, "id", "name", "event"))]),
                ["bookings"] = new JsonArray([.. st.Bookings.Select(b => (JsonNode?)WithoutTokens(b))]),
                ["orders"] = new JsonArray([.. st.Orders.Select(o => (JsonNode?)WithoutTokens(o))]),
                ["team"] = new JsonArray([.. (users.TryGetValue(r.Id, out var team) ? team : []).Select(m => (JsonNode?)m.DeepClone())]),
                ["ratings"] = rating is null
                    ? new JsonObject { ["count"] = 0, ["average"] = null }
                    : new JsonObject { ["count"] = rating.Count, ["average"] = Math.Round(rating.Average, 2, MidpointRounding.ToEven) },
            });
        }

        var guests = await db.Guests.AsNoTracking().OrderByDescending(g => g.Created).ToListAsync();
        var people = users.Values.SelectMany(t => t).ToDictionary(u => (string)u["id"]!, u => (string)u["name"]!);
        var audit = await db.Audit.AsNoTracking().OrderByDescending(a => a.Id).Take(300).ToListAsync();
        var admins = await db.PlatformAdmins.AsNoTracking().ToDictionaryAsync(a => a.Id, a => a.Name);
        var platformAudit = await db.PlatformAudit.AsNoTracking().OrderByDescending(a => a.Id).Take(200).ToListAsync();
        return new JsonObject
        {
            ["tenants"] = tenants,
            ["guests"] = new JsonArray([.. guests.Select(g => (JsonNode?)new JsonObject { ["id"] = g.Id, ["name"] = g.Name, ["phone"] = g.Phone, ["created"] = g.Created })]),
            ["audit"] = new JsonArray([.. audit.Select(a => (JsonNode?)new JsonObject
            {
                ["id"] = a.Id, ["tenant"] = a.TenantId, ["user"] = a.UserId, ["action"] = a.Action, ["created"] = a.Created,
                ["tenantName"] = a.TenantId is not null && names.TryGetValue(a.TenantId, out var tn) ? tn : "—",
                ["who"] = a.UserId is not null && people.TryGetValue(a.UserId, out var who) ? who : (a.UserId ?? "").StartsWith("guest:") ? "Guest" : "—",
            })]),
            ["platformAudit"] = new JsonArray([.. platformAudit.Select(a => (JsonNode?)new JsonObject
            {
                ["id"] = a.Id, ["admin"] = a.AdminId, ["action"] = a.Action, ["target"] = a.Target, ["detail"] = a.Detail, ["created"] = a.Created,
                ["who"] = admins.TryGetValue(a.AdminId, out var name) ? name : "—",
            })]),
            ["system"] = System(),
            ["counts"] = new JsonObject
            {
                ["otpsLastDay"] = await db.OtpLog.CountAsync(l => l.Created > now - 86400),
                ["guestSessions"] = await db.GuestSessions.CountAsync(s => s.Expires > now),
                ["staffSessions"] = active.Count,
                ["uploads"] = await db.Uploads.CountAsync(),
            },
        };
    }

    private static JsonObject WithoutTokens(JsonObject rec)
    {
        var copy = rec.DeepClone().AsObject();
        copy.Remove("token");
        if (copy["tickets"] is JsonArray tickets)
            foreach (var t in tickets.OfType<JsonObject>()) t.Remove("token");
        return copy;
    }
}
