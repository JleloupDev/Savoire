// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Common;

public enum VaultAccessLevel { Read, Write }

/// <summary>
/// Centralise les vérifications d'accès aux vaults.
/// Appelé automatiquement par <c>VaultAccessBehavior</c> pour toute requête
/// implémentant <see cref="IRequiresVaultAccess"/>.
/// </summary>
public interface IVaultAccessGuard
{
    /// <summary>Lève VaultNotFoundException ou AccessDeniedException si l'accès est refusé.</summary>
    Task RequireReadAsync(string callerId, string vaultId, CancellationToken ct = default);

    /// <summary>Comme RequireReadAsync mais refuse les membres avec le rôle "viewer".</summary>
    Task RequireWriteAsync(string callerId, string vaultId, CancellationToken ct = default);
}
