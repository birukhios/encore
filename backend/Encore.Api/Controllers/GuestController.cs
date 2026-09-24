using Encore.Api.Repositories;
using Encore.Api.Services;
using Encore.Api.Web;
using Microsoft.AspNetCore.Mvc;

namespace Encore.Api.Controllers;

/// <summary>
/// The guest app API (/api). Browsing, quotes and receipts are open; orders, ratings and profile need a guest signed in
/// with an SMS code, and a guest only ever sees their own records.
/// </summary>
[ApiController]
[Route("api")]
public sealed class GuestController(GuestService guests, ActivityRepository activity, EncoreOptions options, SmsService sms) : EncoreController
{
    [HttpGet("health")]
    public IActionResult HealthCheck() => Reply(Health("guest", options, sms));

    [HttpGet("workspaces")]
    public async Task<IActionResult> Directory() => Reply(await guests.DirectoryAsync());

    [HttpGet("public")]
    public async Task<IActionResult> Public() => Reply(await guests.PublicAsync(Query("tenant"), Query("table"), Session));

    [HttpGet("table")]
    public async Task<IActionResult> Table() => Reply(await guests.TableAsync(Query("tenant"), Query("code"), Query("token"), ClientIp));

    [HttpGet("receipt")]
    public async Task<IActionResult> Receipt() => Reply(await guests.ReceiptAsync(Query("tenant"), Query("ref"), Query("token")));

    [HttpGet("guest/me")]
    public async Task<IActionResult> Me()
    {
        var g = await guests.CurrentGuestAsync(Session, required: false);
        return Reply(new System.Text.Json.Nodes.JsonObject { ["guest"] = g is null ? null : GuestService.Describe(g) });
    }

    [HttpGet("guest/records")]
    public async Task<IActionResult> Records() => Reply(await guests.RecordsAsync((await guests.CurrentGuestAsync(Session))!, Query("tenant")));

    [HttpGet("guest/notifications")]
    public async Task<IActionResult> Notifications() => Reply(await guests.NotificationsAsync((await guests.CurrentGuestAsync(Session))!));

    [HttpPost("guest/otp")]
    public async Task<IActionResult> SendCode() => Reply(await guests.SendCodeAsync(Body, ClientIp));

    [HttpPost("guest/verify")]
    public async Task<IActionResult> Verify()
    {
        var (body, cookie) = await guests.VerifyCodeAsync(Body);
        return Reply(body, cookie: cookie);
    }

    [HttpPost("guest/signout")]
    public async Task<IActionResult> EndSession()
    {
        await guests.SignOutAsync(Session);
        return Reply(Done(), cookie: guests.Cookie("", 0));
    }

    [HttpPost("quote")]
    public async Task<IActionResult> Quote() => Reply(await guests.QuoteAsync(Body, Session));

    [HttpPost("checkout")]
    public async Task<IActionResult> Checkout()
    {
        await guests.CheckoutAsync(Body);
        return Reply(null); // not reached: checkout fails closed until online payment is connected
    }

    [HttpPost("guest/profile")]
    public async Task<IActionResult> Profile() => Reply(await guests.RenameAsync((await guests.CurrentGuestAsync(Session))!, Body));

    [HttpPost("guest/notifications/read")]
    public async Task<IActionResult> ReadNotifications()
    {
        await activity.MarkGuestReadAsync((await guests.CurrentGuestAsync(Session))!.Id);
        return Reply(Done());
    }

    [HttpPost("order")]
    public async Task<IActionResult> Order() => Reply(await guests.OrderAsync((await guests.CurrentGuestAsync(Session))!, Body, ClientIp), 201);

    [HttpPost("guest/rating")]
    public async Task<IActionResult> Rate() => Reply(await guests.RateAsync((await guests.CurrentGuestAsync(Session))!, Body));

    private string? Session => CookieValue(GuestService.SessionCookie);
}
