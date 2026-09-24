using System.Net;

namespace Encore.Api.Services;

public interface ILegacyRelayService
{
    Task ForwardAsync(HttpContext context, CancellationToken cancellationToken);
}

// Temporary compatibility path: the .NET listener owns the public API address while
// unchanged business rules continue in the loopback-only Python listeners.
public sealed class LegacyRelayService(IHttpClientFactory clients, IConfiguration configuration) : ILegacyRelayService
{
    private static readonly HashSet<string> HopHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "TE", "Trailer",
        "Transfer-Encoding", "Upgrade", "Host", "Content-Length"
    };

    public async Task ForwardAsync(HttpContext context, CancellationToken cancellationToken)
    {
        var path = context.Request.Path.Value ?? "";
        var admin = path.StartsWith("/admin/api/", StringComparison.Ordinal);
        var guest = path.StartsWith("/api/", StringComparison.Ordinal);
        var upload = path.StartsWith("/uploads/", StringComparison.Ordinal);
        if (!admin && !guest && !upload)
        {
            context.Response.StatusCode = 404;
            return;
        }

        var baseUrl = admin || upload
            ? configuration["Legacy:Admin"] ?? "http://127.0.0.1:8081"
            : configuration["Legacy:Guest"] ?? "http://127.0.0.1:8082";
        var destination = new Uri(new Uri(baseUrl.TrimEnd('/') + "/"), path.TrimStart('/') + context.Request.QueryString);
        using var outgoing = new HttpRequestMessage(new HttpMethod(context.Request.Method), destination);
        if (context.Request.ContentLength > 0)
        {
            outgoing.Content = new StreamContent(context.Request.Body);
            outgoing.Content.Headers.ContentLength = context.Request.ContentLength;
        }
        foreach (var (name, values) in context.Request.Headers)
        {
            if (HopHeaders.Contains(name)) continue;
            if (!outgoing.Headers.TryAddWithoutValidation(name, values.ToArray()))
                outgoing.Content?.Headers.TryAddWithoutValidation(name, values.ToArray());
        }

        HttpResponseMessage incoming;
        try
        {
            incoming = await clients.CreateClient("legacy")
                .SendAsync(outgoing, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }
        catch (HttpRequestException)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            await context.Response.WriteAsJsonAsync(new { error = "The service is temporarily unavailable. Please try again." }, cancellationToken: cancellationToken);
            return;
        }
        using (incoming)
        {
            context.Response.StatusCode = (int)incoming.StatusCode;
            foreach (var header in incoming.Headers.Concat(incoming.Content.Headers))
            {
                if (!HopHeaders.Contains(header.Key)) context.Response.Headers[header.Key] = header.Value.ToArray();
            }
            context.Response.Headers.Remove("transfer-encoding");
            if (!HttpMethods.IsHead(context.Request.Method))
                await incoming.Content.CopyToAsync(context.Response.Body, cancellationToken);
        }
    }
}
