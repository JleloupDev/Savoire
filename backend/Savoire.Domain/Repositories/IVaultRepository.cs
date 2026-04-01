// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;
using Savoire.Domain.ValueObjects;

namespace Savoire.Domain.Repositories;

public interface IVaultRepository
{
    Task<Vault?> GetByIdAsync(string vaultId, CancellationToken ct = default);
    Task<IReadOnlyList<(Vault Vault, string Role)>> GetForUserAsync(string userId, CancellationToken ct = default);
    Task<IReadOnlyList<VaultMember>> GetMembersAsync(string vaultId, CancellationToken ct = default);
    Task<VaultMember?> GetMemberAsync(string vaultId, string userId, CancellationToken ct = default);
    Task<VaultStats> GetStatsAsync(string vaultId, CancellationToken ct = default);
    Task AddAsync(Vault vault, CancellationToken ct = default);
    Task UpdateAsync(Vault vault, CancellationToken ct = default);
    Task DeleteAsync(string vaultId, CancellationToken ct = default);
    Task AddMemberAsync(VaultMember member, CancellationToken ct = default);
    Task RemoveMemberAsync(string vaultId, string userId, CancellationToken ct = default);
}
