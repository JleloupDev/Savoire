// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Enums;

/// <summary>Access level granted on a resource.</summary>
public enum Permission
{
    Read,
    Write,
    Admin,
    /// <summary>
    /// Aucun acces : surcharge un droit herite (un membre du vault exclu d'un
    /// dossier ou d'une note). Seulement sur un dossier ou un document.
    /// </summary>
    None
}

public static class PermissionExtensions
{
    public static string ToApiString(this Permission p) => p switch
    {
        Permission.Read  => "read",
        Permission.Write => "write",
        Permission.Admin => "admin",
        Permission.None  => "none",
        _                => throw new ArgumentOutOfRangeException(nameof(p), p, null)
    };

    public static Permission ParsePermission(this string s) => s switch
    {
        "read"  => Permission.Read,
        "write" => Permission.Write,
        "admin" => Permission.Admin,
        "none"  => Permission.None,
        _       => throw new ArgumentException($"Unknown Permission: '{s}'")
    };
}
