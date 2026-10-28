// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// GET /internal/indexer/changes?instance={name}&since={seq}&limit={n}
//
// Le flux est global ; le backend le filtre pour l'instance (un seul calcul
// de repartition, un seul endroit). Sont rendues les lignes des vaults que
// l'instance possede et qui sont servis par le pair gere, plus les
// « vault-deleted » (un vault supprime ou sorti du pair gere doit etre purge).

using MediatR;
using Microsoft.Extensions.Options;
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Indexer.Internal;

public sealed record GetIndexerChangesQuery(string Instance, long Since, int? Limit) : IRequest<IndexerChangesDto>;

public sealed class GetIndexerChangesQueryHandler(
    IOptionsMonitor<IndexerOptions> options,
    IIndexerChangeRepository        changes,
    IVaultIndexerSettingRepository  settings) : IRequestHandler<GetIndexerChangesQuery, IndexerChangesDto>
{
    public const int DefaultLimit = 500;
    public const int MaxLimit = 2000;
    /// <summary>Lignes lues par lot dans le flux global.</summary>
    public const int BatchSize = 500;
    /// <summary>Au plus autant de lignes examinees par appel : le pair rappelle a partir de « last ».</summary>
    public const int MaxScanned = 20_000;

    public async Task<IndexerChangesDto> Handle(GetIndexerChangesQuery q, CancellationToken ct)
    {
        IReadOnlyList<IndexerInstanceOptions> instances = options.CurrentValue.Instances;
        int limit = Math.Clamp(q.Limit ?? DefaultLimit, 1, MaxLimit);
        long last = Math.Max(0, q.Since);
        string epoch = await changes.GetEpochAsync(ct);

        var result = new List<IndexerChangeDto>();
        var managed = new Dictionary<string, bool>(StringComparer.Ordinal);
        int scanned = 0;
        while (result.Count < limit && scanned < MaxScanned)
        {
            IReadOnlyList<IndexerChange> batch = await changes.GetSinceAsync(last, BatchSize, ct);
            if (batch.Count == 0) break;

            string[] unknown = batch.Select(c => c.VaultId).Distinct().Where(id => !managed.ContainsKey(id)).ToArray();
            if (unknown.Length > 0)
                foreach (var (vaultId, setting) in await settings.GetManyAsync(unknown, ct))
                    managed[vaultId] = setting.Mode == IndexerMode.Managed;

            foreach (IndexerChange change in batch)
            {
                last = change.Seq;
                scanned++;
                bool inScope = change.Kind == IndexerChangeKind.VaultDeleted || managed[change.VaultId];
                if (inScope && IndexerRouting.IsOwner(q.Instance, change.VaultId, instances))
                    result.Add(new IndexerChangeDto(change.Seq, change.VaultId, change.Kind, change.DocId));
                if (result.Count == limit) break;
            }
            if (batch.Count < BatchSize) break;
        }
        return new IndexerChangesDto(result, last, epoch);
    }
}
