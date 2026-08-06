// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Repositories;

/// <summary>
/// S2 for a Managed vault: stores the vault's Keyring in clear, server-side --
/// keyed by VaultId alone (not per-user, unlike IVaultKeyWrapRepository's S3
/// wrap), since the server itself is the direct key holder for this vault.
/// See ManagedVaultKeyringSource.ts on the client.
/// </summary>
public interface IManagedVaultKeyringRepository
{
    Task<byte[]?> GetAsync(string vaultId, CancellationToken ct = default);
    Task SetAsync(string vaultId, byte[] keyringBytes, CancellationToken ct = default);
}
