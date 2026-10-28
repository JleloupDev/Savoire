// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// GET /internal/indexer/vaults?instance={name} : les vaults que possede cette
// instance (hachage de rendez-vous), servis par le pair gere.

using MediatR;
using Microsoft.Extensions.Options;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Indexer.Internal;

public sealed record ListIndexerVaultsQuery(string Instance) : IRequest<IndexerVaultListDto>;

public sealed class ListIndexerVaultsQueryHandler(
    IOptionsMonitor<IndexerOptions> options,
    IVaultRepository                vaults,
    IVaultIndexerSettingRepository  settings) : IRequestHandler<ListIndexerVaultsQuery, IndexerVaultListDto>
{
    public async Task<IndexerVaultListDto> Handle(ListIndexerVaultsQuery q, CancellationToken ct)
    {
        IReadOnlyList<IndexerInstanceOptions> instances = options.CurrentValue.Instances;
        List<Vault> owned = (await vaults.GetAllAsync(ct))
            .Where(v => IndexerRouting.IsOwner(q.Instance, v.Id, instances))
            .ToList();
        var modes = await settings.GetManyAsync(owned.Select(v => v.Id).ToArray(), ct);
        return new IndexerVaultListDto(owned
            .Where(v => modes[v.Id].Mode == IndexerMode.Managed)
            .Select(v => new IndexerVaultDto(v.Id, v.Name))
            .ToList());
    }
}
