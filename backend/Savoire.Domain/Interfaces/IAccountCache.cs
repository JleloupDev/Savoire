// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Interfaces;

/// <summary>
/// Etat des comptes garde en memoire pendant la validation des jetons
/// (administrateur, bloque). A oublier quand un compte change.
/// </summary>
public interface IAccountCache
{
    void Forget(string userId);
    /// <summary>
    /// Compte supprime : un jeton encore valide chez le fournisseur d'identite
    /// ne le recree pas (sans cela, la premiere requete d'un onglet reste
    /// ouvert ferait renaitre un compte vide).
    /// </summary>
    void MarkDeleted(string userId);
}
