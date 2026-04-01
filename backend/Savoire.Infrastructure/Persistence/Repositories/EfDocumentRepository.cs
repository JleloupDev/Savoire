// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfDocumentRepository(AppDbContext db) : IDocumentRepository
{
    public async Task<Document?> GetByIdAsync(string docId, CancellationToken ct = default)
    {
        DocumentEntity? e = await db.Documents.AsNoTracking()
            .FirstOrDefaultAsync(d => d.Id == docId, ct);
        return e?.ToDomain();
    }

    public async Task<Document?> GetByPathAsync(string vaultId, string path, CancellationToken ct = default)
    {
        DocumentEntity? e = await db.Documents.AsNoTracking()
            .FirstOrDefaultAsync(d => d.VaultId == vaultId && d.Path == path && d.DeletedAt == null, ct);
        return e?.ToDomain();
    }

    public async Task<IReadOnlyList<Document>> ListAsync(
        string vaultId, string? folderPrefix = null, bool includeDeleted = false,
        CancellationToken ct = default)
    {
        IQueryable<DocumentEntity> query = db.Documents.AsNoTracking()
            .Where(d => d.VaultId == vaultId);

        if (!includeDeleted)
            query = query.Where(d => d.DeletedAt == null);

        if (folderPrefix is not null)
        {
            string prefix = folderPrefix.TrimEnd('/') + "/";
            query = query.Where(d => d.Path.StartsWith(prefix));
        }

        List<DocumentEntity> entities = await query.OrderBy(d => d.Path).ToListAsync(ct);
        return entities.Select(e => e.ToDomain()).ToList();
    }

    public async Task<IReadOnlyList<Document>> GetChangedSinceAsync(
        string vaultId, DateTime since, CancellationToken ct = default)
    {
        List<DocumentEntity> entities = await db.Documents.AsNoTracking()
            .Where(d => d.VaultId == vaultId && d.UpdatedAt >= since)
            .OrderBy(d => d.UpdatedAt)
            .ToListAsync(ct);
        return entities.Select(e => e.ToDomain()).ToList();
    }

    public async Task AddAsync(Document document, CancellationToken ct = default)
    {
        db.Documents.Add(new DocumentEntity
        {
            Id        = document.Id,
            VaultId   = document.VaultId,
            Path      = document.Path,
            Title     = document.Title,
            SizeBytes = document.SizeBytes,
            Hash      = document.Hash,
            CreatedAt = document.CreatedAt,
            UpdatedAt = document.UpdatedAt,
            DeletedAt = document.DeletedAt
        });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueConstraintViolation(ex))
        {
            // Conflit de chemin en concurrence (index unique vaultId+path).
            throw new PathConflictException(document.Path);
        }
    }

    public async Task UpdateAsync(Document document, CancellationToken ct = default)
    {
        DocumentEntity? existing = await db.Documents.FindAsync([document.Id], ct);
        if (existing is null) return;

        existing.Path      = document.Path;
        existing.Title     = document.Title;
        existing.SizeBytes = document.SizeBytes;
        existing.Hash      = document.Hash;
        existing.UpdatedAt = document.UpdatedAt;
        existing.DeletedAt = document.DeletedAt;
        await db.SaveChangesAsync(ct);
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
