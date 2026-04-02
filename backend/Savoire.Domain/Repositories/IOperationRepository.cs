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
    /// Replaces all operations for the document with a single compacted snapshot.
    /// If <paramref name="force"/> is false, has no effect when the document has few operations (threshold = 50).
    /// </summary>
    Task CompactAsync(string docId, byte[] snapshotBytes, bool force = false, CancellationToken ct = default);
}
