// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;

namespace Savoire.Domain.Repositories;

public interface IOperationRepository
{
    Task AppendAsync(Operation op, CancellationToken ct = default);
    Task<IReadOnlyList<Operation>> GetSinceAsync(string docId, DateTime since, CancellationToken ct = default);
    Task<byte[]?> GetSyncVectorAsync(string docId, string clientId, CancellationToken ct = default);
    Task SetSyncVectorAsync(string docId, string clientId, byte[] vector, CancellationToken ct = default);
    /// <summary>
    /// Remplace toutes les opérations du document par un unique snapshot compacté.
    /// Si <paramref name="force"/> est false, sans effet quand le document a peu d'opérations (seuil = 50).
    /// </summary>
    Task CompactAsync(string docId, byte[] snapshotBytes, bool force = false, CancellationToken ct = default);
}
