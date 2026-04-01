// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfIndexSnapshotRepository(AppDbContext db) : IIndexSnapshotRepository
{
    public async Task<IndexSnapshot?> GetLatestAsync(
        string vaultId, string @namespace, CancellationToken ct = default)
    {
        var e = await db.IndexSnapshots.AsNoTracking()
            .Where(x => x.VaultId == vaultId && x.Namespace == @namespace)
            .OrderByDescending(x => x.ProcessedSeq)
            .FirstOrDefaultAsync(ct);
        return e?.ToDomain();
    }

    public async Task SaveAsync(IndexSnapshot snapshot, CancellationToken ct = default)
    {
        db.IndexSnapshots.Add(new IndexSnapshotEntity
        {
            Id           = snapshot.Id,
            VaultId      = snapshot.VaultId,
            Namespace    = snapshot.Namespace,
            ProcessedSeq = snapshot.ProcessedSeq,
            Data         = snapshot.Data,
            CreatedAt    = snapshot.CreatedAt,
        });
        await db.SaveChangesAsync(ct);
    }
}
