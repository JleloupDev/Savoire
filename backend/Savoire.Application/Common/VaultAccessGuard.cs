// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Common;

public sealed class VaultAccessGuard(IVaultRepository vaults) : IVaultAccessGuard
{
    public async Task RequireReadAsync(string callerId, string vaultId, CancellationToken ct = default)
    {
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;
        VaultMember? member = await vaults.GetMemberAsync(vaultId, callerId, ct);
        if (member is null) throw new VaultNotFoundException(vaultId);
    }

    public async Task RequireWriteAsync(string callerId, string vaultId, CancellationToken ct = default)
    {
        Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
        if (vault is null) throw new VaultNotFoundException(vaultId);
        if (vault.IsOwner(callerId)) return;
        VaultMember? member = await vaults.GetMemberAsync(vaultId, callerId, ct);
        if (member is null) throw new VaultNotFoundException(vaultId);
        if (member.Role == VaultRole.Viewer)
            throw new AccessDeniedException("Les membres 'viewer' ne peuvent pas modifier ce vault.");
    }
}
