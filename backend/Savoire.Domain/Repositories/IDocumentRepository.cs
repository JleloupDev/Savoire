// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;

namespace Savoire.Domain.Repositories;

public interface IDocumentRepository
{
    Task<Document?> GetByIdAsync(string docId, CancellationToken ct = default);
    Task<Document?> GetByPathAsync(string vaultId, string path, CancellationToken ct = default);
    Task<IReadOnlyList<Document>> ListAsync(string vaultId,
        string? folderPrefix = null, bool includeDeleted = false,
        CancellationToken ct = default);
    Task<IReadOnlyList<Document>> GetChangedSinceAsync(string vaultId, DateTime since,
        CancellationToken ct = default);
    Task AddAsync(Document document, CancellationToken ct = default);
    Task UpdateAsync(Document document, CancellationToken ct = default);
}
