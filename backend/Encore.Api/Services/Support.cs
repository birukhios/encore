using System.Globalization;
using Encore.Api.Repositories;
using Encore.Api.Web;

namespace Encore.Api.Services;

/// <summary>Sliding-window limits per key (address, phone, guest). In memory: one server instance, as on Render.</summary>
public sealed class RateLimiter(EncoreOptions options)
{
    private readonly Dictionary<string, List<double>> _hits = [];
    private readonly object _lock = new();

    public bool Limited(string key, int limit, int windowSeconds)
    {
        if (options.TestMode) return false;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
        lock (_lock)
        {
            var hits = _hits.TryGetValue(key, out var list) ? list : [];
            hits.RemoveAll(t => t <= now - windowSeconds);
            _hits[key] = hits;
            if (hits.Count >= limit) return true;
            hits.Add(now);
        }
        return false;
    }
}

/// <summary>In-app notifications are always stored; SMS to guests is best-effort and never blocks the action.</summary>
public sealed class Notifier(ActivityRepository activity, SmsService sms, ILogger<Notifier> log)
{
    public Task NotifyAsync(string tenantId, string audience, string title, string body, string? guestId = null, string? kind = null, string? reference = null) =>
        activity.NotifyAsync(tenantId, audience, title, body, guestId, kind, reference);

    public async Task TextGuestAsync(string phone, string message)
    {
        try
        {
            await sms.SendAsync(phone, message);
        }
        catch (Exception problem) when (problem is SmsNotConfigured or SmsDeliveryFailed)
        {
            log.LogWarning("SMS notification to {Phone} not sent: {Reason}", SmsService.MaskPhone(phone), problem.Message);
        }
    }

    /// <summary>12,345.50 — amounts in messages, from integer cents.</summary>
    public static string Amount(long cents) => (cents / 100m).ToString("#,##0.00", CultureInfo.InvariantCulture);
}

public static class Sessions
{
    /// <summary>The value in the cookie. Only its SHA-256 digest is stored, so a database leak cannot sign anyone in.</summary>
    public static string NewToken() => Domain.Ids.Uid() + Domain.Ids.Uid();

    public static string ClientIp(HttpContext http, EncoreOptions options)
    {
        var forwarded = http.Request.Headers["X-Forwarded-For"].ToString();
        if (options.TrustProxy && forwarded.Length > 0) return forwarded.Split(',')[0].Trim();
        return http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    }
}
