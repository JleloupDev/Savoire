// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ReadModels;

/// <summary>
/// Un jeton personnel de l'API ouverte : il agit au nom de la personne qui l'a
/// cree, avec ses droits, limite a certains vaults s'il le faut. Le serveur
/// n'en garde que l'empreinte (SHA-256) : le jeton n'est montre qu'une fois.
/// </summary>
public sealed record AccessToken(
    string Id,
    string UserId,
    string Name,
    // Debut du jeton, pour le reconnaitre dans la liste (svp_abcd...).
    string Prefix,
    string TokenHash,
    // « read » : lecture et recherche. L'ecriture viendra avec un mode a part.
    string Scope,
    // Vaults permis ; null : tous ceux de la personne.
    IReadOnlyList<string>? VaultIds,
    DateTime CreatedAt,
    DateTime? ExpiresAt,
    DateTime? LastUsedAt,
    DateTime? RevokedAt);
