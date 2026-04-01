// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfShareLinkRepository(AppDbContext db) : IShareLinkRepository
{
    public async Task<ShareLink?> GetByTokenAsync(string token, CancellationToken ct = default)
    {
        ShareLinkEntity? e = await db.ShareLinks
            .AsNoTracking()
            .FirstOrDefaultAsync(l => l.Token == token, ct);
        return e?.ToDomain();
    }

    public async Task<ShareLink?> GetByIdAsync(string id, CancellationToken ct = default)
    {
        ShareLinkEntity? e = await db.ShareLinks
            .AsNoTracking()
            .FirstOrDefaultAsync(l => l.Id == id, ct);
        return e?.ToDomain();
    }

    public async Task<IReadOnlyList<ShareLink>> ListForResourceAsync(
        string resourceType, string resourceId, CancellationToken ct = default)
    {
        List<ShareLinkEntity> entities = await db.ShareLinks
            .AsNoTracking()
            .Where(l => l.ResourceType == resourceType && l.ResourceId == resourceId)
            .OrderByDescending(l => l.CreatedAt)
            .ToListAsync(ct);
        return entities.Select(e => e.ToDomain()).ToList();
    }

    public async Task AddAsync(ShareLink link, CancellationToken ct = default)
    {
        db.ShareLinks.Add(new ShareLinkEntity
        {
            Id           = link.Id,
            Token        = link.Token,
            ResourceType = link.ResourceType,
            ResourceId   = link.ResourceId,
            Permission   = link.Permission,
            CreatedBy    = link.CreatedBy,
            CreatedAt    = link.CreatedAt,
            ExpiresAt    = link.ExpiresAt,
            RevokedAt    = link.RevokedAt
        });
        await db.SaveChangesAsync(ct);
    }

    public async Task UpdateAsync(ShareLink link, CancellationToken ct = default)
    {
        ShareLinkEntity? entity = await db.ShareLinks.FindAsync([link.Id], ct);
        if (entity is null) return;
        entity.RevokedAt = link.RevokedAt;
        await db.SaveChangesAsync(ct);
    }
}
