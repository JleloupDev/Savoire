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
}
