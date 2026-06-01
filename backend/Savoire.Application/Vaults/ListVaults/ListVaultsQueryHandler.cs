// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;
using Savoire.Domain.ValueObjects;

namespace Savoire.Application.Vaults.ListVaults;

public sealed class ListVaultsQueryHandler(
    IVaultRepository vaults,
    IResourcePermissionRepository permissions)
    : IRequestHandler<ListVaultsQuery, WorkspaceDto>
{
    public async Task<WorkspaceDto> Handle(ListVaultsQuery query, CancellationToken ct)
    {
        var vaultItems = await vaults.GetForUserAsync(query.UserId, ct);

        var vaultSummaries = new List<VaultSummaryDto>(vaultItems.Count);
        foreach ((Vault vault, VaultRole role) in vaultItems)
        {
            VaultStats stats = await vaults.GetStatsAsync(vault.Id, ct);
            vaultSummaries.Add(ToSummary(vault, role.ToApiString(), stats));
        }

        // Document-level shared notes are not resolvable without SQL projection.
        // TODO(P4): rebuild from CRDT vault directory.
        return new WorkspaceDto(vaultSummaries, []);
    }

    private static VaultSummaryDto ToSummary(Vault vault, string role, VaultStats stats) =>
        new(vault.Id, vault.Name, role, stats.DocumentCount, stats.FolderCount,
            stats.LastModifiedAt, stats.SizeBytes);
}
