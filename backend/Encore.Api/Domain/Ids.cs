using System.Security.Cryptography;
using System.Text;

namespace Encore.Api.Domain;

/// <summary>Identifiers, codes and hashes. Every value that guards access comes from the OS random generator.</summary>
public static class Ids
{
    private const string CodeAlphabet = "ACDEFGHJKLMNPQRTUVWXY3469"; // no look-alikes such as 0/O or 1/I

    /// <summary>
    /// Tests replay golden cases recorded from the original rules, which needs the same ids and clock on both sides.
    /// Scoped to the calling async flow, so a test using it never affects requests running in parallel.
    /// </summary>
    public sealed class Script
    {
        private int _uid, _code, _below;
        public long Clock { get; init; } = 1_790_000_000;
        public string NextUid() => $"uid{++_uid:D4}";
        public string NextCode() => $"C{++_code:D5}";
        public int NextBelow(int n) => _below++ % n;
    }

    private static readonly AsyncLocal<Script?> Scripted = new();

    public static IDisposable UseScript(Script script)
    {
        Scripted.Value = script;
        return new Reset();
    }

    private sealed class Reset : IDisposable
    {
        public void Dispose() => Scripted.Value = null;
    }

    /// <summary>24 URL-safe characters (18 random bytes), the same shape the tokens have always had.</summary>
    public static string Uid() =>
        Scripted.Value?.NextUid() ?? Convert.ToBase64String(RandomNumberGenerator.GetBytes(18)).Replace('+', '-').Replace('/', '_');

    public static string ShortCode(int length = 6) =>
        Scripted.Value?.NextCode() ??
        string.Create(length, 0, (span, _) => { for (var i = 0; i < span.Length; i++) span[i] = CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)]; });

    public static int Below(int n) => Scripted.Value?.NextBelow(n) ?? RandomNumberGenerator.GetInt32(n);

    public static string Reference() => "EN-" + ShortCode();

    /// <summary>Sessions, invites and recovery codes are stored only as this digest, never as the token itself.</summary>
    public static string Digest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    public static long Now() => Scripted.Value?.Clock ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
}
