// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfVaultMemberIdentityRepository(AppDbContext db) : IVaultMemberIdentityRepository
{
    public async Task AddAsync(string vaultId, string userId, byte[] signPub, CancellationToken ct = default)
    {
        VaultMemberIdentityEntity? existing = await db.VaultMemberIdentities
            .FirstOrDefaultAsync(e => e.VaultId == vaultId && e.SignPub == signPub, ct);
        if (existing is not null) return;

        db.VaultMemberIdentities.Add(new VaultMemberIdentityEntity
        {
            VaultId = vaultId, UserId = userId, SignPub = signPub, RegisteredAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<(string UserId, byte[] SignPub)>> GetAllAsync(string vaultId, CancellationToken ct = default)
    {
        List<VaultMemberIdentityEntity> rows = await db.VaultMemberIdentities
            .Where(e => e.VaultId == vaultId)
            .ToListAsync(ct);
        return [.. rows.Select(e => (e.UserId, e.SignPub))];
    }

    public async Task RemoveForUserAsync(string vaultId, string userId, CancellationToken ct = default)
    {
        await db.VaultMemberIdentities
            .Where(e => e.VaultId == vaultId && e.UserId == userId)
            .ExecuteDeleteAsync(ct);
    }
}
