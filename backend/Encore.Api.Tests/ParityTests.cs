using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Encore.Api.Domain;
using Encore.Api.Persistence;

namespace Encore.Api.Tests;

/// <summary>
/// Replays tests/parity.py's golden cases, which the Python domain.py computed. The .NET port must give the
/// same quote or the same message for every one. Regenerate with `python3 tests/parity.py`.
/// </summary>
public sealed class ParityTests
{
    private static readonly JsonObject Fixture = Load();

    private static JsonObject Load([CallerFilePath] string here = "") =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(Path.GetDirectoryName(here)!, "Fixtures", "parity.json")))!.AsObject();

    public static TheoryData<int> Quotes() => Indexes("quotes");
    public static TheoryData<int> Money() => Indexes("money");
    public static TheoryData<int> Wholes() => Indexes("whole");
    public static TheoryData<int> Phones() => Indexes("phones");
    public static TheoryData<int> Emails() => Indexes("emails");

    [Theory, MemberData(nameof(Quotes))]
    public void Quote_matches_python(int i)
    {
        var c = Fixture["quotes"]![i]!;
        var workspace = Workspace.Parse(c["workspace"]!.ToJsonString());
        var request = c["request"]!.DeepClone().AsObject();
        Check(c, () => Pricing.QuoteOrder(workspace, request, (string?)c["guest"], (bool)c["staff"]!));
    }

    [Theory, MemberData(nameof(Money))]
    public void Money_matches_python(int i)
    {
        var c = Fixture["money"]![i]!;
        Check(c, () => Values.MoneyCents(c["input"]?.DeepClone(), 10_000_000, "Bad amount."));
    }

    [Theory, MemberData(nameof(Wholes))]
    public void Whole_matches_python(int i)
    {
        var c = Fixture["whole"]![i]!;
        Check(c, () => Values.Whole(c["input"]?.DeepClone(), 0, 50, "Whole only."));
    }

    [Theory, MemberData(nameof(Phones))]
    public void Phone_matches_python(int i)
    {
        var c = Fixture["phones"]![i]!;
        Check(c, () => Values.NormalizePhone(c["input"]?.DeepClone()));
    }

    [Theory, MemberData(nameof(Emails))]
    public void Email_matches_python(int i)
    {
        var c = Fixture["emails"]![i]!;
        Check(c, () => Values.Email(c["input"]?.DeepClone(), required: false));
    }

    [Fact]
    public void Fixture_prices_a_real_share_of_cases()
    {
        // Guards against a regenerated fixture that only exercises refusals.
        Assert.True(Fixture["quotes"]!.AsArray().Count(q => q!["expect"]!["ok"] is not null) >= 100);
    }

    private static void Check<T>(JsonNode c, Func<T> run)
    {
        var expect = c["expect"]!;
        string? actual, error = null;
        try { actual = Canonical(JsonSerializer.SerializeToNode(run())); }
        catch (DomainException problem) { actual = null; error = problem.Message; }

        if (expect["error"] is { } message)
            Assert.Equal(((string?)message, (string?)null), (error, actual));
        else
            Assert.Equal((Canonical(expect["ok"]), (string?)null), (actual, error));
    }

    /// <summary>Key order and 15 vs 15.0 are not differences Python or the browser can observe.</summary>
    private static string Canonical(JsonNode? node)
    {
        var sb = new StringBuilder();
        Write(node);
        return sb.ToString();

        void Write(JsonNode? n)
        {
            switch (n)
            {
                case null: sb.Append("null"); break;
                case JsonObject o:
                    sb.Append('{');
                    foreach (var (k, v) in o.OrderBy(p => p.Key, StringComparer.Ordinal)) { sb.Append(JsonSerializer.Serialize(k)).Append(':'); Write(v); sb.Append(','); }
                    sb.Append('}');
                    break;
                case JsonArray a:
                    sb.Append('[');
                    foreach (var v in a) { Write(v); sb.Append(','); }
                    sb.Append(']');
                    break;
                case JsonValue v when v.GetValueKind() == JsonValueKind.Number:
                    sb.Append(v.GetValue<decimal>().ToString("0.############", CultureInfo.InvariantCulture));
                    break;
                default: sb.Append(n.ToJsonString()); break;
            }
        }
    }

    private static TheoryData<int> Indexes(string group)
    {
        var data = new TheoryData<int>();
        for (var i = 0; i < Fixture[group]!.AsArray().Count; i++) data.Add(i);
        return data;
    }
}
