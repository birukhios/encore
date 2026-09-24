using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Encore.Api.Domain;

/// <summary>A rule was broken; the message is written for the guest or staff member and is safe to show.</summary>
public sealed class DomainException(string message) : Exception(message);

/// <summary>
/// Input parsing ported from the original Python rules (text, email, number, money_cents, whole, flag, normalize_phone).
/// Inputs arrive as JSON from the browser, so every helper takes a JsonNode and never trusts its type.
/// </summary>
public static partial class Values
{
    public const long MaxTipCents = 5_000_000;

    public static string Text(JsonNode? v, int maxLength = 200, bool required = true)
    {
        var s = v is JsonValue value && value.TryGetValue(out string? str) ? str : null;
        if (v is null || (s is not null && s.Trim().Length == 0))
        {
            if (required) throw new DomainException("Please complete all required fields.");
            return "";
        }
        if (s is null) throw new DomainException("Please complete all required fields.");
        if (s.Length > maxLength) throw new DomainException($"Keep this under {maxLength} characters.");
        return s.Trim();
    }

    public static string Email(JsonNode? v, bool required = true)
    {
        var s = Text(v, 200, required).ToLowerInvariant();
        if (s.Length > 0 && !EmailPattern().IsMatch(s)) throw new DomainException("Enter a valid email address.");
        return s;
    }

    /// <summary>A plain number within a range. Never used for money; see <see cref="MoneyCents"/>.</summary>
    public static double Number(JsonNode? v, double low = 0, double high = 1_000_000)
    {
        if (IsBool(v)) throw new DomainException("Invalid number.");
        if (!TryDouble(v, out var n)) throw new DomainException("Enter a valid number.");
        if (!(low <= n && n <= high)) throw new DomainException("Number is outside the allowed range.");
        return n;
    }

    public static int Whole(JsonNode? v, double low, double high, string message = "Enter a whole number.")
    {
        var n = Number(v, low, high);
        if (n != Math.Floor(n)) throw new DomainException(message);
        return (int)n;
    }

    /// <summary>An amount in currency units as exact integer cents: at most two decimals, never negative.</summary>
    public static long MoneyCents(JsonNode? v, long maxCents, string message)
    {
        if (v is null || (v is JsonValue sv && sv.TryGetValue(out string? empty) && empty == "")) return 0;
        if (IsBool(v)) throw new DomainException(message);
        var raw = v is JsonValue s && s.TryGetValue(out string? str) ? str : v.ToJsonString();
        if (!decimal.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var amount))
            throw new DomainException(message);
        var cents = amount * 100;
        if (amount < 0 || cents != decimal.Truncate(cents) || cents > maxCents) throw new DomainException(message);
        return (long)cents;
    }

    public static bool Flag(JsonNode? v) =>
        v is JsonValue value && (
            (value.TryGetValue(out bool b) && b) ||
            (value.TryGetValue(out string? s) && s is "on" or "true" or "1") ||
            (value.GetValueKind() == JsonValueKind.Number && Double(value) == 1));

    /// <summary>E.164; Ethiopian local formats are accepted.</summary>
    public static string NormalizePhone(JsonNode? v)
    {
        if (v is not JsonValue value || !value.TryGetValue(out string? s)) throw new DomainException("Enter your mobile number.");
        var raw = PhoneNoise().Replace(s, "");
        if (LocalEthiopian().IsMatch(raw) || InternationalEthiopian().IsMatch(raw)) return "+251" + raw[^9..];
        if (International().IsMatch(raw)) return "+" + (raw.StartsWith('+') ? raw[1..] : raw[2..]);
        throw new DomainException("Enter a valid mobile number, for example 0911 234 567.");
    }

    /// <summary>Python truthiness for workspace settings, which older documents store loosely.</summary>
    public static bool Truthy(JsonNode? v) => v switch
    {
        null => false,
        JsonArray a => a.Count > 0,
        JsonObject o => o.Count > 0,
        JsonValue x when x.TryGetValue(out bool b) => b,
        JsonValue x when x.TryGetValue(out string? s) => s.Length > 0,
        JsonValue x when x.GetValueKind() == JsonValueKind.Number => Double(x) != 0,
        _ => true,
    };

    /// <summary>
    /// A stored number as decimal. Works for numbers parsed from JSON and for ones this server created as long,
    /// int or double (System.Text.Json's GetValue only converts the former).
    /// </summary>
    public static decimal Decimal(JsonNode? v)
    {
        if (v is not JsonValue x || x.GetValueKind() != JsonValueKind.Number) throw new InvalidDataException("A stored number is missing.");
        if (x.TryGetValue(out decimal d)) return d;
        if (x.TryGetValue(out long l)) return l;
        if (x.TryGetValue(out int i)) return i;
        return decimal.Parse(x.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    public static double Double(JsonNode? v)
    {
        if (v is not JsonValue x || x.GetValueKind() != JsonValueKind.Number) throw new InvalidDataException("A stored number is missing.");
        return x.TryGetValue(out double d) ? d : double.Parse(x.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    public static long Long(JsonNode? v) => (long)Decimal(v);

    /// <summary>Python's "{:g}": 70.0 prints as 70, 10.25 as 10.25, six significant digits.</summary>
    public static string PyG(double n)
    {
        var text = n.ToString("G6", CultureInfo.InvariantCulture);
        var e = text.IndexOf('E');
        if (e < 0) return text;
        var exponent = int.Parse(text[(e + 1)..], CultureInfo.InvariantCulture);
        return text[..e] + "e" + (exponent < 0 ? "-" : "+") + Math.Abs(exponent).ToString("00", CultureInfo.InvariantCulture);
    }

    /// <summary>What Python's str() prints for a JSON scalar, for messages that quote stored values.</summary>
    public static string Show(JsonNode? v) =>
        v is JsonValue x && x.TryGetValue(out string? s) ? s : v?.ToJsonString() ?? "None";

    /// <summary>Compare secrets such as table tokens without leaking their contents through timing.</summary>
    public static bool SameSecret(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    private static bool IsBool(JsonNode? v) => v is JsonValue x && x.GetValueKind() is JsonValueKind.True or JsonValueKind.False;

    private static bool TryDouble(JsonNode? v, out double n)
    {
        n = 0;
        if (v is not JsonValue x) return false;
        if (x.GetValueKind() == JsonValueKind.Number) { n = Double(x); return true; }
        if (!x.TryGetValue(out string? s)) return false;
        s = s.Trim();
        // Python's float() also accepts these; they then fail the range check with its message.
        switch (s.ToLowerInvariant().TrimStart('+', '-'))
        {
            case "inf" or "infinity": n = s.StartsWith('-') ? double.NegativeInfinity : double.PositiveInfinity; return true;
            case "nan": n = double.NaN; return true;
        }
        return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out n);
    }

    [GeneratedRegex(@"^[^\s@]+@[^\s@]+\.[^\s@]+\z")] private static partial Regex EmailPattern();
    [GeneratedRegex(@"[\s().-]")] private static partial Regex PhoneNoise();
    [GeneratedRegex(@"^0?[79]\d{8}\z")] private static partial Regex LocalEthiopian();
    [GeneratedRegex(@"^(?:\+|00)251[79]\d{8}\z")] private static partial Regex InternationalEthiopian();
    [GeneratedRegex(@"^(?:\+|00)[1-9]\d{7,14}\z")] private static partial Regex International();
}
