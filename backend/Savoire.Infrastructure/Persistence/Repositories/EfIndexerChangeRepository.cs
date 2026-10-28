// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

/// <summary>Lecture du flux du pair indexeur. L'ecriture : voir IndexerChangeWriter.</summary>
public class EfIndexerChangeRepository(AppDbContext db) : IIndexerChangeRepository
{
    private const string EpochKey = "epoch";

    public async Task<IReadOnlyList<IndexerChange>> GetSinceAsync(long since, int max, CancellationToken ct = default) =>
        await db.IndexerChanges.AsNoTracking()
            .Where(c => c.Seq > since)
            .OrderBy(c => c.Seq)
            .Take(max)
            .Select(c => new IndexerChange(c.Seq, c.VaultId, c.Kind, c.DocId))
            .ToListAsync(ct);

    public async Task<string> GetEpochAsync(CancellationToken ct = default)
    {
        string? epoch = await ReadEpochAsync(ct);
        if (epoch is not null) return epoch;
        // Cree par la migration ; une base creee autrement le recoit ici, une fois.
        await db.Database.ExecuteSqlAsync(
            $"INSERT OR IGNORE INTO indexer_feed_state (key, value) VALUES ({EpochKey}, lower(hex(randomblob(16))))", ct);
        return await ReadEpochAsync(ct) ?? throw new InvalidOperationException("indexer_feed_state : epoch absent.");
    }

    private Task<string?> ReadEpochAsync(CancellationToken ct) =>
        db.IndexerFeedState.AsNoTracking()
            .Where(s => s.Key == EpochKey)
            .Select(s => s.Value)
            .FirstOrDefaultAsync(ct);
}
