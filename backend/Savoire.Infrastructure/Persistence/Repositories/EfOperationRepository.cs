// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfOperationRepository(AppDbContext db) : IOperationRepository
{
    public async Task AppendAsync(Operation op, CancellationToken ct = default)
    {
        bool exists = await db.Operations.AnyAsync(o => o.Id == op.Id, ct);
        if (exists) return;

        db.Operations.Add(new OperationEntity
        {
            Id         = op.Id,
            DocumentId = op.DocumentId,
            ClientId   = op.ClientId,
            ProducedAt = op.ProducedAt,
            ReceivedAt = op.ReceivedAt,
            OpBytes    = op.OpBytes
        });
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<Operation>> GetSinceAsync(
        string docId, DateTime since, CancellationToken ct = default)
    {
        List<OperationEntity> entities = await db.Operations.AsNoTracking()
            .Where(o => o.DocumentId == docId && o.ReceivedAt >= since)
            .OrderBy(o => o.ReceivedAt)
            .ToListAsync(ct);
        return entities.Select(e => e.ToDomain()).ToList();
    }

    public async Task<byte[]?> GetSyncVectorAsync(string docId, string clientId, CancellationToken ct = default)
    {
        SyncVectorEntity? e = await db.SyncVectors.AsNoTracking()
            .FirstOrDefaultAsync(s => s.DocumentId == docId && s.ClientId == clientId, ct);
        return e?.Vector;
    }

    public async Task SetSyncVectorAsync(string docId, string clientId, byte[] vector, CancellationToken ct = default)
    {
        SyncVectorEntity? existing = await db.SyncVectors.FindAsync([docId, clientId], ct);
        if (existing is not null)
        {
            existing.Vector    = vector;
            existing.UpdatedAt = DateTime.UtcNow;
        }
        else
        {
            db.SyncVectors.Add(new SyncVectorEntity
            {
                DocumentId = docId, ClientId = clientId,
                Vector = vector, UpdatedAt = DateTime.UtcNow
            });
        }
        await db.SaveChangesAsync(ct);
    }

    public async Task CompactAsync(string docId, byte[] snapshotBytes, bool force = false, CancellationToken ct = default)
    {
        if (!force)
        {
            int count = await db.Operations.CountAsync(o => o.DocumentId == docId, ct);
            if (count <= 50) return;
        }

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.Operations
            .Where(o => o.DocumentId == docId)
            .ExecuteDeleteAsync(ct);
        db.Operations.Add(new OperationEntity
        {
            Id         = Guid.NewGuid().ToString(),
            DocumentId = docId,
            ClientId   = "snapshot",
            ProducedAt = DateTime.UtcNow,
            ReceivedAt = DateTime.UtcNow,
            OpBytes    = snapshotBytes,
        });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }
}
