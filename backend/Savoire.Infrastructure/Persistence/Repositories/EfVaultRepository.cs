// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;
using Savoire.Domain.ValueObjects;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfVaultRepository(AppDbContext db) : IVaultRepository
{
    public async Task<Vault?> GetByIdAsync(string vaultId, CancellationToken ct = default)
    {
        VaultEntity? e = await db.Vaults.AsNoTracking()
            .FirstOrDefaultAsync(v => v.Id == vaultId, ct);
        return e?.ToDomain();
    }

    public async Task<IReadOnlyList<(Vault Vault, string Role)>> GetForUserAsync(
        string userId, CancellationToken ct = default)
    {
        var owned = await db.Vaults.AsNoTracking()
            .Where(v => v.OwnerId == userId)
            .ToListAsync(ct);

        var memberVaults = await db.VaultMembers.AsNoTracking()
            .Include(m => m.Vault)
            .Where(m => m.UserId == userId && m.Vault.OwnerId != userId)
            .ToListAsync(ct);

        var result = new List<(Vault, string)>();
        foreach (VaultEntity v in owned)  result.Add((v.ToDomain(), "owner"));
        foreach (VaultMemberEntity m in memberVaults) result.Add((m.Vault.ToDomain(), m.Role));
        return result.OrderBy(x => x.Item1.CreatedAt).ToList();
    }

    public async Task<IReadOnlyList<VaultMember>> GetMembersAsync(string vaultId, CancellationToken ct = default)
    {
        List<VaultMemberEntity> entities = await db.VaultMembers.AsNoTracking()
            .Where(m => m.VaultId == vaultId)
            .ToListAsync(ct);
        return entities.Select(e => e.ToDomain()).ToList();
    }

    public async Task<VaultMember?> GetMemberAsync(string vaultId, string userId, CancellationToken ct = default)
    {
        VaultMemberEntity? e = await db.VaultMembers.AsNoTracking()
            .FirstOrDefaultAsync(m => m.VaultId == vaultId && m.UserId == userId, ct);
        return e?.ToDomain();
    }

    public async Task<VaultStats> GetStatsAsync(string vaultId, CancellationToken ct = default)
    {
        int docCount = await db.Documents.CountAsync(d => d.VaultId == vaultId && d.DeletedAt == null, ct);
        int folderCount = await db.Folders.CountAsync(f => f.VaultId == vaultId, ct);
        DateTime? lastModified = await db.Documents
            .Where(d => d.VaultId == vaultId && d.DeletedAt == null)
            .OrderByDescending(d => d.UpdatedAt)
            .Select(d => (DateTime?)d.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        long sizeBytes = await db.Documents
            .Where(d => d.VaultId == vaultId && d.DeletedAt == null)
            .SumAsync(d => d.SizeBytes, ct);
        return new VaultStats(docCount, folderCount, lastModified, sizeBytes);
    }

    public async Task AddAsync(Vault vault, CancellationToken ct = default)
    {
        db.Vaults.Add(new VaultEntity
        {
            Id = vault.Id, Name = vault.Name,
            OwnerId = vault.OwnerId, CreatedAt = vault.CreatedAt
        });
        await db.SaveChangesAsync(ct);
    }

    public async Task UpdateAsync(Vault vault, CancellationToken ct = default)
    {
        await db.Vaults
            .Where(v => v.Id == vault.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(v => v.Name, vault.Name), ct);
    }

    public async Task DeleteAsync(string vaultId, CancellationToken ct = default)
    {
        await db.Vaults.Where(v => v.Id == vaultId).ExecuteDeleteAsync(ct);
    }

    public async Task AddMemberAsync(VaultMember member, CancellationToken ct = default)
    {
        VaultMemberEntity? existing = await db.VaultMembers
            .FindAsync([member.VaultId, member.UserId], ct);

        if (existing is not null)
        {
            existing.Role = member.Role;
            existing.JoinedAt = member.JoinedAt;
        }
        else
        {
            db.VaultMembers.Add(new VaultMemberEntity
            {
                VaultId = member.VaultId, UserId = member.UserId,
                Role = member.Role, JoinedAt = member.JoinedAt
            });
        }
        await db.SaveChangesAsync(ct);
    }

    public async Task RemoveMemberAsync(string vaultId, string userId, CancellationToken ct = default)
    {
        await db.VaultMembers
            .Where(m => m.VaultId == vaultId && m.UserId == userId)
            .ExecuteDeleteAsync(ct);
    }
}
