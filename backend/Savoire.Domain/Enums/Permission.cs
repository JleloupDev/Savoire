// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Enums;

/// <summary>Access level granted on a resource.</summary>
public enum Permission
{
    Read,
    Write,
    Admin
}

public static class PermissionExtensions
{
    public static string ToApiString(this Permission p) => p switch
    {
        Permission.Read  => "read",
        Permission.Write => "write",
        Permission.Admin => "admin",
        _                => throw new ArgumentOutOfRangeException(nameof(p), p, null)
    };

    public static Permission ParsePermission(this string s) => s switch
    {
        "read"  => Permission.Read,
        "write" => Permission.Write,
        "admin" => Permission.Admin,
        _       => throw new ArgumentException($"Unknown Permission: '{s}'")
    };
}
