using Encore.Api.Data;
using Encore.Api.Models;
using Encore.Api.Repositories;
using Encore.Api.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
var databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL");
if (string.IsNullOrWhiteSpace(databaseUrl))
    throw new InvalidOperationException("DATABASE_URL must point to PostgreSQL.");

builder.Services.AddDbContext<EncoreIdentityDbContext>(options =>
    options.UseNpgsql(DatabaseUrl.ToConnectionString(databaseUrl)));
builder.Services.AddIdentityCore<EncoreIdentityUser>()
    .AddRoles<IdentityRole>()
    .AddEntityFrameworkStores<EncoreIdentityDbContext>();
builder.Services.AddScoped<IReadinessRepository, ReadinessRepository>();
builder.Services.AddScoped<ILegacyRelayService, LegacyRelayService>();
builder.Services.AddHttpClient("legacy")
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        AutomaticDecompression = System.Net.DecompressionMethods.None
    });
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}
app.MapControllers();
app.Run();
