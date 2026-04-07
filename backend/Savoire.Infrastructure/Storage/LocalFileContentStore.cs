// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Local filesystem implementation of IContentStore.
// see ADR-002

using Savoire.Application.Abstractions;

namespace Savoire.Infrastructure.Storage;

public class LocalFileContentStore(string storageRoot) : IContentStore
{
    private string DocPath(string vaultId, string docId)
        => Path.Combine(storageRoot, vaultId, $"{docId}.md");

    private string AttachPath(string vaultId, string storagePath)
        => Path.Combine(storageRoot, vaultId, "attachments", storagePath);

    private static void EnsureDir(string filePath)
        => Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);

    private static async Task WriteAtomicAsync(string path, Stream content, CancellationToken ct)
    {
        EnsureDir(path);
        string tmp = path + ".tmp";
        await using (FileStream fs = File.Create(tmp))
        {
            await content.CopyToAsync(fs, ct);
            await fs.FlushAsync(ct);
        }
        File.Move(tmp, path, overwrite: true);
    }

    public Task<Stream?> ReadDocumentAsync(string vaultId, string docId, CancellationToken ct = default)
    {
        string path = DocPath(vaultId, docId);
        return Task.FromResult<Stream?>(File.Exists(path) ? File.OpenRead(path) : null);
    }

    public Task WriteDocumentAsync(string vaultId, string docId, Stream content, CancellationToken ct = default)
        => WriteAtomicAsync(DocPath(vaultId, docId), content, ct);

    public Task DeleteDocumentAsync(string vaultId, string docId, CancellationToken ct = default)
    {
        string md = DocPath(vaultId, docId);
        if (File.Exists(md)) File.Delete(md);
        return Task.CompletedTask;
    }

    public Task<Stream?> ReadAttachmentAsync(string vaultId, string storagePath, CancellationToken ct = default)
    {
        string path = AttachPath(vaultId, storagePath);
        return Task.FromResult<Stream?>(File.Exists(path) ? File.OpenRead(path) : null);
    }

    public async Task<string> WriteAttachmentAsync(string vaultId, string filename, Stream content, CancellationToken ct = default)
    {
        string fileId      = Guid.NewGuid().ToString("N");
        string ext         = Path.GetExtension(filename);
        string storagePath = $"{fileId}{ext}";
        await WriteAtomicAsync(AttachPath(vaultId, storagePath), content, ct);
        return storagePath;
    }

    public Task DeleteAttachmentAsync(string vaultId, string storagePath, CancellationToken ct = default)
    {
        string path = AttachPath(vaultId, storagePath);
        if (File.Exists(path)) File.Delete(path);
        return Task.CompletedTask;
    }
}