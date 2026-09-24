using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Identity;

namespace Encore.Api.Security;

public enum PasswordCheck { Wrong, Correct, CorrectButRehash }

/// <summary>
/// Passwords are hashed with ASP.NET Core Identity's PasswordHasher (PBKDF2, versioned format).
/// Accounts created by the earlier Python server hold "salthex:scrypthex"; those still verify, and the caller
/// replaces the hash on the next successful sign-in so nobody is locked out and nobody needs a reset.
/// </summary>
public sealed class Passwords
{
    private static readonly PasswordHasher<object> Hasher = new();
    private static readonly object Account = new();

    public string Hash(string password) => Hasher.HashPassword(Account, password);

    public PasswordCheck Verify(string password, string stored)
    {
        if (string.IsNullOrEmpty(stored)) return PasswordCheck.Wrong;
        if (stored.Contains(':')) return VerifyLegacy(password, stored) ? PasswordCheck.CorrectButRehash : PasswordCheck.Wrong;
        try
        {
            return Hasher.VerifyHashedPassword(Account, stored, password) switch
            {
                PasswordVerificationResult.Success => PasswordCheck.Correct,
                PasswordVerificationResult.SuccessRehashNeeded => PasswordCheck.CorrectButRehash,
                _ => PasswordCheck.Wrong,
            };
        }
        catch (FormatException)
        {
            return PasswordCheck.Wrong;
        }
    }

    private static bool VerifyLegacy(string password, string stored)
    {
        var parts = stored.Split(':');
        if (parts.Length != 2) return false;
        byte[] salt, expected;
        try
        {
            salt = Convert.FromHexString(parts[0]);
            expected = Convert.FromHexString(parts[1]);
        }
        catch (FormatException)
        {
            return false;
        }
        var actual = Scrypt.DeriveKey(Encoding.UTF8.GetBytes(password), salt, 16384, 8, 1, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}
