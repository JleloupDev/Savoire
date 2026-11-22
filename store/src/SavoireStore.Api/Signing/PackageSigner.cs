// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Signature des paquets : ECDSA P-256 sur SHA-256, format IEEE P1363 (r||s,
// 64 octets), celui de WebCrypto. L'application verifie la signature avec la
// cle publique du store avant d'installer quoi que ce soit.
//
// La cle privee vit dans un fichier PEM (Store:SigningKeyFile). Absent : en
// developpement, une cle est creee a cet endroit ; ailleurs, le store refuse
// de demarrer (une cle perdue invaliderait toutes les signatures).
using System.Security.Cryptography;

namespace SavoireStore.Signing;

public sealed class PackageSigner : IDisposable
{
    private readonly ECDsa _key;

    public PackageSigner(ECDsa key)
    {
        if (key.KeySize != 256) throw new ArgumentException("Cle P-256 attendue.");
        _key = key;
        PublicKeySpki = Convert.ToBase64String(key.ExportSubjectPublicKeyInfo());
        KeyId = Convert.ToHexStringLower(SHA256.HashData(key.ExportSubjectPublicKeyInfo()))[..16];
    }

    /// <summary>Cle publique (SubjectPublicKeyInfo, base64), a donner a l'application.</summary>
    public string PublicKeySpki { get; }

    /// <summary>Empreinte courte de la cle publique (pour la rotation).</summary>
    public string KeyId { get; }

    /// <summary>Cle donnee en PEM (PKCS#8 ou EC), ou en base64 d'un PEM (une seule ligne, pour une variable).</summary>
    public static PackageSigner FromPem(string pemOrBase64)
    {
        string pem = pemOrBase64.Contains("-----BEGIN", StringComparison.Ordinal)
            ? pemOrBase64
            : System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(pemOrBase64.Trim()));
        var key = ECDsa.Create();
        key.ImportFromPem(pem);
        return new PackageSigner(key);
    }

    public static PackageSigner Load(string path, bool createIfMissing)
    {
        var key = ECDsa.Create();
        if (File.Exists(path))
        {
            key.ImportFromPem(File.ReadAllText(path));
        }
        else
        {
            if (!createIfMissing) throw new InvalidOperationException($"Cle de signature introuvable : {path} (Store:SigningKeyFile).");
            key.GenerateKey(ECCurve.NamedCurves.nistP256);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            File.WriteAllText(path, key.ExportPkcs8PrivateKeyPem());
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        return new PackageSigner(key);
    }

    public string Sign(byte[] package) =>
        Convert.ToBase64String(_key.SignData(package, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));

    public bool Verify(byte[] package, string signature) =>
        _key.VerifyData(package, Convert.FromBase64String(signature), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    public static string Sha256(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));

    public void Dispose() => _key.Dispose();
}
