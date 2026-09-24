namespace Encore.Api.Persistence;

// These classes mirror the tables the Python server created, which hold the live data. Timestamps are Unix seconds
// (INTEGER); changing a column type needs a real migration, not just an edit here.

public sealed class Tenant
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string State { get; set; } = "";
    public int? Version { get; set; }
    public string Status { get; set; } = "active";
    public string StatusNote { get; set; } = "";
    public int Created { get; set; }
}

public sealed class User
{
    public string Id { get; set; } = "";
    public string TenantId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public string Password { get; set; } = "";
    public string Recovery { get; set; } = "";
    public string Role { get; set; } = "";
    public string Avatar { get; set; } = "";
}

public sealed class StaffSession
{
    public string Token { get; set; } = "";
    public string UserId { get; set; } = "";
    public int Expires { get; set; }
}

public sealed class Invite
{
    public string Token { get; set; } = "";
    public string TenantId { get; set; } = "";
    public string Email { get; set; } = "";
    public string Role { get; set; } = "";
    public int Expires { get; set; }
}

public sealed class AuditEntry
{
    public long Id { get; set; }
    public string? TenantId { get; set; }
    public string? UserId { get; set; }
    public string? Action { get; set; }
    public int? Created { get; set; }
}

public sealed class Guest
{
    public string Id { get; set; } = "";
    public string Phone { get; set; } = "";
    public string Name { get; set; } = "";
    public int Created { get; set; }
    public int Terms { get; set; }
}

public sealed class GuestSession
{
    public string Token { get; set; } = "";
    public string GuestId { get; set; } = "";
    public int Expires { get; set; }
}

public sealed class Otp
{
    public string Phone { get; set; } = "";
    public string Code { get; set; } = "";
    public int Expires { get; set; }
    public int Attempts { get; set; }
    public int Sent { get; set; }
}

public sealed class OtpLogEntry
{
    public long Id { get; set; }
    public string Phone { get; set; } = "";
    public string Ip { get; set; } = "";
    public int Created { get; set; }
}

public sealed class Notification
{
    public long Id { get; set; }
    public string TenantId { get; set; } = "";
    public string Audience { get; set; } = "";
    public string? GuestId { get; set; }
    public string? Kind { get; set; }
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
    public string? Ref { get; set; }
    public int Created { get; set; }
    public int Read { get; set; }
}

public sealed class Rating
{
    public string TenantId { get; set; } = "";
    public string GuestId { get; set; } = "";
    public int Stars { get; set; }
    public string Comment { get; set; } = "";
    public string Name { get; set; } = "";
    public int Created { get; set; }
    public int Updated { get; set; }
}

public sealed class Upload
{
    public string Name { get; set; } = "";
    public string Mime { get; set; } = "";
    public byte[] Data { get; set; } = [];
    public int Created { get; set; }
}

public sealed class PlatformAdmin
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public string Password { get; set; } = "";
    public int Created { get; set; }
}

public sealed class PlatformSession
{
    public string Token { get; set; } = "";
    public string AdminId { get; set; } = "";
    public int Expires { get; set; }
}

public sealed class PlatformAuditEntry
{
    public long Id { get; set; }
    public string AdminId { get; set; } = "";
    public string Action { get; set; } = "";
    public string Target { get; set; } = "";
    public string Detail { get; set; } = "";
    public int Created { get; set; }
}
