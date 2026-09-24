using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Encore.Api.Services;

/// <summary>No provider can deliver messages in this environment.</summary>
public sealed class SmsNotConfigured(string message) : Exception(message);

/// <summary>The provider rejected or did not accept a message.</summary>
public sealed class SmsDeliveryFailed(string message) : Exception(message);

public sealed record SmsStatus(string? Provider, bool Delivers, string Label);

/// <summary>
/// SMS for guest sign-in codes and order notifications. Choose a provider with SMS_PROVIDER and set its variables:
///
///   twilio          TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID)
///   africastalking  AT_USERNAME, AT_API_KEY, AT_FROM (optional sender id)
///   afromessage     AFROMESSAGE_TOKEN, AFROMESSAGE_SENDER (default "Afropay"), AFROMESSAGE_CALLBACK (optional),
///                   AFROMESSAGE_CHALLENGE=1 to let AfroMessage generate and verify sign-in codes. `from` is never sent.
///   geezsms         GEEZSMS_TOKEN, GEEZSMS_FROM (optional sender id)
///   http            SMS_HTTP_URL, SMS_HTTP_METHOD (POST), SMS_HTTP_AUTH (header value),
///                   SMS_HTTP_BODY (JSON template with {phone} and {text}), SMS_HTTP_CONTENT_TYPE
///   file            Tests only: messages are appended to SMS_FILE. Refused in production.
///   console         Development only: the message is printed, never delivered. Refused in production.
///
/// Nothing is ever reported as sent unless the provider accepted it. Requests and replies are logged with the
/// message, the code and the number hidden; SMS_DEBUG=1 logs them in full while troubleshooting.
/// </summary>
public sealed partial class SmsService(IConfiguration config, IHttpClientFactory clients, ILogger<SmsService> log)
{
    public const string AfroMessageApi = "https://api.afromessage.com/api";
    public const string AfroMessageDefaultSender = "Afropay";
    // Gateways behind Cloudflare reject unknown agents with "error code: 1010".
    private const string DefaultUserAgent = "Mozilla/5.0 (compatible; Encore/1.0; +https://github.com/birukhios/encore)";
    private static readonly string[] SecretFields = ["message", "msg", "text", "Body", "pr", "ps", "token"];
    private static readonly string[] Providers = ["file", "twilio", "africastalking", "afromessage", "geezsms", "http"];
    private static readonly object FileLock = new();

    private string Env(string name) => (config[name] ?? "").Trim();
    private bool Production => Env("ENCORE_ENV") == "production";
    private bool Debug => Env("SMS_DEBUG").ToLowerInvariant() is "1" or "true" or "yes" or "on";
    public string ProviderName => Env("SMS_PROVIDER").ToLowerInvariant();

    /// <summary>Settings the chosen provider still needs.</summary>
    public List<string> MissingSettings()
    {
        List<string> Need(params string[] names) => names.Where(n => Env(n).Length == 0).ToList();
        return ProviderName switch
        {
            "file" => Need("SMS_FILE"),
            "twilio" => [.. Need("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"),
                .. Env("TWILIO_FROM").Length > 0 || Env("TWILIO_MESSAGING_SERVICE_SID").Length > 0 ? [] : new[] { "TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID" }],
            "africastalking" => Need("AT_USERNAME", "AT_API_KEY"),
            "afromessage" => Need("AFROMESSAGE_TOKEN"),
            "geezsms" => Need("GEEZSMS_TOKEN"),
            "http" => Need("SMS_HTTP_URL"),
            _ => [],
        };
    }

    /// <summary>Delivery status for the organizer's settings screen and the production check.</summary>
    public SmsStatus Status()
    {
        var name = ProviderName;
        if (name == "file") return new("file", !Production, "Test sink: messages are written to SMS_FILE, not sent");
        if (Providers.Contains(name))
        {
            var missing = MissingSettings();
            return missing.Count > 0 ? new(name, false, $"{name}: set {string.Join(", ", missing)}") : new(name, true, $"Connected ({name})");
        }
        if (!Production && name is "" or "console") return new("console", false, "Development mode: codes are printed in the server log, not sent");
        return new(name.Length > 0 ? name : null, false, "Not configured — set SMS_PROVIDER and its credentials");
    }

    public JsonObject StatusJson()
    {
        var s = Status();
        return new JsonObject { ["provider"] = s.Provider, ["delivers"] = s.Delivers, ["label"] = s.Label };
    }

    /// <summary>Deliver one message; returns the provider's name. Throws SmsNotConfigured or SmsDeliveryFailed.</summary>
    public async Task<string> SendAsync(string phone, string text, CancellationToken ct = default)
    {
        var name = ProviderName;
        if (name == "file" && Production) throw new SmsNotConfigured("The file SMS sink is for development and tests only.");
        if (Providers.Contains(name))
        {
            var missing = MissingSettings();
            if (missing.Count > 0) throw new SmsNotConfigured($"{name} is missing {string.Join(", ", missing)}.");
            switch (name)
            {
                case "file": SendFile(phone, text); break;
                case "twilio": await SendTwilio(phone, text, ct); break;
                case "africastalking": await SendAfricasTalking(phone, text, ct); break;
                case "afromessage": await SendAfroMessage(phone, text, ct); break;
                case "geezsms": await SendGeezSms(phone, text, ct); break;
                case "http": await SendHttp(phone, text, ct); break;
            }
            return name;
        }
        if (!Production && name is "" or "console")
        {
            Console.WriteLine($"[DEV SMS - NOT DELIVERED] to {phone}: {text}");
            return "console";
        }
        throw new SmsNotConfigured("SMS delivery is not configured.");
    }

    /// <summary>
    /// Deliver a sign-in code. Returns (code, verificationId). Normally Encore's own code is sent and checked locally,
    /// so the id is empty. With AfroMessage's challenge endpoint the gateway makes the code and verifies it later, so
    /// an id comes back and the code itself never needs to be stored.
    /// </summary>
    public async Task<(string Code, string VerificationId)> SendSigninCodeAsync(string phone, string code, int ttl, int length = 6, CancellationToken ct = default)
    {
        if (ProviderName == "afromessage" && Flag("AFROMESSAGE_CHALLENGE"))
        {
            var missing = MissingSettings();
            if (missing.Count > 0) throw new SmsNotConfigured($"afromessage is missing {string.Join(", ", missing)}.");
            return await AfroMessageChallenge(phone, ttl, length, ct);
        }
        await SendAsync(phone, $"Your Afropay code is {code}. It expires in {ttl / 60} minutes. Never share this code.", ct);
        return (code, "");
    }

    /// <summary>Ask the provider that issued a code whether it is right. Only used when the provider made the code.</summary>
    public async Task<bool> VerifySigninCodeAsync(string phone, string code, string verificationId, CancellationToken ct = default)
    {
        if (ProviderName != "afromessage") throw new SmsNotConfigured("This provider cannot verify codes.");
        var query = new List<(string, string)> { ("to", phone), ("code", code) };
        if (verificationId.Length > 0) query.Add(("vc", verificationId));
        try
        {
            AfroMessageResult(await Get($"{AfroMessageApi}/verify", query, AfroMessageAuth(), ct));
            return true;
        }
        catch (SmsDeliveryFailed problem)
        {
            Log($"verify rejected for {MaskPhone(phone)}: {problem.Message}");
            return false;
        }
    }

    /// <summary>Remaining credit on the AfroMessage account behind the token.</summary>
    public async Task<JsonNode> AfroMessageBalanceAsync(CancellationToken ct = default) =>
        AfroMessageResult(await Get($"{AfroMessageApi}/balance", [], AfroMessageAuth(), ct));

    public static string MaskPhone(string value) =>
        value.Length > 9 ? value[..5] + new string('*', Math.Max(0, value.Length - 9)) + value[^4..] : "***";

    // ------------------------------------------------------------ providers

    private void SendFile(string phone, string text)
    {
        var line = JsonSerializer.Serialize(new { phone, text }) + "\n";
        lock (FileLock) File.AppendAllText(Env("SMS_FILE"), line, new UTF8Encoding(false));
    }

    private async Task SendTwilio(string phone, string text, CancellationToken ct)
    {
        var sid = Env("TWILIO_ACCOUNT_SID");
        var fields = new List<(string, string)> { ("To", phone), ("Body", text) };
        fields.Add(Env("TWILIO_MESSAGING_SERVICE_SID") is { Length: > 0 } service ? ("MessagingServiceSid", service) : ("From", Env("TWILIO_FROM")));
        var auth = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{sid}:{Env("TWILIO_AUTH_TOKEN")}"));
        await Send(HttpMethod.Post, $"https://api.twilio.com/2010-04-01/Accounts/{Uri.EscapeDataString(sid)}/Messages.json",
            Form(fields), "application/x-www-form-urlencoded", new() { ["Authorization"] = "Basic " + auth }, ct);
    }

    private async Task SendAfricasTalking(string phone, string text, CancellationToken ct)
    {
        var username = Env("AT_USERNAME");
        var fields = new List<(string, string)> { ("username", username), ("to", phone), ("message", text) };
        if (Env("AT_FROM") is { Length: > 0 } sender) fields.Add(("from", sender));
        var host = username == "sandbox" ? "api.sandbox.africastalking.com" : "api.africastalking.com";
        await Send(HttpMethod.Post, $"https://{host}/version1/messaging", Form(fields), "application/x-www-form-urlencoded",
            new() { ["apiKey"] = Env("AT_API_KEY") }, ct);
    }

    /// <summary>AfroMessage identifies the account from the token; `from` is not sent.</summary>
    private Dictionary<string, string> AfroMessageAuth() => new() { ["Authorization"] = "Bearer " + Env("AFROMESSAGE_TOKEN") };

    private List<(string, string)> AfroMessageBase() =>
        [("sender", Env("AFROMESSAGE_SENDER") is { Length: > 0 } s ? s : AfroMessageDefaultSender), ("callback", Env("AFROMESSAGE_CALLBACK"))];

    private async Task SendAfroMessage(string phone, string text, CancellationToken ct) =>
        AfroMessageResult(await Get($"{AfroMessageApi}/send", [.. AfroMessageBase(), ("to", phone), ("message", text)], AfroMessageAuth(), ct));

    /// <summary>AfroMessage generates and sends a code; Encore keeps only the verificationId and later asks /verify.</summary>
    private async Task<(string, string)> AfroMessageChallenge(string phone, int ttl, int length, CancellationToken ct)
    {
        var query = new List<(string, string)>(AfroMessageBase())
        {
            ("to", phone), ("len", length.ToString()), ("ttl", ttl.ToString()),
            ("t", Env("AFROMESSAGE_CODE_TYPE") is { Length: > 0 } t ? t : "0"), ("sb", "1"), ("sa", "1"),
            ("pr", Env("AFROMESSAGE_PREFIX") is { Length: > 0 } pr ? pr : "Your Afropay code is"),
            ("ps", Env("AFROMESSAGE_POSTFIX") is { Length: > 0 } ps ? ps : ". It expires in 5 minutes. Never share this code."),
        };
        var result = AfroMessageResult(await Get($"{AfroMessageApi}/challenge", query, AfroMessageAuth(), ct));
        var verification = Scalar(result["verificationId"]).Trim();
        var code = Scalar(result["code"]).Trim();
        if (verification.Length == 0 && code.Length == 0)
            throw new SmsDeliveryFailed("AfroMessage returned neither a verification id nor a code, so the sign-in cannot be checked.");
        return (code, verification);
    }

    /// <summary>AfroMessage answers 200 for failures too: only `acknowledge: success` means the message was accepted.</summary>
    private static JsonNode AfroMessageResult(string body)
    {
        JsonNode? data;
        try { data = JsonNode.Parse(body); }
        catch (JsonException) { throw new SmsDeliveryFailed($"unexpected reply from AfroMessage: {Cut(body, 200)}"); }
        if (data is not JsonObject o || Scalar(o["acknowledge"]).ToLowerInvariant() != "success")
        {
            var detail = data is JsonObject d ? (Truthy(d["response"]) ? d["response"]!.ToJsonString() : Scalar(d["message"])) : body;
            throw new SmsDeliveryFailed(Cut(detail, 200));
        }
        return Truthy(o["response"]) ? o["response"]! : new JsonObject();
    }

    private async Task SendGeezSms(string phone, string text, CancellationToken ct)
    {
        var payload = new JsonObject { ["token"] = Env("GEEZSMS_TOKEN"), ["phone"] = phone, ["msg"] = text };
        if (Env("GEEZSMS_FROM") is { Length: > 0 } sender) payload["shortcode_id"] = sender;
        RejectErrorBody(await Send(HttpMethod.Post, "https://api.geezsms.com/api/v1/sms/send", payload.ToJsonString(), "application/json", [], ct));
    }

    /// <summary>Generic gateway: posts a configured body template. Use for providers not built in.</summary>
    private async Task SendHttp(string phone, string text, CancellationToken ct)
    {
        var template = Env("SMS_HTTP_BODY") is { Length: > 0 } b ? b : """{"to": "{phone}", "text": "{text}"}""";
        var body = template.Replace("{phone}", phone).Replace("{text}", JsonSerializer.Serialize(text)[1..^1]);
        var headers = new Dictionary<string, string>();
        if (Env("SMS_HTTP_AUTH") is { Length: > 0 } auth) headers["Authorization"] = auth;
        var method = new HttpMethod(Env("SMS_HTTP_METHOD") is { Length: > 0 } m ? m.ToUpperInvariant() : "POST");
        RejectErrorBody(await Send(method, Env("SMS_HTTP_URL"), body, Env("SMS_HTTP_CONTENT_TYPE") is { Length: > 0 } ct2 ? ct2 : "application/json", headers, ct));
    }

    /// <summary>Some gateways answer 200 with an error payload; treat a declared failure as a failure.</summary>
    private static void RejectErrorBody(string body)
    {
        JsonNode? data;
        try { data = JsonNode.Parse(body); }
        catch (JsonException) { return; }
        if (data is not JsonObject o) return;
        var status = (Scalar(o["acknowledge"]) is { Length: > 0 } a ? a : Scalar(o["status"]) is { Length: > 0 } s ? s : Scalar(o["result"])).ToLowerInvariant();
        if (status is "error" or "failed" or "failure" or "false" || Truthy(o["error"]) || Truthy(o["errors"]))
        {
            var reason = new[] { o["response"], o["message"], o["error"] }.FirstOrDefault(Truthy);
            throw new SmsDeliveryFailed(Cut(reason is null ? body : Scalar(reason), 200));
        }
    }

    // ------------------------------------------------------------ HTTP

    private Task<string> Get(string url, List<(string Key, string Value)> query, Dictionary<string, string> headers, CancellationToken ct)
    {
        var kept = query.Where(p => p.Value.Length > 0).ToList();
        return Send(HttpMethod.Get, kept.Count > 0 ? url + "?" + Form(kept) : url + "?", null, "application/json", headers, ct);
    }

    /// <summary>One request; both directions are logged so operators can see what the gateway was asked and answered.</summary>
    private async Task<string> Send(HttpMethod method, string url, string? body, string contentType, Dictionary<string, string> headers, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, url);
        request.Headers.TryAddWithoutValidation("User-Agent", Env("SMS_USER_AGENT") is { Length: > 0 } ua ? ua : DefaultUserAgent);
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        foreach (var (k, v) in headers) request.Headers.TryAddWithoutValidation(k, v);
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, MediaTypeHeaderValue.Parse(contentType));
        Log($"-> {method} {SafeUrl(url)}" + (body is { Length: > 0 } ? $" body={SafeBody(body)}" : ""));
        HttpResponseMessage response;
        try
        {
            response = await clients.CreateClient("sms").SendAsync(request, ct);
        }
        catch (Exception problem) when (problem is HttpRequestException or TaskCanceledException)
        {
            Log($"<- no reply: {problem.Message}");
            throw new SmsDeliveryFailed($"could not reach the SMS provider: {problem.Message}");
        }
        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(ct);
            Log($"<- {(int)response.StatusCode} {SafeBody(text)}");
            if (!response.IsSuccessStatusCode) throw new SmsDeliveryFailed($"{(int)response.StatusCode}: {Cut(text, 200)}");
            return text;
        }
    }

    /// <summary>The query carries the message (and so the code) and the guest's number: hide both unless debugging.</summary>
    private string SafeUrl(string url)
    {
        var at = url.IndexOf('?');
        if (Debug || at < 0 || at == url.Length - 1) return url;
        var parts = url[(at + 1)..].Split('&').Select(pair =>
        {
            var eq = pair.IndexOf('=');
            var key = Unescape(eq < 0 ? pair : pair[..eq]);
            var value = eq < 0 ? "" : Unescape(pair[(eq + 1)..]);
            if (SecretFields.Contains(key)) value = $"<{value.Length} chars hidden>";
            else if (key is "to" or "phone" or "To") value = MaskPhone(value);
            return $"{key}={value}";
        });
        return url[..at] + "?" + string.Join("&", parts);
    }

    /// <summary>Keep the gateway's status and errors; hide any code it generated.</summary>
    private string SafeBody(string body) => Debug ? body : Cut(CodeField().Replace(body, "$1***$2"), 400);

    private void Log(string line) => log.LogInformation("SMS {Line}", line);

    private bool Flag(string name) => Env(name).ToLowerInvariant() is "1" or "true" or "yes" or "on";

    private static string Form(IEnumerable<(string Key, string Value)> fields) =>
        string.Join("&", fields.Select(f => Escape(f.Key) + "=" + Escape(f.Value)));

    // application/x-www-form-urlencoded, as Python's urlencode writes it (spaces as '+').
    private static string Escape(string value) => Uri.EscapeDataString(value).Replace("%20", "+");

    private static string Unescape(string value) => Uri.UnescapeDataString(value.Replace('+', ' '));

    private static string Scalar(JsonNode? v) => v switch
    {
        null => "",
        JsonValue x when x.TryGetValue(out string? s) => s,
        _ => v.ToJsonString(),
    };

    private static bool Truthy(JsonNode? v) => Domain.Values.Truthy(v);

    private static string Cut(string s, int n) => s.Length > n ? s[..n] : s;

    [GeneratedRegex("(\"(?:code|pin|otp)\"\\s*:\\s*\")[^\"]*(\")")] private static partial Regex CodeField();
}
