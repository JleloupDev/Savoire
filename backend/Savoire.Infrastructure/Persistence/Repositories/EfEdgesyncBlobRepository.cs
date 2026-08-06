// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfEdgesyncBlobRepository(AppDbContext db) : IEdgesyncBlobRepository
{
    public async Task<byte[]?> GetAsync(string vaultId, string key, CancellationToken ct = default)
    {
        EdgesyncBlobEntity? e = await db.EdgesyncBlobs.FindAsync([vaultId, key], ct);
        return e?.Bytes;
    }

    public async Task SetAsync(string vaultId, string key, byte[] bytes, CancellationToken ct = default)
    {
        EdgesyncBlobEntity? existing = await db.EdgesyncBlobs.FindAsync([vaultId, key], ct);
        if (existing is not null)
        {
            existing.Bytes     = bytes;
            existing.UpdatedAt = DateTime.UtcNow;
        }
        else
        {
            db.EdgesyncBlobs.Add(new EdgesyncBlobEntity
            {
                VaultId = vaultId, Key = key,
                Bytes = bytes, UpdatedAt = DateTime.UtcNow,
            });
        }
        await db.SaveChangesAsync(ct);
    }
}
