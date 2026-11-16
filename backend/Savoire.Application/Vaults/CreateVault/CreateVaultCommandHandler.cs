// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Vaults.CreateVault;

public sealed class CreateVaultCommandHandler(
    IVaultRepository vaults,
    Savoire.Application.Abstractions.IVaultStorageQuota quota,
    Microsoft.Extensions.Options.IOptionsMonitor<LimitsOptions> limits)
    : IRequestHandler<CreateVaultCommand, VaultSummaryDto>
{
    public async Task<VaultSummaryDto> Handle(CreateVaultCommand cmd, CancellationToken ct)
    {
        int max = limits.CurrentValue.VaultsPerAccount;
        if (max > 0 && await quota.OwnedVaultCountAsync(cmd.OwnerId, ct) >= max)
            throw new Savoire.Domain.Exceptions.QuotaExceededException($"Un compte a {max} vaults au plus. Supprimez-en un pour en créer un autre.");
        Vault vault = Vault.Create(cmd.Name, cmd.OwnerId);
        await vaults.AddAsync(vault, ct);
        return new VaultSummaryDto(vault.Id, vault.Name, "owner", 0, 0, null, 0);
    }
}
