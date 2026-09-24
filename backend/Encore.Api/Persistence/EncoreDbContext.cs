using Encore.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Encore.Api.Persistence;

// Maps the live schema owned by db.py. Its migration history is kept apart from Identity's so the two
// contexts can evolve independently while both run against the one Encore database.
public sealed class EncoreDbContext(DbContextOptions<EncoreDbContext> options) : DbContext(options)
{
    public const string HistoryTable = "__encore_migrations";

    public DbSet<Tenant> Tenants => Set<Tenant>();
    public DbSet<User> Users => Set<User>();
    public DbSet<StaffSession> Sessions => Set<StaffSession>();
    public DbSet<Invite> Invites => Set<Invite>();
    public DbSet<AuditEntry> Audit => Set<AuditEntry>();
    public DbSet<Guest> Guests => Set<Guest>();
    public DbSet<GuestSession> GuestSessions => Set<GuestSession>();
    public DbSet<Otp> Otps => Set<Otp>();
    public DbSet<OtpLogEntry> OtpLog => Set<OtpLogEntry>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<Rating> Ratings => Set<Rating>();
    public DbSet<Upload> Uploads => Set<Upload>();
    public DbSet<PlatformAdmin> PlatformAdmins => Set<PlatformAdmin>();
    public DbSet<PlatformSession> PlatformSessions => Set<PlatformSession>();
    public DbSet<PlatformAuditEntry> PlatformAudit => Set<PlatformAuditEntry>();

    public static void Configure(DbContextOptionsBuilder options, string connectionString) =>
        options.UseNpgsql(connectionString, npgsql => npgsql.MigrationsHistoryTable(HistoryTable));

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Tenant>(e =>
        {
            e.ToTable("tenants").HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.Name).HasColumnName("name");
            e.Property(x => x.State).HasColumnName("state");
            e.Property(x => x.Version).HasColumnName("version").HasDefaultValue(0);
            e.Property(x => x.Status).HasColumnName("status").HasDefaultValue("active");
            e.Property(x => x.StatusNote).HasColumnName("status_note").HasDefaultValue("");
            e.Property(x => x.Created).HasColumnName("created").HasDefaultValue(0);
        });
        b.Entity<User>(e =>
        {
            e.ToTable("users").HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.TenantId).HasColumnName("tenant");
            e.Property(x => x.Name).HasColumnName("name");
            e.Property(x => x.Email).HasColumnName("email");
            e.Property(x => x.Password).HasColumnName("password");
            e.Property(x => x.Recovery).HasColumnName("recovery");
            e.Property(x => x.Role).HasColumnName("role");
            e.Property(x => x.Avatar).HasColumnName("avatar").HasDefaultValue("");
            e.HasIndex(x => x.Email).IsUnique().HasDatabaseName("users_email_key");
            e.HasIndex(x => x.TenantId).HasDatabaseName("users_tenant");
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.NoAction);
        });
        b.Entity<StaffSession>(e =>
        {
            e.ToTable("sessions").HasKey(x => x.Token);
            e.Property(x => x.Token).HasColumnName("token");
            e.Property(x => x.UserId).HasColumnName("user");
            e.Property(x => x.Expires).HasColumnName("expires");
            e.HasIndex(x => x.Expires).HasDatabaseName("sessions_expires");
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Invite>(e =>
        {
            e.ToTable("invites").HasKey(x => x.Token);
            e.Property(x => x.Token).HasColumnName("token");
            e.Property(x => x.TenantId).HasColumnName("tenant");
            e.Property(x => x.Email).HasColumnName("email");
            e.Property(x => x.Role).HasColumnName("role");
            e.Property(x => x.Expires).HasColumnName("expires");
            e.HasIndex(x => x.Expires).HasDatabaseName("invites_expires");
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.NoAction);
        });
        b.Entity<AuditEntry>(e =>
        {
            e.ToTable("audit").HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").UseSerialColumn();
            e.Property(x => x.TenantId).HasColumnName("tenant");
            e.Property(x => x.UserId).HasColumnName("user");
            e.Property(x => x.Action).HasColumnName("action");
            e.Property(x => x.Created).HasColumnName("created");
            e.HasIndex(x => new { x.TenantId, x.Created }).HasDatabaseName("audit_tenant");
        });
        b.Entity<Guest>(e =>
        {
            e.ToTable("guests").HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.Phone).HasColumnName("phone");
            e.Property(x => x.Name).HasColumnName("name");
            e.Property(x => x.Created).HasColumnName("created");
            e.Property(x => x.Terms).HasColumnName("terms");
            e.HasIndex(x => x.Phone).IsUnique().HasDatabaseName("guests_phone_key");
        });
        b.Entity<GuestSession>(e =>
        {
            e.ToTable("guest_sessions").HasKey(x => x.Token);
            e.Property(x => x.Token).HasColumnName("token");
            e.Property(x => x.GuestId).HasColumnName("guest");
            e.Property(x => x.Expires).HasColumnName("expires");
            e.HasIndex(x => x.Expires).HasDatabaseName("guest_sessions_expires");
            e.HasOne<Guest>().WithMany().HasForeignKey(x => x.GuestId).OnDelete(DeleteBehavior.NoAction);
        });
        b.Entity<Otp>(e =>
        {
            e.ToTable("otps").HasKey(x => x.Phone);
            e.Property(x => x.Phone).HasColumnName("phone");
            e.Property(x => x.Code).HasColumnName("code");
            e.Property(x => x.Expires).HasColumnName("expires");
            e.Property(x => x.Attempts).HasColumnName("attempts").HasDefaultValue(0);
            e.Property(x => x.Sent).HasColumnName("sent");
        });
        b.Entity<OtpLogEntry>(e =>
        {
            e.ToTable("otp_log").HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").UseSerialColumn();
            e.Property(x => x.Phone).HasColumnName("phone");
            e.Property(x => x.Ip).HasColumnName("ip");
            e.Property(x => x.Created).HasColumnName("created");
            e.HasIndex(x => new { x.Phone, x.Created }).HasDatabaseName("otp_log_phone");
        });
        b.Entity<Notification>(e =>
        {
            e.ToTable("notifications").HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").UseSerialColumn();
            e.Property(x => x.TenantId).HasColumnName("tenant");
            e.Property(x => x.Audience).HasColumnName("audience");
            e.Property(x => x.GuestId).HasColumnName("guest");
            e.Property(x => x.Kind).HasColumnName("kind");
            e.Property(x => x.Title).HasColumnName("title");
            e.Property(x => x.Body).HasColumnName("body");
            e.Property(x => x.Ref).HasColumnName("ref");
            e.Property(x => x.Created).HasColumnName("created");
            e.Property(x => x.Read).HasColumnName("read").HasDefaultValue(0);
            e.HasIndex(x => new { x.GuestId, x.Created }).HasDatabaseName("notifications_guest");
            e.HasIndex(x => new { x.TenantId, x.Audience, x.Created }).HasDatabaseName("notifications_tenant");
        });
        b.Entity<Rating>(e =>
        {
            e.ToTable("ratings").HasKey(x => new { x.TenantId, x.GuestId });
            e.Property(x => x.TenantId).HasColumnName("tenant");
            e.Property(x => x.GuestId).HasColumnName("guest");
            e.Property(x => x.Stars).HasColumnName("stars");
            e.Property(x => x.Comment).HasColumnName("comment").HasDefaultValue("");
            e.Property(x => x.Name).HasColumnName("name");
            e.Property(x => x.Created).HasColumnName("created");
            e.Property(x => x.Updated).HasColumnName("updated");
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.NoAction);
            e.HasOne<Guest>().WithMany().HasForeignKey(x => x.GuestId).OnDelete(DeleteBehavior.NoAction);
        });
        b.Entity<Upload>(e =>
        {
            e.ToTable("uploads").HasKey(x => x.Name);
            e.Property(x => x.Name).HasColumnName("name");
            e.Property(x => x.Mime).HasColumnName("mime");
            e.Property(x => x.Data).HasColumnName("data");
            e.Property(x => x.Created).HasColumnName("created");
            e.HasIndex(x => x.Created).HasDatabaseName("uploads_created");
        });
        b.Entity<PlatformAdmin>(e =>
        {
            e.ToTable("platform_admins").HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.Name).HasColumnName("name");
            e.Property(x => x.Email).HasColumnName("email");
            e.Property(x => x.Password).HasColumnName("password");
            e.Property(x => x.Created).HasColumnName("created");
            e.HasIndex(x => x.Email).IsUnique().HasDatabaseName("platform_admins_email_key");
        });
        b.Entity<PlatformSession>(e =>
        {
            e.ToTable("platform_sessions").HasKey(x => x.Token);
            e.Property(x => x.Token).HasColumnName("token");
            e.Property(x => x.AdminId).HasColumnName("admin");
            e.Property(x => x.Expires).HasColumnName("expires");
            e.HasIndex(x => x.Expires).HasDatabaseName("platform_sessions_expires");
            e.HasOne<PlatformAdmin>().WithMany().HasForeignKey(x => x.AdminId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<PlatformAuditEntry>(e =>
        {
            e.ToTable("platform_audit").HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").UseSerialColumn();
            e.Property(x => x.AdminId).HasColumnName("admin");
            e.Property(x => x.Action).HasColumnName("action");
            e.Property(x => x.Target).HasColumnName("target").HasDefaultValue("");
            e.Property(x => x.Detail).HasColumnName("detail").HasDefaultValue("");
            e.Property(x => x.Created).HasColumnName("created");
        });
    }
}

public sealed class EncoreDbContextFactory : IDesignTimeDbContextFactory<EncoreDbContext>
{
    public EncoreDbContext CreateDbContext(string[] args)
    {
        // Migrations are generated offline; a placeholder address is enough and nothing connects to it.
        var url = Environment.GetEnvironmentVariable("DATABASE_URL") ?? "postgresql://design:design@localhost:5432/design";
        var options = new DbContextOptionsBuilder<EncoreDbContext>();
        EncoreDbContext.Configure(options, DatabaseUrl.ToConnectionString(url));
        return new EncoreDbContext(options.Options);
    }
}
