// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Common;

public enum VaultAccessLevel { Read, Write, Admin }

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

    /// <summary>
    /// Allows access if the caller is a vault member/owner, or if they hold a
    /// non-expired document-level permission in resource_permissions.
    /// Throws VaultNotFoundException (masked as 404) otherwise.
    /// </summary>
    Task RequireDocumentReadAsync(string callerId, string vaultId, string docId, CancellationToken ct = default);

    /// <summary>
    /// Like RequireDocumentReadAsync but also rejects vault viewers and
    /// callers whose document-level permission is read-only.
    /// </summary>
    Task RequireDocumentWriteAsync(string callerId, string vaultId, string docId, CancellationToken ct = default);

    /// <summary>
    /// Requires vault owner or an explicit admin permission grant on the vault.
    /// Used for sharing/permission-management operations.
    /// </summary>
    Task RequireAdminAsync(string callerId, string vaultId, CancellationToken ct = default);
}
