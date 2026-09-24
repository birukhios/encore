using System.Text;
using System.Text.Json.Nodes;
using Encore.Api.Domain;
using Encore.Api.Persistence;
using Encore.Api.Repositories;
using Encore.Api.Security;
using Encore.Api.Services;

namespace Encore.Api.Web;

/// <summary>Operator commands: npm run check, npm run sms:test, npm run sms:balance, npm run platform-admin.</summary>
public static class Cli
{
    /// <summary>What must be fixed before going live, and what is worth knowing. Exit code 1 while anything must be fixed.</summary>
    public static Task<int> CheckAsync(WebApplication app)
    {
        var options = app.Services.GetRequiredService<EncoreOptions>();
        var sms = app.Services.GetRequiredService<SmsService>();
        var config = app.Services.GetRequiredService<IConfiguration>();
        var problems = options.ProductionProblems(sms).Where(p => p.Blocking).Select(p => p.Message).ToList();
        if (!options.Production) problems.Insert(0, "ENCORE_ENV is not \"production\": secure cookies, HSTS and origin checks are relaxed.");
        var status = sms.Status();
        var notes = new List<string> { $"SMS: {status.Label}" + (status.Delivers ? "" : " — guests cannot sign in until this is fixed.") };
        if (!options.PaymentsReady) notes.Add("Online wallet payments (AfroPay) are not connected. Organizers can still sell with cash: Settings → Payments.");
        if (string.IsNullOrEmpty(config["ENCORE_PLATFORM_EMAIL"]))
            notes.Add("ENCORE_PLATFORM_EMAIL / ENCORE_PLATFORM_PASSWORD not set: no platform console account is created at startup.");
        Console.WriteLine("Encore production check");
        foreach (var (label, items) in new[] { ("Must fix", problems), ("Also note", notes) })
        {
            Console.WriteLine($"\n{label}:");
            foreach (var item in items.Count > 0 ? items : ["Nothing."]) Console.WriteLine(" - " + item);
        }
        return Task.FromResult(problems.Count > 0 ? 1 : 0);
    }

    /// <summary>Send one test message through the configured provider, so delivery is checked before guests rely on it.</summary>
    public static async Task<int> SmsTestAsync(WebApplication app, string[] args)
    {
        var at = Array.IndexOf(args, "--sms-test");
        var number = at + 1 < args.Length ? args[at + 1] : "";
        if (number.Length == 0)
        {
            Console.Error.WriteLine("Usage: npm run sms:test -- +251911234567");
            return 1;
        }
        try
        {
            var used = await app.Services.GetRequiredService<SmsService>()
                .SendAsync(Values.NormalizePhone(number), "Encore test message. If you received this, SMS delivery works.");
            Console.WriteLine($"Sent through \"{used}\". Check the handset.");
            return 0;
        }
        catch (Exception problem) when (problem is SmsNotConfigured or SmsDeliveryFailed or DomainException)
        {
            Console.Error.WriteLine($"Not sent: {problem.Message}");
            return 1;
        }
    }

    public static async Task<int> SmsBalanceAsync(WebApplication app)
    {
        var sms = app.Services.GetRequiredService<SmsService>();
        if (sms.ProviderName != "afromessage")
        {
            Console.WriteLine("Only AfroMessage reports a balance.");
            return 0;
        }
        try
        {
            Console.WriteLine((await sms.AfroMessageBalanceAsync()).ToJsonString());
            return 0;
        }
        catch (Exception problem) when (problem is SmsNotConfigured or SmsDeliveryFailed)
        {
            Console.Error.WriteLine($"Could not read the balance: {problem.Message}");
            return 1;
        }
    }

    /// <summary>Create a platform operator, or reset one's password. The password is typed, never passed on the command line.</summary>
    public static async Task<int> CreatePlatformAdminAsync(WebApplication app)
    {
        await Startup.PrepareDatabaseAsync(app.Services);
        using var scope = app.Services.CreateScope();
        var accounts = scope.ServiceProvider.GetRequiredService<AccountRepository>();
        var passwords = scope.ServiceProvider.GetRequiredService<Passwords>();
        var options = scope.ServiceProvider.GetRequiredService<EncoreOptions>();
        Console.Write("Platform admin email: ");
        var mail = Values.Email(Console.ReadLine() ?? "");
        Console.Write("Name: ");
        var typed = Console.ReadLine() ?? "";
        var name = Values.Text(typed.Length > 0 ? typed : "Platform admin", 100);
        Console.Write("Password (12+ characters): ");
        var password = ReadHidden();
        if (password.Length < 12)
        {
            Console.Error.WriteLine("Use at least 12 characters.");
            return 1;
        }
        var existing = await accounts.PlatformAdminByEmailAsync(mail);
        if (existing is not null) await accounts.SetPlatformAdminAsync(existing.Id, name, passwords.Hash(password));
        else await accounts.AddPlatformAdminAsync(new PlatformAdmin { Id = Ids.Uid(), Name = name, Email = mail, Password = passwords.Hash(password), Created = (int)Ids.Now() });
        Console.WriteLine($"Platform admin ready: {mail}. Sign in at {options.AdminOrigin}/admin/platform");
        return 0;
    }

    private static string ReadHidden()
    {
        if (Console.IsInputRedirected) return Console.ReadLine() ?? "";
        var text = new StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter) break;
            if (key.Key == ConsoleKey.Backspace) { if (text.Length > 0) text.Length--; }
            else if (!char.IsControl(key.KeyChar)) text.Append(key.KeyChar);
        }
        Console.WriteLine();
        return text.ToString();
    }
}
