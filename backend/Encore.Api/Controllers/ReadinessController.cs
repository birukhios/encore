using Encore.Api.Repositories;
using Microsoft.AspNetCore.Mvc;

namespace Encore.Api.Controllers;

[ApiController]
[Route("bridge/health")]
public sealed class ReadinessController(IReadinessRepository repository) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken) =>
        await repository.CanConnectAsync(cancellationToken)
            ? Ok(new { ok = true, database = "PostgreSQL", paymentReady = false })
            : StatusCode(503, new { error = "Database unavailable." });
}
