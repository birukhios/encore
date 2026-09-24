using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Web;
using Encore.Api.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Encore.Api.Tests;

/// <summary>Each provider is checked by capturing the HTTP request it would send, never by contacting the gateway.</summary>
public sealed class SmsProviderTests
{
    private readonly Dictionary<string, string?> _env = [];
    private readonly List<(HttpRequestMessage Request, string Body)> _sent = [];
    private readonly List<string> _log = [];
    private string _reply = """{"acknowledge": "success"}""";
    private HttpStatusCode _status = HttpStatusCode.OK;

    private SmsService Sms(params (string Key, string Value)[] env)
    {
        foreach (var (k, v) in env) _env[k] = v;
        var config = new ConfigurationBuilder().AddInMemoryCollection(_env).Build();
        return new SmsService(config, new Clients(this), new ListLog(_log));
    }

    private (HttpRequestMessage Request, string Body) Last => _sent[^1];

    private static Dictionary<string, string> Query(Uri uri)
    {
        var q = HttpUtility.ParseQueryString(uri.Query);
        return q.AllKeys.ToDictionary(k => k!, k => q[k]!);
    }

    [Fact]
    public async Task Twilio_request_and_missing_settings()
    {
        var sms = Sms(("SMS_PROVIDER", "twilio"), ("TWILIO_ACCOUNT_SID", "AC123"), ("TWILIO_AUTH_TOKEN", "secret"), ("TWILIO_FROM", "+15550001111"));
        Assert.True(sms.Status().Delivers);
        Assert.Equal("twilio", await sms.SendAsync("+251911234567", "Your Encore code is 123456."));
        Assert.Equal("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json", Last.Request.RequestUri!.ToString());
        Assert.Contains("To=%2B251911234567", Last.Body);
        Assert.Contains("From=%2B15550001111", Last.Body);
        Assert.Contains("Body=Your+Encore+code", Last.Body);
        Assert.StartsWith("Basic ", Last.Request.Headers.Authorization!.ToString());
        _env.Remove("TWILIO_FROM");
        sms = Sms();
        Assert.Contains("TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID", sms.Status().Label);
        await Assert.ThrowsAsync<SmsNotConfigured>(() => sms.SendAsync("+251911234567", "x"));
    }

    [Fact]
    public async Task Africastalking_afromessage_and_geezsms()
    {
        await Sms(("SMS_PROVIDER", "africastalking"), ("AT_USERNAME", "encore"), ("AT_API_KEY", "key")).SendAsync("+251911234567", "hello");
        Assert.Equal("https://api.africastalking.com/version1/messaging", Last.Request.RequestUri!.ToString());
        Assert.Equal("key", Last.Request.Headers.GetValues("apiKey").Single());

        _reply = """{"acknowledge": "success", "response": {"status": "Send in progress...", "message_id": "abc"}}""";
        await Sms(("SMS_PROVIDER", "afromessage"), ("AFROMESSAGE_TOKEN", "tok"), ("AFROMESSAGE_SENDER", "Encore")).SendAsync("+251911234567", "hello");
        var uri = Last.Request.RequestUri!;
        Assert.Equal(("https", "api.afromessage.com", "/api/send", "GET"), (uri.Scheme, uri.Host, uri.AbsolutePath, Last.Request.Method.Method));
        Assert.Equal(new Dictionary<string, string> { ["sender"] = "Encore", ["to"] = "+251911234567", ["message"] = "hello" }, Query(uri)); // no `from`
        Assert.Equal("Bearer tok", Last.Request.Headers.Authorization!.ToString());

        await Sms(("SMS_PROVIDER", "geezsms"), ("GEEZSMS_TOKEN", "tok2")).SendAsync("+251911234567", "hello");
        Assert.Equal("hello", (string)JsonNode.Parse(Last.Body)!["msg"]!);
    }

    [Fact]
    public async Task Requests_and_replies_are_logged_without_codes()
    {
        _reply = """{"acknowledge": "success", "response": {"code": "778899", "message_id": "abc"}}""";
        await Sms(("SMS_PROVIDER", "afromessage"), ("AFROMESSAGE_TOKEN", "tok")).SendAsync("+251911234567", "Your Encore code is 123456.");
        var quiet = string.Join("\n", _log);
        Assert.Contains("-> GET https://api.afromessage.com/api/send", quiet);
        Assert.Contains("<- 200", quiet);
        Assert.Contains("acknowledge", quiet);    // the gateway's answer is visible
        Assert.Contains("+2519****4567", quiet);  // the number is masked
        Assert.DoesNotContain("123456", quiet);   // the code Encore sent is hidden
        Assert.DoesNotContain("778899", quiet);   // and the code the gateway generated
        _log.Clear();
        await Sms(("SMS_DEBUG", "1")).SendAsync("+251911234567", "Your Encore code is 123456.");
        var loud = string.Join("\n", _log);
        Assert.Contains("123456", loud); // full detail only while debugging
        Assert.Contains("778899", loud);
    }

    [Fact]
    public async Task Afromessage_failures_and_challenge_codes()
    {
        var sms = Sms(("SMS_PROVIDER", "afromessage"), ("AFROMESSAGE_TOKEN", "tok"), ("AFROMESSAGE_SENDER", "Encore"));
        // Anything other than acknowledge: success is a failure, even with HTTP 200.
        _reply = """{"acknowledge": "error", "response": {"errors": ["invalid recipient"]}}""";
        await Assert.ThrowsAsync<SmsDeliveryFailed>(() => sms.SendAsync("+251911234567", "hello"));
        // Without the challenge endpoint, Encore sends the code it generated itself.
        _reply = """{"acknowledge": "success", "response": {"message_id": "abc"}}""";
        Assert.Equal(("123456", ""), await sms.SendSigninCodeAsync("+251911234567", "123456", 300));
        Assert.Contains("123456", Uri.UnescapeDataString(Last.Request.RequestUri!.ToString()));
        // With AFROMESSAGE_CHALLENGE=1 the gateway generates the code and returns a verification id.
        sms = Sms(("AFROMESSAGE_CHALLENGE", "1"), ("AFROMESSAGE_PREFIX", "Your Afropay code is"));
        _reply = """{"acknowledge": "success", "response": {"code": "778899", "verificationId": "vid-1", "message_id": "xyz"}}""";
        Assert.Equal(("778899", "vid-1"), await sms.SendSigninCodeAsync("+251911234567", "123456", 300));
        var query = Query(Last.Request.RequestUri!);
        Assert.Equal("/api/challenge", Last.Request.RequestUri!.AbsolutePath);
        Assert.Equal(("+251911234567", "6", "300", "0", "Encore"), (query["to"], query["len"], query["ttl"], query["t"], query["sender"]));
        Assert.False(query.ContainsKey("from"));
        Assert.Equal("Your Afropay code is", query["pr"]);
        // A challenge with neither a code nor a verification id cannot be checked later, so it must fail.
        _reply = """{"acknowledge": "success", "response": {"message_id": "xyz"}}""";
        var problem = await Assert.ThrowsAsync<SmsDeliveryFailed>(() => sms.SendSigninCodeAsync("+251911234567", "123456", 300));
        Assert.Contains("neither a verification id nor a code", problem.Message);
        // Verification asks /api/verify with the id and the code the guest typed.
        _reply = """{"acknowledge": "success", "response": {"phone": "+251911234567", "code": "778899"}}""";
        Assert.True(await sms.VerifySigninCodeAsync("+251911234567", "778899", "vid-1"));
        Assert.Equal("/api/verify", Last.Request.RequestUri!.AbsolutePath);
        Assert.Equal(new Dictionary<string, string> { ["to"] = "+251911234567", ["code"] = "778899", ["vc"] = "vid-1" }, Query(Last.Request.RequestUri!));
        _reply = """{"acknowledge": "error", "response": {"errors": ["code not found"]}}""";
        Assert.False(await sms.VerifySigninCodeAsync("+251911234567", "000000", "vid-1"));
    }

    [Fact]
    public async Task Requests_carry_a_user_agent_cloudflare_accepts()
    {
        // Cloudflare answers unknown agents with 403 "error code: 1010".
        _reply = """{"acknowledge": "success", "response": {}}""";
        await Sms(("SMS_PROVIDER", "afromessage"), ("AFROMESSAGE_TOKEN", "tok")).SendAsync("+251911234567", "hello");
        Assert.Contains("Mozilla/5.0", Last.Request.Headers.UserAgent.ToString());
        Assert.Equal("application/json", Last.Request.Headers.Accept.ToString());
    }

    [Fact]
    public async Task Afromessage_needs_only_a_token_and_defaults_the_sender()
    {
        var sms = Sms(("SMS_PROVIDER", "afromessage"), ("AFROMESSAGE_TOKEN", "tok"));
        Assert.True(sms.Status().Delivers);
        await sms.SendAsync("+251911234567", "hello");
        Assert.Equal("Afropay", Query(Last.Request.RequestUri!)["sender"]); // default when nothing is configured
        await Sms(("AFROMESSAGE_SENDER", "Blue Note")).SendAsync("+251911234567", "hello");
        Assert.Equal("Blue Note", Query(Last.Request.RequestUri!)["sender"]); // an organizer's own name still wins
    }

    [Fact]
    public async Task Afromessage_without_a_token_never_reports_success()
    {
        var sms = Sms(("SMS_PROVIDER", "afromessage"));
        Assert.False(sms.Status().Delivers);
        Assert.Contains("AFROMESSAGE_TOKEN", sms.Status().Label);
        await Assert.ThrowsAsync<SmsNotConfigured>(() => sms.SendSigninCodeAsync("+251911234567", "123456", 300));
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Custom_http_gateway_and_error_payloads()
    {
        var sms = Sms(("SMS_PROVIDER", "http"), ("SMS_HTTP_URL", "https://gateway.example/send"), ("SMS_HTTP_AUTH", "Bearer k"),
            ("SMS_HTTP_BODY", """{"number": "{phone}", "content": "{text}"}"""));
        await sms.SendAsync("+251911234567", "Code \"123456\"");
        var payload = JsonNode.Parse(Last.Body)!;
        Assert.Equal(("+251911234567", "Code \"123456\""), ((string)payload["number"]!, (string)payload["content"]!));
        _reply = """{"acknowledge": "error", "response": "invalid sender"}""";
        Assert.Contains("invalid sender", (await Assert.ThrowsAsync<SmsDeliveryFailed>(() => sms.SendAsync("+251911234567", "x"))).Message);
    }

    [Fact]
    public async Task Unconfigured_provider_never_reports_success()
    {
        var sms = Sms(("SMS_PROVIDER", ""), ("ENCORE_ENV", "production"));
        Assert.False(sms.Status().Delivers);
        await Assert.ThrowsAsync<SmsNotConfigured>(() => sms.SendAsync("+251911234567", "x"));
        await Assert.ThrowsAsync<SmsNotConfigured>(() => Sms(("SMS_PROVIDER", "file"), ("SMS_FILE", "/tmp/x")).SendAsync("+251911234567", "x")); // no test sink in production
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Gateway_errors_are_failures()
    {
        _status = HttpStatusCode.Forbidden;
        _reply = "error code: 1010";
        var problem = await Assert.ThrowsAsync<SmsDeliveryFailed>(() => Sms(("SMS_PROVIDER", "afromessage"), ("AFROMESSAGE_TOKEN", "tok")).SendAsync("+251911234567", "x"));
        Assert.Contains("403", problem.Message);
        Assert.Equal("+2519****4567", SmsService.MaskPhone("+251911234567"));
    }

    private sealed class Clients(SmsProviderTests test) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new Capture(test));
    }

    private sealed class Capture(SmsProviderTests test) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            test._sent.Add((request, body));
            return new HttpResponseMessage(test._status) { Content = new StringContent(test._reply, Encoding.UTF8, "application/json") };
        }
    }

    private sealed class ListLog(List<string> lines) : ILogger<SmsService>
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            lines.Add(formatter(state, exception));
    }
}
