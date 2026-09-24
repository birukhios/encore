using Encore.Api.Data;
using Encore.Api.Domain;
using Encore.Api.Persistence;
using Encore.Api.Repositories;
using Encore.Api.Security;
using Encore.Api.Services;
using Encore.Api.Web;
using Microsoft.EntityFrameworkCore;

// Local runs read .env (never committed); real environment variables, such as Render's, always win.
var root = RootFolder();
EncoreOptions.LoadEnvFile(Path.Combine(root, ".env"));
Environment.SetEnvironmentVariable("ENCORE_ROOT", Environment.GetEnvironmentVariable("ENCORE_ROOT") ?? root);

var builder = WebApplication.CreateBuilder(args.Where(a => !a.StartsWith("--", StringComparison.Ordinal) || a.Contains('=')).ToArray());
if (string.IsNullOrEmpty(builder.Configuration["ASPNETCORE_URLS"]) && string.IsNullOrEmpty(builder.Configuration["urls"]))
{
    var host = builder.Configuration["HOST"] is { Length: > 0 } h ? h : "127.0.0.1";
    var port = builder.Configuration["PORT"] is { Length: > 0 } p ? p : "8080";
    builder.WebHost.UseUrls($"http://{host}:{port}");
}
builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss "; });
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Logging.AddFilter("Microsoft.EntityFrameworkCore", LogLevel.Warning);

builder.Services.AddSingleton(sp => EncoreOptions.From(sp.GetRequiredService<IConfiguration>()));
builder.Services.AddDbContext<EncoreDbContext>((sp, db) =>
{
    var settings = sp.GetRequiredService<EncoreOptions>();
    EncoreDbContext.Configure(db, settings.DatabaseConfigured ? DatabaseUrl.ToConnectionString(settings.DatabaseUrl) : "Host=unconfigured");
});
builder.Services.AddScoped<RequestTransaction>();
builder.Services.AddScoped<AccountRepository>();
builder.Services.AddScoped<GuestRepository>();
builder.Services.AddScoped<ActivityRepository>();
builder.Services.AddScoped<WorkspaceRepository>();
builder.Services.AddScoped<IWorkspaceRepository>(sp => sp.GetRequiredService<WorkspaceRepository>());
builder.Services.AddScoped<StaffService>();
builder.Services.AddScoped<GuestService>();
builder.Services.AddScoped<PlatformService>();
builder.Services.AddScoped<Notifier>();
builder.Services.AddSingleton<Passwords>();
builder.Services.AddSingleton<RateLimiter>();
builder.Services.AddSingleton<SmsService>();
// No built-in request logging: it would write the full URL, and AfroMessage's carries the number and the sign-in code.
// SmsService logs every request itself, with both hidden.
builder.Services.AddHttpClient("sms", c => c.Timeout = TimeSpan.FromSeconds(15)).RemoveAllLoggers();
builder.Services.AddHostedService<Housekeeping>();
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();
var options = app.Services.GetRequiredService<EncoreOptions>();

if (args.Contains("--check")) return await Cli.CheckAsync(app);
if (args.Contains("--sms-test")) return await Cli.SmsTestAsync(app, args);
if (args.Contains("--sms-balance")) return await Cli.SmsBalanceAsync(app);
if (args.Contains("--create-platform-admin")) return await Cli.CreatePlatformAdminAsync(app);

var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Encore");
var problems = options.ProductionProblems(app.Services.GetRequiredService<SmsService>());
foreach (var (message, blocking) in problems)
    if (blocking) log.LogError("{Problem}", message); else log.LogWarning("{Problem}", message);
if (problems.Any(p => p.Blocking))
{
    log.LogError("Encore cannot start until these are fixed. See .env.example.");
    return 1;
}
if (!string.IsNullOrEmpty(app.Configuration["GUEST_PORT"]))
    log.LogWarning("GUEST_PORT is no longer used: one port ({Port}) serves both apps. Remove GUEST_PORT from .env, and remove ADMIN_ORIGIN/GUEST_ORIGIN unless you use the dev servers; otherwise table QR codes point at {Guest}.",
        app.Configuration["PORT"] ?? "8080", options.GuestOrigin);
await Startup.PrepareDatabaseAsync(app.Services);
log.LogInformation("Database: {Database} · SMS: {Sms}", options.DescribeDatabase(), app.Services.GetRequiredService<SmsService>().Status().Label);
log.LogInformation("Encore guest app: {Guest}/  ·  organizer admin: {Admin}/admin", options.GuestOrigin, options.AdminOrigin);

app.Use(Http.HeadAsGet);
app.Use((http, next) =>
{
    http.Response.OnStarting(() => { Http.SecurityHeaders(http.Response, options.Production); return Task.CompletedTask; });
    return next(http);
});
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}
app.UseRouting();
app.UseWhen(http => Http.IsApi(http.Request.Path), api => api.Use(Http.ApiPipeline));
app.MapControllers();
app.MapFallback("{**path}", async (HttpContext http) =>
{
    if (HttpMethods.IsGet(http.Request.Method)) await StaticSite.ServeAsync(http);
    else await Http.WriteJson(http, new System.Text.Json.Nodes.JsonObject { ["error"] = "Not found" }, 404);
});
await app.RunAsync();
return 0;

static string RootFolder()
{
    if (Environment.GetEnvironmentVariable("ENCORE_ROOT") is { Length: > 0 } configured) return configured;
    foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "package.json"))) return dir.FullName;
    return Directory.GetCurrentDirectory();
}

public partial class Program;

/// <summary>Schema, cleanup and the platform operator account, before the first request.</summary>
public static class Startup
{
    public static async Task PrepareDatabaseAsync(IServiceProvider services)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EncoreDbContext>();
        await db.Database.MigrateAsync();
        await scope.ServiceProvider.GetRequiredService<ActivityRepository>().CleanOldRowsAsync(Ids.Now());
        await scope.ServiceProvider.GetRequiredService<PlatformService>().BootstrapAdminAsync();
    }
}

/// <summary>Hourly cleanup of expired sessions, codes and stale logs. Never stops the server.</summary>
public sealed class Housekeeping(IServiceProvider services, ILogger<Housekeeping> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
                using var scope = services.CreateScope();
                await scope.ServiceProvider.GetRequiredService<ActivityRepository>().CleanOldRowsAsync(Ids.Now());
            }
            catch (OperationCanceledException) { return; }
            catch (Exception problem) { log.LogWarning(problem, "Housekeeping failed; will try again in an hour."); }
        }
    }
}
