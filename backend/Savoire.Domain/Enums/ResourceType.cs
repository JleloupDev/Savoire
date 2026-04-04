// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Enums;

/// <summary>Discriminant for polymorphic ACL / share-link resources.</summary>
public enum ResourceType
{
    Vault,
    Document
}

public static class ResourceTypeExtensions
{
    public static string ToApiString(this ResourceType rt) => rt switch
    {
        ResourceType.Vault    => "vault",
        ResourceType.Document => "document",
        _                     => throw new ArgumentOutOfRangeException(nameof(rt), rt, null)
    };

    public static ResourceType ParseResourceType(this string s) => s switch
    {
        "vault"    => ResourceType.Vault,
        "document" => ResourceType.Document,
        _          => throw new ArgumentException($"Unknown ResourceType: '{s}'")
    };
}
