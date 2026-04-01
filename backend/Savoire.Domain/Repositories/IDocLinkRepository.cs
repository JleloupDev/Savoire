// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Aggregates;
using Savoire.Domain.ReadModels;

namespace Savoire.Domain.Repositories;

public interface IDocLinkRepository
{
    /// <summary>Tous les liens dont la source est ce document.</summary>
    Task<IReadOnlyList<DocLink>> GetBySourceAsync(string sourceId, CancellationToken ct = default);

    /// <summary>Tous les documents qui linkent vers ce document (backlinks).</summary>
    Task<IReadOnlyList<DocLink>> GetBacklinksAsync(string targetId, CancellationToken ct = default);

    /// <summary>Tous les liens qui pointent vers ce path (pour cascade rename).</summary>
    Task<IReadOnlyList<DocLink>> GetByTargetPathAsync(string vaultId, string targetPath, CancellationToken ct = default);

    /// <summary>Remplace tous les liens d'un document source. Appelé à chaque re-indexation.</summary>
    Task ReplaceForSourceAsync(string sourceId, IReadOnlyList<DocLink> links, CancellationToken ct = default);

    /// <summary>Met à jour le targetPath des liens qui pointaient vers oldPath.</summary>
    Task UpdateTargetPathAsync(string vaultId, string oldPath, string newPath, string? newTargetId, CancellationToken ct = default);

    Task DeleteBySourceAsync(string sourceId, CancellationToken ct = default);

    /// <summary>Tous les liens du vault avec le path source résolu — pour initialiser le graphe côté client.</summary>
    Task<IReadOnlyList<VaultLinkProjection>> GetAllByVaultAsync(string vaultId, CancellationToken ct = default);
}

