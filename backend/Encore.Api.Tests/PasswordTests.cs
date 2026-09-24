using System.Text;
using Encore.Api.Security;

namespace Encore.Api.Tests;

public sealed class PasswordTests
{
    // Produced by the Python server's password() for a throwaway test password; the format every existing account has.
    private const string PythonHash = "9d2df13d3a359e51ff945e14462c972c:b197a825e86db49348952871e05c7d33ab8057cc375179e13a58986aa081486858d2491379975408999366d75ef5ccafe655a1c47ab8473faada4ad8bca8cd8f";

    [Theory]
    [InlineData("", "", 16, 1, 1, "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906")]
    [InlineData("password", "NaCl", 1024, 8, 16, "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640")]
    public void Scrypt_matches_rfc_7914(string password, string salt, int n, int r, int p, string hex) =>
        Assert.Equal(hex, Convert.ToHexString(Scrypt.DeriveKey(Encoding.UTF8.GetBytes(password), Encoding.UTF8.GetBytes(salt), n, r, p, 64)).ToLowerInvariant());

    [Fact]
    public void Accounts_from_the_python_server_still_sign_in_and_are_upgraded()
    {
        var passwords = new Passwords();
        Assert.Equal(PasswordCheck.CorrectButRehash, passwords.Verify("test-only password é", PythonHash));
        Assert.Equal(PasswordCheck.Wrong, passwords.Verify("test-only password e", PythonHash));
        Assert.Equal(PasswordCheck.Wrong, passwords.Verify("anything", "not:hex"));
    }

    [Fact]
    public void New_hashes_use_identity_and_verify()
    {
        var passwords = new Passwords();
        var hash = passwords.Hash("a long enough password");
        Assert.DoesNotContain(':', hash);
        Assert.Equal(PasswordCheck.Correct, passwords.Verify("a long enough password", hash));
        Assert.Equal(PasswordCheck.Wrong, passwords.Verify("a long enough passwore", hash));
        Assert.Equal(PasswordCheck.Wrong, passwords.Verify("x", ""));
    }
}
