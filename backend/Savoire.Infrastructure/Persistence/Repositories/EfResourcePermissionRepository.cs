// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfResourcePermissionRepository(AppDbContext db) : IResourcePermissionRepository
{
    public async Task<IReadOnlyList<ResourcePermission>> ListForResourceAsync(
        ResourceType resourceType, string resourceId, CancellationToken ct = default)
    {
        string rt = resourceType.ToApiString();
        List<ResourcePermissionEntity> entities = await db.ResourcePermissions
            .AsNoTracking()
            .Where(p => p.ResourceType == rt && p.ResourceId == resourceId)
            .ToListAsync(ct);
        return entities.Select(e => e.ToDomain()).ToList();
    }

    public async Task<ResourcePermission?> GetAsync(
        ResourceType resourceType, string resourceId,
        SubjectType subjectType, string subjectId,
        CancellationToken ct = default)
    {
        string rt = resourceType.ToApiString();
        string st = subjectType.ToApiString();
        ResourcePermissionEntity? e = await db.ResourcePermissions
            .AsNoTracking()
            .FirstOrDefaultAsync(p =>
                p.ResourceType == rt && p.ResourceId  == resourceId &&
                p.SubjectType  == st && p.SubjectId   == subjectId, ct);
        return e?.ToDomain();
    }

    public async Task AddAsync(ResourcePermission permission, CancellationToken ct = default)
    {
        db.ResourcePermissions.Add(new ResourcePermissionEntity
        {
            Id           = permission.Id,
            ResourceType = permission.ResourceType.ToApiString(),
            ResourceId   = permission.ResourceId,
            SubjectType  = permission.SubjectType.ToApiString(),
            SubjectId    = permission.SubjectId,
            Permission   = permission.Permission.ToApiString(),
            GrantedBy    = permission.GrantedBy,
            GrantedAt    = permission.GrantedAt,
            ExpiresAt    = permission.ExpiresAt
        });
        await db.SaveChangesAsync(ct);
    }

    public async Task DeleteAsync(string id, CancellationToken ct = default)
    {
        await db.ResourcePermissions
            .Where(p => p.Id == id)
            .ExecuteDeleteAsync(ct);
    }
}
