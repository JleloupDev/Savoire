// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Implémentation Azure Blob Storage de IContentStore.
// see ADR-020
// NuGet : Azure.Storage.Blobs

using Azure.Storage.Blobs;
using Savoire.Application.Abstractions;

namespace Savoire.Infrastructure.Storage;

public class AzureBlobContentStore(
    BlobServiceClient blobServiceClient,
    string containerName = "vaults") : IContentStore
{
    private readonly BlobContainerClient _container =
        blobServiceClient.GetBlobContainerClient(containerName);

    /// <summary>Crée le container Blob s'il n'existe pas (appeler au démarrage).</summary>
    public async Task InitializeAsync()
        => await _container.CreateIfNotExistsAsync();

    // ── Helpers — mêmes conventions de nommage que LocalFileContentStore ──

    private static string DocBlobName(string vaultId, string docId)
        => $"{vaultId}/{docId}.md";

    private static string CrdtBlobName(string vaultId, string docId)
        => $"{vaultId}/{docId}.md.crdt";

    private static string AttachBlobName(string vaultId, string storagePath)
        => $"{vaultId}/attachments/{storagePath}";

    // ── IContentStore ────────────────────────────────────────────────────

    public async Task<Stream?> ReadDocumentAsync(
        string vaultId, string docId, CancellationToken ct = default)
    {
        var blob = _container.GetBlobClient(DocBlobName(vaultId, docId));
        if (!await blob.ExistsAsync(ct)) return null;
        var response = await blob.DownloadStreamingAsync(cancellationToken: ct);
        return response.Value.Content;
    }

    public async Task WriteDocumentAsync(
        string vaultId, string docId, Stream content, CancellationToken ct = default)
    {
        var blob = _container.GetBlobClient(DocBlobName(vaultId, docId));
        await blob.UploadAsync(content, overwrite: true, cancellationToken: ct);
    }

    public async Task<Stream?> ReadCrdtAsync(
        string vaultId, string docId, CancellationToken ct = default)
    {
        var blob = _container.GetBlobClient(CrdtBlobName(vaultId, docId));
        if (!await blob.ExistsAsync(ct)) return null;
        var response = await blob.DownloadStreamingAsync(cancellationToken: ct);
        return response.Value.Content;
    }

    public async Task WriteCrdtAsync(
        string vaultId, string docId, Stream content, CancellationToken ct = default)
    {
        var blob = _container.GetBlobClient(CrdtBlobName(vaultId, docId));
        await blob.UploadAsync(content, overwrite: true, cancellationToken: ct);
    }

    public async Task DeleteDocumentAsync(
        string vaultId, string docId, CancellationToken ct = default)
    {
        var docBlob = _container.GetBlobClient(DocBlobName(vaultId, docId));
        await docBlob.DeleteIfExistsAsync(cancellationToken: ct);

        var crdtBlob = _container.GetBlobClient(CrdtBlobName(vaultId, docId));
        await crdtBlob.DeleteIfExistsAsync(cancellationToken: ct);
    }

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