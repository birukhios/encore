using Encore.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Encore.Api.Repositories;

/// <summary>Phone-number guests, their sessions, and one-time sign-in codes.</summary>
public sealed class GuestRepository(EncoreDbContext db)
{
    public Task<Guest?> GuestBySessionAsync(string tokenDigest, long now) =>
        (from g in db.Guests
         join s in db.GuestSessions on g.Id equals s.GuestId
         where s.Token == tokenDigest && s.Expires > now
         select g).AsNoTracking().FirstOrDefaultAsync();

    public Task<Guest?> GuestByPhoneAsync(string phone) => db.Guests.AsNoTracking().FirstOrDefaultAsync(g => g.Phone == phone);

    public async Task AddGuestAsync(Guest guest)
    {
        db.Guests.Add(guest);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public Task RenameAsync(string guestId, string name) =>
        db.Guests.Where(g => g.Id == guestId).ExecuteUpdateAsync(s => s.SetProperty(g => g.Name, name));

    public async Task AddSessionAsync(string tokenDigest, string guestId, long expires)
    {
        db.GuestSessions.Add(new GuestSession { Token = tokenDigest, GuestId = guestId, Expires = (int)expires });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public Task EndSessionAsync(string tokenDigest) => db.GuestSessions.Where(s => s.Token == tokenDigest).ExecuteDeleteAsync();

    public Task<Otp?> OtpAsync(string phone) => db.Otps.AsNoTracking().FirstOrDefaultAsync(o => o.Phone == phone);

    /// <summary>A new code replaces any earlier one for the number and resets its failed attempts.</summary>
    public Task SaveOtpAsync(string phone, string stored, long expires, long sent) =>
        db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO otps(phone,code,expires,attempts,sent) VALUES({phone},{stored},{(int)expires},0,{(int)sent})
            ON CONFLICT(phone) DO UPDATE SET code=excluded.code,expires=excluded.expires,attempts=0,sent=excluded.sent
            """);

    public Task CountFailedAttemptAsync(string phone) =>
        db.Otps.Where(o => o.Phone == phone).ExecuteUpdateAsync(s => s.SetProperty(o => o.Attempts, o => o.Attempts + 1));

    public Task DeleteOtpAsync(string phone) => db.Otps.Where(o => o.Phone == phone).ExecuteDeleteAsync();

    public Task<int> CodesSentSinceAsync(string phone, long since) => db.OtpLog.CountAsync(l => l.Phone == phone && l.Created > since);

    public async Task LogCodeSentAsync(string phone, string ip, long now)
    {
        db.OtpLog.Add(new OtpLogEntry { Phone = phone, Ip = ip, Created = (int)now });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }
}
