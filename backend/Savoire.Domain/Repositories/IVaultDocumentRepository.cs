// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

using Savoire.Domain.ReadModels;

namespace Savoire.Domain.Repositories;

/// <summary>
/// Registre « document -> vault » du mode serveur.
///
/// La liste des notes d'un vault est un CRDT que le serveur ne lit pas, et le
/// contenu d'un document est range sous son seul identifiant : sans ce
/// registre, le serveur ne sait pas a quel vault appartient un document, et
/// un controle d'acces ne peut verifier que le vault ANNONCE par l'appelant.
/// Creer un document commence donc par l'inscrire ici.
/// </summary>
public interface IVaultDocumentRepository
{
    /// <summary>Vault du document, ou null s'il n'est pas inscrit.</summary>
    Task<string?> GetVaultIdAsync(string docId, CancellationToken ct = default);

    /// <summary>
    /// Inscrit des documents dans un vault. Idempotent pour un document deja
    /// inscrit dans CE vault. Rend les documents refuses parce qu'inscrits dans
    /// un AUTRE vault : un document ne change jamais de vault.
    /// </summary>
    Task<IReadOnlyList<string>> RegisterAsync(
        string vaultId, IReadOnlyCollection<string> docIds, string registeredBy, CancellationToken ct = default);

    /// <summary>Le document inscrit, avec son rangement de piece jointe ; null s'il n'est pas inscrit.</summary>
    Task<VaultDocumentRecord?> GetAsync(string docId, CancellationToken ct = default);

    /// <summary>
    /// Rangement d'une piece jointe : la note dont le dossier la contient
    /// (null : rangee ailleurs) et son nom affiche. Seul le client connait
    /// les chemins (repertoire CRDT) : il annonce ce rangement a l'envoi et a
    /// chaque deplacement. Ne touche que les documents deja inscrits.
    /// </summary>
    Task SetPlacementAsync(string docId, string? parentDocId, string? name, CancellationToken ct = default);

    /// <summary>Pieces jointes rangees dans le dossier de cette note.</summary>
    Task<IReadOnlyList<VaultDocumentRecord>> ListChildrenAsync(string vaultId, string parentDocId, CancellationToken ct = default);
}
