// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;

namespace Savoire.Domain.Repositories;

public interface IDocumentMetaRepository
{
    Task<DocumentMeta?> GetByDocumentIdAsync(string documentId, CancellationToken ct = default);
    Task<IReadOnlyList<DocumentMeta>> ListByVaultAsync(string vaultId, bool includeDerived = true, CancellationToken ct = default);
    Task<IReadOnlyList<DocumentMeta>> ListByTagAsync(string vaultId, string tag, CancellationToken ct = default);
    Task UpsertAsync(DocumentMeta meta, CancellationToken ct = default);
    Task DeleteByDocumentIdAsync(string documentId, CancellationToken ct = default);
}
