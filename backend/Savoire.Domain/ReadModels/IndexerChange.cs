// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ReadModels;

/// <summary>
/// Une ligne du flux de changements lu par le pair indexeur
/// (docs/Architecture/indexer-protocol.md, « API interne »).
/// Une ligne par ressource : une nouvelle ecriture la deplace a la fin du
/// flux avec une nouvelle sequence.
/// </summary>
public sealed record IndexerChange(long Seq, string VaultId, string Kind, string? DocId);

/// <summary>Valeurs de <see cref="IndexerChange.Kind"/>, telles que le protocole les nomme.</summary>
public static class IndexerChangeKind
{
    /// <summary>Arborescence du vault modifiee.</summary>
    public const string Vault        = "vault";
    /// <summary>Contenu d'un document modifie.</summary>
    public const string Document     = "document";
    /// <summary>Vault supprime, ou sorti du pair gere (reglage none / organization).</summary>
    public const string VaultDeleted = "vault-deleted";
}
