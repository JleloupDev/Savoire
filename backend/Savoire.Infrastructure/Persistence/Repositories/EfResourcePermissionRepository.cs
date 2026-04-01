// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfResourcePermissionRepository(AppDbContext db) : IResourcePermissionRepository
{
    public async Task<IReadOnlyList<ResourcePermission>> ListForResourceAsync(
        string resourceType, string resourceId, CancellationToken ct = default)
    {
        List<ResourcePermissionEntity> entities = await db.ResourcePermissions
            .AsNoTracking()
            .Where(p => p.ResourceType == resourceType && p.ResourceId == resourceId)
            .ToListAsync(ct);
        return entities.Select(e => e.ToDomain()).ToList();
    }

    public async Task<ResourcePermission?> GetAsync(
        string resourceType, string resourceId,
        string subjectType, string subjectId,
        CancellationToken ct = default)
    {
        ResourcePermissionEntity? e = await db.ResourcePermissions
            .AsNoTracking()
            .FirstOrDefaultAsync(p =>
                p.ResourceType == resourceType && p.ResourceId   == resourceId &&
                p.SubjectType  == subjectType  && p.SubjectId    == subjectId, ct);
        return e?.ToDomain();
    }

    public async Task AddAsync(ResourcePermission permission, CancellationToken ct = default)
    {
        db.ResourcePermissions.Add(new ResourcePermissionEntity
        {
            Id           = permission.Id,
            ResourceType = permission.ResourceType,
            ResourceId   = permission.ResourceId,
            SubjectType  = permission.SubjectType,
            SubjectId    = permission.SubjectId,
            Permission   = permission.Permission,
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
