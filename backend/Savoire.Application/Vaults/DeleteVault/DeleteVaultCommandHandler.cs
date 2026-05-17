// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Vaults.DeleteVault;

public sealed class DeleteVaultCommandHandler(IVaultRepository vaults)
    : IRequestHandler<DeleteVaultCommand>
{
    public async Task Handle(DeleteVaultCommand cmd, CancellationToken ct)
    {
        Vault vault = await vaults.GetByIdAsync(cmd.VaultId, ct)
            ?? throw new VaultNotFoundException(cmd.VaultId);

        vault.RequireOwner(cmd.CallerId);
        await vaults.DeleteAsync(cmd.VaultId, ct);
    }
}
