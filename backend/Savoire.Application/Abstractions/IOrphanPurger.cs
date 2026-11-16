// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.ReadModels;

namespace Savoire.Application.Abstractions;

/// <summary>
/// Menage des restes de vaults supprimes (lignes et fichiers sans vault).
/// Voir VaultEraser.
/// </summary>
public interface IOrphanPurger
{
    /// <summary><paramref name="dryRun"/> : compter sans rien effacer.</summary>
    Task<OrphanReport> PurgeOrphansAsync(bool dryRun, CancellationToken ct = default);
}
