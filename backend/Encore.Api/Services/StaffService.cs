using System.Text.Json.Nodes;
using Encore.Api.Domain;
using Encore.Api.Persistence;
using Encore.Api.Repositories;
using Encore.Api.Security;
using Encore.Api.Web;

namespace Encore.Api.Services;

/// <summary>Organizer accounts and everything staff do in the admin app. Every query is scoped to the caller's workspace.</summary>
public sealed class StaffService(
    EncoreOptions options, AccountRepository accounts, WorkspaceRepository workspaces, ActivityRepository activity,
    Passwords passwords, SmsService sms, Notifier notifier, RateLimiter limiter)
{
    public const string SessionCookie = "encore_session";
    public const string SuspendedMessage = "This organization is suspended. Contact Encore support.";

    /// <summary>Which staff actions each role may take (POST /admin/api/action, field "op").</summary>
    public static readonly Dictionary<string, string[]> RoleActions = new()
    {
        ["Owner"] = ["settings", "config", "event", "menu", "table", "delete", "order_status", "checkin", "checkin_ticket", "settle", "cancel", "waiter", "stock", "staff_order", "inventory", "inventory_adjust"],
        ["Admin"] = ["settings", "config", "event", "menu", "table", "delete", "order_status", "checkin", "checkin_ticket", "settle", "cancel", "waiter", "stock", "staff_order", "inventory", "inventory_adjust"],
        ["Service"] = ["order_status", "settle", "cancel", "staff_order"],
        ["Gate"] = ["checkin", "checkin_ticket"],
    };

    // Actions whose records say which staff member did them (check-ins, stock moves, orders taken).
    private static readonly string[] SignedActions = ["checkin", "checkin_ticket", "stock", "staff_order", "menu", "cancel", "inventory", "inventory_adjust"];

    public string Cookie(string value, int? maxAge = null) =>
        Http.Cookie(options, SessionCookie, value, maxAge ?? EncoreOptions.AdminSessionDays * 86400, "Strict");

    public async Task<User> CurrentUserAsync(string? token)
    {
        var user = await accounts.UserBySessionAsync(Ids.Digest(token ?? ""), Ids.Now()) ?? throw new NotAllowed("Please sign in to continue.");
        await EnsureActiveAsync(user.TenantId);
        return user;
    }

    private async Task EnsureActiveAsync(string tenantId)
    {
        if (await workspaces.StatusAsync(tenantId) == "suspended") throw new ApiException(403, SuspendedMessage, "TENANT_SUSPENDED");
    }

    private async Task<LoadedWorkspace> WorkspaceAsync(string tenantId) =>
        await workspaces.FindAsync(tenantId) ?? throw new NotFound("Workspace not found.");

    /// <summary>What the admin app needs after sign-in and after every change.</summary>
    public async Task<JsonObject> BundleAsync(User u)
    {
        var (row, s) = await WorkspaceAsync(u.TenantId);
        var team = await accounts.TeamAsync(u.TenantId);
        return new JsonObject
        {
            ["user"] = new JsonObject { ["id"] = u.Id, ["name"] = u.Name, ["email"] = u.Email, ["role"] = u.Role, ["tenant"] = u.TenantId, ["avatar"] = u.Avatar },
            ["state"] = JsonNode.Parse(s.Serialize()),
            ["version"] = row.Version,
            ["team"] = new JsonArray([.. team.Select(m => (JsonNode?)new JsonObject
            {
                ["id"] = m.Id, ["name"] = m.Name, ["email"] = m.Email, ["role"] = m.Role, ["avatar"] = m.Avatar,
            })]),
            ["paymentReady"] = options.PaymentsReady,
            ["sms"] = sms.StatusJson(),
            ["guestOrigin"] = options.GuestOrigin,
            ["unread"] = await activity.UnreadStaffAsync(u.TenantId),
            ["ratings"] = await activity.RatingSummaryAsync(u.TenantId, recent: 5),
        };
    }

    private void LimitSignIns(string ip)
    {
        if (limiter.Limited("auth:" + ip, 30, 900)) throw new ApiException(429, "Too many attempts. Try again in 15 minutes.");
    }

    public async Task<(JsonObject Body, string Cookie)> SignInAsync(JsonObject v, string ip)
    {
        LimitSignIns(ip);
        var mail = Values.Email(v["email"]);
        var password = Values.Text(v["password"], 200);
        var u = await accounts.UserByEmailAsync(mail);
        var check = u is null ? PasswordCheck.Wrong : passwords.Verify(password, u.Password);
        if (u is null || check == PasswordCheck.Wrong) throw new NotAllowed("Email or password is incorrect.");
        await EnsureActiveAsync(u.TenantId);
        if (check == PasswordCheck.CorrectButRehash) await accounts.SetPasswordAsync(u.Id, passwords.Hash(password));
        var token = Sessions.NewToken();
        await accounts.AddSessionAsync(Ids.Digest(token), u.Id, Ids.Now() + EncoreOptions.AdminSessionDays * 86400);
        return (await BundleAsync(u), Cookie(token));
    }

    public async Task<(JsonObject Body, string Cookie)> SignUpAsync(JsonObject v, string ip)
    {
        LimitSignIns(ip);
        var mail = Values.Email(v["email"]);
        var password = Values.Text(v["password"], 200);
        if (password.Length < 12) throw new DomainException("Use a password with at least 12 characters.");
        var name = Values.Text(v["name"], 100);
        string tenantId, role = "Owner";
        if (Values.Truthy(v["invite"]))
        {
            var digest = Ids.Digest(Values.Show(v["invite"]));
            var invite = await accounts.InviteAsync(digest, Ids.Now());
            if (invite is null || invite.Email != mail) throw new DomainException("Invitation is invalid or expired.");
            (tenantId, role) = (invite.TenantId, invite.Role);
            await accounts.DeleteInviteAsync(digest);
        }
        else
        {
            var team = Values.Text(v["team"], 80);
            tenantId = Ids.Uid();
            await workspaces.CreateAsync(tenantId, WorkspaceRules.Blank(team));
        }
        var recovery = Ids.Uid();
        var u = new User
        {
            Id = Ids.Uid(), TenantId = tenantId, Name = name, Email = mail, Password = passwords.Hash(password),
            Recovery = Ids.Digest(recovery), Role = role,
        };
        await accounts.AddUserAsync(u);
        var token = Sessions.NewToken();
        await accounts.AddSessionAsync(Ids.Digest(token), u.Id, Ids.Now() + EncoreOptions.AdminSessionDays * 86400);
        var body = await BundleAsync(u);
        body["recovery"] = recovery; // shown once so the owner can store it; only its digest is kept
        return (body, Cookie(token));
    }

    /// <summary>Set a new password with the one-time recovery code. Ends every session of that account.</summary>
    public async Task<JsonObject> RecoverAsync(JsonObject v, string ip)
    {
        LimitSignIns(ip);
        var mail = Values.Email(v["email"]);
        var password = Values.Text(v["password"], 200);
        if (password.Length < 12) throw new DomainException("Use a password with at least 12 characters.");
        var u = await accounts.UserByEmailAsync(mail);
        var given = Ids.Digest(v.ContainsKey("recovery") ? Values.Show(v["recovery"]) : "");
        if (u is null || !Values.SameSecret(u.Recovery, given)) throw new NotAllowed("Recovery details do not match.");
        var recovery = Ids.Uid();
        await accounts.SetPasswordAndRecoveryAsync(u.Id, passwords.Hash(password), Ids.Digest(recovery));
        await accounts.EndSessionsForUserAsync(u.Id);
        return new JsonObject { ["recovery"] = recovery };
    }

    public Task SignOutAsync(string? token) => accounts.EndSessionAsync(Ids.Digest(token ?? ""));

    public async Task<JsonObject> ProfileAsync(User u, JsonObject v)
    {
        var name = Values.Text(v["name"], 100);
        var avatar = SettingsRules.CleanImage(v.ContainsKey("avatar") ? v["avatar"] : u.Avatar);
        await accounts.SetProfileAsync(u.Id, name, Values.Show(avatar));
        u.Name = name;
        u.Avatar = Values.Show(avatar);
        return await BundleAsync(u);
    }

    /// <summary>Change password; every session of the account ends, this one included.</summary>
    public async Task ChangePasswordAsync(User u, JsonObject v)
    {
        if (passwords.Verify(Values.Text(v["current"], 200), u.Password) == PasswordCheck.Wrong)
            throw new DomainException("Current password is incorrect.");
        var password = Values.Text(v["password"], 200);
        if (password.Length < 12) throw new DomainException("Use at least 12 characters.");
        await accounts.SetPasswordAsync(u.Id, passwords.Hash(password));
        await accounts.EndSessionsForUserAsync(u.Id);
    }

    /// <summary>Owner and Admin only. The invite link is valid for 7 days and only for the invited email.</summary>
    public async Task<JsonObject> InviteAsync(User u, JsonObject v)
    {
        if (u.Role is not ("Owner" or "Admin")) throw new NotAllowed("Only administrators can invite members.");
        var role = WorkspaceRules.Str(v["role"]);
        if (role is not ("Admin" or "Service" or "Gate")) throw new DomainException("Select a role.");
        var token = Ids.Uid();
        await accounts.AddInviteAsync(new Invite
        {
            Token = Ids.Digest(token), TenantId = u.TenantId, Email = Values.Email(v["email"]), Role = role, Expires = (int)(Ids.Now() + 604800),
        });
        return new JsonObject { ["url"] = options.AdminOrigin + "/admin/signup?invite=" + token };
    }

    /// <summary>Owner only; the owner account itself cannot be removed.</summary>
    public async Task<JsonObject> RemoveMemberAsync(User u, JsonObject v)
    {
        if (u.Role != "Owner") throw new NotAllowed("Only the workspace owner can remove members.");
        var member = WorkspaceRules.Str(v["id"]) is { } id ? await accounts.MemberAsync(id, u.TenantId) : null;
        if (member is null || member.Role == "Owner") throw new DomainException("This member cannot be removed.");
        await accounts.EndSessionsForUserAsync(member.Id);
        await accounts.DeleteUserAsync(member.Id);
        return await BundleAsync(u);
    }

    /// <summary>Owner and Admin only. PNG, JPEG or WebP up to 5 MB, checked by content, stored in PostgreSQL.</summary>
    public async Task<JsonObject> UploadAsync(User u, JsonObject v)
    {
        if (u.Role is not ("Owner" or "Admin")) throw new NotAllowed("Only administrators can upload images.");
        byte[] raw;
        try { raw = Convert.FromBase64String(v.ContainsKey("data") ? WorkspaceRules.Str(v["data"]) ?? throw new FormatException() : ""); }
        catch (FormatException) { throw new DomainException("Upload a PNG, JPEG, or WebP image."); }
        if (raw.Length > 5_000_000) throw new DomainException("Choose an image smaller than 5 MB.");
        var ext = raw.AsSpan().StartsWith(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }) ? "png"
            : raw.AsSpan().StartsWith(new byte[] { 0xFF, 0xD8, 0xFF }) ? "jpg"
            : raw.Length >= 12 && raw.AsSpan(0, 4).SequenceEqual("RIFF"u8) && raw.AsSpan(8, 4).SequenceEqual("WEBP"u8) ? "webp"
            : null;
        if (ext is null) throw new DomainException("Upload a PNG, JPEG, or WebP image.");
        var file = Ids.Uid() + "." + ext;
        await activity.AddUploadAsync(file, ext switch { "png" => "image/png", "jpg" => "image/jpeg", _ => "image/webp" }, raw);
        return new JsonObject { ["url"] = "/uploads/" + file };
    }

    /// <summary>
    /// A staff action on the workspace. The role must allow it, and the version must match what the screen last loaded,
    /// so nobody saves over a change they have not seen.
    /// </summary>
    public async Task<JsonObject> ActAsync(User u, JsonObject v)
    {
        var op = WorkspaceRules.Str(v["op"]);
        if (op is null || !RoleActions.TryGetValue(u.Role, out var allowed) || !allowed.Contains(op))
            throw new NotAllowed("Your role does not allow this action.");
        var (row, s) = await WorkspaceAsync(u.TenantId);
        var sent = v["version"];
        if (!(sent is JsonValue && sent.GetValueKind() == System.Text.Json.JsonValueKind.Number && Values.Decimal(sent) == (row.Version ?? 0)))
            throw new ApiException(409, "This workspace changed. Refresh before saving.");
        var data = v.ContainsKey("data") ? v["data"] : new JsonObject();
        if (data is JsonObject d)
        {
            d.Remove("_by");
            if (SignedActions.Contains(op)) d["_by"] = u.Name;
        }
        var notices = new List<Notice>();
        Actions.Mutate(s, op, data, notices);
        if (!await workspaces.SaveAsync(u.TenantId, s, row.Version ?? 0, default))
            throw new ApiException(409, "This workspace changed. Refresh before saving.");
        await activity.AuditAsync(u.TenantId, u.Id, op);
        var smsOrderReady = Values.Truthy(s.Settings["notifications"]!["smsOrderReady"]);
        foreach (var n in notices)
        {
            if (WorkspaceRules.Str(n.Record["guest"]) is not { Length: > 0 } guest) continue;
            var reference = WorkspaceRules.Str(n.Record["ref"]);
            await notifier.NotifyAsync(u.TenantId, "guest", n.Title, n.Body, guest, n.Kind, reference);
            if (n.Kind == "order_ready" && smsOrderReady)
                await notifier.TextGuestAsync(Values.Show(n.Record["phone"]), $"{s.Name}: {n.Body} Ref {reference}.");
        }
        var output = await BundleAsync(u);
        if (data is JsonObject result && Values.Truthy(result["result"])) output["result"] = result["result"]!.DeepClone();
        return output;
    }
}
