// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;
using System.Text.Json;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfDocumentMetaRepository(AppDbContext db) : IDocumentMetaRepository
{
    public async Task<DocumentMeta?> GetByDocumentIdAsync(string documentId, CancellationToken ct = default)
    {
        var e = await db.DocumentMetas.AsNoTracking()
            .FirstOrDefaultAsync(x => x.DocumentId == documentId, ct);
        return e?.ToDomain();
    }

    public async Task<IReadOnlyList<DocumentMeta>> ListByVaultAsync(
        string vaultId, bool includeDerived = true, CancellationToken ct = default)
    {
        var q = db.DocumentMetas.AsNoTracking().Where(x => x.VaultId == vaultId);
        if (!includeDerived) q = q.Where(x => x.DerivedFrom == null);
        var list = await q.ToListAsync(ct);
        return list.Select(e => e.ToDomain()).ToList();
    }

    public async Task<IReadOnlyList<DocumentMeta>> ListByTagAsync(
        string vaultId, string tag, CancellationToken ct = default)
    {
        // SQLite : LIKE sur JSON array — suffisant pour le POC
        var list = await db.DocumentMetas.AsNoTracking()
            .Where(x => x.VaultId == vaultId && EF.Functions.Like(x.Tags, $"%\"{tag}\"%"))
            .ToListAsync(ct);
        return list.Select(e => e.ToDomain()).ToList();
    }

    public async Task UpsertAsync(DocumentMeta meta, CancellationToken ct = default)
    {
        var existing = await db.DocumentMetas
            .FirstOrDefaultAsync(x => x.DocumentId == meta.DocumentId, ct);

        var tagsJson = JsonSerializer.Serialize(meta.Tags);

        if (existing is null)
        {
            db.DocumentMetas.Add(new DocumentMetaEntity
            {
                DocumentId  = meta.DocumentId,
                VaultId     = meta.VaultId,
                ContentType = meta.ContentType,
                DerivedFrom = meta.DerivedFrom,
                DerivedBy   = meta.DerivedBy,
                Tags        = tagsJson,
                Frontmatter = meta.Frontmatter,
                IndexedAt   = meta.IndexedAt,
            });
        }
        else
        {
            existing.Tags        = tagsJson;
            existing.Frontmatter = meta.Frontmatter;
            existing.IndexedAt   = meta.IndexedAt;
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task DeleteByDocumentIdAsync(string documentId, CancellationToken ct = default)
    {
        await db.DocumentMetas
            .Where(x => x.DocumentId == documentId)
            .ExecuteDeleteAsync(ct);
    }
}
