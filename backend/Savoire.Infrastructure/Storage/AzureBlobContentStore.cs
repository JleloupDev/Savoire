// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Azure Blob Storage implementation of IContentStore.
// see ADR-020
// NuGet: Azure.Storage.Blobs

using Azure.Storage.Blobs;
using Savoire.Application.Abstractions;

namespace Savoire.Infrastructure.Storage;

public class AzureBlobContentStore(
    BlobServiceClient blobServiceClient,
    string containerName = "vaults") : IContentStore
{
    private readonly BlobContainerClient _container =
        blobServiceClient.GetBlobContainerClient(containerName);

    /// <summary>Creates the Blob container if it does not exist (call at startup).</summary>
    public async Task InitializeAsync()
        => await _container.CreateIfNotExistsAsync();

    // ── Helpers — same naming conventions as LocalFileContentStore ──────────

    private static string AttachBlobName(string vaultId, string storagePath)
        => $"{vaultId}/attachments/{storagePath}";

    // ── IContentStore ────────────────────────────────────────────────────

    public async Task<Stream?> ReadAttachmentAsync(
        string vaultId, string storagePath, CancellationToken ct = default)
    {
        var blob = _container.GetBlobClient(AttachBlobName(vaultId, storagePath));
        if (!await blob.ExistsAsync(ct)) return null;
        var response = await blob.DownloadStreamingAsync(cancellationToken: ct);
        return response.Value.Content;
    }

    public async Task<string> WriteAttachmentAsync(
        string vaultId, string filename, Stream content, CancellationToken ct = default)
    {
        string fileId      = Guid.NewGuid().ToString("N");
        string ext         = Path.GetExtension(filename);
        string storagePath = $"{fileId}{ext}";

        var blob = _container.GetBlobClient(AttachBlobName(vaultId, storagePath));
        await blob.UploadAsync(content, overwrite: true, cancellationToken: ct);
        return storagePath;
    }

    public async Task DeleteAttachmentAsync(
        string vaultId, string storagePath, CancellationToken ct = default)
    {
        var blob = _container.GetBlobClient(AttachBlobName(vaultId, storagePath));
        await blob.DeleteIfExistsAsync(cancellationToken: ct);
    }
}