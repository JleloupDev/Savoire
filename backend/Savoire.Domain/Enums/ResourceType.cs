// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Enums;

/// <summary>Discriminant for polymorphic ACL / share-link resources.</summary>
public enum ResourceType
{
    Vault,
    Document,
    /// <summary>Un dossier d'un vault (droits herites par son contenu). Id : « vaultId:chemin/du/dossier ».</summary>
    Folder
}

public static class ResourceTypeExtensions
{
    public static string ToApiString(this ResourceType rt) => rt switch
    {
        ResourceType.Vault    => "vault",
        ResourceType.Document => "document",
        ResourceType.Folder   => "folder",
        _                     => throw new ArgumentOutOfRangeException(nameof(rt), rt, null)
    };

    public static ResourceType ParseResourceType(this string s) => s switch
    {
        "vault"    => ResourceType.Vault,
        "document" => ResourceType.Document,
        "folder"   => ResourceType.Folder,
        _          => throw new ArgumentException($"Unknown ResourceType: '{s}'")
    };
}

/// <summary>Identifiant d'un dossier pour les droits : « vaultId:chemin » (sans « / » au bout).</summary>
public static class FolderResource
{
    public static string Id(string vaultId, string folder) => $"{vaultId}:{Normalize(folder)}";

    /// <summary>« /A//B/ » -> « A/B » ; null pour un chemin invalide (« .. », caracteres de controle).</summary>
    public static string? Normalize(string? folder)
    {
        if (folder is null) return null;
        string[] parts = folder.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Any(p => p is "." or ".." || p.Any(char.IsControl))) return null;
        string joined = string.Join('/', parts);
        return joined.Length > 1024 ? null : joined;
    }

    /// <summary>Dossiers englobants, du plus profond au plus haut : « A/B/C » -> C, B, A.</summary>
    public static IEnumerable<string> Ancestors(string? folder)
    {
        string? f = Normalize(folder);
        while (!string.IsNullOrEmpty(f))
        {
            yield return f;
            int slash = f.LastIndexOf('/');
            f = slash < 0 ? "" : f[..slash];
        }
    }
}
