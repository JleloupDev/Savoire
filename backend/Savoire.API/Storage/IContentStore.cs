// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Abstraction de stockage de contenu (fichiers .md et .md.crdt, pièces jointes).
// Implémentation locale : LocalFileContentStore.
// Implémentation SaaS future : Azure Blob / S3.
// Conforme à docs/Claude/Storage requierement.md § Interface d'abstraction (C#)

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
