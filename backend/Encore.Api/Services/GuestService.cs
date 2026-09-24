using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Encore.Api.Domain;
using Encore.Api.Persistence;
using Encore.Api.Repositories;
using Encore.Api.Web;

namespace Encore.Api.Services;

/// <summary>The guest app: phone sign-in, browsing organizers, table QR codes, quotes, orders and ratings.</summary>
public sealed partial class GuestService(
    EncoreOptions options, GuestRepository guests, WorkspaceRepository workspaces, ActivityRepository activity,
    SmsService sms, Notifier notifier, RateLimiter limiter, RequestTransaction tx, ILogger<GuestService> log)
{
    public const string SessionCookie = "encore_guest";
    private const string ProviderCode = "provider:"; // marks a code the SMS provider generated and will verify
    private const int OtpTtl = 300, OtpResend = 60, OtpMaxAttempts = 5;

    // Lax so the session survives opening a table QR link from the phone's camera app.
    public string Cookie(string value, int? maxAge = null) =>
        Http.Cookie(options, SessionCookie, value, maxAge ?? EncoreOptions.GuestSessionDays * 86400, "Lax");

    public async Task<Guest?> CurrentGuestAsync(string? token, bool required = true)
    {
        var g = token is { Length: > 0 } ? await guests.GuestBySessionAsync(Ids.Digest(token), Ids.Now()) : null;
        if (g is null && required) throw new NotAllowed("Sign in with your phone number to continue.");
        return g;
    }

    public static JsonObject Describe(Guest g) => new() { ["id"] = g.Id, ["name"] = g.Name, ["phone"] = g.Phone };

    private static JsonObject AsRecordOwner(Guest g) => Describe(g);

    private async Task<LoadedWorkspace> WorkspaceAsync(string tenantId) =>
        await workspaces.FindAsync(tenantId) ?? throw new NotFound("Workspace not found.");

    /// <summary>A workspace guests may book or order with; suspended organizations are hidden.</summary>
    private async Task<LoadedWorkspace> OpenWorkspaceAsync(string tenantId)
    {
        var loaded = await WorkspaceAsync(tenantId);
        if (loaded.Row.Status == "suspended") throw new NotFound("This organizer is not available right now.");
        return loaded;
    }

    // ------------------------------------------------ browsing

    public async Task<JsonArray> DirectoryAsync()
    {
        var output = new JsonArray();
        foreach (var r in await workspaces.ActiveAsync())
        {
            var st = WorkspaceRules.Upgrade(Workspace.Parse(r.State));
            var profile = st.Settings["profile"]!;
            var theme = st.Settings["theme"]!;
            var published = st.Events.Where(e => Values.Truthy(e["published"])).OrderBy(e => WorkspaceRules.Str(e["date"]), StringComparer.Ordinal).ToList();
            var photos = profile["photos"] as JsonArray ?? [];
            output.Add(new JsonObject
            {
                ["id"] = r.Id, ["name"] = r.Name, ["description"] = st.Description, ["logo"] = theme["logo"]?.DeepClone(),
                ["photo"] = photos.Count > 0 ? photos[0]?.DeepClone() : theme["cover"]?.DeepClone(),
                ["city"] = profile["city"]?.DeepClone(), ["address"] = profile["address"]?.DeepClone(),
                ["events"] = published.Count,
                ["nextEvents"] = new JsonArray([.. published.Take(3).Select(e => (JsonNode?)WorkspaceRules.Pick(e, "id", "name", "date", "venue", "price", "image"))]),
                ["currency"] = st.Currency, ["rating"] = await activity.RatingSummaryAsync(r.Id), ["mapLink"] = WorkspaceRules.MapLink(st),
            });
        }
        return output;
    }

    public async Task<JsonObject> PublicAsync(string tenantId, string? table, string? token)
    {
        var (row, s) = await OpenWorkspaceAsync(tenantId);
        var output = WorkspaceRules.PublicState(s);
        output["id"] = row.Id;
        output["paymentReady"] = options.PaymentsReady;
        var viewer = await CurrentGuestAsync(token, required: false);
        output["ratings"] = await activity.RatingSummaryAsync(row.Id, viewer?.Id, recent: 6);
        output["table"] = null;
        if (!string.IsNullOrEmpty(table))
        {
            var t = Pricing.FindTable(s, token: table) ?? throw new NotFound("This table link is invalid. Ask your host for a new QR code.");
            output["table"] = WorkspaceRules.Pick(t, "id", "name", "event", "status");
        }
        return output;
    }

    /// <summary>Find a table by the code printed under its QR, or by its token.</summary>
    public async Task<JsonObject> TableAsync(string tenantId, string? code, string? token, string ip)
    {
        if (limiter.Limited("table:" + ip, 30, 600)) throw new ApiException(429, "Too many attempts. Please wait a few minutes.");
        var (_, s) = await OpenWorkspaceAsync(tenantId);
        var t = (!string.IsNullOrEmpty(code) ? Pricing.FindTable(s, code: code) : Pricing.FindTable(s, token: token ?? ""))
            ?? throw new NotFound("We could not find that table. Check the code printed under the QR.");
        return new JsonObject { ["token"] = t["token"]?.DeepClone(), ["name"] = t["name"]?.DeepClone(), ["event"] = t["event"]?.DeepClone(), ["status"] = t["status"]?.DeepClone() };
    }

    /// <summary>A receipt link works for anyone holding its secret token, signed in or not.</summary>
    public async Task<JsonObject> ReceiptAsync(string tenantId, string reference, string token)
    {
        var (_, s) = await WorkspaceAsync(tenantId);
        var rec = s.Orders.Concat(s.Bookings).FirstOrDefault(r =>
            WorkspaceRules.Str(r["ref"]) == reference && token.Length > 0 && Values.SameSecret(WorkspaceRules.Str(r["token"]) ?? "", token))
            ?? throw new NotFound("We could not find that receipt. Check the link from your confirmation.");
        return WorkspaceRules.Receipt(s, rec);
    }

    public async Task<JsonObject> RecordsAsync(Guest g, string tenantId)
    {
        var (_, s) = await WorkspaceAsync(tenantId);
        var records = s.Bookings.Concat(s.Orders).Where(r => WorkspaceRules.Str(r["guest"]) == g.Id)
            .Select(r => WorkspaceRules.Receipt(s, r)).OrderByDescending(r => Values.Long(r["created"])).ToList();
        return new JsonObject
        {
            ["records"] = new JsonArray([.. records.Select(r => (JsonNode?)r)]),
            ["events"] = new JsonArray([.. Pricing.GuestEventIds(s, g.Id).Order(StringComparer.Ordinal).Select(e => (JsonNode?)e)]),
        };
    }

    public Task<JsonArray> NotificationsAsync(Guest g) => activity.GuestNotificationsAsync(g.Id);

    // ------------------------------------------------ sign-in with a code sent by SMS

    public async Task<JsonObject> SendCodeAsync(JsonObject v, string ip)
    {
        var phone = Values.NormalizePhone(v["phone"]);
        var now = Ids.Now();
        if (limiter.Limited("otp-ip:" + ip, 20, 3600)) throw new ApiException(429, "Too many code requests. Try again later.");
        var last = await guests.OtpAsync(phone);
        if (last is not null && now - last.Sent < OtpResend)
            throw new ApiException(429, $"Please wait {OtpResend - (now - last.Sent)} seconds before requesting another code.", "OTP_WAIT");
        if (await guests.CodesSentSinceAsync(phone, now - 3600) >= 5)
            throw new ApiException(429, "Too many codes were sent to this number. Try again in an hour.");
        var code = RandomNumberGenerator.GetInt32(1_000_000).ToString("D6");
        string verification;
        try
        {
            // The provider may generate and later verify the code itself (AfroMessage challenge).
            (code, verification) = await sms.SendSigninCodeAsync(phone, code, OtpTtl);
        }
        catch (SmsNotConfigured problem)
        {
            LogSmsProblem("not configured", phone, problem);
            throw new ApiException(503, "Phone sign-in is temporarily unavailable. Please try again later.", "SMS_NOT_CONFIGURED");
        }
        catch (SmsDeliveryFailed problem)
        {
            LogSmsProblem("delivery failed", phone, problem);
            throw new ApiException(502, "We could not send a code to this number. Check it and try again.", "SMS_FAILED");
        }
        // With provider verification the code is never stored; only the id used to ask the provider.
        var stored = verification.Length > 0 ? ProviderCode + verification : CodeDigest(phone, code);
        await guests.SaveOtpAsync(phone, stored, now + OtpTtl, now);
        await guests.LogCodeSentAsync(phone, ip, now);
        return new JsonObject { ["sent"] = true, ["phone"] = phone, ["resendIn"] = OtpResend, ["expiresIn"] = OtpTtl };
    }

    /// <summary>Check the code; a first-time guest also gives a name and accepts the terms. Returns the reply and a cookie.</summary>
    public async Task<(JsonObject Body, string? Cookie)> VerifyCodeAsync(JsonObject v)
    {
        var phone = Values.NormalizePhone(v["phone"]);
        var code = (v.ContainsKey("code") ? Values.Show(v["code"]) : "").Trim();
        var now = Ids.Now();
        var otp = await guests.OtpAsync(phone);
        if (otp is null || otp.Expires < now) throw new DomainException("This code has expired. Request a new one.");
        if (otp.Attempts >= OtpMaxAttempts) throw new DomainException("Too many incorrect codes. Request a new one.");
        bool correct;
        if (otp.Code.StartsWith(ProviderCode, StringComparison.Ordinal))
        {
            try
            {
                correct = ProviderCodeShape().IsMatch(code) && await sms.VerifySigninCodeAsync(phone, code, otp.Code[ProviderCode.Length..]);
            }
            catch (Exception problem) when (problem is SmsDeliveryFailed or SmsNotConfigured)
            {
                LogSmsProblem("verification failed", phone, problem);
                throw new ApiException(502, "We could not check that code. Please try again in a moment.", "SMS_FAILED");
            }
        }
        else
        {
            correct = SixDigits().IsMatch(code) && Values.SameSecret(otp.Code, CodeDigest(phone, code));
        }
        if (!correct)
        {
            await guests.CountFailedAttemptAsync(phone);
            await tx.CommitAsync(); // keep the failed-attempt count even though the request fails
            throw new DomainException("That code is not correct.");
        }
        var g = await guests.GuestByPhoneAsync(phone);
        if (g is null)
        {
            if (!Values.Truthy(v["name"])) return (new JsonObject { ["needsName"] = true }, null);
            if (!(v["acceptTerms"] is JsonValue accepted && accepted.TryGetValue(out bool yes) && yes))
                throw new DomainException("Please accept the terms to create your account.");
            g = new Guest { Id = Ids.Uid(), Phone = phone, Name = Values.Text(v["name"], 80), Created = (int)now, Terms = (int)now };
            await guests.AddGuestAsync(g);
        }
        await guests.DeleteOtpAsync(phone);
        var token = Sessions.NewToken();
        await guests.AddSessionAsync(Ids.Digest(token), g.Id, now + EncoreOptions.GuestSessionDays * 86400);
        return (new JsonObject { ["guest"] = Describe(g) }, Cookie(token));
    }

    public Task SignOutAsync(string? token) => guests.EndSessionAsync(Ids.Digest(token ?? ""));

    private string CodeDigest(string phone, string code) =>
        Convert.ToHexString(HMACSHA256.HashData(options.Secret(), Encoding.UTF8.GetBytes(phone + ":" + code))).ToLowerInvariant();

    /// <summary>Operators see why a message was refused; the provider's reason never reaches the guest.</summary>
    private void LogSmsProblem(string kind, string phone, Exception problem) =>
        log.LogWarning("SMS {Kind} [{Provider}] to {Phone}: {Reason}", kind, sms.ProviderName is { Length: > 0 } p ? p : "none", SmsService.MaskPhone(phone), problem.Message);

    // ------------------------------------------------ quotes, orders, ratings

    public async Task<JsonObject> QuoteAsync(JsonObject v, string? token)
    {
        var (_, s) = await OpenWorkspaceAsync(Values.Text(v["tenant"]));
        var g = await CurrentGuestAsync(token, required: false);
        return Pricing.QuoteOrder(s, v, g?.Id);
    }

    /// <summary>Online payment is not connected yet, so checkout always fails closed. Nothing is recorded.</summary>
    public async Task CheckoutAsync(JsonObject v)
    {
        await WorkspaceAsync(Values.Text(v["tenant"]));
        throw new ApiException(503, "Online payments are not available yet. Please try again later.", "PAYMENT_NOT_CONFIGURED");
    }

    public async Task<JsonObject> RenameAsync(Guest g, JsonObject v)
    {
        var name = Values.Text(v["name"], 80);
        await guests.RenameAsync(g.Id, name);
        return new JsonObject { ["guest"] = new JsonObject { ["id"] = g.Id, ["name"] = name, ["phone"] = g.Phone } };
    }

    /// <summary>Only guests who booked or ordered with an organizer may rate it; rating again replaces the earlier one.</summary>
    public async Task<JsonObject> RateAsync(Guest g, JsonObject v)
    {
        var (row, st) = await OpenWorkspaceAsync(Values.Text(v["tenant"]));
        if (!st.Bookings.Concat(st.Orders).Any(r => WorkspaceRules.Str(r["guest"]) == g.Id))
            throw new NotAllowed("You can rate an organizer after booking tickets or ordering with them.");
        var stars = Values.Whole(v["stars"], 1, 5, "Choose 1 to 5 stars.");
        var comment = Values.Text(v["comment"], 500, false);
        var first = g.Name.Split(' ')[0];
        await activity.RateAsync(row.Id, g.Id, stars, comment, first, Ids.Now());
        await notifier.NotifyAsync(row.Id, "staff", $"New {stars}-star rating", comment.Length > 0 ? comment : $"{first} rated {st.Name} {stars} of 5.", kind: "rating");
        return await activity.RatingSummaryAsync(row.Id, g.Id, recent: 6);
    }

    /// <summary>
    /// Reserve tickets or order food and drink, paying in cash at the venue. The record starts unpaid; staff mark it
    /// paid when the money is taken. Prices come from the workspace, never from the request.
    /// </summary>
    public async Task<JsonObject> OrderAsync(Guest g, JsonObject v, string ip)
    {
        if (limiter.Limited("order:" + ip, 30, 900) || limiter.Limited("order-guest:" + g.Id, 20, 900))
            throw new ApiException(429, "Too many orders in a short time. Please wait a few minutes.");
        var (row, s) = await OpenWorkspaceAsync(Values.Text(v["tenant"]));
        var cash = WorkspaceRules.Str(v["payment"]) == "cash";
        var rec = Actions.GuestRecord(s, v, AsRecordOwner(g), cash);
        await workspaces.WriteAsync(row.Id, s);
        await activity.AuditAsync(row.Id, "guest:" + g.Id, "guest_" + (v.ContainsKey("kind") ? Values.Show(v["kind"]) : "None"));
        var prefs = s.Settings["notifications"]!;
        var reference = WorkspaceRules.Str(rec["ref"]);
        var currency = WorkspaceRules.Str(rec["currency"]);
        var amount = Notifier.Amount(Values.Long(rec["total"]));
        string title, body;
        if (Values.Truthy(rec["qty"]))
        {
            var qty = Values.Long(rec["qty"]);
            var eventName = Values.Show(rec["eventName"]);
            title = "Tickets reserved";
            body = $"{qty} ticket{(qty > 1 ? "s" : "")} for {eventName}. Pay {currency} {amount} at the entrance. Ref {reference}.";
            await notifier.NotifyAsync(row.Id, "staff", $"New booking · {reference}", $"{g.Name} reserved {qty} for {eventName}.", kind: "booking", reference: reference);
            if (Values.Truthy(prefs["smsBookings"])) await notifier.TextGuestAsync(g.Phone, $"{s.Name}: {body}");
        }
        else
        {
            var items = Values.Show(rec["items"]);
            var tableName = WorkspaceRules.Str(rec["tableName"]);
            title = "Order received";
            body = $"{items} for {(string.IsNullOrEmpty(tableName) ? "counter pickup" : tableName)}. Ref {reference}.";
            if (cash) body += $" Please pay {currency} {amount} in cash when your order arrives.";
            if (Values.Truthy(prefs["staffNewOrders"]))
                await notifier.NotifyAsync(row.Id, "staff", $"New {(cash ? "cash " : "")}order · {reference}",
                    $"{(string.IsNullOrEmpty(tableName) ? "Counter" : tableName)}: {items}" + (cash ? $" · collect {currency} {amount} cash" : ""),
                    kind: "order", reference: reference);
        }
        await notifier.NotifyAsync(row.Id, "guest", title, body, g.Id, "placed", reference);
        return WorkspaceRules.Receipt(s, rec);
    }

    [GeneratedRegex(@"^[A-Za-z0-9]{4,10}\z")] private static partial Regex ProviderCodeShape();
    [GeneratedRegex(@"^\d{6}\z")] private static partial Regex SixDigits();
}
