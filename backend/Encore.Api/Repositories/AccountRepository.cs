using Encore.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Encore.Api.Repositories;

/// <summary>Organizer staff accounts, their sessions and invitations, and platform operators.</summary>
public sealed class AccountRepository(EncoreDbContext db)
{
    // ------------------------------------------------ organizer staff

    public Task<User?> UserBySessionAsync(string tokenDigest, long now) =>
        (from u in db.Users
         join s in db.Sessions on u.Id equals s.UserId
         where s.Token == tokenDigest && s.Expires > now
         select u).AsNoTracking().FirstOrDefaultAsync();

    public Task<User?> UserByEmailAsync(string email) => db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email == email);

    public Task<User?> UserAsync(string id) => db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == id);

    public Task<User?> MemberAsync(string id, string tenantId) =>
        db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == id && u.TenantId == tenantId);

    public Task<List<User>> TeamAsync(string tenantId) =>
        db.Users.AsNoTracking().Where(u => u.TenantId == tenantId).OrderBy(u => u.Name).ToListAsync();

    public async Task AddUserAsync(User user)
    {
        db.Users.Add(user);
        await db.SaveChangesAsync();
        db.Entry(user).State = EntityState.Detached;
    }

    public Task SetPasswordAsync(string userId, string hash) =>
        db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(s => s.SetProperty(u => u.Password, hash));

    public Task SetPasswordAndRecoveryAsync(string userId, string hash, string recoveryDigest) =>
        db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(s => s.SetProperty(u => u.Password, hash).SetProperty(u => u.Recovery, recoveryDigest));

    public Task SetRecoveryAsync(string userId, string recoveryDigest) =>
        db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(s => s.SetProperty(u => u.Recovery, recoveryDigest));

    public Task SetProfileAsync(string userId, string name, string avatar) =>
        db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(s => s.SetProperty(u => u.Name, name).SetProperty(u => u.Avatar, avatar));

    public Task DeleteUserAsync(string userId) => db.Users.Where(u => u.Id == userId).ExecuteDeleteAsync();

    public async Task AddSessionAsync(string tokenDigest, string userId, long expires)
    {
        db.Sessions.Add(new StaffSession { Token = tokenDigest, UserId = userId, Expires = (int)expires });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public Task EndSessionAsync(string tokenDigest) => db.Sessions.Where(s => s.Token == tokenDigest).ExecuteDeleteAsync();

    public Task EndSessionsForUserAsync(string userId) => db.Sessions.Where(s => s.UserId == userId).ExecuteDeleteAsync();

    public Task EndSessionsForTenantAsync(string tenantId) =>
        db.Sessions.Where(s => db.Users.Any(u => u.Id == s.UserId && u.TenantId == tenantId)).ExecuteDeleteAsync();

    public async Task AddInviteAsync(Invite invite)
    {
        db.Invites.Add(invite);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public Task<Invite?> InviteAsync(string tokenDigest, long now) =>
        db.Invites.AsNoTracking().FirstOrDefaultAsync(i => i.Token == tokenDigest && i.Expires > now);

    public Task DeleteInviteAsync(string tokenDigest) => db.Invites.Where(i => i.Token == tokenDigest).ExecuteDeleteAsync();

    // ------------------------------------------------ platform operators (Encore staff, not organizers)

    public Task<PlatformAdmin?> PlatformAdminBySessionAsync(string tokenDigest, long now) =>
        (from a in db.PlatformAdmins
         join s in db.PlatformSessions on a.Id equals s.AdminId
         where s.Token == tokenDigest && s.Expires > now
         select a).AsNoTracking().FirstOrDefaultAsync();

    public Task<PlatformAdmin?> PlatformAdminByEmailAsync(string email) =>
        db.PlatformAdmins.AsNoTracking().FirstOrDefaultAsync(a => a.Email == email);

    public async Task AddPlatformAdminAsync(PlatformAdmin admin)
    {
        db.PlatformAdmins.Add(admin);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public Task SetPlatformAdminAsync(string id, string name, string hash) =>
        db.PlatformAdmins.Where(a => a.Id == id).ExecuteUpdateAsync(s => s.SetProperty(a => a.Name, name).SetProperty(a => a.Password, hash));

    public Task SetPlatformPasswordAsync(string id, string hash) =>
        db.PlatformAdmins.Where(a => a.Id == id).ExecuteUpdateAsync(s => s.SetProperty(a => a.Password, hash));

    public async Task AddPlatformSessionAsync(string tokenDigest, string adminId, long expires)
    {
        db.PlatformSessions.Add(new PlatformSession { Token = tokenDigest, AdminId = adminId, Expires = (int)expires });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    public Task EndPlatformSessionAsync(string tokenDigest) => db.PlatformSessions.Where(s => s.Token == tokenDigest).ExecuteDeleteAsync();

    public Task EndPlatformSessionsForAdminAsync(string adminId) => db.PlatformSessions.Where(s => s.AdminId == adminId).ExecuteDeleteAsync();
}
