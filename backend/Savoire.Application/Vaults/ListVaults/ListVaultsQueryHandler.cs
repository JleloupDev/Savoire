// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;
using Savoire.Domain.ValueObjects;

namespace Savoire.Application.Vaults.ListVaults;

public class ListVaultsQueryHandler(IVaultRepository vaults)
    : IRequestHandler<ListVaultsQuery, IReadOnlyList<VaultSummaryDto>>
{
    public async Task<IReadOnlyList<VaultSummaryDto>> Handle(
        ListVaultsQuery query, CancellationToken ct)
    {
        IReadOnlyList<(Vault Vault, VaultRole Role)> items =
            await vaults.GetForUserAsync(query.UserId, ct);

        var result = new List<VaultSummaryDto>(items.Count);
        foreach ((Vault vault, VaultRole role) in items)
        {
            VaultStats stats = await vaults.GetStatsAsync(vault.Id, ct);
            result.Add(ToSummary(vault, role.ToApiString(), stats));
        }
        return result;
    }

    private static VaultSummaryDto ToSummary(Vault vault, string role, VaultStats stats) =>
        new(vault.Id, vault.Name, role, stats.DocumentCount, stats.FolderCount,
            stats.LastModifiedAt, stats.SizeBytes);
}
