// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;
using Savoire.Domain.ReadModels;

namespace Savoire.Domain.Repositories;

public interface IDocLinkRepository
{
    /// <summary>All links whose source is this document.</summary>
    Task<IReadOnlyList<DocLink>> GetBySourceAsync(string sourceId, CancellationToken ct = default);

    /// <summary>All documents that link to this document (backlinks).</summary>
    Task<IReadOnlyList<DocLink>> GetBacklinksAsync(string targetId, CancellationToken ct = default);

    /// <summary>All links pointing to this path (for rename cascade).</summary>
    Task<IReadOnlyList<DocLink>> GetByTargetPathAsync(string vaultId, string targetPath, CancellationToken ct = default);

    /// <summary>Replaces all links for a source document. Called on every re-indexing pass.</summary>
    Task ReplaceForSourceAsync(string sourceId, IReadOnlyList<DocLink> links, CancellationToken ct = default);

    /// <summary>Updates the targetPath of links that pointed to oldPath.</summary>
    Task UpdateTargetPathAsync(string vaultId, string oldPath, string newPath, string? newTargetId, CancellationToken ct = default);

    Task DeleteBySourceAsync(string sourceId, CancellationToken ct = default);

    /// <summary>All vault links with the resolved source path — used to initialize the client-side graph.</summary>
    Task<IReadOnlyList<VaultLinkProjection>> GetAllByVaultAsync(string vaultId, CancellationToken ct = default);
}

