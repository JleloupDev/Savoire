// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Repositories;

/// <summary>
/// Blind key-value blob store, scoped per vault. Backs the edgesync protocol's
/// IStorage port for a coordinating-but-blind server (S3): values are opaque
/// ciphertext produced client-side, the server never decrypts or interprets
/// them (see ADR-022 for the same "opaque to the server" stance applied to
/// index snapshots).
/// </summary>
public interface IEdgesyncBlobRepository
{
    Task<byte[]?> GetAsync(string vaultId, string key, CancellationToken ct = default);
    Task SetAsync(string vaultId, string key, byte[] bytes, CancellationToken ct = default);
}
