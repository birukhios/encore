using System.Collections.Concurrent;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Encore.Api.Repositories;
using Microsoft.AspNetCore.StaticFiles;

namespace Encore.Api.Web;

/// <summary>
/// The two web apps (dist/, built by `npm run build`), uploaded images and robots.txt. The guest app is served at /, the
/// organizer admin at /admin; any other path is a screen inside one of them, so it gets that app's page.
/// </summary>
public static partial class StaticSite
{
    private static readonly byte[] Robots = "User-agent: *\nDisallow: /admin\nDisallow: /api/\n"u8.ToArray();
    private static readonly string[] Compressible = [".js", ".css", ".html", ".svg", ".json", ".webmanifest"];
    private static readonly string[] RootFiles = ["/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"];
    private static readonly FileExtensionContentTypeProvider Types = new() { Mappings = { [".webmanifest"] = "application/manifest+json" } };
    private static readonly ConcurrentDictionary<(string, DateTime), byte[]> GzipCache = new();

    public static async Task ServeAsync(HttpContext http)
    {
        var options = http.RequestServices.GetRequiredService<EncoreOptions>();
        var path = http.Request.Path.Value ?? "/";
        if (path == "/robots.txt")
        {
            await Write(http, Robots, "text/plain; charset=utf-8", null, false);
            return;
        }
        if (path.StartsWith("/uploads/", StringComparison.Ordinal))
        {
            await ServeUploadAsync(http, options, Path.GetFileName(path));
            return;
        }

        var dist = Path.GetFullPath(options.WebRoot);
        var candidate = Path.GetFullPath(Path.Combine(dist, path.TrimStart('/')));
        var allowed = path.StartsWith("/assets/", StringComparison.Ordinal) || RootFiles.Contains(path) || WalletImage().IsMatch(path);
        var admin = path == "/admin" || path.StartsWith("/admin/", StringComparison.Ordinal);
        var file = allowed && candidate.StartsWith(dist + Path.DirectorySeparatorChar, StringComparison.Ordinal) && File.Exists(candidate)
            ? candidate
            : Path.Combine(dist, admin ? "admin.html" : "guest.html");
        if (!File.Exists(file))
        {
            await Http.WriteJson(http, new System.Text.Json.Nodes.JsonObject { ["error"] = "Build the client before starting the application." }, 404);
            return;
        }

        var body = await File.ReadAllBytesAsync(file);
        var ext = Path.GetExtension(file);
        var type = Types.TryGetContentType(file, out var t) ? t : "application/octet-stream";
        var cache = path.StartsWith("/assets/", StringComparison.Ordinal) ? "public, max-age=31536000, immutable" : "no-cache";
        if (ext == ".html") http.Response.Headers.ContentSecurityPolicy = ContentSecurityPolicy(body);
        byte[]? packed = null;
        if (Compressible.Contains(ext) && body.Length >= 1024 && Http.AcceptsGzip(http))
            packed = GzipCache.GetOrAdd((file, File.GetLastWriteTimeUtc(file)), _ => Http.Gzip(body, CompressionLevel.SmallestSize));
        if (Compressible.Contains(ext)) http.Response.Headers.Vary = "Accept-Encoding";
        await Write(http, packed ?? body, type, cache, packed is not null);
    }

    private static async Task ServeUploadAsync(HttpContext http, EncoreOptions options, string name)
    {
        var upload = await http.RequestServices.GetRequiredService<ActivityRepository>().UploadAsync(name);
        if (upload is not null)
        {
            await Write(http, upload.Data, upload.Mime, "public, max-age=31536000, immutable", false);
            return;
        }
        // Images uploaded before uploads moved into the database.
        var legacy = Path.Combine(options.DataDir, "uploads", name);
        if (name.Length > 0 && File.Exists(legacy) && Types.TryGetContentType(legacy, out var type))
        {
            await Write(http, await File.ReadAllBytesAsync(legacy), type, "public, max-age=31536000, immutable", false);
            return;
        }
        await Http.WriteJson(http, new System.Text.Json.Nodes.JsonObject { ["error"] = "Not found" }, 404);
    }

    private static async Task Write(HttpContext http, byte[] body, string type, string? cache, bool gzip)
    {
        http.Response.StatusCode = 200;
        http.Response.ContentType = type;
        if (cache is not null) http.Response.Headers.CacheControl = cache;
        if (gzip) http.Response.Headers.ContentEncoding = "gzip";
        http.Response.ContentLength = body.Length;
        await http.Response.Body.WriteAsync(body);
    }

    /// <summary>Scripts may come only from this origin, plus the exact inline scripts in the page (by hash).</summary>
    private static string ContentSecurityPolicy(byte[] page)
    {
        var html = System.Text.Encoding.UTF8.GetString(page);
        var hashes = string.Join(" ", InlineScript().Matches(html)
            .Select(m => m.Groups[1].Value).Where(s => s.Trim().Length > 0)
            .Select(s => "'sha256-" + Convert.ToBase64String(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(s))) + "'"));
        return "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
               $"script-src 'self' {hashes}; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    }

    [GeneratedRegex(@"^/wallets/[a-z-]+\.(?:png|svg|jpg|webp)\z")] private static partial Regex WalletImage();
    [GeneratedRegex(@"<script[^>]*>(.*?)</script>", RegexOptions.Singleline)] private static partial Regex InlineScript();
}
