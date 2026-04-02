// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Content storage abstraction (.md and .md.crdt files, attachments).
// Local implementation: LocalFileContentStore.
// Future SaaS implementation: Azure Blob / S3.

namespace Savoire.Server.Storage;

public interface IContentStore
{
    Task<Stream?> ReadDocumentAsync(string vaultId, string docId, CancellationToken ct = default);
    Task WriteDocumentAsync(string vaultId, string docId, Stream content, CancellationToken ct = default);
    Task<Stream?> ReadCrdtAsync(string vaultId, string docId, CancellationToken ct = default);
    Task WriteCrdtAsync(string vaultId, string docId, Stream content, CancellationToken ct = default);
    Task DeleteDocumentAsync(string vaultId, string docId, CancellationToken ct = default);
    Task<Stream?> ReadAttachmentAsync(string vaultId, string storagePath, CancellationToken ct = default);
    Task<string> WriteAttachmentAsync(string vaultId, string filename, Stream content, CancellationToken ct = default);
    Task DeleteAttachmentAsync(string vaultId, string storagePath, CancellationToken ct = default);
}
