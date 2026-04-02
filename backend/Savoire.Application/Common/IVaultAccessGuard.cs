// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Common;

public enum VaultAccessLevel { Read, Write }

/// <summary>
/// Centralizes vault access checks.
/// Called automatically by <c>VaultAccessBehavior</c> for every request
/// implementing <see cref="IRequiresVaultAccess"/>.
/// </summary>
public interface IVaultAccessGuard
{
    /// <summary>Throws VaultNotFoundException or AccessDeniedException if access is denied.</summary>
    Task RequireReadAsync(string callerId, string vaultId, CancellationToken ct = default);

    /// <summary>Like RequireReadAsync but rejects members with the "viewer" role.</summary>
    Task RequireWriteAsync(string callerId, string vaultId, CancellationToken ct = default);
}
