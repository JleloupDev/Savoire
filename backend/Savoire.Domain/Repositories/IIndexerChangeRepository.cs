// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.ReadModels;

namespace Savoire.Domain.Repositories;

/// <summary>
/// Lecture du flux de changements du pair indexeur.
///
/// L'ecriture n'a pas d'API : elle a lieu dans la meme transaction que
/// l'ecriture qu'elle signale, dans les repositories qui ecrivent (journal
/// CRDT, suppression d'un vault, reglage du pair). Aucun chemin d'ecriture ne
/// peut donc l'oublier.
/// </summary>
public interface IIndexerChangeRepository
{
    /// <summary>Les changements de sequence strictement superieure a <paramref name="since"/>, dans l'ordre, au plus <paramref name="max"/>.</summary>
    Task<IReadOnlyList<IndexerChange>> GetSinceAsync(long since, int max, CancellationToken ct = default);

    /// <summary>
    /// Identifiant de cette base. Il change si la base est recreee (sequences
    /// reparties de zero) : le pair sait alors qu'il doit tout reconstruire.
    /// </summary>
    Task<string> GetEpochAsync(CancellationToken ct = default);
}
