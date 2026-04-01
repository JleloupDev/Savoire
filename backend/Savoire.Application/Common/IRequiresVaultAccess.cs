// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Common;

/// <summary>
/// Interface marqueur — toute commande/requête qui l'implémente
/// déclenche automatiquement la vérification d'accès vault via
/// <see cref="IVaultAccessGuard"/> dans <c>VaultAccessBehavior</c>.
/// </summary>
public interface IRequiresVaultAccess
{
    string           CallerId       { get; }
    string           VaultId        { get; }
    VaultAccessLevel RequiredAccess { get; }
}
