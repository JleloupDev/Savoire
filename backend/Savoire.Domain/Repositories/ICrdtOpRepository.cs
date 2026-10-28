// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;

namespace Savoire.Domain.Repositories;

/// <summary>
/// Generic append-only CRDT op log. ResourceId is an opaque string key:
/// documents use the document id, vaults use "vault:{vaultId}".
/// ResourceType (see CrdtResourceType) scopes queries to the correct partition.
/// </summary>
public interface ICrdtOpRepository
{
    Task AppendAsync(Operation op, CancellationToken ct = default);
    Task<IReadOnlyList<Operation>> GetAllAsync(string resourceType, string resourceId, CancellationToken ct = default);
    Task<IReadOnlyList<Operation>> GetSinceAsync(string resourceType, string resourceId, DateTime since, CancellationToken ct = default);
    Task<byte[]?> GetSyncVectorAsync(string resourceId, string clientId, CancellationToken ct = default);
    Task SetSyncVectorAsync(string resourceId, string clientId, byte[] vector, CancellationToken ct = default);
    Task CompactAsync(string resourceType, string resourceId, byte[] snapshotBytes, bool force = false, CancellationToken ct = default);

    /// <summary>
    /// Remplace par un etat compacte EXACTEMENT les ops <paramref name="replacedOpIds"/>
    /// (celles que l'auteur de l'etat a rejouees). Les ops arrivees depuis
    /// restent. Si aucune de ces ops n'existe plus (une autre compaction est
    /// passee), rien n'est ecrit. Rend le nombre d'ops remplacees.
    /// </summary>
    Task<int> ReplaceAsync(string resourceType, string resourceId, IReadOnlyCollection<string> replacedOpIds,
        byte[] snapshotBytes, CancellationToken ct = default);
}
