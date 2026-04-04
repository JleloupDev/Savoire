// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Security.Cryptography;
using Savoire.Domain.Enums;

namespace Savoire.Domain.Aggregates;

/// <summary>
/// Share link — allows anonymous or authenticated users to access a resource via a URL token.
/// see ADR-003
/// </summary>
public sealed class ShareLink
{
    public string       Id           { get; private set; } = null!;
    public string       Token        { get; private set; } = null!;  // URL-safe random token
    public ResourceType ResourceType { get; private set; }
    public string       ResourceId   { get; private set; } = null!;
    public Permission   Permission   { get; private set; }
    public string       CreatedBy    { get; private set; } = null!;
    public DateTime     CreatedAt    { get; private set; }
    public DateTime?    ExpiresAt    { get; private set; }
    public DateTime?    RevokedAt    { get; private set; }

    private ShareLink() { }

    public static ShareLink Create(
        ResourceType resourceType, string resourceId,
        Permission permission, string createdBy,
        DateTime? expiresAt = null) => new()
    {
        Id           = Guid.NewGuid().ToString(),
        Token        = GenerateToken(),
        ResourceType = resourceType,
        ResourceId   = resourceId,
        Permission   = permission,
        CreatedBy    = createdBy,
        CreatedAt    = DateTime.UtcNow,
        ExpiresAt    = expiresAt
    };

    public static ShareLink Rehydrate(
        string id, string token, ResourceType resourceType, string resourceId,
        Permission permission, string createdBy, DateTime createdAt,
        DateTime? expiresAt, DateTime? revokedAt) => new()
    {
        Id           = id,
        Token        = token,
        ResourceType = resourceType,
        ResourceId   = resourceId,
        Permission   = permission,
        CreatedBy    = createdBy,
        CreatedAt    = createdAt,
        ExpiresAt    = expiresAt,
        RevokedAt    = revokedAt
    };

    public bool IsValid() =>
        RevokedAt is null &&
        (ExpiresAt is null || ExpiresAt.Value > DateTime.UtcNow);

    public bool AllowsWrite() =>
        Permission is Permission.Write && IsValid();

    public void Revoke() => RevokedAt = DateTime.UtcNow;

    // see ADR-003
    private static string GenerateToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}
