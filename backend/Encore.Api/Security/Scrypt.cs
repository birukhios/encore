using System.Buffers.Binary;
using System.Numerics;
using System.Security.Cryptography;

namespace Encore.Api.Security;

/// <summary>
/// scrypt (RFC 7914). Only used to check passwords saved by the earlier Python server
/// (hashlib.scrypt, N=16384, r=8, p=1, 64-byte key); new passwords use ASP.NET Core Identity's hasher.
/// </summary>
public static class Scrypt
{
    public static byte[] DeriveKey(byte[] password, byte[] salt, int n, int r, int p, int length)
    {
        if (n < 2 || (n & (n - 1)) != 0) throw new ArgumentException("N must be a power of two above 1.", nameof(n));
        var blockSize = 128 * r;
        var b = Rfc2898DeriveBytes.Pbkdf2(password, salt, 1, HashAlgorithmName.SHA256, p * blockSize);
        var x = new uint[32 * r];
        var v = new uint[32 * r * n];
        var scratch = new uint[16];
        for (var i = 0; i < p; i++)
        {
            var chunk = b.AsSpan(i * blockSize, blockSize);
            for (var k = 0; k < x.Length; k++) x[k] = BinaryPrimitives.ReadUInt32LittleEndian(chunk[(4 * k)..]);
            RoMix(x, v, n, r, scratch);
            for (var k = 0; k < x.Length; k++) BinaryPrimitives.WriteUInt32LittleEndian(chunk[(4 * k)..], x[k]);
        }
        return Rfc2898DeriveBytes.Pbkdf2(password, b, 1, HashAlgorithmName.SHA256, length);
    }

    private static void RoMix(uint[] x, uint[] v, int n, int r, uint[] scratch)
    {
        var words = 32 * r;
        var y = new uint[words];
        for (var i = 0; i < n; i++)
        {
            Array.Copy(x, 0, v, i * words, words);
            BlockMix(x, y, r, scratch);
            Array.Copy(y, x, words);
        }
        for (var i = 0; i < n; i++)
        {
            var j = (int)(x[(2 * r - 1) * 16] & (uint)(n - 1)); // Integerify: first word of the last 64-byte block
            for (var k = 0; k < words; k++) x[k] ^= v[j * words + k];
            BlockMix(x, y, r, scratch);
            Array.Copy(y, x, words);
        }
    }

    private static void BlockMix(uint[] b, uint[] output, int r, uint[] x)
    {
        Array.Copy(b, (2 * r - 1) * 16, x, 0, 16);
        for (var i = 0; i < 2 * r; i++)
        {
            for (var k = 0; k < 16; k++) x[k] ^= b[i * 16 + k];
            Salsa208(x);
            // Even blocks go to the first half of the output, odd blocks to the second half.
            var target = (i % 2 == 0 ? i / 2 : r + i / 2) * 16;
            Array.Copy(x, 0, output, target, 16);
        }
    }

    private static void Salsa208(uint[] b)
    {
        Span<uint> x = stackalloc uint[16];
        b.AsSpan().CopyTo(x);
        for (var i = 0; i < 8; i += 2)
        {
            x[4] ^= BitOperations.RotateLeft(x[0] + x[12], 7); x[8] ^= BitOperations.RotateLeft(x[4] + x[0], 9);
            x[12] ^= BitOperations.RotateLeft(x[8] + x[4], 13); x[0] ^= BitOperations.RotateLeft(x[12] + x[8], 18);
            x[9] ^= BitOperations.RotateLeft(x[5] + x[1], 7); x[13] ^= BitOperations.RotateLeft(x[9] + x[5], 9);
            x[1] ^= BitOperations.RotateLeft(x[13] + x[9], 13); x[5] ^= BitOperations.RotateLeft(x[1] + x[13], 18);
            x[14] ^= BitOperations.RotateLeft(x[10] + x[6], 7); x[2] ^= BitOperations.RotateLeft(x[14] + x[10], 9);
            x[6] ^= BitOperations.RotateLeft(x[2] + x[14], 13); x[10] ^= BitOperations.RotateLeft(x[6] + x[2], 18);
            x[3] ^= BitOperations.RotateLeft(x[15] + x[11], 7); x[7] ^= BitOperations.RotateLeft(x[3] + x[15], 9);
            x[11] ^= BitOperations.RotateLeft(x[7] + x[3], 13); x[15] ^= BitOperations.RotateLeft(x[11] + x[7], 18);
            x[1] ^= BitOperations.RotateLeft(x[0] + x[3], 7); x[2] ^= BitOperations.RotateLeft(x[1] + x[0], 9);
            x[3] ^= BitOperations.RotateLeft(x[2] + x[1], 13); x[0] ^= BitOperations.RotateLeft(x[3] + x[2], 18);
            x[6] ^= BitOperations.RotateLeft(x[5] + x[4], 7); x[7] ^= BitOperations.RotateLeft(x[6] + x[5], 9);
            x[4] ^= BitOperations.RotateLeft(x[7] + x[6], 13); x[5] ^= BitOperations.RotateLeft(x[4] + x[7], 18);
            x[11] ^= BitOperations.RotateLeft(x[10] + x[9], 7); x[8] ^= BitOperations.RotateLeft(x[11] + x[10], 9);
            x[9] ^= BitOperations.RotateLeft(x[8] + x[11], 13); x[10] ^= BitOperations.RotateLeft(x[9] + x[8], 18);
            x[12] ^= BitOperations.RotateLeft(x[15] + x[14], 7); x[13] ^= BitOperations.RotateLeft(x[12] + x[15], 9);
            x[14] ^= BitOperations.RotateLeft(x[13] + x[12], 13); x[15] ^= BitOperations.RotateLeft(x[14] + x[13], 18);
        }
        for (var i = 0; i < 16; i++) b[i] += x[i];
    }
}
