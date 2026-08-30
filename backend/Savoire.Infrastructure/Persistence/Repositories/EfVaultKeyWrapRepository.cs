// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfVaultKeyWrapRepository(AppDbContext db) : IVaultKeyWrapRepository
{
    public async Task<byte[]?> GetAsync(string userId, string vaultId, CancellationToken ct = default)
    {
        VaultKeyWrapEntity? e = await db.VaultKeyWraps.FindAsync([userId, vaultId], ct);
        return e?.WrappedKeyBytes;
    }

    public async Task SetAsync(string userId, string vaultId, byte[] wrappedKeyBytes, CancellationToken ct = default)
    {
        VaultKeyWrapEntity? existing = await db.VaultKeyWraps.FindAsync([userId, vaultId], ct);
        if (existing is not null)
        {
            existing.WrappedKeyBytes = wrappedKeyBytes;
            existing.UpdatedAt       = DateTime.UtcNow;
        }
        else
        {
            db.VaultKeyWraps.Add(new VaultKeyWrapEntity
            {
                UserId = userId, VaultId = vaultId,
                WrappedKeyBytes = wrappedKeyBytes, UpdatedAt = DateTime.UtcNow,
            });
        }
        await db.SaveChangesAsync(ct);
    }
}
