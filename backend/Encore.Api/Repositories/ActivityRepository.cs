using System.Text.Json.Nodes;
using Encore.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Encore.Api.Repositories;

/// <summary>Notifications, ratings, uploads and the audit trails.</summary>
public sealed class ActivityRepository(EncoreDbContext db)
{
    public async Task NotifyAsync(string tenantId, string audience, string title, string body, string? guestId = null, string? kind = null, string? reference = null)
    {
        db.Notifications.Add(new Notification
        {
            TenantId = tenantId, Audience = audience, Title = title, Body = body, GuestId = guestId, Kind = kind, Ref = reference,
            Created = (int)Domain.Ids.Now(),
        });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public async Task<JsonArray> StaffNotificationsAsync(string tenantId)
    {
        var rows = await db.Notifications.AsNoTracking().Where(n => n.TenantId == tenantId && n.Audience == "staff")
            .OrderByDescending(n => n.Created).ThenByDescending(n => n.Id).Take(50).ToListAsync();
        return new JsonArray([.. rows.Select(n => (JsonNode?)new JsonObject
        {
            ["id"] = n.Id, ["kind"] = n.Kind, ["title"] = n.Title, ["body"] = n.Body, ["ref"] = n.Ref, ["created"] = n.Created, ["read"] = n.Read,
        })]);
    }

    public async Task<JsonArray> GuestNotificationsAsync(string guestId)
    {
        var rows = await (from n in db.Notifications
                          join t in db.Tenants on n.TenantId equals t.Id
                          where n.Audience == "guest" && n.GuestId == guestId
                          orderby n.Created descending, n.Id descending
                          select new { n, merchant = t.Name }).AsNoTracking().Take(50).ToListAsync();
        return new JsonArray([.. rows.Select(r => (JsonNode?)new JsonObject
        {
            ["id"] = r.n.Id, ["tenant"] = r.n.TenantId, ["merchant"] = r.merchant, ["kind"] = r.n.Kind, ["title"] = r.n.Title,
            ["body"] = r.n.Body, ["ref"] = r.n.Ref, ["created"] = r.n.Created, ["read"] = r.n.Read,
        })]);
    }

    public Task<int> UnreadStaffAsync(string tenantId) =>
        db.Notifications.CountAsync(n => n.TenantId == tenantId && n.Audience == "staff" && n.Read == 0);

    public Task MarkStaffReadAsync(string tenantId) =>
        db.Notifications.Where(n => n.TenantId == tenantId && n.Audience == "staff").ExecuteUpdateAsync(s => s.SetProperty(n => n.Read, 1));

    public Task MarkGuestReadAsync(string guestId) =>
        db.Notifications.Where(n => n.Audience == "guest" && n.GuestId == guestId).ExecuteUpdateAsync(s => s.SetProperty(n => n.Read, 1));

    public async Task AuditAsync(string tenantId, string who, string action)
    {
        db.Audit.Add(new AuditEntry { TenantId = tenantId, UserId = who, Action = action, Created = (int)Domain.Ids.Now() });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public async Task PlatformAuditAsync(string adminId, string action, string target = "", string detail = "")
    {
        db.PlatformAudit.Add(new PlatformAuditEntry { AdminId = adminId, Action = action, Target = target, Detail = detail, Created = (int)Domain.Ids.Now() });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    /// <summary>Count and average stars; optionally recent comments and the viewer's own rating.</summary>
    public async Task<JsonObject> RatingSummaryAsync(string tenantId, string? guestId = null, int recent = 0)
    {
        var stars = await db.Ratings.AsNoTracking().Where(r => r.TenantId == tenantId).Select(r => r.Stars).ToListAsync();
        var output = new JsonObject
        {
            ["count"] = stars.Count,
            ["average"] = stars.Count > 0 ? Math.Round(stars.Average(), 1, MidpointRounding.ToEven) : null,
        };
        if (recent > 0)
        {
            var rows = await db.Ratings.AsNoTracking().Where(r => r.TenantId == tenantId && r.Comment != "")
                .OrderByDescending(r => r.Updated).Take(recent).ToListAsync();
            output["recent"] = new JsonArray([.. rows.Select(r => (JsonNode?)new JsonObject
            {
                ["name"] = r.Name, ["stars"] = r.Stars, ["comment"] = r.Comment, ["updated"] = r.Updated,
            })]);
        }
        if (guestId is not null)
        {
            var mine = await db.Ratings.AsNoTracking().FirstOrDefaultAsync(r => r.TenantId == tenantId && r.GuestId == guestId);
            output["mine"] = mine is null ? null : new JsonObject { ["stars"] = mine.Stars, ["comment"] = mine.Comment };
        }
        return output;
    }

    /// <summary>One rating per guest per organizer; rating again replaces it.</summary>
    public Task RateAsync(string tenantId, string guestId, int stars, string comment, string name, long now) =>
        db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO ratings(tenant,guest,stars,comment,name,created,updated) VALUES({tenantId},{guestId},{stars},{comment},{name},{(int)now},{(int)now})
            ON CONFLICT(tenant,guest) DO UPDATE SET stars=excluded.stars,comment=excluded.comment,name=excluded.name,updated=excluded.updated
            """);

    public async Task AddUploadAsync(string name, string mime, byte[] data)
    {
        db.Uploads.Add(new Upload { Name = name, Mime = mime, Data = data, Created = (int)Domain.Ids.Now() });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public Task<Upload?> UploadAsync(string name) => db.Uploads.AsNoTracking().FirstOrDefaultAsync(u => u.Name == name);

    /// <summary>Rows nobody reads again: expired sessions and codes, old logs, read notifications.</summary>
    public async Task<int> CleanOldRowsAsync(long now)
    {
        var day = 86400;
        var n = 0;
        n += await db.Sessions.Where(s => s.Expires < now).ExecuteDeleteAsync();
        n += await db.GuestSessions.Where(s => s.Expires < now).ExecuteDeleteAsync();
        n += await db.PlatformSessions.Where(s => s.Expires < now).ExecuteDeleteAsync();
        n += await db.Invites.Where(i => i.Expires < now).ExecuteDeleteAsync();
        n += await db.Otps.Where(o => o.Expires < now).ExecuteDeleteAsync();
        n += await db.OtpLog.Where(l => l.Created < now - day).ExecuteDeleteAsync();
        n += await db.Notifications.Where(x => x.Read == 1 && x.Created < now - 180 * day).ExecuteDeleteAsync();
        n += await db.Audit.Where(a => a.Created < now - 400 * day).ExecuteDeleteAsync();
        n += await db.PlatformAudit.Where(a => a.Created < now - 400 * day).ExecuteDeleteAsync();
        return n;
    }
}
