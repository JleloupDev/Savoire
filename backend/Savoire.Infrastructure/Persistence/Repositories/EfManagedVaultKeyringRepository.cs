// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfManagedVaultKeyringRepository(AppDbContext db) : IManagedVaultKeyringRepository
{
    public async Task<byte[]?> GetAsync(string vaultId, CancellationToken ct = default)
    {
        ManagedVaultKeyringEntity? e = await db.ManagedVaultKeyrings.FindAsync([vaultId], ct);
        return e?.KeyringBytes;
    }

    public async Task SetAsync(string vaultId, byte[] keyringBytes, CancellationToken ct = default)
    {
        ManagedVaultKeyringEntity? existing = await db.ManagedVaultKeyrings.FindAsync([vaultId], ct);
        if (existing is not null)
        {
            existing.KeyringBytes = keyringBytes;
            existing.UpdatedAt    = DateTime.UtcNow;
        }
        else
        {
            db.ManagedVaultKeyrings.Add(new ManagedVaultKeyringEntity
            {
                VaultId = vaultId,
                KeyringBytes = keyringBytes, UpdatedAt = DateTime.UtcNow,
            });
        }
        await db.SaveChangesAsync(ct);
    }
}
