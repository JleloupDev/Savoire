// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Repositories;

/// <summary>
/// Blind, per-user key escrow: stores a vault's Keyring wrapped under that
/// user's own K_User (never seen by the server). S3 shape — see
/// VaultKeyEscrow.ts on the client for the wrap/unwrap side. Unrelated to
/// IEdgesyncBlobRepository, which persists vault *content*, not keys.
/// </summary>
public interface IVaultKeyWrapRepository
{
    Task<byte[]?> GetAsync(string userId, string vaultId, CancellationToken ct = default);
    Task SetAsync(string userId, string vaultId, byte[] wrappedKeyBytes, CancellationToken ct = default);
}
