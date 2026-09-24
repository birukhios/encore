using System.Text.Json.Nodes;
using Encore.Api.Services;
using Encore.Api.Web;
using Microsoft.AspNetCore.Mvc;

namespace Encore.Api.Controllers;

/// <summary>Shared plumbing: the parsed JSON body, the caller's address and the reply format.</summary>
public abstract class EncoreController : ControllerBase
{
    protected JsonObject Body => HttpContext.Items[Http.BodyKey] as JsonObject ?? [];

    protected string ClientIp => Sessions.ClientIp(HttpContext, HttpContext.RequestServices.GetRequiredService<EncoreOptions>());

    protected string? CookieValue(string name) => Request.Cookies[name];

    protected string Query(string name) => Request.Query[name].ToString();

    protected static EncoreResult Reply(JsonNode? body, int status = 200, string? cookie = null) => new(body, status, cookie);

    protected static JsonObject Done() => new() { ["ok"] = true };

    protected JsonObject Health(string app, EncoreOptions options, SmsService sms) => new()
    {
        ["ok"] = true, ["app"] = app, ["payments"] = options.PaymentsReady, ["sms"] = sms.Status().Delivers, ["database"] = options.DescribeDatabase(),
    };
}

/// <summary>Anything else under /api or /admin/api.</summary>
[ApiController]
public sealed class NotFoundController : EncoreController
{
    [AcceptVerbs("GET", "POST")]
    [Route("api/{**rest}", Order = int.MaxValue)]
    [Route("admin/api/{**rest}", Order = int.MaxValue)]
    public IActionResult Missing() => throw new NotFound("Not found");
}
