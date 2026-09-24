using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Encore.Api.Domain;
using Encore.Api.Persistence;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;

namespace Encore.Api.Web;

/// <summary>An error with a status and an optional machine-readable code the screens react to (e.g. OTP_WAIT).</summary>
public class ApiException(int status, string message, string? code = null) : Exception(message)
{
    public int Status { get; } = status;
    public string? Code { get; } = code;
}

/// <summary>401: the caller is not signed in, or may not do this.</summary>
public sealed class NotAllowed(string message) : ApiException(401, message);

/// <summary>404: the thing asked for does not exist (or is hidden from this caller).</summary>
public sealed class NotFound(string message) : ApiException(404, message);

/// <summary>
/// One transaction per write request. Every writer takes the same advisory lock first, so read-check-write sequences
/// (stock, ticket capacity, workspace versions) never interleave, exactly as the Python server serialized them.
/// </summary>
public sealed class RequestTransaction(EncoreDbContext db)
{
    private const long WriteLock = 734117; // shared by every Encore writer
    private IDbContextTransaction? _tx;

    public async Task BeginAsync(CancellationToken ct)
    {
        _tx = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlRawAsync($"SELECT pg_advisory_xact_lock({WriteLock})", ct);
    }

    /// <summary>Commit now. Used before replying, and when a failed attempt must still be recorded (wrong OTP code).</summary>
    public async Task CommitAsync()
    {
        if (_tx is null) return;
        await _tx.CommitAsync();
        await _tx.DisposeAsync();
        _tx = null;
    }

    public async Task RollbackAsync()
    {
        if (_tx is null) return;
        await _tx.RollbackAsync();
        await _tx.DisposeAsync();
        _tx = null;
    }
}

/// <summary>A JSON reply. Commits the request's transaction first, so the client's next request sees this write.</summary>
public sealed class EncoreResult(JsonNode? body, int status = 200, string? cookie = null) : IActionResult
{
    public async Task ExecuteResultAsync(ActionContext context)
    {
        var http = context.HttpContext;
        if (status < 400) await http.RequestServices.GetRequiredService<RequestTransaction>().CommitAsync();
        await Http.WriteJson(http, body, status, cookie);
    }
}

public static class Http
{
    public const string BodyKey = "encore.body";
    private const int MaxBody = 7_500_000;
    private static readonly JsonSerializerOptions Compact = new() { WriteIndented = false };

    public static bool IsApi(PathString path) =>
        path.StartsWithSegments("/api") || path.StartsWithSegments("/admin/api");

    public static bool IsAdmin(PathString path) => path.StartsWithSegments("/admin/api");

    public static async Task WriteJson(HttpContext http, JsonNode? body, int status, string? cookie = null)
    {
        var bytes = Encoding.UTF8.GetBytes(body?.ToJsonString(Compact) ?? "null");
        var response = http.Response;
        response.StatusCode = status;
        response.ContentType = "application/json";
        response.Headers.Vary = "Accept-Encoding";
        response.Headers.CacheControl = "no-store";
        if (cookie is not null) response.Headers.Append("Set-Cookie", cookie);
        if (bytes.Length >= 1024 && AcceptsGzip(http))
        {
            bytes = Gzip(bytes, CompressionLevel.Optimal);
            response.Headers.ContentEncoding = "gzip";
        }
        response.ContentLength = bytes.Length;
        await response.Body.WriteAsync(bytes);
    }

    public static bool AcceptsGzip(HttpContext http) => http.Request.Headers.AcceptEncoding.ToString().Contains("gzip");

    public static byte[] Gzip(byte[] data, CompressionLevel level)
    {
        using var output = new MemoryStream();
        using (var zip = new GZipStream(output, level)) zip.Write(data);
        return output.ToArray();
    }

    public static string Cookie(EncoreOptions options, string name, string value, int maxAge, string sameSite) =>
        $"{name}={value}; Path=/; HttpOnly; SameSite={sameSite}; Max-Age={maxAge}" + (options.Production ? "; Secure" : "");

    public static void SecurityHeaders(HttpResponse response, bool production)
    {
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Referrer-Policy"] = "no-referrer";
        response.Headers["X-Frame-Options"] = "DENY";
        response.Headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()";
        if (production) response.Headers.StrictTransportSecurity = "max-age=31536000; includeSubDomains";
    }

    /// <summary>
    /// Everything under /api and /admin/api: body checks for writes, one transaction per write, and every failure
    /// turned into the plain-language JSON error the screens show.
    /// </summary>
    public static async Task ApiPipeline(HttpContext http, RequestDelegate next)
    {
        var options = http.RequestServices.GetRequiredService<EncoreOptions>();
        var tx = http.RequestServices.GetRequiredService<RequestTransaction>();
        var post = HttpMethods.IsPost(http.Request.Method);
        try
        {
            if (post)
            {
                var length = http.Request.ContentLength ?? 0;
                if (length <= 0 || length > MaxBody)
                {
                    await WriteJson(http, new JsonObject { ["error"] = "Request is too large." }, 413);
                    return;
                }
                using var reader = new StreamReader(http.Request.Body, Encoding.UTF8);
                var raw = await reader.ReadToEndAsync(); // always read the body so a refusal is not lost to a reset
                var origin = http.Request.Headers.Origin.ToString();
                var expected = IsAdmin(http.Request.Path) ? options.AdminOrigin : options.GuestOrigin;
                if (origin.Length > 0 && origin != expected) throw new NotAllowed("Request origin is not allowed.");
                if (!(http.Request.ContentType ?? "").StartsWith("application/json", StringComparison.Ordinal))
                {
                    await WriteJson(http, new JsonObject { ["error"] = "JSON required" }, 415);
                    return;
                }
                JsonNode? parsed;
                try { parsed = JsonNode.Parse(raw); }
                catch (JsonException) { throw new DomainException("Request must be a JSON object."); }
                if (parsed is not JsonObject body) throw new DomainException("Request must be a JSON object.");
                http.Items[BodyKey] = body;
                await tx.BeginAsync(http.RequestAborted);
            }
            await next(http);
        }
        catch (Exception problem) when (!http.Response.HasStarted)
        {
            await tx.RollbackAsync();
            var (status, error) = Describe(problem, post, http);
            await WriteJson(http, error, status);
        }
        finally
        {
            await tx.RollbackAsync(); // no-op once committed
        }
    }

    private static (int, JsonObject) Describe(Exception problem, bool post, HttpContext http) => problem switch
    {
        ApiException api when api is NotAllowed or NotFound => (api.Status, new JsonObject { ["error"] = api.Message }),
        ApiException api => (api.Status, new JsonObject { ["error"] = api.Message, ["code"] = api.Code }),
        DomainException domain => (400, new JsonObject { ["error"] = domain.Message }),
        DbUpdateException { InnerException: PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } } or
            PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } when post
            => (409, new JsonObject { ["error"] = "An account with these details already exists." }),
        // Malformed input of the wrong JSON type (a number where text belongs, and so on).
        InvalidOperationException or InvalidCastException or FormatException or KeyNotFoundException when post
            => (400, new JsonObject { ["error"] = "Invalid request." }),
        _ => Unexpected(problem, http),
    };

    private static (int, JsonObject) Unexpected(Exception problem, HttpContext http)
    {
        http.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Encore")
            .LogError(problem, "Request {Method} {Path} failed", http.Request.Method, http.Request.Path);
        return (500, new JsonObject { ["error"] = "The request could not be completed. Please try again." });
    }

    /// <summary>
    /// HEAD is answered like GET with the body dropped, so uptime monitors see the real status and Content-Length.
    /// </summary>
    public static async Task HeadAsGet(HttpContext http, RequestDelegate next)
    {
        if (!HttpMethods.IsHead(http.Request.Method))
        {
            await next(http);
            return;
        }
        http.Request.Method = HttpMethods.Get;
        var original = http.Response.Body;
        var sink = new CountingSink();
        http.Response.Body = sink;
        try
        {
            await next(http);
        }
        finally
        {
            http.Response.Body = original;
            http.Request.Method = HttpMethods.Head;
        }
        if (http.Response.ContentLength is null) http.Response.ContentLength = sink.Length;
    }

    private sealed class CountingSink : Stream
    {
        private long _length;
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => _length;
        public override long Position { get => _length; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => _length += count;
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) { _length += count; return Task.CompletedTask; }
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default) { _length += buffer.Length; return ValueTask.CompletedTask; }
    }
}
