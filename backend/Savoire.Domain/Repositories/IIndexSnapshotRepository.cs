// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;

namespace Savoire.Domain.Repositories;

public interface IIndexSnapshotRepository
{
    /// <summary>Snapshot le plus récent pour ce namespace dans ce vault.</summary>
    Task<IndexSnapshot?> GetLatestAsync(string vaultId, string @namespace, CancellationToken ct = default);

    Task SaveAsync(IndexSnapshot snapshot, CancellationToken ct = default);
}
