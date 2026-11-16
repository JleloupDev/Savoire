// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Content storage interface — moved into Application (application concern).
// Implemented by LocalFileContentStore in Infrastructure.

namespace Savoire.Application.Abstractions;

public interface IContentStore
{
    Task<Stream?> ReadAttachmentAsync(string vaultId, string storagePath, CancellationToken ct = default);
    Task<string> WriteAttachmentAsync(string vaultId, string filename, Stream content, CancellationToken ct = default);
    /// <summary>Ecrit (ou remplace) une piece jointe sous un chemin de stockage choisi par l'appelant.</summary>
    Task PutAttachmentAsync(string vaultId, string storagePath, Stream content, CancellationToken ct = default);
    Task DeleteAttachmentAsync(string vaultId, string storagePath, CancellationToken ct = default);
    /// <summary>Efface tous les fichiers d'un vault (suppression du vault). Sans effet s'il n'en a pas.</summary>
    Task DeleteVaultAsync(string vaultId, CancellationToken ct = default);
    /// <summary>Les vaults qui ont des fichiers (pour retrouver ceux d'un vault supprime).</summary>
    Task<IReadOnlyList<string>> ListVaultIdsAsync(CancellationToken ct = default);
    /// <summary>Octets des fichiers d'un vault (quota de stockage).</summary>
    Task<long> GetVaultBytesAsync(string vaultId, CancellationToken ct = default);
}
