// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfFolderRepository(AppDbContext db) : IFolderRepository
{
    public async Task<Folder?> GetByIdAsync(string folderId, CancellationToken ct = default)
    {
        FolderEntity? e = await db.Folders.AsNoTracking()
            .FirstOrDefaultAsync(f => f.Id == folderId, ct);
        return e?.ToDomain();
    }

    public async Task<Folder?> GetByPathAsync(string vaultId, string path, CancellationToken ct = default)
    {
        FolderEntity? e = await db.Folders.AsNoTracking()
            .FirstOrDefaultAsync(f => f.VaultId == vaultId && f.Path == path, ct);
        return e?.ToDomain();
    }

    public async Task<IReadOnlyList<Folder>> ListAsync(string vaultId, CancellationToken ct = default)
    {
        List<FolderEntity> entities = await db.Folders.AsNoTracking()
            .Where(f => f.VaultId == vaultId)
            .OrderBy(f => f.Path)
            .ToListAsync(ct);
        return entities.Select(e => e.ToDomain()).ToList();
    }

    public async Task<bool> HasDocumentsAsync(string vaultId, string folderPath, CancellationToken ct = default)
    {
        string prefix = folderPath.TrimEnd('/') + "/";
        return await db.Documents.AnyAsync(
            d => d.VaultId == vaultId && d.Path.StartsWith(prefix) && d.DeletedAt == null, ct);
    }

    public async Task AddAsync(Folder folder, CancellationToken ct = default)
    {
        bool exists = await db.Folders.AnyAsync(
            f => f.Id == folder.Id || (f.VaultId == folder.VaultId && f.Path == folder.Path), ct);
        if (exists) return;

        db.Folders.Add(new FolderEntity
        {
            Id = folder.Id, VaultId = folder.VaultId,
            Path = folder.Path, CreatedAt = folder.CreatedAt
        });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueConstraintViolation(ex))
        {
            // Idempotence en concurrence: un autre flux a pu creer le meme dossier juste avant.
        }
    }

    private static bool IsUniqueConstraintViolation(DbUpdateException ex)
    {
        // SQLite unique violation codes: 19 (constraint), 2067 (unique constraint).
        if (ex.InnerException is SqliteException sqlite)
            return sqlite.SqliteErrorCode == 19 || sqlite.SqliteExtendedErrorCode == 2067;

        var msg = ex.InnerException?.Message ?? ex.Message;
        return msg.Contains("UNIQUE", StringComparison.OrdinalIgnoreCase)
               || msg.Contains("duplicate", StringComparison.OrdinalIgnoreCase);
    }

    public async Task<(int MovedFolders, int MovedDocuments)> MoveAsync(
        string folderId, string newPath, CancellationToken ct = default)
    {
        Folder? folder = await GetByIdAsync(folderId, ct);
        if (folder is null) return (0, 0);

        string oldPath   = folder.Path;
        string oldPrefix = oldPath + "/";
        string newPrefix = newPath + "/";

        await db.Folders.Where(f => f.Id == folderId)
            .ExecuteUpdateAsync(s => s.SetProperty(f => f.Path, newPath), ct);

        List<FolderEntity> subFolders = await db.Folders
            .Where(f => f.VaultId == folder.VaultId && f.Path.StartsWith(oldPrefix))
            .ToListAsync(ct);

        foreach (FolderEntity sub in subFolders)
            sub.Path = newPrefix + sub.Path[oldPrefix.Length..];

        List<DocumentEntity> docs = await db.Documents
            .Where(d => d.VaultId == folder.VaultId && d.Path.StartsWith(oldPrefix) && d.DeletedAt == null)
            .ToListAsync(ct);

        DateTime now = DateTime.UtcNow;
        foreach (DocumentEntity doc in docs)
        {
            doc.Path = newPrefix + doc.Path[oldPrefix.Length..];
            doc.UpdatedAt = now;
        }

        await db.SaveChangesAsync(ct);
        return (subFolders.Count + 1, docs.Count);
    }

    public async Task<int> DeleteRecursiveAsync(string folderId, DateTime deletedAt, CancellationToken ct = default)
    {
        Folder? folder = await GetByIdAsync(folderId, ct);
        if (folder is null) return 0;

        string prefix = folder.Path + "/";

        int deleted = await db.Documents
            .Where(d => d.VaultId == folder.VaultId
                && (d.Path.StartsWith(prefix) || d.Path == folder.Path)
                && d.DeletedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.DeletedAt, deletedAt), ct);

        await db.Folders
            .Where(f => f.VaultId == folder.VaultId && (f.Id == folderId || f.Path.StartsWith(prefix)))
            .ExecuteDeleteAsync(ct);

        return deleted;
    }
}
