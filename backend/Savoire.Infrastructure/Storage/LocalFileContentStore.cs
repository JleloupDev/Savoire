// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Local filesystem implementation of IContentStore.
// see ADR-002

using Savoire.Application.Abstractions;

namespace Savoire.Infrastructure.Storage;

public class LocalFileContentStore(string storageRoot) : IContentStore
{
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

    public Task PutAttachmentAsync(string vaultId, string storagePath, Stream content, CancellationToken ct = default)
        => WriteAtomicAsync(AttachPath(vaultId, storagePath), content, ct);

    public Task DeleteAttachmentAsync(string vaultId, string storagePath, CancellationToken ct = default)
    {
        string path = AttachPath(vaultId, storagePath);
        if (File.Exists(path)) File.Delete(path);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Le dossier d'un vault, ou null si l'identifiant ne designe pas un
    /// dossier situe directement sous la racine (jamais « .. », ni un chemin).
    /// </summary>
    private string? VaultDir(string vaultId)
    {
        if (string.IsNullOrWhiteSpace(vaultId) || vaultId is "." or ".."
            || vaultId.IndexOfAny([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar, '\0']) >= 0) return null;
        string root = Path.GetFullPath(storageRoot);
        string dir = Path.GetFullPath(Path.Combine(root, vaultId));
        return Path.GetDirectoryName(dir) == root.TrimEnd(Path.DirectorySeparatorChar) ? dir : null;
    }

    public Task DeleteVaultAsync(string vaultId, CancellationToken ct = default)
    {
        string? dir = VaultDir(vaultId);
        if (dir is not null && Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<string>> ListVaultIdsAsync(CancellationToken ct = default)
    {
        IReadOnlyList<string> ids = Directory.Exists(storageRoot)
            ? Directory.EnumerateDirectories(storageRoot).Select(d => Path.GetFileName(d)!).ToList()
            : [];
        return Task.FromResult(ids);
    }

    public Task<long> GetVaultBytesAsync(string vaultId, CancellationToken ct = default)
    {
        string? dir = VaultDir(vaultId);
        if (dir is null || !Directory.Exists(dir)) return Task.FromResult(0L);
        long total = 0;
        foreach (string file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
        {
            ct.ThrowIfCancellationRequested();
            try { total += new FileInfo(file).Length; } catch (IOException) { /* efface entre-temps */ }
        }
        return Task.FromResult(total);
    }
}