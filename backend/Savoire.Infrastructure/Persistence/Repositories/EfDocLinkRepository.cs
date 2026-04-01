// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfDocLinkRepository(AppDbContext db) : IDocLinkRepository
{
    public async Task<IReadOnlyList<DocLink>> GetBySourceAsync(string sourceId, CancellationToken ct = default)
    {
        var list = await db.DocLinks.AsNoTracking()
            .Where(x => x.SourceId == sourceId)
            .ToListAsync(ct);
        return list.Select(e => e.ToDomain()).ToList();
    }

    public async Task<IReadOnlyList<DocLink>> GetBacklinksAsync(string targetId, CancellationToken ct = default)
    {
        var list = await db.DocLinks.AsNoTracking()
            .Where(x => x.TargetId == targetId)
            .ToListAsync(ct);
        return list.Select(e => e.ToDomain()).ToList();
    }

    public async Task<IReadOnlyList<DocLink>> GetByTargetPathAsync(
        string vaultId, string targetPath, CancellationToken ct = default)
    {
        var list = await db.DocLinks.AsNoTracking()
            .Where(x => x.VaultId == vaultId && x.TargetPath == targetPath)
            .ToListAsync(ct);
        return list.Select(e => e.ToDomain()).ToList();
    }

    public async Task ReplaceForSourceAsync(
        string sourceId, IReadOnlyList<DocLink> links, CancellationToken ct = default)
    {
        await db.DocLinks.Where(x => x.SourceId == sourceId).ExecuteDeleteAsync(ct);

        foreach (var link in links)
        {
            db.DocLinks.Add(new DocLinkEntity
            {
                Id         = link.Id,
                SourceId   = link.SourceId,
                VaultId    = link.VaultId,
                TargetId   = link.TargetId,
                TargetPath = link.TargetPath,
                LinkType   = link.LinkType,
            });
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task UpdateTargetPathAsync(
        string vaultId, string oldPath, string newPath, string? newTargetId, CancellationToken ct = default)
    {
        var affected = await db.DocLinks
            .Where(x => x.VaultId == vaultId && x.TargetPath == oldPath)
            .ToListAsync(ct);

        foreach (var link in affected)
        {
            link.TargetPath = newPath;
            link.TargetId   = newTargetId;
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task DeleteBySourceAsync(string sourceId, CancellationToken ct = default)
    {
        await db.DocLinks.Where(x => x.SourceId == sourceId).ExecuteDeleteAsync(ct);
    }

    public async Task<IReadOnlyList<VaultLinkProjection>> GetAllByVaultAsync(
        string vaultId, CancellationToken ct = default)
    {
        var result = await db.DocLinks.AsNoTracking()
            .Where(x => x.VaultId == vaultId)
            .Join(db.Documents.AsNoTracking().Where(d => d.VaultId == vaultId && d.DeletedAt == null),
                  link => link.SourceId,
                  doc  => doc.Id,
                  (link, doc) => new VaultLinkProjection(
                      link.SourceId,
                      doc.Path,
                      link.TargetId,
                      link.TargetPath,
                      link.LinkType))
            .ToListAsync(ct);
        return result;
    }
}
