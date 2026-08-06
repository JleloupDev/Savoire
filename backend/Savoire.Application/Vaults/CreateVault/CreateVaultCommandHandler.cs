// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Vaults.CreateVault;

public sealed class CreateVaultCommandHandler(IVaultRepository vaults)
    : IRequestHandler<CreateVaultCommand, VaultSummaryDto>
{
    public async Task<VaultSummaryDto> Handle(CreateVaultCommand cmd, CancellationToken ct)
    {
        Vault vault = Vault.Create(cmd.Name, cmd.OwnerId, cmd.IsManaged);
        await vaults.AddAsync(vault, ct);
        return new VaultSummaryDto(vault.Id, vault.Name, "owner", 0, 0, null, 0, vault.IsManaged);
    }
}
