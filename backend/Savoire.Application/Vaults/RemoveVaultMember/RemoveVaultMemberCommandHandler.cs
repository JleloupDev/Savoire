// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Vaults.RemoveVaultMember;

public class RemoveVaultMemberCommandHandler(IVaultRepository vaults)
    : IRequestHandler<RemoveVaultMemberCommand>
{
    public async Task Handle(RemoveVaultMemberCommand cmd, CancellationToken ct)
    {
        Vault vault = await vaults.GetByIdAsync(cmd.VaultId, ct)
            ?? throw new VaultNotFoundException(cmd.VaultId);

        vault.RequireOwner(cmd.CallerId);

        if (vault.IsOwner(cmd.MemberId))
            throw new AccessDeniedException("Impossible de retirer l'owner d'un vault.");

        await vaults.RemoveMemberAsync(cmd.VaultId, cmd.MemberId, ct);
    }
}
