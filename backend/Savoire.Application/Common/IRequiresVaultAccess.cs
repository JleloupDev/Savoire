// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Common;

/// <summary>
/// Marker interface — any command/query implementing it
/// automatically triggers vault access verification via
/// <see cref="IVaultAccessGuard"/> in <c>VaultAccessBehavior</c>.
/// </summary>
public interface IRequiresVaultAccess
{
    string           CallerId       { get; }
    string           VaultId        { get; }
    VaultAccessLevel RequiredAccess { get; }
}
