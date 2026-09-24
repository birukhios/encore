using Encore.Api.Repositories;
using Encore.Api.Services;
using Encore.Api.Web;
using Microsoft.AspNetCore.Mvc;

namespace Encore.Api.Controllers;

/// <summary>
/// The organizer admin API (/admin/api). Sign-up, sign-in and recovery are open (rate limited); everything else needs an
/// organizer session, and what a member may change is decided by their role (Owner, Admin, Service, Gate).
/// </summary>
[ApiController]
[Route("admin/api")]
public sealed class AdminController(StaffService staff, ActivityRepository activity, EncoreOptions options, SmsService sms) : EncoreController
{
    [HttpGet("health")]
    public IActionResult HealthCheck() => Reply(Health("admin", options, sms));

    [HttpGet("me")]
    public async Task<IActionResult> Me() => Reply(await staff.BundleAsync(await staff.CurrentUserAsync(Session)));

    [HttpGet("notifications")]
    public async Task<IActionResult> Notifications() =>
        Reply(await activity.StaffNotificationsAsync((await staff.CurrentUserAsync(Session)).TenantId));

    /// <summary>Anyone: creates a workspace with the caller as Owner, or joins one with an invitation.</summary>
    [HttpPost("signup")]
    public async Task<IActionResult> SignUp()
    {
        var (body, cookie) = await staff.SignUpAsync(Body, ClientIp);
        return Reply(body, 201, cookie);
    }

    [HttpPost("signin")]
    public async Task<IActionResult> SignIn()
    {
        var (body, cookie) = await staff.SignInAsync(Body, ClientIp);
        return Reply(body, cookie: cookie);
    }

    [HttpPost("recover")]
    public async Task<IActionResult> Recover() => Reply(await staff.RecoverAsync(Body, ClientIp));

    [HttpPost("signout")]
    public async Task<IActionResult> EndSession()
    {
        await staff.CurrentUserAsync(Session);
        await staff.SignOutAsync(Session);
        return Reply(Done(), cookie: staff.Cookie("", 0));
    }

    [HttpPost("profile")]
    public async Task<IActionResult> Profile() => Reply(await staff.ProfileAsync(await staff.CurrentUserAsync(Session), Body));

    [HttpPost("password")]
    public async Task<IActionResult> Password()
    {
        await staff.ChangePasswordAsync(await staff.CurrentUserAsync(Session), Body);
        return Reply(Done(), cookie: staff.Cookie("", 0));
    }

    /// <summary>Owner, Admin.</summary>
    [HttpPost("invite")]
    public async Task<IActionResult> Invite() => Reply(await staff.InviteAsync(await staff.CurrentUserAsync(Session), Body));

    /// <summary>Owner only.</summary>
    [HttpPost("team/remove")]
    public async Task<IActionResult> RemoveMember() => Reply(await staff.RemoveMemberAsync(await staff.CurrentUserAsync(Session), Body));

    /// <summary>Owner, Admin.</summary>
    [HttpPost("upload")]
    public async Task<IActionResult> Upload() => Reply(await staff.UploadAsync(await staff.CurrentUserAsync(Session), Body));

    [HttpPost("notifications/read")]
    public async Task<IActionResult> ReadNotifications()
    {
        await activity.MarkStaffReadAsync((await staff.CurrentUserAsync(Session)).TenantId);
        return Reply(Done());
    }

    /// <summary>Any member, limited per action by StaffService.RoleActions.</summary>
    [HttpPost("action")]
    public async Task<IActionResult> Act() => Reply(await staff.ActAsync(await staff.CurrentUserAsync(Session), Body));

    private string? Session => CookieValue(StaffService.SessionCookie);
}

/// <summary>The platform console API (/admin/api/platform). Platform operators only; organizer sessions are refused.</summary>
[ApiController]
[Route("admin/api/platform")]
public sealed class PlatformController(PlatformService platform) : EncoreController
{
    [HttpGet("me")]
    public async Task<IActionResult> Me() => Reply(platform.Me(await platform.CurrentAdminAsync(Session)));

    [HttpGet("data")]
    public async Task<IActionResult> Data()
    {
        await platform.CurrentAdminAsync(Session);
        return Reply(await platform.SnapshotAsync());
    }

    [HttpPost("signin")]
    public async Task<IActionResult> SignIn()
    {
        var (body, cookie) = await platform.SignInAsync(Body, ClientIp);
        return Reply(body, cookie: cookie);
    }

    [HttpPost("signout")]
    public async Task<IActionResult> EndSession()
    {
        await platform.SignOutAsync(Session);
        return Reply(Done(), cookie: platform.Cookie("", 0));
    }

    [HttpPost("tenant/status")]
    public async Task<IActionResult> TenantStatus()
    {
        await platform.SetTenantStatusAsync(await platform.CurrentAdminAsync(Session), Body);
        return Reply(Done());
    }

    [HttpPost("user/reset")]
    public async Task<IActionResult> ResetAccess() => Reply(await platform.ResetAccessAsync(await platform.CurrentAdminAsync(Session), Body));

    [HttpPost("user/signout")]
    public async Task<IActionResult> EndSessions()
    {
        await platform.EndUserSessionsAsync(await platform.CurrentAdminAsync(Session), Body);
        return Reply(Done());
    }

    private string? Session => CookieValue(PlatformService.SessionCookie);
}
