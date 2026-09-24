using Encore.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Encore.Api.Controllers;

[ApiController]
public sealed class RelayController(ILegacyRelayService relay) : ControllerBase
{
    [AcceptVerbs("GET", "POST", "HEAD")]
    [Route("api/{**path}")]
    [Route("admin/api/{**path}")]
    [Route("uploads/{**path}")]
    [Route("robots.txt")]
    public Task Forward(CancellationToken cancellationToken) => relay.ForwardAsync(HttpContext, cancellationToken);
}
