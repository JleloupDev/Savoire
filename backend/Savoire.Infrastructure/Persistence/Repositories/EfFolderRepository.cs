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

    public Task<bool> HasDocumentsAsync(string vaultId, string folderPath, CancellationToken ct = default)
        => Task.FromResult(false); // Documents are CRDT-only — no SQL projection available

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
        catch (DbUpdateException ex) when (IsUniqueConstraintViolation(ex)) { }
    }

    public async Task<(int MovedFolders, int MovedDocuments)> MoveAsync(
        string folderId, string newPath, CancellationToken ct = default)
    {
        Folder? folder = await GetByIdAsync(folderId, ct);
        if (folder is null) return (0, 0);

        string oldPrefix = folder.Path + "/";
        string newPrefix = newPath + "/";

        await db.Folders.Where(f => f.Id == folderId)
            .ExecuteUpdateAsync(s => s.SetProperty(f => f.Path, newPath), ct);

        List<FolderEntity> subFolders = await db.Folders
            .Where(f => f.VaultId == folder.VaultId && f.Path.StartsWith(oldPrefix))
            .ToListAsync(ct);

        foreach (FolderEntity sub in subFolders)
            sub.Path = newPrefix + sub.Path[oldPrefix.Length..];

        await db.SaveChangesAsync(ct);
        return (subFolders.Count + 1, 0); // documents moved via CRDT
    }

    public async Task<int> DeleteRecursiveAsync(string folderId, DateTime deletedAt, CancellationToken ct = default)
    {
        Folder? folder = await GetByIdAsync(folderId, ct);
        if (folder is null) return 0;

        string prefix = folder.Path + "/";

        await db.Folders
            .Where(f => f.VaultId == folder.VaultId && (f.Id == folderId || f.Path.StartsWith(prefix)))
            .ExecuteDeleteAsync(ct);

        return 0; // documents deleted via CRDT
    }

    private static bool IsUniqueConstraintViolation(DbUpdateException ex)
    {
        if (ex.InnerException is SqliteException sqlite)
            return sqlite.SqliteErrorCode == 19 || sqlite.SqliteExtendedErrorCode == 2067;
        var msg = ex.InnerException?.Message ?? ex.Message;
        return msg.Contains("UNIQUE", StringComparison.OrdinalIgnoreCase)
               || msg.Contains("duplicate", StringComparison.OrdinalIgnoreCase);
    }
}
