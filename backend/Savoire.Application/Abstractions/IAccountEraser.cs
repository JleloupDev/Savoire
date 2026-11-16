// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Abstractions;

/// <summary>
/// Les vaults touches par la suppression d'un compte : ceux qu'il possedait
/// (effaces, pour tous leurs membres) et ceux dont il etait membre.
/// </summary>
public sealed record AccountErasure(IReadOnlyList<string> DeletedVaultIds, IReadOnlyList<string> LeftVaultIds);

/// <summary>
/// Supprime un compte et tout ce qui est a lui (revue du 14/11/2026, E2 :
/// droit a l'effacement) : chez le fournisseur d'identite d'abord, puis dans
/// Savoire. Voir AccountEraser.
/// </summary>
public interface IAccountEraser
{
    Task<AccountErasure> EraseAsync(string userId, CancellationToken ct = default);
}

/// <summary>
/// Le fournisseur d'identite, vu par l'API pour y supprimer un compte.
/// Non configure (tests, installation sans fournisseur) : rien n'y est fait.
/// </summary>
public interface IIdentityProviderAdmin
{
    bool Configured { get; }
    /// <summary>Supprime le compte chez le fournisseur. Sans effet s'il n'y est plus. Leve si le fournisseur refuse.</summary>
    Task DeleteUserAsync(string subject, CancellationToken ct = default);
}
