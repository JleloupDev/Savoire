// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Enums;

namespace Savoire.Domain.Aggregates;

/// <summary>
/// ACL entry — grants a subject (user) a permission on a resource (vault or document).
/// </summary>
public sealed class ResourcePermission
{
    public string       Id           { get; private set; } = null!;
    public ResourceType ResourceType { get; private set; }
    public string       ResourceId   { get; private set; } = null!;
    public SubjectType  SubjectType  { get; private set; }
    public string       SubjectId    { get; private set; } = null!;
    public Permission   Permission   { get; private set; }
    public string       GrantedBy    { get; private set; } = null!;
    public DateTime     GrantedAt    { get; private set; }
    public DateTime?    ExpiresAt    { get; private set; }

    private ResourcePermission() { }

    public static ResourcePermission Create(
        ResourceType resourceType, string resourceId,
        SubjectType subjectType, string subjectId,
        Permission permission, string grantedBy,
        DateTime? expiresAt = null) => new()
    {
        Id           = Guid.NewGuid().ToString(),
        ResourceType = resourceType,
        ResourceId   = resourceId,
        SubjectType  = subjectType,
        SubjectId    = subjectId,
        Permission   = permission,
        GrantedBy    = grantedBy,
        GrantedAt    = DateTime.UtcNow,
        ExpiresAt    = expiresAt
    };

    public static ResourcePermission Rehydrate(
        string id, ResourceType resourceType, string resourceId,
        SubjectType subjectType, string subjectId, Permission permission,
        string grantedBy, DateTime grantedAt, DateTime? expiresAt) => new()
    {
        Id           = id,
        ResourceType = resourceType,
        ResourceId   = resourceId,
        SubjectType  = subjectType,
        SubjectId    = subjectId,
        Permission   = permission,
        GrantedBy    = grantedBy,
        GrantedAt    = grantedAt,
        ExpiresAt    = expiresAt
    };

    public bool IsExpired() => ExpiresAt.HasValue && ExpiresAt.Value < DateTime.UtcNow;

    public bool AllowsWrite() => Permission is Permission.Write or Permission.Admin;
}
