// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Repositories;

/// <summary>
/// The bridge between the classic ACL (vault_members, indexed by userId) and
/// the edgesync protocol (which only ever knows signPub). Purely public key
/// material -- the client self-registers its own signPub (registerSelf.ts
/// side), the server never derives or generates any of it. See
/// GetVaultMemberIdentitiesQuery for how this is combined with vault
/// ownership/membership to produce the authorized set the protocol consults.
/// </summary>
public interface IVaultMemberIdentityRepository
{
    Task AddAsync(string vaultId, string userId, byte[] signPub, CancellationToken ct = default);
    Task<IReadOnlyList<(string UserId, byte[] SignPub)>> GetAllAsync(string vaultId, CancellationToken ct = default);
    Task RemoveForUserAsync(string vaultId, string userId, CancellationToken ct = default);
}
