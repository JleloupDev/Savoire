// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Enums;

/// <summary>Role of a user within a vault.</summary>
public enum VaultRole
{
    Owner,
    Editor,
    Viewer
}

public static class VaultRoleExtensions
{
    public static string ToApiString(this VaultRole r) => r switch
    {
        VaultRole.Owner  => "owner",
        VaultRole.Editor => "editor",
        VaultRole.Viewer => "viewer",
        _                => throw new ArgumentOutOfRangeException(nameof(r), r, null)
    };

    public static VaultRole ParseVaultRole(this string s) => s switch
    {
        "owner"  => VaultRole.Owner,
        "editor" => VaultRole.Editor,
        "viewer" => VaultRole.Viewer,
        _        => throw new ArgumentException($"Unknown VaultRole: '{s}'")
    };
}
