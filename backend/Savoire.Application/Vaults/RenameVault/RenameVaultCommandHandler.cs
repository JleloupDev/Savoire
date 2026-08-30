// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;
using Savoire.Domain.ValueObjects;

namespace Savoire.Application.Vaults.RenameVault;

public sealed class RenameVaultCommandHandler(IVaultRepository vaults)
    : IRequestHandler<RenameVaultCommand, VaultSummaryDto>
{
    public async Task<VaultSummaryDto> Handle(RenameVaultCommand cmd, CancellationToken ct)
    {
        Vault vault = await vaults.GetByIdAsync(cmd.VaultId, ct)
            ?? throw new VaultNotFoundException(cmd.VaultId);

        vault.RequireOwner(cmd.CallerId);
        vault.Rename(cmd.NewName);
        await vaults.UpdateAsync(vault, ct);

        VaultStats stats = await vaults.GetStatsAsync(vault.Id, ct);
        return new VaultSummaryDto(vault.Id, vault.Name, "owner",
            stats.DocumentCount, stats.FolderCount, stats.LastModifiedAt, stats.SizeBytes);
    }
}
